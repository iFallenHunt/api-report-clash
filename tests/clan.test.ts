import { describe, expect, it } from 'vitest';
import { CocApiError, CocClient, CocUnavailableError, parseCocTime, type RawWar } from '../src/collectors/coc/client.js';
import { ClanPoller } from '../src/collectors/coc/poll.js';
import { harness } from './helpers.js';

const TAG = '#ABC123';

function fakeClient(state: { war?: RawWar | Error; group?: unknown; raid?: unknown }) {
  return {
    currentWar: async () => { if (state.war instanceof Error) throw state.war; return state.war ?? { state: 'notInWar' }; },
    leagueGroup: async () => { if (state.group instanceof Error) throw state.group; if (!state.group) throw new CocApiError(404, 'notFound', 'not in league'); return state.group; },
    leagueWar: async () => { throw new Error('não usado'); },
    capitalRaidSeasons: async () => { if (state.raid instanceof Error) throw state.raid; return { items: state.raid ? [state.raid] : [] }; },
  } as unknown as CocClient;
}

function war(state: RawWar['state'], over: Partial<RawWar> = {}): RawWar {
  return {
    state, teamSize: 15, attacksPerMember: 2,
    preparationStartTime: '20260924T100000.000Z', startTime: '20260925T100000.000Z', endTime: '20260926T100000.000Z',
    clan: { tag: TAG, name: 'Nosso', stars: 20, destructionPercentage: 70.5, attacks: 20 },
    opponent: { tag: '#OPP', name: 'Rival', stars: 18, destructionPercentage: 65.1, attacks: 25 },
    ...over,
  };
}

function poller(h: ReturnType<typeof harness>, client: CocClient) {
  return new ClanPoller({ client, clanTag: TAG, db: h.db, repo: h.repo, outbox: h.outbox, cfg: h.cfg, log: h.log });
}

