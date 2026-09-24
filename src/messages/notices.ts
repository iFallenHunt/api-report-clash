import { DateTime } from 'luxon';
import { displayStatus, formatWhen, humanDuration, PHASE_NOTE } from '../domain/dates.js';
import { CATEGORY_LABEL, type ClashEvent } from '../domain/types.js';
import { FOOTER_TZ, bold, categoryEmoji, eventBlock, joinBlocks } from './format.js';
import { fieldLabel } from './reports.js';

export function noticeAnnounced(ev: ClashEvent, tz: string, now = new Date()): string {
  return joinBlocks([
    `📣 ${bold(`NOVO ANÚNCIO: ${ev.title}`)}`,
    `${CATEGORY_LABEL[ev.category]}. Anunciado pela Supercell; ${announcedPhase(ev, tz, now)}.`,
    eventBlock(ev, tz, { now }),
    FOOTER_TZ,
  ]);
}

function announcedPhase(ev: ClashEvent, tz: string, now: Date): string {
  const st = displayStatus(ev, now, tz);
  if (st === 'active') return 'já está em andamento';
  const note = PHASE_NOTE[st];
  if (note) return note;
  if (st === 'announced') return 'datas ainda não confirmadas';
  return 'ainda não começou';
}

export function noticeStarted(ev: ClashEvent, tz: string, now = new Date()): string {
  return joinBlocks([
    `${categoryEmoji(ev)} ${bold(`EVENTO INICIADO: ${ev.title}`)}`,
    eventBlock(ev, tz, { now }),
    FOOTER_TZ,
  ]);
}

export function noticeEnded(ev: ClashEvent, tz: string): string {
  return joinBlocks([
    `🏁 ${bold(`EVENTO ENCERRADO: ${ev.title}`)}`,
    eventBlock(ev, tz, { rewards: false }),
    FOOTER_TZ,
  ]);
}

export function noticeChanged(ev: ClashEvent, changedFields: string[], previous: Partial<Record<string, { from: unknown; to: unknown }>>, tz: string, now = new Date()): string {
  const labels = Array.from(new Set(changedFields.map(fieldLabel)));
  const lines: string[] = [];
  const s = previous.startAt;
  const e = previous.endAt;
  if (s) lines.push(`📅 Início: ${fmtPrev(s.from, ev.startPrecision, tz)} → ${formatWhen(ev.startAt, ev.startPrecision, tz) ?? 'não informado'}`);
  if (e) lines.push(`🏁 Término: ${fmtPrev(e.from, ev.endPrecision, tz)} → ${formatWhen(ev.endAt, ev.endPrecision, tz) ?? 'não informado'}`);
  return joinBlocks([
    `✏️ ${bold(`ALTERAÇÃO CONFIRMADA: ${ev.title}`)}`,
    `Mudou: ${labels.join(', ')}.`,
    lines.length ? lines : null,
    eventBlock(ev, tz, { now }),
    FOOTER_TZ,
  ]);
}

export function noticeCancelled(ev: ClashEvent, tz: string): string {
  const reason = typeof ev.extra.cancelReason === 'string' ? ev.extra.cancelReason : null;
  return joinBlocks([
    `❌ ${bold(`CANCELADO: ${ev.title}`)}`,
    reason ? `Motivo informado: ${reason}` : 'Cancelamento confirmado pela fonte.',
    eventBlock(ev, tz, { rewards: false }),
    FOOTER_TZ,
  ]);
}

export function noticeReminder(ev: ClashEvent, anchor: 'start' | 'end', tz: string, now = new Date()): string {
  const target = anchor === 'start' ? ev.startAt : ev.endAt;
  const left = target ? humanDuration(DateTime.fromISO(target).toMillis() - now.getTime()) : null;
  const title = anchor === 'start' ? `COMEÇA EM ${left ?? 'breve'}: ${ev.title}` : `TERMINA EM ${left ?? 'breve'}: ${ev.title}`;
  const hint =
    anchor === 'end' && ev.scope === 'global'
      ? 'Garanta as recompensas antes do encerramento.'
      : anchor === 'end'
        ? 'Últimos ataques!'
        : null;
  return joinBlocks([`⏰ ${bold(title)}`, hint, eventBlock(ev, tz, { now }), FOOTER_TZ]);
}

function fmtPrev(v: unknown, precision: ClashEvent['startPrecision'], tz: string): string {
  return typeof v === 'string' ? (formatWhen(v, precision, tz) ?? v) : 'não informado';
}
