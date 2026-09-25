import { Cron } from 'croner';
import { DateTime } from 'luxon';
import type { ApplyResult, CalendarRepo } from '../calendar/repo.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { addHours, computeStatus, durationMs, nowIso, yearMonth } from '../domain/dates.js';
import type { ClashEvent } from '../domain/types.js';
import type { Logger } from '../logger.js';
import { noticeAnnounced, noticeCancelled, noticeChanged, noticeReminder, noticeStarted } from '../messages/notices.js';
import { buildMonthlyReport, buildMonthlyUpdate, buildWeeklyReport, type MonthlyDiff, type ReportContext } from '../messages/reports.js';
import type { Outbox } from '../outbox/queue.js';

export interface EngineDeps {
  db: Db;
  repo: CalendarRepo;
  outbox: Outbox;
  cfg: AppConfig;
  log: Logger;
  /** Estado da fonte de anúncios para o rodapé dos relatórios. */
  announcementsHealth: () => { lastOkAt: string | null; lastFailed: boolean };
}

const DATE_FIELDS = ['startAt', 'startPrecision', 'endAt', 'endPrecision'] as const;
const REMINDER_KINDS = ['reminder', 'event_started'];

/**
 * Regras de negócio de notificação: transforma alterações no calendário e a passagem do tempo
 * em itens na fila de saída, com chaves de deduplicação estáveis:
 *   event_announced:<id>            (uma vez por evento)
 *   event_started:<id>              (uma vez por ocorrência; correções de texto não repetem)
 *   event_changed:<id>:r<revisão>   (uma vez por revisão relevante)
 *   event_cancelled:<id>
 *   reminder:<id>:<start|end>:<horas>
 *   report:monthly:<AAAA-MM> / report:weekly:<AAAA-Wnn> / report:monthly_update:<AAAA-MM>:<AAAA-MM-DD>
 */
export class Engine {
  constructor(private readonly d: EngineDeps) {}

  private get tz() {
    return this.d.cfg.tzDisplay;
  }

  private ctx(now: string): ReportContext {
    const h = this.d.announcementsHealth();
    return { tz: this.tz, now: new Date(now), announcementsCheckedAt: h.lastOkAt, announcementsUnavailable: h.lastFailed };
  }

  private noticeExpiry(now: string) {
    return addHours(now, this.d.cfg.delivery.noticeTtlHours);
  }

  // ---------- Reações a alterações ----------

