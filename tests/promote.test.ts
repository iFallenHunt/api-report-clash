import { describe, expect, it } from 'vitest';
import { CocUnavailableError, type CocClient, type RawWar } from '../src/collectors/coc/client.js';
import { ClanPoller } from '../src/collectors/coc/poll.js';
import { runPromote } from '../src/cli/promote.js';
import { Outbox } from '../src/outbox/queue.js';
import { runOutboxWorker, type Sender } from '../src/outbox/worker.js';
import { harness, memDb } from './helpers.js';

const TAG = '#ABC123';
const KEY = 'clan:war:2026-09-24T18:28:34Z:preparation';
const NOW = '2026-09-24T20:00:00Z';
const BODY = '⚔️ *GUERRA ENCONTRADA* — DIA DE PREPARAÇÃO\nvs Rival';

function war(state: RawWar['state'], over: Partial<RawWar> = {}): RawWar {
  return {
    state, teamSize: 15, attacksPerMember: 2,
    preparationStartTime: '20260924T182834.000Z', startTime: '20260925T182834.000Z', endTime: '20260926T182834.000Z',
    clan: { tag: TAG, name: 'Nosso' }, opponent: { tag: '#OPP', name: 'Rival' },
    ...over,
  };
}

function fakeClient(st: { war?: RawWar | Error; leagueWar?: RawWar }) {
  const client = {
    currentWar: async () => { if (st.war instanceof Error) throw st.war; return st.war ?? { state: 'notInWar' }; },
    leagueWar: async () => st.leagueWar ?? war('preparation'),
    leagueGroup: async () => { throw new Error('não usado'); },
    capitalRaidSeasons: async () => ({ items: [] }),
  } as unknown as CocClient;
  return { client };
}

/** Banco com um item dry_run já validado (#1) e aplicação em modo live (DRY_RUN=false). */
function setup(over: { status?: string; expiresAt?: string; kind?: string; dedupKey?: string; eventId?: string | null } = {}) {
  const db = memDb();
  const dry = new Outbox(db, 'dry_run');
  dry.enqueue({ dedupKey: over.dedupKey ?? KEY, kind: over.kind ?? 'clan_war_found', eventId: over.eventId ?? null, body: BODY, expiresAt: '2026-09-25T00:28:34Z' }, '2026-09-24T18:28:34Z');
  if (over.status) db.run('UPDATE outbox SET status = ? WHERE id = 1', over.status);
  if (over.expiresAt) db.run('UPDATE outbox SET expires_at = ? WHERE id = 1', over.expiresAt);
  const h = harness({ mode: 'live', db, cfg: { coc: { base: 'x', token: 't', clanTag: TAG } } });
  const out: string[] = [];
  return { ...h, dry, live: new Outbox(db, 'live'), out, print: (s: string) => out.push(s) };
}

const snapshot = (db: ReturnType<typeof memDb>) => JSON.stringify(db.all('SELECT * FROM outbox ORDER BY id'));

