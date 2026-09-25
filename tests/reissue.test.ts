import { afterEach, describe, expect, it, vi } from 'vitest';
import { CocApiError, CocUnavailableError, type CocClient, type RawWar } from '../src/collectors/coc/client.js';
import { ClanPoller } from '../src/collectors/coc/poll.js';
import { reissueKey, runReissue } from '../src/cli/reissue.js';
import { Outbox } from '../src/outbox/queue.js';
import { harness, memDb } from './helpers.js';

// O comando nunca pode montar o cliente do WhatsApp nem rodar o worker: se tentar, os espiões acusam.
const waCtor = vi.hoisted(() => vi.fn());
const workerRun = vi.hoisted(() => vi.fn());
vi.mock('../src/whatsapp/client.js', () => ({ WhatsAppSender: waCtor }));
vi.mock('../src/outbox/worker.js', () => ({ runOutboxWorker: workerRun, DryRunSender: vi.fn() }));

const TAG = '#ABC123';
const KEY = 'clan:war:2026-09-24T18:28:34Z:preparation';
const NEW_KEY = 'reissue:1:clan:war:2026-09-24T18:28:34Z:preparation';
const PREP_AT = '2026-09-24T18:30:00Z';
const SENT_AT = '2026-09-24T18:31:00Z';
const NOW = '2026-09-24T20:00:00Z';
const BATTLE = '2026-09-25T17:28:34Z';

function war(state: RawWar['state'], over: Partial<RawWar> = {}): RawWar {
  return {
    state, teamSize: 15, attacksPerMember: 2,
    preparationStartTime: '20260924T182834.000Z', startTime: '20260925T172834.000Z', endTime: '20260926T172834.000Z',
    clan: { tag: TAG, name: 'Nosso' }, opponent: { tag: '#VORTEX', name: 'Vortex' },
    ...over,
  };
}

function fakeClient(st: { war?: RawWar | Error }) {
  const currentWar = vi.fn(async () => { if (st.war instanceof Error) throw st.war; return st.war ?? { state: 'notInWar' as const }; });
  const client = {
    currentWar,
    leagueGroup: async () => { throw new CocApiError(404, 'notFound', 'fora da liga'); },
    leagueWar: async () => { throw new Error('não usado'); },
    capitalRaidSeasons: async () => ({ items: [] }),
  } as unknown as CocClient;
  return { client, currentWar };
}

/**
 * Cenário real: o coletor (live) gera o aviso #1 e clan_state; a versão antiga do fluxo o marca "sent"
 * sem confirmação; uma nova coleta não recria o aviso (clan_state já em preparation).
 */
async function setup(over: { skipClanState?: boolean } = {}) {
  const db = memDb();
  const h = harness({ mode: 'live', db, cfg: { coc: { base: 'x', token: 't', clanTag: TAG } } });
  const { client } = fakeClient({ war: war('preparation') });
  const poller = new ClanPoller({ client, clanTag: TAG, db, repo: h.repo, outbox: h.outbox, cfg: h.cfg, log: h.log });
  await poller.pollOnce(PREP_AT);
  const claimed = h.outbox.claimNext(120, SENT_AT)!;
  h.outbox.markSent(claimed.id, 'true_120363@g.us_3EB0OLD', SENT_AT);
  await poller.pollOnce(NOW);
  if (over.skipClanState) db.run('DELETE FROM clan_state');
  const out: string[] = [];
  return { ...h, live: h.outbox, out, print: (s: string) => out.push(s), original: h.outbox.get(1)! };
}

const snapshot = (db: ReturnType<typeof memDb>) => JSON.stringify(db.all('SELECT * FROM outbox ORDER BY id'));
const text = (out: string[]) => out.join('\n');

afterEach(() => vi.restoreAllMocks());