  onEventApplied(res: ApplyResult, now = nowIso()) {
    const ev = res.event;
    if (ev.scope !== 'global') return; // eventos do clã têm avisos próprios no coletor do clã
    const { outbox } = this.d;

    if (res.created) {
      if (ev.status === 'ended' || ev.status === 'cancelled') return;
      // Publicação antiga (primeira coleta, reinício após longa parada): não é notícia, não anuncia.
      const pubAt = typeof ev.extra.publishedAt === 'string' ? new Date(ev.extra.publishedAt).getTime() : null;
      if (pubAt !== null && new Date(now).getTime() - pubAt > this.d.cfg.delivery.noticeTtlHours * 3600_000) return;
      outbox.enqueue({ dedupKey: `event_announced:${ev.id}`, kind: 'event_announced', eventId: ev.id, body: noticeAnnounced(ev, this.tz, new Date(now)), expiresAt: this.noticeExpiry(now) }, now);
      if (ev.status === 'active') {
        // já começou ao ser anunciado: o aviso de anúncio diz isso; consome a chave de "iniciado"
        this.d.db.run(
          `INSERT OR IGNORE INTO outbox (mode, dedup_key, kind, event_id, body, fire_at, expires_at, status, last_error, created_at)
           VALUES (?, ?, 'event_started', ?, '', ?, ?, 'superseded', 'anúncio já informou o início', ?)`,
          outbox.mode, `event_started:${ev.id}`, ev.id, now, now, now,
        );
      }
      return;
    }

    const changed = Object.keys(res.changes);
    if (!changed.length) return;
    const datesChanged = DATE_FIELDS.some((f) => f in res.changes);
    const statusChange = res.changes.status;

    if (statusChange?.to === 'cancelled') {
      outbox.supersedePending(ev.id);
      outbox.enqueue({ dedupKey: `event_cancelled:${ev.id}`, kind: 'event_cancelled', eventId: ev.id, body: noticeCancelled(ev, this.tz), expiresAt: this.noticeExpiry(now) }, now);
      return;
    }
    if (datesChanged) {
      // lembretes e aviso de início pendentes ficaram desatualizados
      outbox.supersedePending(ev.id, REMINDER_KINDS);
      if (ev.status !== 'ended') {
        outbox.enqueue({ dedupKey: `event_changed:${ev.id}:r${ev.relevantRevision}`, kind: 'event_changed', eventId: ev.id, body: noticeChanged(ev, changed, res.changes, this.tz, new Date(now)), expiresAt: this.noticeExpiry(now) }, now);
      }
    } else if (changed.some((f) => f === 'rewards' || f === 'rewardsStatus' || f === 'title')) {
      if (ev.status !== 'ended') {
        outbox.enqueue({ dedupKey: `event_updated:${ev.id}:r${ev.relevantRevision}`, kind: 'event_updated', eventId: ev.id, body: noticeChanged(ev, changed, res.changes, this.tz, new Date(now)), expiresAt: this.noticeExpiry(now) }, now);
      }
    }
    if (statusChange?.to === 'active' && (statusChange.from === 'scheduled' || statusChange.from === 'announced')) {
      this.enqueueStarted(ev, now);
    }
  }

  private enqueueStarted(ev: ClashEvent, now: string) {
    // Sem horário de início confirmado não há como afirmar que começou: o semanal diz "previsto para hoje".
    if (!ev.startAt || ev.startPrecision !== 'datetime') return;
    // Só avisa início se ainda for atual: nada de despejar avisos antigos após indisponibilidade.
    const ageMs = new Date(now).getTime() - new Date(ev.startAt).getTime();
    if (ageMs > this.d.cfg.delivery.noticeTtlHours * 3600_000) return;
    this.d.outbox.enqueue({ dedupKey: `event_started:${ev.id}`, kind: 'event_started', eventId: ev.id, body: noticeStarted(ev, this.tz, new Date(now)), expiresAt: this.noticeExpiry(now) }, now);
  }

  // ---------- Passagem do tempo ----------

  /** Executado a cada minuto: transições de estado e lembretes. */
  tick(now = nowIso()) {
    for (const ev of this.d.repo.listEvents({ scope: 'global' })) {
      const { event, changed } = this.d.repo.refreshStatus(ev, now);
      if (changed && event.status === 'active') this.enqueueStarted(event, now);
      if (changed && event.status === 'ended') this.d.outbox.supersedePending(event.id, REMINDER_KINDS);
      if (event.status === 'scheduled' || event.status === 'active') this.scheduleReminders(event, now);
    }
  }

  /**
   * Lembretes por âncora (início/término) e antecedência configurada.
   * Regras anti-redundância: evento curto (duração < 2× antecedência) não recebe lembrete;
   * lembrete de início exige que o evento tenha sido conhecido antes do ponto de disparo;
   * lembrete a ±1h do relatório semanal é suprimido (o relatório já cobre).
   */
  scheduleReminders(ev: ClashEvent, now = nowIso()) {
    const leadH = this.d.cfg.reminders.leadGlobalHours;
    const leadMs = leadH * 3600_000;
    const nowMs = new Date(now).getTime();
    const dur = durationMs(ev);
    if (dur !== null && dur < 2 * leadMs) return;
    for (const anchor of this.d.cfg.reminders.anchors) {
      const target = anchor === 'start' ? ev.startAt : ev.endAt;
      const precision = anchor === 'start' ? ev.startPrecision : ev.endPrecision;
      if (!target || precision !== 'datetime') continue;
      const targetMs = new Date(target).getTime();
      const fireMs = targetMs - leadMs;
      if (nowMs < fireMs || nowMs >= targetMs) continue;
      if (anchor === 'start' && new Date(ev.firstSeenAt).getTime() > fireMs) continue;
      if (anchor === 'start' && computeStatus(ev, new Date(now)) !== 'scheduled') continue;
      if (this.nearWeeklyReport(nowMs)) continue;
      this.d.outbox.enqueue(
        { dedupKey: `reminder:${ev.id}:${anchor}:${leadH}`, kind: 'reminder', eventId: ev.id, body: noticeReminder(ev, anchor, this.tz, new Date(now)), expiresAt: new Date(targetMs).toISOString() },
        now,
      );
    }
  }

