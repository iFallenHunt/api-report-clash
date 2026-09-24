import { DateTime } from 'luxon';
import type { CalendarRepo } from '../calendar/repo.js';
import type { EventInput } from '../domain/types.js';

/**
 * Dados FICTÍCIOS para desenvolvimento e previews. Nunca são carregados em produção:
 * só via `preview --demo` (banco em memória) ou `demo:seed` explícito.
 */
export function demoEvents(now = new Date()): EventInput[] {
  const base = DateTime.fromJSDate(now, { zone: 'utc' }).startOf('hour');
  const iso = (dt: DateTime) => dt.toISO({ suppressMilliseconds: true })!;
  return [
    {
      category: 'medal_event', scope: 'global', title: '[FICTÍCIO] Evento de Medalhas do Dragão',
      startAt: iso(base.minus({ days: 3 })), startPrecision: 'datetime', endAt: iso(base.plus({ days: 10 })), endPrecision: 'datetime',
      rewardsStatus: 'known',
      rewards: [
        { label: 'Medalhas do Dragão', quantity: 1200, condition: 'completar a trilha do evento', tier: 'free' },
        { label: 'Poção de Herói', quantity: 3, condition: 'trocar na loja do Comerciante', tier: 'free' },
        { label: 'Visual de Rainha Dragão', condition: 'oferta do evento', tier: 'paid' },
      ],
      primarySourceUrl: 'https://supercell.com/en/games/clashofclans/pt/blog/news/exemplo-ficticio-1',
    },
    {
      category: 'season', scope: 'global', title: '[FICTÍCIO] Temporada Lendária de Outubro',
      startAt: iso(base.plus({ days: 5 }).set({ hour: 8, minute: 0 })), startPrecision: 'datetime', endAt: iso(base.plus({ days: 35 }).set({ hour: 8, minute: 0 })), endPrecision: 'datetime',
      rewardsStatus: 'known',
      rewards: [
        { label: 'Minério Brilhante', quantity: 500, condition: 'passe da temporada (trilha gratuita)', tier: 'free' },
        { label: 'Visual de Herói Lendário', condition: 'Passe Ouro', tier: 'paid' },
        { label: 'Poção de Construtor', quantity: 2, tier: 'free', choiceGroup: 'nivel10', condition: 'nível 10 do passe: escolha 1' },
        { label: 'Livro de Feitiços', quantity: 1, tier: 'free', choiceGroup: 'nivel10' },
      ],
      primarySourceUrl: 'https://supercell.com/en/games/clashofclans/pt/blog/news/exemplo-ficticio-2',
    },
    {
      category: 'clan_games', scope: 'global', title: '[FICTÍCIO] Jogos do Clã',
      startAt: base.plus({ days: 2 }).toISODate()!, startPrecision: 'date', endAt: base.plus({ days: 8 }).toISODate()!, endPrecision: 'date',
      rewardsStatus: 'not_announced',
      primarySourceUrl: 'https://supercell.com/en/games/clashofclans/pt/blog/news/exemplo-ficticio-3',
    },
    {
      category: 'special_event', scope: 'global', title: '[FICTÍCIO] Desafio Relâmpago',
      startAt: iso(base.plus({ hours: 20 })), startPrecision: 'datetime', endAt: iso(base.plus({ hours: 26 })), endPrecision: 'datetime',
      rewardsStatus: 'unverified',
      primarySourceUrl: 'https://supercell.com/en/games/clashofclans/pt/blog/news/exemplo-ficticio-4',
    },
    {
      category: 'special_event', scope: 'global', title: '[FICTÍCIO] Evento Misterioso anunciado sem data',
      startPrecision: 'unknown', endPrecision: 'unknown', rewardsStatus: 'not_announced',
      primarySourceUrl: 'https://supercell.com/en/games/clashofclans/pt/blog/news/exemplo-ficticio-5',
    },
    {
      category: 'war', scope: 'clan', title: '[FICTÍCIO] Guerra de clãs vs Clã Exemplo',
      startAt: iso(base.plus({ hours: 6 })), startPrecision: 'datetime', endAt: iso(base.plus({ hours: 30 })), endPrecision: 'datetime', rewardsStatus: 'not_announced',
    },
    {
      category: 'raid_weekend', scope: 'clan', title: '[FICTÍCIO] Fim de Semana de Raides',
      startAt: iso(base.plus({ days: 3 }).set({ hour: 7 })), startPrecision: 'datetime', endAt: iso(base.plus({ days: 6 }).set({ hour: 7 })), endPrecision: 'datetime',
      rewardsStatus: 'known', rewards: [{ label: 'Medalhas de raide', condition: 'usar os ataques antes do término', tier: 'free' }],
    },
  ];
}

export function seedDemo(repo: CalendarRepo, now = new Date()) {
  const out = [];
  for (const ev of demoEvents(now)) out.push(repo.applyEvent({ ...ev, extra: { demo: true } }, { origin: 'manual', now: now.toISOString() }));
  return out;
}
