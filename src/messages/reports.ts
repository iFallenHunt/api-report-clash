import { DateTime } from 'luxon';
import { displayDateTime, displayStatus, eventWindow, formatMonthName, formatWhen, humanDuration, PHASE_NOTE, type DisplayStatus } from '../domain/dates.js';
import { REWARD_CATEGORIES } from '../domain/types.js';
import type { ClashEvent } from '../domain/types.js';
import { FOOTER_TZ, bold, compactLine, eventSummaryLine, isMinorCategory, joinBlocks, sourcesBlock } from './format.js';

export interface ReportContext {
  tz: string;
  now: Date;
  /** Última verificação bem-sucedida da fonte de anúncios (null = nunca / indisponível). */
  announcementsCheckedAt: string | null;
  /** true quando a última tentativa de coleta falhou. */
  announcementsUnavailable: boolean;
}

function within(ev: ClashEvent, fromMs: number, toMs: number, tz: string): boolean {
  const { start: s, end: e } = eventWindow(ev, tz);
  if (s !== null && s >= fromMs && s < toMs) return true;
  if (e !== null && e > fromMs && e <= toMs) return true;
  if (s !== null && e !== null && s < fromMs && e > toMs) return true;
  return false;
}

function statusOf(ev: ClashEvent, now: Date, tz: string): DisplayStatus {
  return displayStatus(ev, now, tz);
}

/** Nota explícita quando algum evento listado tem recompensas que ainda dependem de revisão manual. */
function rewardsReviewNote(listed: ClashEvent[]): string | null {
  const pending = listed.some((e) => e.scope === 'global' && REWARD_CATEGORIES.has(e.category) && e.rewardsStatus !== 'not_announced' && !e.rewards.some((r) => r.kind !== 'shop'));
  return pending ? '🎁 Recompensas marcadas como "não verificadas" ainda dependem de revisão manual; confira na fonte oficial.' : null;
}

function coverageNote(ctx: ReportContext): string[] {
  const lines: string[] = [];
  if (ctx.announcementsUnavailable) {
    lines.push('⚠️ A fonte oficial de anúncios não pôde ser consultada na última verificação. Este relatório pode estar incompleto.');
  } else if (ctx.announcementsCheckedAt) {
    const dt = DateTime.fromISO(ctx.announcementsCheckedAt).setZone(ctx.tz).setLocale('pt-BR');
    lines.push(`ℹ️ Anúncios oficiais verificados em ${dt.toFormat("dd/LL 'às' HH:mm")}.`);
  } else {
    lines.push('⚠️ Nenhuma verificação de anúncios oficiais registrada ainda.');
  }
  return lines;
}

/** Relatório mensal: eventos confirmados para o mês (ordem cronológica) + anúncios sem data. */
export function buildMonthlyReport(events: ClashEvent[], yearMonth: string, ctx: ReportContext): string {
  const monthStart = DateTime.fromISO(`${yearMonth}-01`, { zone: ctx.tz });
  const monthEnd = monthStart.plus({ months: 1 });
  const from = monthStart.toMillis();
  const to = monthEnd.toMillis();
  const st = (e: ClashEvent) => statusOf(e, ctx.now, ctx.tz);

  const live = events.filter((e) => st(e) !== 'cancelled');
  const inMonthAll = live.filter((e) => within(e, from, to, ctx.tz)).sort(byStart);
  const main = inMonthAll.filter((e) => !isMinorCategory(e));
  const others = inMonthAll.filter((e) => e.category === 'other');
  const cosmetics = inMonthAll.filter((e) => e.category === 'cosmetic');
  const undated = live.filter((e) => e.scope === 'global' && !e.startAt && st(e) !== 'ended');
  const cancelled = events.filter((e) => e.status === 'cancelled' && within(e, from, to, ctx.tz));

  const blocks: (string | string[] | null)[] = [];
  blocks.push(`📆 ${bold(`CALENDÁRIO DE ${formatMonthName(yearMonth, ctx.tz).toUpperCase()}`)}`);
  const hasAny = main.length + others.length + cosmetics.length + undated.length + cancelled.length > 0;
  if (!hasAny) blocks.push('Nenhum evento com data confirmada para este mês até agora.');
  if (main.length) {
    blocks.push(bold('Eventos confirmados'));
    for (const ev of main) blocks.push(eventSummaryLine(ev, ctx.tz, { now: ctx.now }));
  }
  if (others.length) blocks.push([bold('🧩 Também no mês (ajustes, baús e ofertas)'), ...others.map((ev) => compactLine(ev, ctx.tz))]);
  if (cosmetics.length) blocks.push([bold('🎨 Cosméticos e ofertas na loja'), ...cosmetics.map((ev) => compactLine(ev, ctx.tz))]);
  if (undated.length) blocks.push([bold('📣 Anunciados, ainda sem data confirmada'), ...undated.map((ev) => `• ${ev.title}`)]);
  if (cancelled.length) blocks.push([bold('❌ Cancelados'), ...cancelled.map((ev) => `• ~${ev.title}~`)]);
  blocks.push(
    [
      '📌 Calendário parcial: a Supercell divulga eventos ao longo do mês. Novidades relevantes serão avisadas separadamente.',
      rewardsReviewNote(main),
      ...coverageNote(ctx),
    ].filter((l): l is string => !!l),
  );
  blocks.push(sourcesBlock([...inMonthAll, ...undated]));
  blocks.push(FOOTER_TZ);
  return joinBlocks(blocks);
}

