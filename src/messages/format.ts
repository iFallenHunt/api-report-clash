import { DateTime } from 'luxon';
import { declaredDurationText, displayDateTime, displayStatus, durationText, formatWhen, humanDuration, PHASE_NOTE } from '../domain/dates.js';
import { rewardsLines } from '../domain/rewards.js';
import { CATEGORY_LABEL, REWARD_CATEGORIES, type ClashEvent } from '../domain/types.js';

export const FOOTER_TZ = '🕒 Horário de Brasília';

export function bold(s: string): string {
  return `*${s}*`;
}

export function categoryEmoji(ev: Pick<ClashEvent, 'category'>): string {
  switch (ev.category) {
    case 'season': return '🗓️';
    case 'medal_event': return '🏅';
    case 'clan_games': return '🎮';
    case 'challenge': return '🎯';
    case 'update': return '🛠️';
    case 'cwl': return '🏆';
    case 'war': return '⚔️';
    case 'raid_weekend': return '🏰';
    case 'cosmetic': return '🎨';
    default: return '🎉';
  }
}

/** Linhas de início/término/duração. Só inclui o que está confirmado. */
export function whenLines(ev: ClashEvent, tz: string, now = new Date()): string[] {
  const lines: string[] = [];
  const start = formatWhen(ev.startAt, ev.startPrecision, tz);
  const end = formatWhen(ev.endAt, ev.endPrecision, tz);
  if (start) lines.push(`📅 Início: ${start}`);
  if (end) lines.push(`🏁 Término: ${end}`);
  if (!start && !end) lines.push('📅 Datas ainda não confirmadas');
  else if (!end && ev.endPrecision === 'unknown') lines.push('🏁 Término: ainda não divulgado');
  const dur = durationText(ev) ?? declaredDurationText(ev);
  if (dur) lines.push(`⏳ Duração: ${dur}`);
  const note = PHASE_NOTE[displayStatus(ev, now, tz)];
  if (note) lines.push(`⚠️ ${note.charAt(0).toUpperCase()}${note.slice(1)}`);
  if (ev.status === 'active' && ev.endAt && ev.endPrecision === 'datetime') {
    const left = DateTime.fromISO(ev.endAt).toMillis() - now.getTime();
    if (left > 0) lines.push(`⌛ Termina em: ${humanDuration(left)}`);
  }
  return lines;
}

export function sourceLine(ev: Pick<ClashEvent, 'primarySourceUrl'>): string | null {
  return ev.primarySourceUrl ? `🔗 Fonte: ${ev.primarySourceUrl}` : null;
}

/** Bloco completo de um evento (para avisos individuais). */
export function eventBlock(ev: ClashEvent, tz: string, opts: { rewards?: boolean; now?: Date } = {}): string[] {
  const lines: string[] = [];
  lines.push(...whenLines(ev, tz, opts.now));
  if (opts.rewards !== false && ev.scope === 'global') {
    lines.push('');
    lines.push(...rewardsLines(ev.rewardsStatus, ev.rewards, ev.primarySourceUrl));
  }
  const src = sourceLine(ev);
  if (src) {
    lines.push('');
    lines.push(src);
  }
  return lines;
}

function normText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Título em negrito + categoria, omitindo a categoria quando o título já a contém ("Jogos do Clã · Jogos do Clã"). */
export function headline(ev: Pick<ClashEvent, 'title' | 'category'>): string {
  const label = CATEGORY_LABEL[ev.category];
  const t = normText(ev.title);
  const l = normText(label);
  const firstWord = l.split(' ')[0] ?? l;
  const redundant = t.includes(l) || l.includes(t) || (firstWord.length > 3 && t.startsWith(firstWord));
  return redundant ? bold(ev.title) : `${bold(ev.title)} · ${label}`;
}

