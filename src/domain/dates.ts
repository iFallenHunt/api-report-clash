import { DateTime, Duration } from 'luxon';
import type { ClashEvent, DatePrecision, EventStatus } from './types.js';

export const DEFAULT_TZ = 'America/Sao_Paulo';

export function nowIso(): string {
  return new Date().toISOString();
}

export function toUtcIso(dt: DateTime): string {
  return dt.toUTC().toISO({ suppressMilliseconds: true }) ?? dt.toUTC().toString();
}

export function isDateOnly(iso: string): boolean {
  return iso.length === 10;
}

/**
 * Instante de exibição: datetime → converte de UTC para o fuso; só dia → o próprio dia no fuso
 * (uma data sem horário nunca "muda de dia" por causa do fuso).
 */
export function displayDateTime(iso: string, precision: DatePrecision, tz = DEFAULT_TZ): DateTime {
  if (precision === 'date' || isDateOnly(iso)) return DateTime.fromISO(iso.slice(0, 10), { zone: tz }).setLocale('pt-BR');
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).setLocale('pt-BR');
}

/** Formata data/hora para exibição no fuso configurado, respeitando a precisão. */
export function formatWhen(iso: string | null, precision: DatePrecision, tz = DEFAULT_TZ): string | null {
  if (!iso || precision === 'unknown') return null;
  const dt = displayDateTime(iso, precision, tz);
  if (!dt.isValid) return null;
  if (precision === 'date') {
    // Sem horário confirmado: exibe apenas o dia, sem inventar hora.
    return `${dt.toFormat("ccc, dd 'de' LLL")} (horário não informado)`;
  }
  return dt.toFormat("ccc, dd 'de' LLL 'às' HH:mm");
}

/** Janela [início, fim) do evento em milissegundos para inclusão em relatórios, no fuso de exibição. */
export function eventWindow(ev: Pick<ClashEvent, 'startAt' | 'startPrecision' | 'endAt' | 'endPrecision'>, tz = DEFAULT_TZ): { start: number | null; end: number | null } {
  const start = ev.startAt && ev.startPrecision !== 'unknown' ? displayDateTime(ev.startAt, ev.startPrecision, tz).startOf(ev.startPrecision === 'date' ? 'day' : 'minute').toMillis() : null;
  const end = ev.endAt && ev.endPrecision !== 'unknown' ? (ev.endPrecision === 'date' ? displayDateTime(ev.endAt, 'date', tz).endOf('day').toMillis() + 1 : DateTime.fromISO(ev.endAt).toMillis()) : null;
  return { start, end };
}

export function formatDay(iso: string, tz = DEFAULT_TZ): string {
  return displayDateTime(iso, isDateOnly(iso) ? 'date' : 'datetime', tz).toFormat("dd 'de' LLL");
}

export function formatMonthName(yearMonth: string, tz = DEFAULT_TZ): string {
  const dt = DateTime.fromISO(`${yearMonth}-01`, { zone: tz }).setLocale('pt-BR');
  const name = dt.toFormat('LLLL');
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} de ${dt.toFormat('yyyy')}`;
}

export function humanDuration(ms: number): string {
  if (ms <= 0) return '0 minutos';
  const d = Duration.fromMillis(ms).shiftTo('days', 'hours', 'minutes').toObject();
  const parts: string[] = [];
  const days = Math.floor(d.days ?? 0);
  const hours = Math.floor(d.hours ?? 0);
  const minutes = Math.floor(d.minutes ?? 0);
  if (days) parts.push(`${days} ${days === 1 ? 'dia' : 'dias'}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hora' : 'horas'}`);
  if (!days && minutes) parts.push(`${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`);
  return parts.join(' e ') || 'menos de 1 minuto';
}

/**
 * Duração calculada apenas com datas confirmadas.
 * - datetime + datetime: duração exata.
 * - date + date: apenas em dias (inclusivo), sem inventar horário.
 * - qualquer ponta unknown, ou mistura date/datetime: null.
 */
export function durationText(ev: Pick<ClashEvent, 'startAt' | 'startPrecision' | 'endAt' | 'endPrecision'>): string | null {
  if (!ev.startAt || !ev.endAt) return null;
  if (ev.startPrecision === 'unknown' || ev.endPrecision === 'unknown') return null;
  const s = DateTime.fromISO(ev.startAt, { zone: 'utc' });
  const e = DateTime.fromISO(ev.endAt, { zone: 'utc' });
  if (!s.isValid || !e.isValid || e < s) return null;
  if (ev.startPrecision === 'datetime' && ev.endPrecision === 'datetime') {
    return humanDuration(e.toMillis() - s.toMillis());
  }
  // Só datas (sem horário): contar dias do calendário não é duração transcorrida; a duração é omitida.
  // Se a própria fonte declarar a duração, ela é exibida à parte (declaredDurationText).
  return null;
}