/** Relatório semanal: em andamento, começam em 7 dias, encerramentos próximos. Seções vazias são omitidas. */
export function buildWeeklyReport(events: ClashEvent[], ctx: ReportContext): string {
  const nowMs = ctx.now.getTime();
  const weekEnd = nowMs + 7 * 24 * 3600_000;
  const st = (e: ClashEvent) => statusOf(e, ctx.now, ctx.tz);
  const startsInWeek = (e: ClashEvent) => st(e) === 'scheduled' && (eventWindow(e, ctx.tz).start ?? Infinity) < weekEnd;
  const liveAll = events.filter((e) => st(e) !== 'cancelled' && st(e) !== 'ended');
  const inWeek = (e: ClashEvent) => st(e) !== 'announced' && (st(e) !== 'scheduled' || startsInWeek(e));
  const main = liveAll.filter((e) => !isMinorCategory(e));

  // "Em andamento" só com início confirmado no passado e término que não é hoje sem horário.
  const active = main.filter((e) => st(e) === 'active').sort(byEnd);
  const startingToday = main.filter((e) => st(e) === 'starts_today_unknown_time' || st(e) === 'today_unknown_time').sort(byStart);
  const starting = main.filter(startsInWeek).sort(byStart);
  const endingToday = main.filter((e) => st(e) === 'ends_today_unknown_time');
  const ending = active.filter((e) => (eventWindow(e, ctx.tz).end ?? Infinity) < weekEnd);
  const announced = main.filter((e) => st(e) === 'announced' && e.scope === 'global');
  const others = liveAll.filter((e) => e.category === 'other' && inWeek(e)).sort(byEnd);
  const cosmetics = liveAll.filter((e) => e.category === 'cosmetic' && inWeek(e)).sort(byEnd);

  const dt = DateTime.fromMillis(nowMs).setZone(ctx.tz).setLocale('pt-BR');
  const blocks: (string | string[] | null)[] = [];
  blocks.push(`📋 ${bold(`RESUMO DA SEMANA`)} · ${dt.toFormat("dd/LL")} a ${dt.plus({ days: 7 }).toFormat('dd/LL')}`);

  const sections = active.length + startingToday.length + starting.length + endingToday.length + ending.length + announced.length + others.length + cosmetics.length;
  if (!sections) blocks.push('Nenhum evento confirmado para esta semana até agora.');

  if (active.length) {
    blocks.push(bold('▶️ Em andamento'));
    for (const ev of active) blocks.push(eventSummaryLine(ev, ctx.tz, { now: ctx.now }));
  }
  if (startingToday.length || starting.length) {
    blocks.push(bold('🔜 Começam nos próximos 7 dias'));
    for (const ev of [...startingToday, ...starting]) blocks.push(eventSummaryLine(ev, ctx.tz, { now: ctx.now }));
  }
  if (endingToday.length || ending.length) {
    const lines = [bold('⏰ Encerram nesta semana')];
    for (const ev of endingToday) lines.push(`• ${ev.title} — ${PHASE_NOTE.ends_today_unknown_time}`);
    for (const ev of ending) {
      const end = ev.endPrecision === 'date' && ev.endAt ? `${displayDateTime(ev.endAt, 'date', ctx.tz).toFormat('ccc, dd/LL')} (horário não informado)` : formatWhen(ev.endAt, ev.endPrecision, ctx.tz);
      const left = ev.endAt && ev.endPrecision === 'datetime' ? humanDuration(DateTime.fromISO(ev.endAt).toMillis() - nowMs) : null;
      lines.push(`• ${ev.title} — ${end}${left ? ` (faltam ${left})` : ''}`);
    }
    blocks.push(lines);
  }
  if (others.length) blocks.push([bold('🧩 Também nesta semana (ajustes, baús e ofertas)'), ...others.map((ev) => compactLine(ev, ctx.tz))]);
  if (cosmetics.length) blocks.push([bold('🎨 Cosméticos e ofertas na loja'), ...cosmetics.map((ev) => compactLine(ev, ctx.tz))]);
  if (announced.length) blocks.push([bold('📣 Anunciados sem data confirmada'), ...announced.map((ev) => `• ${ev.title}`)]);
  blocks.push([rewardsReviewNote([...active, ...startingToday, ...starting, ...endingToday]), ...coverageNote(ctx)].filter((l): l is string => !!l));
  blocks.push(sourcesBlock([...active, ...startingToday, ...starting, ...endingToday, ...others, ...cosmetics, ...announced]));
  blocks.push(FOOTER_TZ);
  return joinBlocks(blocks);
}