describe('outbox:reissue (live sent → novo live pending)', () => {
  it('pré-condição: o item original está sent e o coletor não recria o aviso', async () => {
    const s = await setup();
    expect(s.live.list().map((i) => [i.id, i.status, i.kind, i.dedupKey])).toEqual([[1, 'sent', 'clan_war_found', KEY]]);
    expect(s.original.body).toContain('🆚 Adversário: Vortex');
  });

  it('sem --confirm: mostra item, relevância, nova dedup e expiração, e não altera o banco', async () => {
    const s = await setup();
    const before = snapshot(s.db);
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: false, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r).toEqual({ ok: true, reissued: false, dedupKey: NEW_KEY, expiresAt: '2026-09-25T02:00:00.000Z' });
    expect(snapshot(s.db)).toBe(before);
    const t = text(s.out);
    for (const piece of [
      'Item live #1:', 'status: sent', 'kind: clan_war_found', `dedup original: ${KEY}`, 'event_id: -', `sent_at: ${SENT_AT}`,
      'wa_message_id: true_120363@g.us_3EB0OLD', `>>>>>>\n${s.original.body}\n<<<<<<`, 'guerra 2026-09-24T18:28:34Z ainda em preparation', 'mesma guerra: preparationStartTime 2026-09-24T18:28:34Z',
      'adversário: Vortex (#VORTEX)', `batalha começa: ${BATTLE}`, `nova dedup:\n${NEW_KEY}`, 'nova expiração:\n2026-09-25T02:00:00.000Z (TTL de 6h)',
      'Sem --confirm: nada foi alterado.', 'npm run cli -- outbox:reissue 1 --confirm',
    ]) expect(t).toContain(piece);
  });

  it('recusa com DRY_RUN=true, mesmo com --confirm, sem consultar a API', async () => {
    const s = await setup();
    const before = snapshot(s.db);
    const { client, currentWar } = fakeClient({ war: war('preparation') });
    const r = await runReissue(s.db, { ...s.cfg, dryRun: true }, { id: 1, confirm: true, client, now: NOW, print: s.print });
    expect(r).toEqual({ ok: false, reason: 'outbox:reissue só pode ser usado com DRY_RUN=false' });
    expect(currentWar).not.toHaveBeenCalled();
    expect(snapshot(s.db)).toBe(before);
  });

  it('id inválido ou item inexistente', async () => {
    const s = await setup();
    const { client } = fakeClient({ war: war('preparation') });
    expect(await runReissue(s.db, s.cfg, { id: Number(undefined), confirm: true, client, now: NOW, print: s.print })).toMatchObject({ ok: false, reason: 'informe o id numérico do item live' });
    expect(await runReissue(s.db, s.cfg, { id: 99, confirm: true, client, now: NOW, print: s.print })).toEqual({ ok: false, reason: 'item #99 não encontrado' });
  });

  it('item que não pertence à fila live (mesmo com status sent) é recusado', async () => {
    const s = await setup();
    const dry = new Outbox(s.db, 'dry_run');
    dry.enqueue({ dedupKey: KEY, kind: 'clan_war_found', body: s.original.body, expiresAt: '2099-01-01T00:00:00Z' }, NOW);
    const dryId = dry.list()[0]!.id;
    s.db.run(`UPDATE outbox SET status = 'sent' WHERE id = ?`, dryId);
    const before = snapshot(s.db);
    const r = await runReissue(s.db, s.cfg, { id: dryId, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r).toEqual({ ok: false, reason: `item #${dryId} pertence à fila dry_run, não à live` });
    expect(snapshot(s.db)).toBe(before);
  });

  it.each(['pending', 'sending', 'failed', 'expired', 'superseded', 'uncertain', 'dry_run'])('recusa item com status %s', async (status) => {
    const s = await setup();
    s.db.run('UPDATE outbox SET status = ? WHERE id = 1', status);
    const before = snapshot(s.db);
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`status ${status} não é reemitível`);
    expect(snapshot(s.db)).toBe(before);
  });

  it('recusa kind diferente de clan_war_found', async () => {
    const s = await setup();
    s.db.run(`UPDATE outbox SET kind = 'clan_war_started' WHERE id = 1`);
    const before = snapshot(s.db);
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r).toEqual({ ok: false, reason: 'reissue não suportado para este tipo (clan_war_started)' });
    expect(snapshot(s.db)).toBe(before);
  });

  it('recusa aviso da Liga de Guerra (clan:cwl:*) nesta versão', async () => {
    const s = await setup();
    s.db.run(`UPDATE outbox SET dedup_key = 'clan:cwl:2026-09:#8QJ:preparation' WHERE id = 1`);
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Liga de Guerra');
  });

  it('confirma: mesma guerra ainda em preparation → novo item pending preservando body, kind e event_id', async () => {
    const s = await setup();
    s.db.run(`UPDATE outbox SET event_id = 'clan_war_20260924T182834Z' WHERE id = 1`);
    const original = s.live.get(1)!;
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok && r.reissued).toBe(true);
    const item = s.live.getByKey(NEW_KEY)!;
    expect(item).toMatchObject({
      id: 2, mode: 'live', kind: 'clan_war_found', eventId: 'clan_war_20260924T182834Z', body: original.body,
      dedupKey: NEW_KEY, status: 'pending', attempts: 0, fireAt: NOW, expiresAt: '2026-09-25T02:00:00.000Z',
      sentAt: null, waMessageId: null, leaseUntil: null, lastError: null,
    });
    expect(item.dedupKey).not.toBe(original.dedupKey);
    expect(item.dedupKey).toBe(reissueKey(1, KEY));
    const t = text(s.out);
    for (const piece of ['Item live #1 reemitido como novo item live #2.', 'origem: #1', `dedup: ${NEW_KEY}`, 'status: pending', `fire_at: agora (${NOW})`, 'Nenhuma mensagem foi enviada.', 'npm run cli -- outbox:run']) {
      expect(t).toContain(piece);
    }
  });

  it('item original permanece intacto (status, sent_at, wa_message_id, attempts, last_error, dedup_key, body)', async () => {
    const s = await setup();
    const before = JSON.stringify(s.db.get('SELECT * FROM outbox WHERE id = 1'));
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(s.db.get('SELECT * FROM outbox WHERE id = 1'))).toBe(before);
    expect(s.live.get(1)).toMatchObject({ status: 'sent', sentAt: SENT_AT, waMessageId: 'true_120363@g.us_3EB0OLD', attempts: 1, lastError: null, dedupKey: KEY });
  });

  it('expiração pelo TTL quando a batalha está longe; limitada ao início da batalha quando está perto', async () => {
    const s = await setup();
    const late = '2026-09-25T14:00:00Z'; // now + 6h = 20:00Z, depois do início (17:28:34Z)
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: late, print: s.print });
    expect(r.ok).toBe(true);
    expect(s.live.getByKey(NEW_KEY)!.expiresAt).toBe(BATTLE);
    expect(text(s.out)).toContain(`${BATTLE} (limitada ao início da batalha)`);
  });

  it('recusa se a batalha já começou, mesmo com a API ainda em preparation', async () => {
    const s = await setup();
    const before = snapshot(s.db);
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: BATTLE, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('a batalha já começou');
    expect(snapshot(s.db)).toBe(before);
  });

  it.each([
    ['inWar', war('inWar'), 'já está em inWar'],
    ['warEnded', war('warEnded'), 'já está em warEnded'],
    ['notInWar', { state: 'notInWar' }, 'não está em guerra'],
    ['outra guerra', war('preparation', { preparationStartTime: '20261001T100000.000Z' }), 'guerra atual é outra'],
    ['outro adversário', war('preparation', { opponent: { tag: '#OUTRO', name: 'Outro' } }), 'difere do registrado em clan_state'],
    ['adversário sem tag', war('preparation', { opponent: { name: 'Vortex' } }), 'não informou o adversário'],
    ['início da batalha mudou', war('preparation', { startTime: '20260925T190000.000Z' }), 'início da batalha mudou'],
    ['sem início da batalha', war('preparation', { startTime: undefined }), 'não informou o início da batalha'],
  ])('guerra não corresponde (%s): recusa sem alterar o banco', async (_label, current, reason) => {
    const s = await setup();
    const before = snapshot(s.db);
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: current }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
    expect(snapshot(s.db)).toBe(before);
  });

  it('recusa se o corpo original não cita o adversário atual', async () => {
    const s = await setup();
    s.db.run(`UPDATE outbox SET body = replace(body, 'Adversário: Vortex', 'Adversário: Outro') WHERE id = 1`);
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('o corpo original não cita o adversário atual');
  });

  it('recusa sem registro da guerra em clan_state (não há como confirmar o adversário original)', async () => {
    const s = await setup({ skipClanState: true });
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('sem registro da guerra');
  });

  it('erro da API: recusa sem alterar o banco', async () => {
    const s = await setup();
    const before = snapshot(s.db);
    for (const err of [new CocUnavailableError('timeout'), new CocApiError(403, 'accessDenied', 'HTTP 403')]) {
      const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: fakeClient({ war: err }).client, now: NOW, print: s.print });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('não foi possível consultar a API do Clash');
    }
    expect(snapshot(s.db)).toBe(before);
  });

  it('falta de token/API ou de CLAN_TAG: recusa', async () => {
    const s = await setup();
    const before = snapshot(s.db);
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client: null, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('COC_API_TOKEN e CLAN_TAG');
    const r2 = await runReissue(s.db, { ...s.cfg, coc: { ...s.cfg.coc, clanTag: undefined } }, { id: 1, confirm: true, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
    expect(r2.ok).toBe(false);
    expect(snapshot(s.db)).toBe(before);
  });

  it('segunda reemissão do mesmo item é recusada (também no preview)', async () => {
    const s = await setup();
    const { client } = fakeClient({ war: war('preparation') });
    expect((await runReissue(s.db, s.cfg, { id: 1, confirm: true, client, now: NOW, print: s.print })).ok).toBe(true);
    const before = snapshot(s.db);
    for (const confirm of [true, false]) {
      const r = await runReissue(s.db, s.cfg, { id: 1, confirm, client, now: NOW, print: s.print });
      expect(r).toEqual({ ok: false, reason: 'o item #1 já possui uma reemissão registrada (#2, pending)' });
    }
    expect(snapshot(s.db)).toBe(before);
  });

  it.each(['pending', 'sending', 'sent', 'uncertain', 'failed', 'expired', 'superseded'])('reemissão existente com status %s bloqueia nova reemissão', async (status) => {
    const s = await setup();
    const { client } = fakeClient({ war: war('preparation') });
    await runReissue(s.db, s.cfg, { id: 1, confirm: true, client, now: NOW, print: s.print });
    s.db.run('UPDATE outbox SET status = ? WHERE dedup_key = ?', status, NEW_KEY);
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('o item #1 já possui uma reemissão registrada');
    expect(s.live.list()).toHaveLength(2);
  });

  it('reenvio manual (outbox:resend) de uma reemissão também bloqueia nova reemissão do original', async () => {
    const s = await setup();
    const { client } = fakeClient({ war: war('preparation') });
    await runReissue(s.db, s.cfg, { id: 1, confirm: true, client, now: NOW, print: s.print });
    s.db.run(`UPDATE outbox SET status = 'uncertain' WHERE dedup_key = ?`, NEW_KEY);
    s.live.requeue(2, 6, NOW);
    s.db.run(`DELETE FROM outbox WHERE dedup_key = ?`, NEW_KEY); // só o derivado "#resend" permanece
    const r = await runReissue(s.db, s.cfg, { id: 1, confirm: true, client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('já possui uma reemissão registrada');
  });

  it('a própria reemissão não é reemitível (evita cadeia de duplicatas)', async () => {
    const s = await setup();
    const { client } = fakeClient({ war: war('preparation') });
    await runReissue(s.db, s.cfg, { id: 1, confirm: true, client, now: NOW, print: s.print });
    s.db.run(`UPDATE outbox SET status = 'sent' WHERE id = 2`);
    const r = await runReissue(s.db, s.cfg, { id: 2, confirm: true, client, now: NOW, print: s.print });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('dedup_key inesperada');
    expect(s.live.list()).toHaveLength(2);
  });

  it('não chama sender, não executa worker e não envia WhatsApp: só grava o item pending', async () => {
    const s = await setup();
    const claim = vi.spyOn(Outbox.prototype, 'claimNext');
    const markSent = vi.spyOn(Outbox.prototype, 'markSent');
    const markUncertain = vi.spyOn(Outbox.prototype, 'markUncertain');
    const markFailed = vi.spyOn(Outbox.prototype, 'markFailed');
    for (const confirm of [false, true]) {
      const r = await runReissue(s.db, s.cfg, { id: 1, confirm, client: fakeClient({ war: war('preparation') }).client, now: NOW, print: s.print });
      expect(r.ok).toBe(true);
    }
    expect(waCtor).not.toHaveBeenCalled();
    expect(workerRun).not.toHaveBeenCalled();
    for (const spy of [claim, markSent, markUncertain, markFailed]) expect(spy).not.toHaveBeenCalled();
    expect(s.live.getByKey(NEW_KEY)).toMatchObject({ status: 'pending', attempts: 0, sentAt: null, waMessageId: null, leaseUntil: null });
    expect(s.live.lastSentAt()).toBe(SENT_AT); // nenhum envio novo registrado
  });
});