/** Duração declarada pela própria fonte (ex.: "por cinco dias"), guardada em extra.declaredDuration. */
export function declaredDurationText(ev: Pick<ClashEvent, 'extra'>): string | null {
  const d = ev.extra?.declaredDuration as { value?: string } | undefined;
  return d?.value ? `${d.value} (duração informada pela fonte)` : null;
}

/**
 * Estado para EXIBIÇÃO, sem afirmar mais do que a fonte diz:
 * - datas só com o dia são comparadas com o dia de hoje no fuso de exibição;
 * - no dia do início/término sem horário conhecido, o estado é "previsto para hoje", não "em andamento"/"encerrado".
 */
export type DisplayStatus = EventStatus | 'starts_today_unknown_time' | 'ends_today_unknown_time' | 'today_unknown_time';

export function displayStatus(
  ev: Pick<ClashEvent, 'startAt' | 'startPrecision' | 'endAt' | 'endPrecision' | 'status'>,
  now: Date = new Date(),
  tz = DEFAULT_TZ,
): DisplayStatus {
  if (ev.status === 'cancelled') return 'cancelled';
  const nowMs = now.getTime();
  const today = DateTime.fromMillis(nowMs, { zone: tz }).toISODate()!;
  const startDay = ev.startAt && ev.startPrecision === 'date' ? ev.startAt.slice(0, 10) : null;
  const endDay = ev.endAt && ev.endPrecision === 'date' ? ev.endAt.slice(0, 10) : null;

  // término
  let ended = false;
  let endsToday = false;
  if (endDay) {
    if (today > endDay) ended = true;
    else if (today === endDay) endsToday = true;
  } else if (ev.endAt && ev.endPrecision === 'datetime') {
    ended = nowMs >= DateTime.fromISO(ev.endAt).toMillis();
  }
  if (ended) return 'ended';

  // início
  let started = false;
  let startsToday = false;
  if (startDay) {
    if (today > startDay) started = true;
    else if (today === startDay) startsToday = true;
  } else if (ev.startAt && ev.startPrecision === 'datetime') {
    started = nowMs >= DateTime.fromISO(ev.startAt).toMillis();
  }
  if (startsToday && endsToday) return 'today_unknown_time';
  if (startsToday) return 'starts_today_unknown_time';
  if (endsToday) return started || !ev.startAt ? 'ends_today_unknown_time' : 'today_unknown_time';
  if (started) return 'active';
  if (ev.startAt && ev.startPrecision !== 'unknown') return 'scheduled';
  return 'announced';
}

export const PHASE_NOTE: Partial<Record<DisplayStatus, string>> = {
  starts_today_unknown_time: 'previsto para começar hoje; horário não informado',
  ends_today_unknown_time: 'previsto para encerrar hoje; horário não informado',
  today_unknown_time: 'previsto para hoje; horário não informado',
};

export function durationMs(ev: Pick<ClashEvent, 'startAt' | 'startPrecision' | 'endAt' | 'endPrecision'>): number | null {
  if (!ev.startAt || !ev.endAt || ev.startPrecision !== 'datetime' || ev.endPrecision !== 'datetime') return null;
  return DateTime.fromISO(ev.endAt).toMillis() - DateTime.fromISO(ev.startAt).toMillis();
}

/**
 * Estado derivado das datas confirmadas. Cancelado é sempre preservado.
 * Datas com precisão "date" consideram o dia inteiro (UTC) para início e término.
 */
export function computeStatus(
  ev: Pick<ClashEvent, 'startAt' | 'startPrecision' | 'endAt' | 'endPrecision' | 'status'>,
  now: Date = new Date(),
): EventStatus {
  if (ev.status === 'cancelled') return 'cancelled';
  const t = now.getTime();
  const start = boundary(ev.startAt, ev.startPrecision, 'start');
  const end = boundary(ev.endAt, ev.endPrecision, 'end');
  if (end !== null && t >= end) return 'ended';
  if (start !== null && t >= start) return 'active';
  if (start !== null) return 'scheduled';
  return 'announced';
}

function boundary(iso: string | null, precision: DatePrecision, side: 'start' | 'end'): number | null {
  if (!iso || precision === 'unknown') return null;
  const dt = DateTime.fromISO(iso, { zone: 'utc' });
  if (!dt.isValid) return null;
  if (precision === 'date') {
    return side === 'start' ? dt.startOf('day').toMillis() : dt.endOf('day').toMillis() + 1;
  }
  return dt.toMillis();
}

export function yearMonth(iso: string, tz = DEFAULT_TZ): string {
  if (isDateOnly(iso)) return iso.slice(0, 7);
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).toFormat('yyyy-LL');
}

export function isoWeekKey(iso: string, tz = DEFAULT_TZ): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).toFormat("kkkk-'W'WW");
}

export function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();
}
