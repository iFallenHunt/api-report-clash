import { DateTime } from 'luxon';
import { REWARD_CATEGORIES, type DatePrecision, type EventCategory, type EventInput, type Reward, type RewardTier } from '../../domain/types.js';
import type { Block, Publication } from './types.js';

/**
 * Extração determinística e conservadora de eventos a partir de uma publicação.
 * Só reconhece informação explícita e rotulada ("Início do evento: 9 de setembro, às 8h (UTC)")
 * e listas sob um título de recompensas. Tudo o mais fica como "não verificado" para revisão.
 */

export interface ExtractedEvent {
  segmentKey: string;
  input: EventInput;
  confirmedFields: string[];
  notes: string[]; // pendências para review_queue
  yearInferred: boolean;
}

const MONTHS_PT: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, março: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const MONTHS_EN: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const START_LABEL = /^(?:data\s+de\s+)?(?:in[ií]cio|come[çc]a|come[çc]o|start|starts|begins|start\s+date|event\s+start|event\s+starts)(?:\s+d[oa]\s+(?:evento|temporada|desafio))?\s*[:\-–]\s*(.+)$/i;
const END_LABEL = /^(?:data\s+de\s+)?(?:t[ée]rmino|termina|fim|encerramento|encerra|end|ends|finish|finishes|end\s+date|event\s+end|event\s+ends)(?:\s+d[oa]\s+(?:evento|temporada|desafio))?\s*[:\-–]\s*(.+)$/i;
const REWARD_HEADING = /recompensa|reward|pr[êe]mio|prize/i;
const EVENT_WORDS = /evento|event|temporada|season|desafio|challenge|jogos do cl[ãa]|clan games|medal|medalha/i;
const GENERIC_HEADING = /^(quando|when|vamos|let'?s|como|how|o que|what|detalhes|details|recursos|resources)\b/i;

export interface ParsedDate {
  iso: string;
  precision: DatePrecision;
  yearInferred: boolean;
  timeWithoutTz: boolean;
}

/** Interpreta uma expressão de data em PT ou EN. Sem ano explícito, usa o ano mais próximo da publicação. */
export function parseDateExpression(text: string, publishedAt: string | null, issues?: string[]): ParsedDate | null {
  const t = text.replace(/\s+/g, ' ').trim();
  let day: number | undefined, month: number | undefined, year: number | undefined, hour: number | undefined, minute = 0, tz: string | undefined;
  let pm: string | undefined;

  const pt = /(\d{1,2})[ºo°]?\s+de\s+([a-zç]+)(?:\s+de\s+(\d{4}))?(?:,?\s*(?:[àa]s|as)\s+(\d{1,2})(?:[:h](\d{2}))?h?)?\s*(?:\(?\s*(UTC|GMT)\s*\)?)?/i.exec(t);
  const en = /([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?(?:,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\s*(UTC|GMT)?/i.exec(t);
  const enDayFirst = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:,?\s*(\d{4}))?(?:,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\s*(UTC|GMT)?/i.exec(t);

  if (pt && MONTHS_PT[norm(pt[2]!)]) {
    day = Number(pt[1]); month = MONTHS_PT[norm(pt[2]!)]; year = pt[3] ? Number(pt[3]) : undefined;
    hour = pt[4] !== undefined ? Number(pt[4]) : undefined; minute = pt[5] ? Number(pt[5]) : 0; tz = pt[6];
  } else if (en && MONTHS_EN[norm(en[1]!)]) {
    month = MONTHS_EN[norm(en[1]!)]; day = Number(en[2]); year = en[3] ? Number(en[3]) : undefined;
    hour = en[4] !== undefined ? Number(en[4]) : undefined; minute = en[5] ? Number(en[5]) : 0; pm = en[6]; tz = en[7];
  } else if (enDayFirst && MONTHS_EN[norm(enDayFirst[2]!)]) {
    day = Number(enDayFirst[1]); month = MONTHS_EN[norm(enDayFirst[2]!)]; year = enDayFirst[3] ? Number(enDayFirst[3]) : undefined;
    hour = enDayFirst[4] !== undefined ? Number(enDayFirst[4]) : undefined; minute = enDayFirst[5] ? Number(enDayFirst[5]) : 0; pm = enDayFirst[6]; tz = enDayFirst[7];
  } else {
    return null;
  }
  if (!day || !month || day > 31) return null;
  if (pm && hour !== undefined) {
    if (pm.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (pm.toLowerCase() === 'am' && hour === 12) hour = 0;
  }
  // Sem horário explícito, o marcador UTC não significa nada e um "12" solto não é hora.
  let yearInferred = false;
  if (year === undefined) {
    if (!publishedAt) {
      issues?.push(`ano ausente e publicação sem data: "${t}"`);
      return null;
    }
    const inferred = inferYear(day, month, publishedAt);
    if (inferred === null) {
      issues?.push(`ano sem evidência suficiente (data fora da janela de ${YEAR_WINDOW_BEFORE_DAYS} dias antes / ${YEAR_WINDOW_AFTER_DAYS} dias depois da publicação): "${t}"`);
      return null;
    }
    yearInferred = true;
    year = inferred;
  }
  const hasTime = hour !== undefined && hour <= 23;
  const hasTz = !!tz;
  if (hasTime && hasTz) {
    const dt = DateTime.utc(year, month, day, hour as number, minute);
    if (!dt.isValid) return null;
    return { iso: dt.toISO({ suppressMilliseconds: true }), precision: 'datetime', yearInferred, timeWithoutTz: false };
  }
  const dt = DateTime.utc(year, month, day);
  if (!dt.isValid) return null;
  return { iso: dt.toISODate(), precision: 'date', yearInferred, timeWithoutTz: hasTime && !hasTz };
}

/**
 * Janela de plausibilidade para datas sem ano, relativa à data de publicação: anúncios citam o passado
 * recente (ex.: "a loja fica aberta até 24 de setembro") ou o futuro próximo. Fora dessa janela não há
 * evidência suficiente e a data fica pendente. A janela (90 + 200 dias) é menor que um ano, então no
 * máximo um candidato cabe nela.
 */
export const YEAR_WINDOW_BEFORE_DAYS = 90;
export const YEAR_WINDOW_AFTER_DAYS = 200;

export function inferYear(day: number, month: number, reference: string): number | null {
  const ref = DateTime.fromISO(reference, { zone: 'utc' }).startOf('day');
  if (!ref.isValid) return null;
  const min = ref.minus({ days: YEAR_WINDOW_BEFORE_DAYS }).toMillis();
  const max = ref.plus({ days: YEAR_WINDOW_AFTER_DAYS }).toMillis();
  for (const y of [ref.year - 1, ref.year, ref.year + 1]) {
    const cand = DateTime.utc(y, month, day);
    if (cand.isValid && cand.month === month && cand.toMillis() >= min && cand.toMillis() <= max) return y;
  }
  return null;
}

/**
 * Término anterior ao início com ano inferido (ex.: "28 de dezembro a 4 de janeiro" publicado em
 * dezembro): o término pertence ao ano seguinte se isso o deixar até 200 dias após o início.
 * Caso contrário, o término é descartado (pendente) em vez de adivinhado.
 */
export function fixEndBeforeStart(start: ParsedDate, end: ParsedDate, issues?: string[]): ParsedDate | null {
  if (end.iso >= start.iso) return end;
  if (end.yearInferred) {
    const e = DateTime.fromISO(end.iso, { zone: 'utc' }).plus({ years: 1 });
    const s = DateTime.fromISO(start.iso, { zone: 'utc' });
    if (e.diff(s, 'days').days <= YEAR_WINDOW_AFTER_DAYS) {
      const iso = end.precision === 'datetime' ? e.toISO({ suppressMilliseconds: true })! : e.toISODate()!;
      return { ...end, iso };
    }
  }
  issues?.push(`término (${end.iso}) anterior ao início (${start.iso}); término mantido como pendente`);
  return null;
}

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function classify(text: string): EventCategory {
  const t = norm(text);
  if (/medalha|medal/.test(t)) return 'medal_event';
  if (/visua(l|is) de her|hero skin|skin|paisagem|scenery|figurinha|sticker|personalizac|cosmetic|decorac|decoration/.test(t)) return 'cosmetic';
  if (/jogos do cla|clan games/.test(t)) return 'clan_games';
  if (/liga de guerra|liga das guerras|clan war league|\bcwl\b/.test(t)) return 'cwl';
  if (/\braid/.test(t)) return 'raid_weekend';
  if (/desafio|challenge|classificacao|leaderboard/.test(t)) return 'challenge';
  if (/corrida|\brush\b/.test(t)) return 'special_event';
  if (/temporada|season/.test(t)) return 'season';
  if (/atualizacao|update|balanceamento|balance|notas|patch|manutencao|maintenance/.test(t)) return 'update';
  if (/evento|event/.test(t)) return 'special_event';
  return 'other';
}

interface Segment {
  key: string;
  heading: string | null;
  blocks: Block[];
}

function segments(blocks: Block[]): Segment[] {
  const out: Segment[] = [{ key: 's0', heading: null, blocks: [] }];
  for (const b of blocks) {
    if (b.type === 'heading' && b.level <= 3) out.push({ key: `s${out.length}`, heading: b.text, blocks: [] });
    else out[out.length - 1]!.blocks.push(b);
  }
  return out.filter((s) => s.blocks.length || s.heading);
}

function lines(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'paragraph') out.push(b.text);
    else if (b.type === 'list') out.push(...b.items);
    else if (b.type === 'heading') out.push(b.text);
  }
  return out;
}

function findLabeled(ls: string[], re: RegExp): string | null {
  for (const l of ls) {
    const m = re.exec(l.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

const SHOP_HEADING = /loja|shop|comerciante|trader/i;
const PROBABILITY = /probabilidad|chance|drop rate|taxa de (obten|drop)|%/i;
const PRICE_COL = /pre[çc]o|price|cost|custo/i;
const LIMIT_COL = /limite|limit/i;
const REWARD_COL = /recompensa|reward|pr[êe]mio|item/i;
const FREE_COL = /gr[áa]tis|gratuit|free/i;
const PAID_COL = /bilhete|pass[e]?\b|pago|paid|ouro|gold/i;
const LEVEL_COL = /n[íi]vel|level|tier|patamar|etapa|step|pontos|points/i;

/**
 * Recompensas explícitas e estruturadas. Formatos reconhecidos:
 * 1. Lista logo abaixo de um título de recompensas (não de loja) → prêmios.
 * 2. Tabela de loja (colunas item + preço [+ limite]) → itens de loja (kind "shop"), nunca prêmios garantidos.
 * 3. Lista abaixo de título de loja → itens de loja sem preço (só se o artigo não tiver a tabela da loja).
 * 4. Tabela de caminho de recompensas (coluna de nível + colunas grátis/pago ou recompensa) → prêmios
 *    com condição "Nível X" e tier conforme a coluna.
 * Tabelas de probabilidade (baús, drops) são sempre ignoradas: não são recompensas garantidas.
 * Prosa nunca é interpretada.
 */
export function extractRewards(blocks: Block[]): Reward[] {
  const prizes: Reward[] = [];
  const shopFromTable: Reward[] = [];
  const shopFromList: Reward[] = [];
  let heading = '';
  let lastParagraph = '';
  for (const b of blocks) {
    if (b.type === 'heading') {
      heading = b.text;
      lastParagraph = '';
      continue;
    }
    if (b.type === 'paragraph') {
      lastParagraph = b.text;
      continue;
    }
    const probabilityContext = PROBABILITY.test(heading) && !REWARD_HEADING.test(heading) ? true : /probabilidad|chance|drop rate/i.test(lastParagraph);
    if (b.type === 'table') {
      const parsed = parseRewardTable(b.rows, probabilityContext);
      if (parsed.kind === 'shop') shopFromTable.push(...parsed.items);
      else if (parsed.kind === 'reward') prizes.push(...parsed.items);
      continue;
    }
    if (b.type === 'list' && heading) {
      if (SHOP_HEADING.test(heading)) shopFromList.push(...b.items.map((i) => ({ ...rewardFromItem(i), kind: 'shop' as const, tier: 'unknown' as const })));
      else if (REWARD_HEADING.test(heading) && !probabilityContext) prizes.push(...b.items.map(rewardFromItem));
    }
  }
  const shop = shopFromTable.length ? dedupe(shopFromTable) : dedupe(shopFromList);
  return [...dedupe(prizes), ...shop];
}

function rewardFromItem(item: string): Reward {
  const [head, ...rest] = item.split(/:\s+/);
  const label = (head ?? item).trim().replace(/[.;]+$/, '');
  const condition = rest.join(': ').trim().replace(/[.;]+$/, '') || undefined;
  const q = /(\d[\d.,]*)\s*[x×]\s/i.exec(item) ?? /[x×]\s*(\d[\d.,]*)/i.exec(item);
  const quantity = q?.[1] ? Number(q[1].replace(/[.,]/g, '')) : undefined;
  const t = norm(item);
  let tier: RewardTier = 'unknown';
  // Pago só com menção explícita a passe/bilhete pago ou preço em dinheiro. "Comprar com medalhas" não é pago.
  if (/passe ouro|gold pass|bilhete dourado|bilhete de evento|event pass|\bpago\b|\bpaid\b|r\$|us\$|\$\s?\d/.test(t)) tier = 'paid';
  else if (/gratis|gratuit|\bfree\b/.test(t)) tier = 'free';
  return { label, ...(quantity !== undefined && Number.isFinite(quantity) ? { quantity } : {}), ...(condition ? { condition } : {}), tier };
}

function dedupe(list: Reward[]): Reward[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = JSON.stringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parseRewardTable(rows: string[][], probabilityContext: boolean): { kind: 'shop' | 'reward' | 'ignored'; items: Reward[] } {
  const [header, ...body] = rows;
  if (!header || body.length === 0) return { kind: 'ignored', items: [] };
  if (probabilityContext || header.some((h) => PROBABILITY.test(h))) return { kind: 'ignored', items: [] };
  const priceIdx = header.findIndex((h) => PRICE_COL.test(h));
  if (priceIdx >= 0) {
    const labelIdx = priceIdx === 0 ? 1 : 0;
    const limitIdx = header.findIndex((h) => LIMIT_COL.test(h));
    const currency = /\((?:em\s+)?([^)]+)\)/i.exec(header[priceIdx]!)?.[1]?.trim();
    const items: Reward[] = [];
    for (const r of body) {
      const label = r[labelIdx]?.trim();
      const price = r[priceIdx]?.trim();
      if (!label || !price) continue;
      const limit = limitIdx >= 0 ? Number((r[limitIdx] ?? '').replace(/\D/g, '')) : NaN;
      items.push({ label, kind: 'shop', tier: 'unknown', price: currency ? `${price} ${currency}` : price, ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) });
    }
    return { kind: 'shop', items };
  }
  const levelIdx = header.findIndex((h) => LEVEL_COL.test(h));
  const tierCols = header.map((h, i) => ({ i, tier: FREE_COL.test(h) ? ('free' as const) : PAID_COL.test(h) ? ('paid' as const) : null })).filter((c) => c.tier && c.i !== levelIdx);
  const rewardIdx = header.findIndex((h, i) => i !== levelIdx && REWARD_COL.test(h));
  if (levelIdx < 0 || (tierCols.length === 0 && rewardIdx < 0)) return { kind: 'ignored', items: [] };
  const items: Reward[] = [];
  for (const r of body) {
    const cond = `${header[levelIdx]} ${r[levelIdx] ?? ''}`.trim();
    const cols = tierCols.length ? tierCols : [{ i: rewardIdx, tier: 'unknown' as const }];
    for (const c of cols) {
      const cell = r[c.i]?.trim();
      if (!cell || cell === '-' || cell === '—') continue;
      items.push({ ...rewardFromItem(cell), condition: cond, tier: c.tier ?? 'unknown' });
    }
  }
  return { kind: 'reward', items };
}

const RANGE_EN = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*[-–]\s*(?:([a-z]+)\s+)?(\d{1,2})(?:st|nd|rd|th)?)?\s*:\s*(.+)$/i;
// "De 1º a 30 de setembro: título. descrição", "15 de setembro: título. descrição"
const RANGE_PT = /^(?:de\s+)?(\d{1,2})[ºo°]?(?:\s+(?:a|até|-|–)\s+(\d{1,2})[ºo°]?)?\s+de\s+([a-zç]+)\s*:\s*(.+)$/i;

export interface RangeItem {
  title: string;
  description: string | null;
  start: ParsedDate;
  end: ParsedDate;
}

function splitTitle(rest: string, locale: 'en' | 'pt'): { title: string; description: string | null } {
  const r = rest.trim();
  const sep = locale === 'en' ? /\s+[-–—]\s+/ : /\.\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/;
  const idx = r.search(sep);
  if (idx > 0 && idx < 90) {
    const m = sep.exec(r)!;
    return { title: cleanTitle(r.slice(0, idx)), description: r.slice(idx + m[0].length).trim() || null };
  }
  // sem separador claro: título = até o primeiro ponto final ou 80 caracteres
  const dot = r.indexOf('. ');
  if (dot > 0 && dot < 90) return { title: cleanTitle(r.slice(0, dot)), description: r.slice(dot + 2).trim() || null };
  return { title: cleanTitle(r.slice(0, 80)), description: r.length > 80 ? r : null };
}

/**
 * Itens de calendário ("September 1-30: Nome", "De 1º a 30 de setembro: Nome") em parágrafos ou listas
 * → sub-eventos com precisão de dia. É assim que a Supercell publica o calendário mensal da temporada.
 */
export function rangeItems(blocks: Block[], publishedAt: string | null, issues?: string[]): RangeItem[] {
  const out: RangeItem[] = [];
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'list') texts.push(...b.items);
    else if (b.type === 'paragraph') texts.push(b.text);
  }
  for (const raw of texts) {
    const line = raw.trim();
    let m = RANGE_EN.exec(line);
    if (m && MONTHS_EN[norm(m[1]!)]) {
      const s = parseDateExpression(`${m[1]} ${m[2]}`, publishedAt, issues);
      const e0 = m[4] ? parseDateExpression(`${m[3] ?? m[1]} ${m[4]}`, publishedAt, issues) : s;
      const e = s && e0 ? fixEndBeforeStart(s, e0, issues) : null;
      if (s && e) out.push({ ...splitTitle(m[5]!, 'en'), start: s, end: e });
      continue;
    }
    m = RANGE_PT.exec(line);
    if (m && MONTHS_PT[norm(m[3]!)]) {
      const s = parseDateExpression(`${m[1]} de ${m[3]}`, publishedAt, issues);
      const e0 = m[2] ? parseDateExpression(`${m[2]} de ${m[3]}`, publishedAt, issues) : s;
      const e = s && e0 ? fixEndBeforeStart(s, e0, issues) : null;
      if (s && e) out.push({ ...splitTitle(m[4]!, 'pt'), start: s, end: e });
    }
  }
  return out;
}

function cleanTitle(t: string): string {
  const s = t.replace(/\s+/g, ' ').replace(/[!.\s]+$/g, '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function extractEvents(pub: Publication): ExtractedEvent[] {
  const segs = segments(pub.blocks);
  const dated: { seg: Segment; start: ParsedDate | null; end: ParsedDate | null; issues: string[] }[] = [];
  const issues: string[] = [];
  for (const seg of segs) {
    const ls = lines(seg.blocks);
    const s = findLabeled(ls, START_LABEL);
    const e = findLabeled(ls, END_LABEL);
    const segIssues: string[] = [];
    const start = s ? parseDateExpression(s, pub.publishedAt, segIssues) : null;
    let end = e ? parseDateExpression(e, pub.publishedAt, segIssues) : null;
    if (start && end) end = fixEndBeforeStart(start, end, segIssues);
    if (s && !start && !segIssues.length) segIssues.push(`data de início rotulada não interpretada: "${s}"`);
    if (e && !end && !segIssues.length) segIssues.push(`data de término rotulada não interpretada: "${e}"`);
    issues.push(...segIssues);
    if (start || end) dated.push({ seg, start, end, issues: segIssues });
  }

  const articleTitle = cleanTitle(pub.title);
  const articleCategory = classify(pub.title);
  const allRewards = extractRewards(pub.blocks);
  const out: ExtractedEvent[] = [];

  if (dated.length === 0) {
    // Sem datas rotuladas: itens de calendário ("September 1-30: ...") ou anúncio sem data.
    const ranges = rangeItems(pub.blocks, pub.publishedAt, issues);
    if (ranges.length) {
      const seen = new Set<string>();
      for (const r of ranges) {
        const key = `r:${slugKey(r.title)}:${r.start.iso.slice(0, 10)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(build(pub, key, r.title, classify(r.title), r.start, r.end, [], [], r.description));
      }
      // Post de calendário (≥3 itens) ou de temporada: o artigo em si vira o evento "temporada" com o intervalo total.
      if (ranges.length >= 3 || articleCategory === 'season') {
        const starts = ranges.map((r) => r.start).sort((a, b) => a.iso.localeCompare(b.iso));
        const ends = ranges.map((r) => r.end).sort((a, b) => b.iso.localeCompare(a.iso));
        // Término explícito na prosa ("... terminar em 1º de outubro", "ends on October 1st") tem prioridade
        // sobre o intervalo derivado dos itens do calendário.
        const explicitEnd = findSeasonEnd(pub.blocks, pub.publishedAt, issues);
        const ev = build(pub, 's0', articleTitle, articleCategory === 'other' ? 'season' : articleCategory, starts[0]!, explicitEnd ?? ends[0]!, allRewards, [], null);
        ev.confirmedFields.push('start_at_derived_from_calendar_items');
        if (!explicitEnd) ev.confirmedFields.push('end_at_derived_from_calendar_items');
        out.unshift(ev);
      }
      return out;
    }
    if (EVENT_WORDS.test(pub.title) && articleCategory !== 'update') {
      out.push(build(pub, 's0', articleTitle, articleCategory, null, null, allRewards, issues.length ? issues : ['sem datas rotuladas na publicação'], null));
    }
    return out;
  }

  const multi = dated.length > 1;
  for (const d of dated) {
    const headingOk = d.seg.heading && !GENERIC_HEADING.test(d.seg.heading);
    const title = multi && headingOk ? cleanTitle(d.seg.heading!) : articleTitle;
    const category = multi && headingOk ? classify(`${d.seg.heading} ${pub.title}`) : articleCategory;
    const segRewards = multi ? extractRewards(d.seg.blocks) : allRewards;
    out.push(build(pub, multi ? d.seg.key : 's0', title, category, d.start, d.end, segRewards.length ? segRewards : multi ? [] : allRewards, d.issues, null));
  }
  return out;
}

const SEASON_END = /(?:terminar|termina|encerrar|encerra|acabar|acaba|ends?|ending)\s+(?:em|no dia|on)\s+((?:\d{1,2}[ºo°]?\s+de\s+[a-zç]+)|(?:[a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?))/i;

function findSeasonEnd(blocks: Block[], publishedAt: string | null, issues: string[]): ParsedDate | null {
  for (const b of blocks) {
    const texts = b.type === 'paragraph' ? [b.text] : b.type === 'list' ? b.items : [];
    for (const t of texts) {
      const m = SEASON_END.exec(t);
      if (m?.[1]) {
        const d = parseDateExpression(m[1], publishedAt, issues);
        if (d) return d;
      }
    }
  }
  return null;
}

const NUM_WORDS: Record<string, number> = {
  um: 1, uma: 1, one: 1, dois: 2, duas: 2, two: 2, tres: 3, three: 3, quatro: 4, four: 4, cinco: 5, five: 5,
  seis: 6, six: 6, sete: 7, seven: 7, oito: 8, eight: 8, nove: 9, nine: 9, dez: 10, ten: 10,
  catorze: 14, quatorze: 14, fourteen: 14,
};

/**
 * Duração declarada explicitamente no texto da fonte ("por cinco dias", "por 48 horas", "for five days",
 * "48-hour run"). Guardada com o trecho citado; nunca calculada a partir de datas sem horário.
 */
export function findDeclaredDuration(text: string | null | undefined): { value: string; quote: string } | null {
  if (!text) return null;
  const t = norm(text);
  const m =
    /\b(?:por|durante|for)\s+(\d{1,3}|[a-z]+)\s+(dias?|horas?|days?|hours?)\b/.exec(t) ??
    /\b(\d{1,3})-(hour|day)\s+(?:run|boost|event)\b/.exec(t) ??
    /\brodada de\s+(\d{1,3}|[a-z]+)\s+(dias?|horas?)\b/.exec(t);
  if (!m?.[1] || !m[2]) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1]];
  if (!n) return null;
  const hours = /^h/.test(m[2]);
  const value = hours ? `${n} ${n === 1 ? 'hora' : 'horas'}` : `${n} ${n === 1 ? 'dia' : 'dias'}`;
  const start = Math.max(0, m.index - 40);
  return { value, quote: text.slice(start, m.index + m[0].length + 20).trim() };
}

function slugKey(s: string): string {
  return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function build(pub: Publication, segmentKey: string, title: string, category: EventCategory, start: ParsedDate | null, end: ParsedDate | null, rewards: Reward[], notes: string[], description: string | null): ExtractedEvent {
  const confirmed: string[] = ['title'];
  const n = [...notes];
  let yearInferred = false;
  if (start) {
    confirmed.push('start_at');
    yearInferred ||= start.yearInferred;
    if (start.timeWithoutTz) n.push('horário de início sem fuso explícito; mantido como data');
  }
  if (end) {
    confirmed.push('end_at');
    yearInferred ||= end.yearInferred;
    if (end.timeWithoutTz) n.push('horário de término sem fuso explícito; mantido como data');
  }
  if (rewards.length) confirmed.push('rewards');
  const hasPrizes = rewards.some((r) => r.kind !== 'shop');
  if (REWARD_CATEGORIES.has(category) && !hasPrizes) {
    n.push(
      rewards.length
        ? 'recompensas do caminho do evento não extraídas (a fonte só traz o catálogo da loja em formato estruturado)'
        : 'recompensas não extraídas automaticamente (sem lista ou tabela estruturada de recompensas)',
    );
  }
  if (yearInferred) confirmed.push('year_inferred_from_publish_date');
  const input: EventInput = {
    category,
    scope: 'global',
    title,
    ...(description ? { description: description.slice(0, 400) } : {}),
    startAt: start?.iso ?? null,
    startPrecision: start?.precision ?? 'unknown',
    endAt: end?.iso ?? null,
    endPrecision: end?.precision ?? 'unknown',
    rewards,
    rewardsStatus: rewards.length ? 'known' : 'unverified',
    primarySourceUrl: pub.sourceKind === 'blog' ? pub.url : null,
    extra: {
      locale: pub.locale,
      publicationId: pub.id,
      publishedAt: pub.publishedAt,
      ...(findDeclaredDuration(description) ? { declaredDuration: findDeclaredDuration(description) } : {}),
    },
  };
  return { segmentKey, input, confirmedFields: confirmed, notes: n, yearInferred };
}