export interface MonthlyDiff {
  added: ClashEvent[];
  changed: { event: ClashEvent; fields: string[] }[];
  cancelled: ClashEvent[];
}

/** Atualização do calendário: só o que mudou desde o último relatório mensal. */
export function buildMonthlyUpdate(diff: MonthlyDiff, yearMonth: string, ctx: ReportContext): string | null {
  if (!diff.added.length && !diff.changed.length && !diff.cancelled.length) return null;
  const blocks: (string | string[])[] = [];
  blocks.push(`🔄 ${bold(`ATUALIZAÇÃO DO CALENDÁRIO · ${formatMonthName(yearMonth, ctx.tz)}`)}`);
  if (diff.added.length) {
    blocks.push(bold('Novos'));
    for (const ev of diff.added) blocks.push(eventSummaryLine(ev, ctx.tz));
  }
  if (diff.changed.length) {
    blocks.push(bold('Alterados'));
    for (const c of diff.changed) blocks.push([`• ${bold(c.event.title)} — mudou: ${c.fields.map(fieldLabel).join(', ')}`, ...eventSummaryLine(c.event, ctx.tz).slice(1)]);
  }
  if (diff.cancelled.length) {
    blocks.push(bold('Cancelados'));
    for (const ev of diff.cancelled) blocks.push(`• ~${ev.title}~`);
  }
  blocks.push(FOOTER_TZ);
  return joinBlocks(blocks);
}

export function fieldLabel(f: string): string {
  switch (f) {
    case 'startAt': case 'startPrecision': return 'início';
    case 'endAt': case 'endPrecision': return 'término';
    case 'rewards': case 'rewardsStatus': return 'recompensas';
    case 'title': return 'nome';
    case 'status': return 'estado';
    case 'category': return 'categoria';
    default: return f;
  }
}

function byStart(a: ClashEvent, b: ClashEvent) {
  return (a.startAt ?? '9999').localeCompare(b.startAt ?? '9999') || a.title.localeCompare(b.title);
}
function byEnd(a: ClashEvent, b: ClashEvent) {
  return (a.endAt ?? '9999').localeCompare(b.endAt ?? '9999') || a.title.localeCompare(b.title);
}