  nearWeeklyReport(nowMs: number): boolean {
    try {
      const c = new Cron(this.d.cfg.schedule.weeklyCron, { timezone: this.tz });
      const next = c.nextRun(new Date(nowMs))?.getTime();
      const prev = c.previousRuns(1, new Date(nowMs))[0]?.getTime();
      const hour = 3600_000;
      return (next !== undefined && next - nowMs <= hour) || (prev !== undefined && nowMs - prev <= hour);
    } catch {
      return false;
    }
  }

  // ---------- Relatórios ----------

  reportKey(kind: 'monthly' | 'weekly', now: string): string {
    const dt = DateTime.fromISO(now, { zone: 'utc' }).setZone(this.tz);
    return kind === 'monthly' ? `report:monthly:${dt.toFormat('yyyy-LL')}` : `report:weekly:${dt.toFormat("kkkk-'W'WW")}`;
  }

  buildReport(kind: 'monthly' | 'weekly', now = nowIso()): string {
    const events = this.d.repo.allEvents();
    if (kind === 'monthly') return buildMonthlyReport(events, yearMonth(now, this.tz), this.ctx(now));
    return buildWeeklyReport(events, this.ctx(now));
  }

  /** Marca do relatório do período no modo da fila, se já foi gerado. */
  reportMark(kind: 'monthly' | 'weekly', now = nowIso()): { generatedAt: string } | undefined {
    const r = this.d.db.get<{ generated_at: string }>('SELECT generated_at FROM report_marks WHERE mode = ? AND key = ?', this.d.outbox.mode, this.reportKey(kind, now));
    return r ? { generatedAt: r.generated_at } : undefined;
  }

  reportExpiry(now = nowIso()): string {
    return addHours(now, this.d.cfg.delivery.reportTtlHours);
  }

  /** Gera e enfileira o relatório se ainda não foi gerado neste período (por modo). */
  runReport(kind: 'monthly' | 'weekly', now = nowIso()): boolean {
    const key = this.reportKey(kind, now);
    const mode = this.d.outbox.mode;
    if (this.reportMark(kind, now)) return false;
    const body = this.buildReport(kind, now);
    const snapshot = kind === 'monthly' ? this.monthSnapshot(now) : {};
    this.d.db.transaction(() => {
      this.d.db.run('INSERT INTO report_marks (mode, key, generated_at, snapshot_json) VALUES (?, ?, ?, ?)', mode, key, now, JSON.stringify(snapshot));
      this.d.outbox.enqueue({ dedupKey: key, kind: `report_${kind}`, body, expiresAt: this.reportExpiry(now) }, now);
    });
    this.d.log.info({ kind, key, mode }, 'relatório gerado');
    return true;
  }