describe('estado do clã', () => {
  it('converte datas da API', () => {
    expect(parseCocTime('20260924T170000.000Z')).toBe('2026-09-24T17:00:00Z');
    expect(parseCocTime('x')).toBeNull();
  });

  it('guerra: preparação → batalha → lembrete 2h → encerrada; consultas repetidas não duplicam', async () => {
    const h = harness();
    const st: { war?: RawWar | Error } = { war: war('preparation') };
    const p = poller(h, fakeClient(st));
    await p.pollOnce('2026-09-24T10:05:00Z');
    await p.pollOnce('2026-09-24T10:10:00Z');
    expect(h.outbox.list().map((i) => i.kind)).toEqual(['clan_war_found']);
    expect(h.outbox.list()[0]!.body).toContain('DIA DE PREPARAÇÃO');
    expect(h.outbox.list()[0]!.body).toContain('Rival');

    st.war = war('inWar');
    await p.pollOnce('2026-09-25T10:05:00Z');
    await p.pollOnce('2026-09-25T10:10:00Z');
    expect(h.outbox.list().map((i) => i.kind).sort()).toEqual(['clan_war_found', 'clan_war_started']);

    await p.pollOnce('2026-09-26T08:30:00Z'); // faltam 1h30 → lembrete de 2h
    const ending = h.outbox.list().find((i) => i.kind === 'clan_war_ending')!;
    expect(ending.body).toContain('TERMINA EM 1 hora');
    expect(ending.body).toContain('Placar: 20 x 18');
    expect(ending.expiresAt).toBe('2026-09-26T10:00:00Z');

    st.war = war('warEnded');
    await p.pollOnce('2026-09-26T10:05:00Z');
    const ended = h.outbox.list().find((i) => i.kind === 'clan_war_ended')!;
    expect(ended.body).toContain('VITÓRIA');

    // evento do clã no calendário
    const ev = h.repo.allEvents().find((e) => e.scope === 'clan')!;
    expect(ev).toMatchObject({ category: 'war', startAt: '2026-09-25T10:00:00Z', endAt: '2026-09-26T10:00:00Z' });
  });

  it('avisos antigos não são despejados após indisponibilidade (início/fim fora do TTL)', async () => {
    const h = harness();
    const p = poller(h, fakeClient({ war: war('inWar') }));
    await p.pollOnce('2026-09-25T20:00:00Z'); // batalha começou há 10h
    expect(h.outbox.list()).toHaveLength(0);
    const p2 = poller(h, fakeClient({ war: war('warEnded') }));
    await p2.pollOnce('2026-09-27T20:00:00Z');
    expect(h.outbox.list()).toHaveLength(0);
  });

  it('falha da API (timeout/429/403) não muda estado nem gera avisos; fica registrada', async () => {
    const h = harness();
    const p = poller(h, fakeClient({ war: war('preparation') }));
    await p.pollOnce('2026-09-24T10:05:00Z');
    const r = await poller(h, fakeClient({ war: new CocUnavailableError('timeout') })).pollOnce('2026-09-24T10:10:00Z');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('timeout');
    const r2 = await poller(h, fakeClient({ war: new CocApiError(403, 'accessDenied', 'HTTP 403') })).pollOnce('2026-09-24T10:15:00Z');
    expect(r2.ok).toBe(false);
    expect(h.db.get<{ state: string }>("SELECT state FROM clan_state WHERE kind = 'war'")!.state).toBe('preparation');
    expect(h.outbox.list().map((i) => i.kind)).toEqual(['clan_war_found']);
    expect(h.db.all<{ ok: number }>("SELECT ok FROM collector_runs WHERE source = 'clan'").map((r) => r.ok)).toEqual([1, 0, 0]);
    // recuperação: consulta volta a funcionar e a transição é detectada normalmente
    await poller(h, fakeClient({ war: war('inWar') })).pollOnce('2026-09-25T10:05:00Z');
    expect(h.outbox.list().map((i) => i.kind).sort()).toEqual(['clan_war_found', 'clan_war_started']);
  });

  it('raides: início, lembrete 2h antes do fim, encerramento com medalhas; evento no calendário com recompensas', async () => {
    const h = harness();
    const raid = { state: 'ongoing', startTime: '20260925T070000.000Z', endTime: '20260928T070000.000Z', capitalTotalLoot: 120000, raidsCompleted: 2, totalAttacks: 40, enemyDistrictsDestroyed: 9 };
    await poller(h, fakeClient({ raid })).pollOnce('2026-09-25T07:05:00Z');
    expect(h.outbox.list().map((i) => i.kind)).toEqual(['clan_raid_started']);
    expect(h.outbox.list()[0]!.body).toContain('⏳ Duração: 3 dias');
    await poller(h, fakeClient({ raid })).pollOnce('2026-09-28T05:30:00Z');
    expect(h.outbox.list().map((i) => i.kind).sort()).toEqual(['clan_raid_ending', 'clan_raid_started']);
    await poller(h, fakeClient({ raid: { ...raid, state: 'ended', offensiveReward: 950, defensiveReward: 120 } })).pollOnce('2026-09-28T07:05:00Z');
    const ended = h.outbox.list().find((i) => i.kind === 'clan_raid_ended')!;
    expect(ended.body).toContain('Medalhas (ofensiva): 950');
    const ev = h.repo.allEvents().find((e) => e.category === 'raid_weekend')!;
    expect(ev.rewardsStatus).toBe('known');
    expect(ev.rewards.find((r) => r.label.includes('ofensiva'))?.quantity).toBe(950);
  });

  it('cliente HTTP: retry em 429 com Retry-After e erro claro em 403', async () => {
    const calls: string[] = [];
    let n = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(url);
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
      n++;
      if (n === 1) return new Response(JSON.stringify({ reason: 'requestThrottled' }), { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify({ state: 'notInWar' }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new CocClient({ base: 'https://api', token: 'tok', fetchImpl, sleep: async () => undefined });
    expect(await c.currentWar('#abc')).toEqual({ state: 'notInWar' });
    expect(calls).toEqual(['https://api/clans/%23ABC/currentwar', 'https://api/clans/%23ABC/currentwar']);
    const c403 = new CocClient({ base: 'https://api', token: 'tok', fetchImpl: async () => new Response(JSON.stringify({ reason: 'accessDenied', message: 'Invalid authorization' }), { status: 403 }), sleep: async () => undefined });
    await expect(c403.clan('#abc')).rejects.toMatchObject({ status: 403, isForbidden: true });
  });
});