describe('outbox:promote (dry_run → live)', () => {
  it('sem --confirm: mostra o item e não altera o banco', async () => {
    const s = setup();
    const before = snapshot(s.db);
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: false, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r).toMatchObject({ ok: true, promoted: false });
    expect(snapshot(s.db)).toBe(before);
    expect(s.live.list()).toHaveLength(0);
    const text = s.out.join('\n');
    for (const piece of ['id original: 1', 'kind: clan_war_found', `dedup_key: ${KEY}`, 'event_id: -', 'status: pending', 'expiração original: 2026-09-25T00:28:34Z', BODY, 'Sem --confirm']) {
      expect(text).toContain(piece);
    }
  });

  it('recusa com DRY_RUN=true, mesmo com --confirm', async () => {
    const s = setup();
    const before = snapshot(s.db);
    const r = await runPromote(s.db, { ...s.cfg, dryRun: true }, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('DRY_RUN=true');
    expect(snapshot(s.db)).toBe(before);
  });

  it('item inexistente ou que não pertence à fila dry_run', async () => {
    const s = setup();
    const { client } = fakeClient({ war: war('preparation') });
    const r = await runPromote(s.db, s.cfg, { id: 99, confirm: true, client, now: NOW, print: s.print });
    expect(r).toMatchObject({ ok: false, reason: 'item #99 não encontrado' });

    s.live.enqueue({ dedupKey: 'outra', kind: 'clan_war_found', body: 'x', expiresAt: '2099-01-01T00:00:00Z' }, NOW);
    const liveId = s.live.list()[0]!.id;
    const r2 = await runPromote(s.db, s.cfg, { id: liveId, confirm: true, client, now: NOW, print: s.print });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('fila live');
  });

  it.each(['sent', 'superseded', 'expired', 'failed', 'uncertain', 'sending'])('recusa item com status %s', async (status) => {
    const s = setup({ status });
    const before = snapshot(s.db);
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`status ${status}`);
    expect(snapshot(s.db)).toBe(before);
  });

  it('recusa tipo sem checagem de relevância', async () => {
    const s = setup({ kind: 'event_announced', dedupKey: 'event_announced:evt_x', eventId: 'evt_x' });
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    expect(s.live.list()).toHaveLength(0);
  });

  it('promove preservando kind, event_id, body e dedup_key; fire_at=now e nova expiração pelo TTL', async () => {
    const s = setup({ expiresAt: '2026-09-25T00:28:34Z' });
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok && r.promoted).toBe(true);
    const [item] = s.live.list();
    expect(item).toMatchObject({ mode: 'live', kind: 'clan_war_found', eventId: null, body: BODY, dedupKey: KEY, status: 'pending', fireAt: NOW });
    expect(item!.expiresAt).toBe('2026-09-25T02:00:00.000Z'); // NOW + NOTICE_TTL_HOURS (6h)
    // origem intacta
    expect(s.dry.get(1)).toMatchObject({ mode: 'dry_run', status: 'pending', expiresAt: '2026-09-25T00:28:34Z' });
  });

  it('item dry_run já processado pelo worker de testes (status dry_run) também é promovível; event_id preservado', async () => {
    const s = setup({ status: 'dry_run', eventId: 'evt_war' });
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(true);
    expect(s.live.list()[0]).toMatchObject({ eventId: 'evt_war', body: BODY });
  });

  it('não copia expiração vencida e limita a nova expiração ao início da batalha', async () => {
    const s = setup({ expiresAt: '2026-09-24T19:00:00Z' }); // já vencida em NOW
    const lateNow = '2026-09-25T15:00:00Z'; // batalha às 18:28:34Z → antes de NOW + 6h
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: lateNow, print: s.print });
    expect(r.ok).toBe(true);
    expect(s.live.list()[0]!.expiresAt).toBe('2026-09-25T18:28:34Z');
    expect(s.out.join('\n')).toContain('vencida; não será copiada');
  });

  it('recusa duplicata já existente na fila live', async () => {
    const s = setup();
    s.live.enqueue({ dedupKey: KEY, kind: 'clan_war_found', body: 'já existe', expiresAt: '2099-01-01T00:00:00Z' }, NOW);
    const before = snapshot(s.db);
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('evitar duplicata');
    expect(snapshot(s.db)).toBe(before);
  });

  it('segunda promoção do mesmo item é recusada', async () => {
    const s = setup();
    const { client } = fakeClient({ war: war('preparation') });
    expect((await runPromote(s.db, s.cfg, { id: 1, confirm: true, client, now: NOW, print: s.print })).ok).toBe(true);
    expect((await runPromote(s.db, s.cfg, { id: 1, confirm: true, client, now: NOW, print: s.print })).ok).toBe(false);
    expect(s.live.list()).toHaveLength(1);
  });

  it('promoção não envia: item fica pending sem tentativas; envio só pelo worker', async () => {
    const s = setup();
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(true);
    expect(s.live.list()[0]).toMatchObject({ status: 'pending', attempts: 0, sentAt: null, waMessageId: null, leaseUntil: null });
    expect(s.live.lastSentAt()).toBeNull();

    // o envio acontece apenas quando o worker roda (aqui com sender falso), com o corpo validado
    const sent: string[] = [];
    const sender: Sender = { isReady: () => true, send: (t) => { sent.push(t); return Promise.resolve('msg-1'); } };
    await runOutboxWorker(s.live, sender, { ...s.cfg, delivery: { ...s.cfg.delivery, minGapSeconds: 0 } }, s.log);
    expect(sent).toEqual([BODY]);
  });

  it.each([
    ['inWar', war('inWar'), 'já está em inWar'],
    ['warEnded', war('warEnded'), 'já está em warEnded'],
    ['notInWar', { state: 'notInWar' }, 'não está em guerra'],
    ['outra guerra', war('preparation', { preparationStartTime: '20261001T100000.000Z' }), 'guerra atual é outra'],
  ])('guerra obsoleta (%s) é recusada', async (_label, current, reason) => {
    const s = setup();
    const before = snapshot(s.db);
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: current }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
    expect(snapshot(s.db)).toBe(before);
  });

  it('falha da API ou falta de credenciais: recusa (não promove sem confirmar a relevância)', async () => {
    const s = setup();
    const r = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: new CocUnavailableError('timeout') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    const r2 = await runPromote(s.db, s.cfg, { id: 1, confirm: true, client: null, now: NOW, print: s.print });
    expect(r2.ok).toBe(false);
    expect(s.live.list()).toHaveLength(0);
  });

  it('cenário real: aviso gerado em DRY_RUN não é recriado em live pelo coletor; promoção resolve', async () => {
    const db = memDb();
    const dryH = harness({ mode: 'dry_run', db });
    const { client } = fakeClient({ war: war('preparation') });
    const mk = (h: ReturnType<typeof harness>) => new ClanPoller({ client, clanTag: TAG, db: h.db, repo: h.repo, outbox: h.outbox, cfg: h.cfg, log: h.log });
    await mk(dryH).pollOnce('2026-09-24T18:30:00Z');
    expect(dryH.outbox.list().map((i) => i.dedupKey)).toEqual([KEY]);

    const liveH = harness({ mode: 'live', db, cfg: { coc: { base: 'x', token: 't', clanTag: TAG } } });
    await mk(liveH).pollOnce(NOW); // clan_state já está em preparation → nada novo
    expect(liveH.outbox.list()).toHaveLength(0);

    const r = await runPromote(db, liveH.cfg, { id: dryH.outbox.list()[0]!.id, confirm: true, client, now: NOW, print: () => {} });
    expect(r.ok).toBe(true);
    expect(liveH.outbox.list()[0]).toMatchObject({ dedupKey: KEY, kind: 'clan_war_found', body: dryH.outbox.list()[0]!.body });
  });
});
