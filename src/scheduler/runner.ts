import { Cron } from 'croner';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Outbox } from '../outbox/queue.js';
import { runOutboxWorker, type Sender } from '../outbox/worker.js';
import type { Engine } from './engine.js';

export interface RunnerDeps {
  cfg: AppConfig;
  log: Logger;
  engine: Engine;
  outbox: Outbox;
  sender: Sender;
  pollAnnouncements: () => Promise<readonly { ok: boolean }[]>;
  pollClan: (() => Promise<unknown>) | null;
}

export interface RunnerHandle {
  stop(): void;
  status(): Record<string, unknown>;
}

function guarded(name: string, log: Logger, fn: () => unknown) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log.error({ job: name, err: err instanceof Error ? err.message : String(err) }, 'job falhou');
    } finally {
      running = false;
    }
  };
}

const ANNOUNCEMENTS_RETRY_MINUTES = 5;

/** Agenda os jobs: relatórios (cron com fuso), tick por minuto, coletas por intervalo e worker de envio. */
export function startRunner(d: RunnerDeps): RunnerHandle {
  const tz = d.cfg.tzDisplay;
  const last: Record<string, string> = {};
  const stamp = (k: string) => () => {
    last[k] = new Date().toISOString();
  };

  const jobs: Cron[] = [];
  const timers: NodeJS.Timeout[] = [];

  jobs.push(new Cron(d.cfg.schedule.monthlyCron, { timezone: tz, protect: true }, guarded('monthly', d.log, () => { d.engine.runReport('monthly'); stamp('monthly')(); })));
  jobs.push(new Cron(d.cfg.schedule.weeklyCron, { timezone: tz, protect: true }, guarded('weekly', d.log, () => { d.engine.runReport('weekly'); stamp('weekly')(); })));
  jobs.push(new Cron('* * * * *', { timezone: tz, protect: true }, guarded('tick', d.log, () => { d.engine.tick(); stamp('tick')(); })));
  // atualização do calendário mensal: verificada uma vez por dia às 12h (só envia se algo mudou)
  jobs.push(new Cron('0 12 * * *', { timezone: tz, protect: true }, guarded('monthly_update', d.log, () => { d.engine.runMonthlyUpdate(); stamp('monthly_update')(); })));

  // Falha na coleta de anúncios (ex.: timeout com a VM ocupada subindo o Chromium) tenta de novo em poucos
  // minutos, sem esperar o intervalo normal: relatório não deve sair com "fonte não consultada" por 1 h.
  let annRetry: NodeJS.Timeout | null = null;
  const ann = guarded('announcements', d.log, async () => {
    const results = await d.pollAnnouncements();
    stamp('announcements')();
    if (annRetry) clearTimeout(annRetry);
    annRetry = null;
    if (results.some((r) => !r.ok)) {
      d.log.warn({ retryMinutes: ANNOUNCEMENTS_RETRY_MINUTES }, 'coleta de anúncios falhou; nova tentativa em breve');
      annRetry = setTimeout(() => void ann(), ANNOUNCEMENTS_RETRY_MINUTES * 60_000);
    }
  });
  timers.push(setInterval(ann, d.cfg.schedule.pollAnnouncementsMinutes * 60_000));
  setTimeout(ann, 5_000);

  if (d.pollClan) {
    const clan = guarded('clan', d.log, async () => { await d.pollClan!(); stamp('clan')(); });
    timers.push(setInterval(clan, d.cfg.schedule.pollClanMinutes * 60_000));
    setTimeout(clan, 10_000);
  }

  const worker = guarded('outbox', d.log, () => runOutboxWorker(d.outbox, d.sender, d.cfg, d.log));
  timers.push(setInterval(worker, 15_000));

  d.log.info(
    { monthly: d.cfg.schedule.monthlyCron, weekly: d.cfg.schedule.weeklyCron, tz, pollClanMin: d.cfg.schedule.pollClanMinutes, pollAnnMin: d.cfg.schedule.pollAnnouncementsMinutes, dryRun: d.cfg.dryRun },
    'agendador iniciado',
  );

  return {
    stop() {
      for (const j of jobs) j.stop();
      for (const t of timers) clearInterval(t);
      if (annRetry) clearTimeout(annRetry);
    },
    status() {
      return { lastRuns: last, nextMonthly: jobs[0]?.nextRun()?.toISOString(), nextWeekly: jobs[1]?.nextRun()?.toISOString() };
    },
  };
}
