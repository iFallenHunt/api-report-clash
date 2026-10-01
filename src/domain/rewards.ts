import { z } from 'zod';
import type { Reward, RewardsStatus } from './types.js';

export const rewardSchema = z.object({
  label: z.string().min(1),
  quantity: z.union([z.number(), z.string()]).optional(),
  condition: z.string().optional(),
  tier: z.enum(['free', 'paid', 'unknown']).default('unknown'),
  choiceGroup: z.string().optional(),
  kind: z.enum(['reward', 'shop']).optional(),
  price: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export function normalizeRewards(list: Reward[]): Reward[] {
  return list
    .map((r) => ({
      label: r.label.trim(),
      ...(r.quantity !== undefined ? { quantity: r.quantity } : {}),
      ...(r.condition ? { condition: r.condition.trim() } : {}),
      tier: r.tier ?? 'unknown',
      ...(r.choiceGroup ? { choiceGroup: r.choiceGroup } : {}),
      ...(r.kind === 'shop' ? { kind: 'shop' as const } : {}),
      ...(r.price ? { price: r.price } : {}),
      ...(r.limit !== undefined ? { limit: r.limit } : {}),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function rewardsEqual(a: Reward[], b: Reward[]): boolean {
  return JSON.stringify(normalizeRewards(a)) === JSON.stringify(normalizeRewards(b));
}

export const SHOP_DISPLAY_LIMIT = 8;

export function isShop(r: Reward): boolean {
  return r.kind === 'shop';
}

/**
 * Bloco de recompensas para mensagens.
 * - not_announced: a Supercell ainda não divulgou.
 * - unverified: a coleta não conseguiu confirmar (não é o mesmo que "não divulgado").
 * - known: prêmios separados em gratuito/pago/sem indicação; opções explicitadas; itens de loja
 *   aparecem em seção própria e nunca como prêmio garantido.
 */
export function rewardsLines(status: RewardsStatus, rewards: Reward[], sourceUrl: string | null, description: string | null = null): string[] {
  if (status === 'not_announced') return ['🎁 Recompensas ainda não divulgadas'];
  const prizes = rewards.filter((r) => !isShop(r));
  const shop = rewards.filter(isShop);
  const unverifiedLine = '🎁 Recompensas: não foi possível verificar automaticamente' + (sourceUrl ? ' (veja a fonte)' : '');
  if (status === 'unverified' || rewards.length === 0) {
    // Sem lista estruturada: cita o que a publicação oficial diz sobre recompensas, literalmente.
    const quotes = rewardQuotes(description);
    return quotes.length ? rewardQuoteLines(quotes) : [unverifiedLine];
  }

  const lines: string[] = [];
  if (prizes.length) {
    const free = prizes.filter((r) => r.tier === 'free');
    const paid = prizes.filter((r) => r.tier === 'paid');
    const unknown = prizes.filter((r) => r.tier === 'unknown');
    lines.push('🎁 *Recompensas*');
    const render = (list: Reward[]) => {
      const groups = new Map<string, Reward[]>();
      const singles: Reward[] = [];
      for (const r of list) {
        if (r.choiceGroup) {
          const g = groups.get(r.choiceGroup) ?? [];
          g.push(r);
          groups.set(r.choiceGroup, g);
        } else singles.push(r);
      }
      for (const r of singles) lines.push(`• ${rewardText(r)}`);
      for (const [, opts] of groups) {
        opts.sort((a, b) => a.label.localeCompare(b.label));
        lines.push(`• Escolha 1 entre: ${opts.map((o) => rewardText(o, true)).join(' / ')}`);
        const cond = opts.find((o) => o.condition)?.condition;
        if (cond) lines.push(`  ↳ ${cond}`);
      }
    };
    if (free.length) {
      if (paid.length || unknown.length) lines.push('_Gratuitas:_');
      render(free);
    }
    if (unknown.length) {
      if (free.length || paid.length) lines.push('_Sem indicação se são gratuitas ou pagas:_');
      render(unknown);
    }
    if (paid.length) {
      lines.push('💳 *Passe/conteúdo pago:*');
      render(paid);
    }
  } else {
    // Só há catálogo de loja: os prêmios do caminho do evento continuam não verificados.
    lines.push('🎁 Recompensas do caminho do evento: não foi possível verificar automaticamente' + (sourceUrl ? ' (veja a fonte)' : ''));
  }
  if (shop.length) {
    lines.push('');
    lines.push('🛒 *Loja do evento* (troca pela moeda do evento; não são prêmios garantidos)');
    for (const r of shop.slice(0, SHOP_DISPLAY_LIMIT)) lines.push(`• ${shopText(r)}`);
    if (shop.length > SHOP_DISPLAY_LIMIT) lines.push(`• … e mais ${shop.length - SHOP_DISPLAY_LIMIT} itens (lista completa na fonte)`);
  }
  return lines;
}

export function shopText(r: Reward): string {
  const meta = [r.price, r.limit !== undefined ? `limite ${r.limit}` : null].filter(Boolean).join(', ');
  return meta ? `${r.label} — ${meta}` : r.label;
}

function rewardText(r: Reward, brief = false): string {
  const qty = r.quantity !== undefined ? `${r.quantity}x ` : '';
  const base = `${qty}${r.label}`;
  if (brief || !r.condition) return base;
  return `${base} — ${r.condition}`;
}

const QUOTE_MAX_SENTENCES = 3;
const QUOTE_MAX_CHARS = 220;
// Frases da fonte que falam do que o jogador recebe. Probabilidades nunca entram (não são prêmio garantido).
const REWARD_CUE = /recompens|premio|resgat|ganh(?:e|a|ar|am|em)\b|receber|para obter|visual de heroi exclusivo|opcao de visual|decoracao exclusiva|agrado|liberando |\bloja\b.*\baberta\b/;
const PROBABILITY_CUE = /probabilidad|chance|%/;
const SHOP_CUE = /\bloja\b/;

function plain(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export interface RewardQuote {
  text: string;
  /** Frase sobre a loja do evento: item trocável, nunca prêmio garantido. */
  shop: boolean;
}

/**
 * Trechos literais da publicação oficial sobre recompensas (quando a fonte não tem lista estruturada).
 * Seleção determinística de frases inteiras por palavras-chave; o texto não é interpretado nem reescrito.
 */
export function rewardQuotes(text: string | null | undefined): RewardQuote[] {
  if (!text) return [];
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=["“(]?[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/);
  const out: RewardQuote[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    const p = plain(s);
    if (!s || !REWARD_CUE.test(p) || PROBABILITY_CUE.test(p)) continue;
    // Recompensa só dentro de um parêntese ("É aterrorizante (X é a opção de visual …)"): cita o parêntese.
    const paren = /\(([^()]+)\)/.exec(s);
    const outside = paren ? plain(s.replace(paren[0], '')) : p;
    const text = paren && !REWARD_CUE.test(outside) ? `${paren[1]!.trim()}.` : s;
    const cut = text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS - 1).replace(/\s+\S*$/, '')}…` : text;
    out.push({ text: cut, shop: SHOP_CUE.test(plain(text)) });
    if (out.length >= QUOTE_MAX_SENTENCES) break;
  }
  return out;
}

/** Linhas de citação para mensagens: loja sempre identificada como loja. */
export function rewardQuoteLines(quotes: RewardQuote[], indent = ''): string[] {
  return quotes.map((q) => (q.shop ? `${indent}🛒 Loja do evento (não é prêmio garantido): “${q.text}”` : `${indent}🎁 Segundo a Supercell: “${q.text}”`));
}
