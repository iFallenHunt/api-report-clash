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
  pollAnnouncements: () => Promise<unknown>;
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

  const ann = guarded('announcements', d.log, async () => { await d.pollAnnouncements(); stamp('announcements')(); });
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
    },
    status() {
      return { lastRuns: last, nextMonthly: jobs[0]?.nextRun()?.toISOString(), nextWeekly: jobs[1]?.nextRun()?.toISOString() };
    },
  };
}
