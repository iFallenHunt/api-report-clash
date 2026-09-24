import { randomBytes } from 'node:crypto';
import type { EventCategory, EventInput } from './types.js';

export function newEventId(): string {
  return `evt_${randomBytes(6).toString('hex')}`;
}

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const NOISE_WORDS = [
  'evento de medalhas',
  'evento',
  'medal event',
  'event',
  'chegou',
  'esta aqui',
  'is here',
  'the',
  'o',
  'a',
  'de',
  'da',
  'do',
];

export function titleKey(title: string): string {
  let t = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[!?:.,]/g, ' ');
  for (const w of NOISE_WORDS) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
  return slugify(t);
}

/**
 * Chave canônica para reconhecer o mesmo evento vindo de fontes/idiomas diferentes.
 * Preferência: categoria + datas confirmadas (invariantes entre idiomas).
 * Sem datas: categoria + chave do título (só funciona no mesmo idioma).
 */
export function canonicalKeyFor(input: Pick<EventInput, 'category' | 'startAt' | 'startPrecision' | 'endAt' | 'endPrecision' | 'title'>): string {
  const cat: EventCategory = input.category;
  const s = input.startAt && input.startPrecision !== 'unknown' ? input.startAt.slice(0, 10) : null;
  const e = input.endAt && input.endPrecision !== 'unknown' ? input.endAt.slice(0, 10) : null;
  // Categorias genéricas (ofertas, boosts, cosméticos) têm muitos itens com as mesmas datas: inclui o título.
  const suffix = cat === 'other' || cat === 'cosmetic' ? `:${titleKey(input.title)}` : '';
  if (s) return `${cat}:${s}${e ? `..${e}` : ''}${suffix}`;
  return `${cat}:title:${titleKey(input.title)}`;
}