  /** Após reinício: gera relatório perdido só se a última execução prevista foi há menos de REPORT_CATCHUP_HOURS. */
  catchUp(now = nowIso()) {
    const nowDate = new Date(now);
    const limitMs = this.d.cfg.schedule.catchupHours * 3600_000;
    for (const [kind, expr] of [['monthly', this.d.cfg.schedule.monthlyCron], ['weekly', this.d.cfg.schedule.weeklyCron]] as const) {
      const prev = new Cron(expr, { timezone: this.tz }).previousRuns(1, nowDate)[0];
      if (!prev) continue;
      if (nowDate.getTime() - prev.getTime() <= limitMs) {
        const key = this.reportKey(kind, prev.toISOString());
        if (!this.d.db.get('SELECT 1 FROM report_marks WHERE mode = ? AND key = ?', this.d.outbox.mode, key)) {
          this.d.log.info({ kind, scheduledAt: prev.toISOString() }, 'relatório perdido dentro da janela de recuperação; gerando');
          this.runReport(kind, prev.toISOString());
        }
      }
    }
  }

  private monthSnapshot(now: string): Record<string, { rev: number; status: string }> {
    const ym = yearMonth(now, this.tz);
    const out: Record<string, { rev: number; status: string }> = {};
    for (const ev of this.d.repo.allEvents()) {
      if (ev.scope !== 'global') continue;
      if ((ev.startAt && yearMonth(ev.startAt, this.tz) === ym) || (ev.endAt && yearMonth(ev.endAt, this.tz) === ym) || !ev.startAt) {
        out[ev.id] = { rev: ev.relevantRevision, status: ev.status };
      }
    }
    return out;
  }

  /** Diferença entre o calendário atual e o snapshot do último relatório mensal. */
  monthlyDiff(now = nowIso()): { yearMonth: string; diff: MonthlyDiff } | null {
    const key = this.reportKey('monthly', now);
    const mark = this.d.db.get<{ snapshot_json: string }>('SELECT snapshot_json FROM report_marks WHERE mode = ? AND key = ?', this.d.outbox.mode, key);
    if (!mark) return null;
    const snap = JSON.parse(mark.snapshot_json) as Record<string, { rev: number; status: string }>;
    const current = this.monthSnapshot(now);
    const diff: MonthlyDiff = { added: [], changed: [], cancelled: [] };
    for (const id of Object.keys(current)) {
      const ev = this.d.repo.getEvent(id)!;
      const before = snap[id];
      if (!before) {
        if (ev.status !== 'cancelled') diff.added.push(ev);
        continue;
      }
      if (ev.status === 'cancelled' && before.status !== 'cancelled') {
        diff.cancelled.push(ev);
        continue;
      }
      if (ev.relevantRevision > before.rev) {
        const fields = new Set<string>();
        for (const v of this.d.repo.versions(id)) {
          if (v.revision > before.rev && v.origin !== 'scheduler') for (const f of Object.keys(JSON.parse(v.changes_json) as object)) fields.add(f);
        }
        if (fields.size) diff.changed.push({ event: ev, fields: Array.from(fields) });
      }
    }
    return { yearMonth: yearMonth(now, this.tz), diff };
  }

  /** Atualização mensal: no máximo uma por dia, só se algo mudou desde o mensal, e não no dia do mensal. */
  runMonthlyUpdate(now = nowIso()): boolean {
    const r = this.monthlyDiff(now);
    if (!r) return false;
    const body = buildMonthlyUpdate(r.diff, r.yearMonth, this.ctx(now));
    if (!body) return false;
    const day = DateTime.fromISO(now, { zone: 'utc' }).setZone(this.tz).toFormat('yyyy-LL-dd');
    if (day.endsWith('-01')) return false;
    const key = `report:monthly_update:${r.yearMonth}:${day}`;
    const enq = this.d.outbox.enqueue({ dedupKey: key, kind: 'report_monthly_update', body, expiresAt: addHours(now, this.d.cfg.delivery.reportTtlHours) }, now);
    if (enq) {
      // avança o snapshot para não repetir as mesmas mudanças amanhã
      this.d.db.run('UPDATE report_marks SET snapshot_json = ? WHERE mode = ? AND key = ?', JSON.stringify(this.monthSnapshot(now)), this.d.outbox.mode, this.reportKey('monthly', now));
    }
    return enq;
  }
}