/** Bloco curto de um evento em listas (relatórios). O link fica no rodapé "Fontes" do relatório. */
export function eventSummaryLine(ev: ClashEvent, tz: string, opts: { link?: boolean; now?: Date } = {}): string[] {
  const out: string[] = [];
  out.push(`${categoryEmoji(ev)} ${headline(ev)}`);
  if (ev.startPrecision === 'date' && ev.endPrecision === 'date' && ev.startAt && ev.endAt) {
    // Datas só com o dia: formato curto, deixando claro que não há horário divulgado.
    const s = displayDateTime(ev.startAt, 'date', tz).toFormat('ccc, dd/LL');
    const e = displayDateTime(ev.endAt, 'date', tz).toFormat('ccc, dd/LL');
    out.push(`   📅 ${s === e ? s : `${s} a ${e}`} · horário não divulgado`);
  } else {
    const start = formatWhen(ev.startAt, ev.startPrecision, tz);
    const end = formatWhen(ev.endAt, ev.endPrecision, tz);
    if (start && end) out.push(`   📅 ${start} → ${end}`);
    else if (start) out.push(`   📅 Início: ${start}${ev.endPrecision === 'unknown' ? ' · término não divulgado' : ''}`);
    else if (end) out.push(`   🏁 Término: ${end}`);
    else out.push('   📅 Datas ainda não confirmadas');
  }
  const dur = durationText(ev) ?? declaredDurationText(ev);
  if (dur) out.push(`   ⏳ ${dur}`);
  const note = opts.now ? PHASE_NOTE[displayStatus(ev, opts.now, tz)] : undefined;
  if (note) out.push(`   ⚠️ ${note}`);
  // Linha de prêmios só para categorias com recompensas a conquistar (temporada, medalhas, desafios, Jogos do Clã).
  if (ev.scope === 'global' && REWARD_CATEGORIES.has(ev.category)) out.push(`   ${rewardsSummary(ev)}`);
  if (opts.link && ev.primarySourceUrl) out.push(`   🔗 ${ev.primarySourceUrl}`);
  return out;
}

/** Itens de menor destaque (ajustes, ofertas, cosméticos): listados de forma compacta nos relatórios. */
export function isMinorCategory(ev: Pick<ClashEvent, 'category'>): boolean {
  return ev.category === 'other' || ev.category === 'cosmetic';
}

/** Rodapé com as fontes oficiais distintas citadas no relatório. */
export function sourcesBlock(events: Pick<ClashEvent, 'primarySourceUrl'>[]): string[] | null {
  const urls = Array.from(new Set(events.map((e) => e.primarySourceUrl).filter((u): u is string => !!u)));
  if (!urls.length) return null;
  return [urls.length === 1 ? '🔗 Fonte oficial:' : '🔗 Fontes oficiais:', ...urls];
}

/** Resumo de uma linha das recompensas, sem misturar itens de loja com prêmios. */
export function rewardsSummary(ev: Pick<ClashEvent, 'rewardsStatus' | 'rewards'>): string {
  if (ev.rewardsStatus === 'not_announced') return '🎁 Recompensas ainda não divulgadas';
  const prizes = ev.rewards.filter((r) => r.kind !== 'shop');
  const shop = ev.rewards.filter((r) => r.kind === 'shop');
  const parts: string[] = [];
  if (ev.rewardsStatus === 'known' && prizes.length) {
    const shown = prizes.filter((r) => r.tier !== 'paid').slice(0, 3).map((r) => (r.quantity !== undefined ? `${r.quantity}x ${r.label}` : r.label));
    const more = prizes.filter((r) => r.tier !== 'paid').length > 3 ? '…' : '';
    parts.push(shown.length ? `🎁 ${shown.join(', ')}${more}` : '🎁 só itens pagos informados');
    if (prizes.some((r) => r.tier === 'paid')) parts.push('💳 há itens pagos');
  } else {
    parts.push('🎁 Recompensas não verificadas (veja a fonte)');
  }
  if (ev.rewardsStatus === 'known' && shop.length) parts.push(`🛒 loja com ${shop.length} itens`);
  return parts.join(' · ');
}

/** Linha compacta para cosméticos/ofertas: "• Nome (dd/LL a dd/LL)". */
export function compactLine(ev: ClashEvent, tz: string): string {
  const s = ev.startAt && ev.startPrecision !== 'unknown' ? displayDateTime(ev.startAt, ev.startPrecision, tz).toFormat('dd/LL') : null;
  const e = ev.endAt && ev.endPrecision !== 'unknown' ? displayDateTime(ev.endAt, ev.endPrecision, tz).toFormat('dd/LL') : null;
  const when = s && e ? (s === e ? s : `${s} a ${e}`) : s ? `a partir de ${s}` : e ? `até ${e}` : 'datas não confirmadas';
  const declared = (ev.extra?.declaredDuration as { value?: string } | undefined)?.value;
  return `• ${ev.title} (${when}${declared ? ` · ${declared}, segundo a fonte` : ''})`;
}

export function joinBlocks(blocks: (string | string[] | null | undefined)[]): string {
  return blocks
    .filter((b): b is string | string[] => b !== null && b !== undefined)
    .map((b) => (Array.isArray(b) ? b.join('\n') : b))
    .filter((b) => b.trim().length > 0)
    .join('\n\n');
}
