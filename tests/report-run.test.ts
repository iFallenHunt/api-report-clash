import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReportRun } from '../src/cli/report-run.js';
import { Outbox } from '../src/outbox/queue.js';
import { Engine } from '../src/scheduler/engine.js';
import { NOW, globalEvent, harness } from './helpers.js';

// O comando nunca pode montar o cliente do WhatsApp nem rodar o worker: se tentar, os espiões acusam.
const waCtor = vi.hoisted(() => vi.fn());
const workerRun = vi.hoisted(() => vi.fn());
vi.mock('../src/whatsapp/client.js', () => ({ WhatsAppSender: waCtor }));
vi.mock('../src/outbox/worker.js', () => ({ runOutboxWorker: workerRun, DryRunSender: vi.fn() }));

const KEY = 'report:weekly:2026-W39'; // NOW = quinta 24/09/2026
const TTL_EXP = '2026-09-25T00:00:00.000Z'; // NOW + REPORT_TTL_HOURS (12h)

/** Banco temporário em memória, aplicação em modo live e eventos reais no calendário. */
function setup(opts: { reportTtlHours?: number } = {}) {
  const base = harness({ mode: 'live' });
  const h = opts.reportTtlHours
    ? harness({ mode: 'live', db: base.db, cfg: { delivery: { ...base.cfg.delivery, reportTtlHours: opts.reportTtlHours } } })
    : base;
  const at = { origin: 'collector:blog', now: '2026-09-20T12:00:00Z' };
  h.repo.applyEvent(globalEvent({ title: 'Jogos do Clã', category: 'clan_games', startAt: '2026-09-22T08:00:00Z', endAt: '2026-09-28T08:00:00Z' }), at);
  h.repo.applyEvent(globalEvent({ title: 'Desafio do John Cena', category: 'challenge', startAt: '2026-09-23T08:00:00Z', endAt: '2026-09-27T08:00:00Z' }), at);
  h.repo.applyEvent(globalEvent({ title: 'Evento de Medalhas de Outubro', startAt: '2026-09-29T08:00:00Z', endAt: '2026-10-10T08:00:00Z' }), at);
  const out: string[] = [];
  return { ...h, out, print: (s: string) => out.push(s) };
}

const dump = (h: ReturnType<typeof setup>) => JSON.stringify([h.db.all('SELECT * FROM outbox ORDER BY id'), h.db.all('SELECT * FROM report_marks ORDER BY mode, key')]);
const marks = (h: ReturnType<typeof setup>) => h.db.all<{ mode: string; key: string }>('SELECT mode, key FROM report_marks ORDER BY mode, key');
const text = (out: string[]) => out.join('\n');

afterEach(() => vi.restoreAllMocks());

describe('report:run weekly', () => {
  it('recusa com DRY_RUN=true, mesmo com --confirm, sem gerar nada', () => {
    const h = setup();
    const before = dump(h);
    const r = runReportRun(h, { ...h.cfg, dryRun: true }, { kind: 'weekly', confirm: true, now: NOW, print: h.print });
    expect(r).toEqual({ ok: false, reason: 'report:run só pode ser usado com DRY_RUN=false (enfileira no modo live)' });
    expect(dump(h)).toBe(before);
    expect(h.out).toEqual([]);
  });

  it('argumento ausente', () => {
    const h = setup();
    expect(runReportRun(h, h.cfg, { kind: undefined, confirm: true, now: NOW, print: h.print })).toEqual({ ok: false, reason: 'informe o tipo do relatório: report:run weekly' });
    expect(marks(h)).toEqual([]);
  });

  it.each([
    ['monthly', 'report:run monthly ainda não é suportado; nesta versão só weekly'],
    ['foo', 'tipo de relatório desconhecido: foo (suportado: weekly)'],
  ])('tipo %s é recusado', (kind, reason) => {
    const h = setup();
    const before = dump(h);
    expect(runReportRun(h, h.cfg, { kind, confirm: true, now: NOW, print: h.print })).toEqual({ ok: false, reason });
    expect(dump(h)).toBe(before);
  });

  it('recusa se a fila da aplicação não estiver em live', () => {
    const h = setup();
    const dry = { engine: h.engine, outbox: new Outbox(h.db, 'dry_run') };
    const r = runReportRun(dry, h.cfg, { kind: 'weekly', confirm: true, now: NOW, print: h.print });
    expect(r.ok).toBe(false);
    expect(marks(h)).toEqual([]);
  });

  it('preview sem --confirm: mostra tipo, modo, dedup, expiração e o corpo real; não altera o banco', () => {
    const h = setup();
    const runReport = vi.spyOn(Engine.prototype, 'runReport');
    const before = dump(h);
    const r = runReportRun(h, h.cfg, { kind: 'weekly', confirm: false, now: NOW, print: h.print });
    const expected = h.engine.buildReport('weekly', NOW);
    expect(r).toEqual({ ok: true, queued: false, dedupKey: KEY, expiresAt: TTL_EXP, body: expected });
    expect(dump(h)).toBe(before);
    expect(marks(h)).toEqual([]); // sem report_marks
    expect(h.outbox.list()).toEqual([]); // sem item na fila
    expect(runReport).not.toHaveBeenCalled();
    expect(expected).toContain('RESUMO DA SEMANA');
    expect(expected).toContain('Jogos do Clã');
    const t = text(h.out);
    for (const piece of [
      'tipo: weekly', 'modo: live', `dedup_key: ${KEY}`, `expiração prevista: ${TTL_EXP} (REPORT_TTL_HOURS=12h)`,
      `>>>>>>\n${expected}\n<<<<<<`, 'já gerado neste período (live): não', 'Sem --confirm: nada foi alterado.', 'Para enfileirar:\nnpm run cli -- report:run weekly --confirm',
    ]) expect(t).toContain(piece);
  });

  it('--confirm: usa Engine.runReport e cria report_mark + item report_weekly pending com o corpo do buildReport', () => {
    const h = setup();
    const runReport = vi.spyOn(Engine.prototype, 'runReport');
    const expected = h.engine.buildReport('weekly', NOW);
    const r = runReportRun(h, h.cfg, { kind: 'weekly', confirm: true, now: NOW, print: h.print });
    expect(r.ok && r.queued).toBe(true);
    expect(runReport).toHaveBeenCalledTimes(1);
    expect(runReport).toHaveBeenCalledWith('weekly', NOW);
    expect(marks(h)).toEqual([{ mode: 'live', key: KEY }]);
    expect(h.outbox.list()).toHaveLength(1);
    expect(h.outbox.getByKey(KEY)).toMatchObject({
      mode: 'live', kind: 'report_weekly', dedupKey: KEY, body: expected, status: 'pending', attempts: 0,
      fireAt: NOW, expiresAt: TTL_EXP, sentAt: null, waMessageId: null, leaseUntil: null, lastError: null,
    });
    const t = text(h.out);
    for (const piece of ['Relatório semanal enfileirado.', 'kind: report_weekly', `dedup: ${KEY}`, 'status: pending', 'Nenhuma mensagem foi enviada.', 'npm run cli -- outbox:list pending', 'npm run cli -- outbox:run']) {
      expect(t).toContain(piece);
    }
  });

  it('é idêntico ao que o agendador geraria no mesmo instante (mesma chave, corpo, kind e expiração)', () => {
    const manual = setup();
    const scheduled = setup();
    runReportRun(manual, manual.cfg, { kind: 'weekly', confirm: true, now: NOW, print: manual.print });
    scheduled.engine.runReport('weekly', NOW);
    const pick = (h: ReturnType<typeof setup>) => h.outbox.list().map(({ dedupKey, kind, body, fireAt, expiresAt, status, attempts }) => ({ dedupKey, kind, body, fireAt, expiresAt, status, attempts }));
    expect(pick(manual)).toEqual(pick(scheduled));
    expect(marks(manual)).toEqual(marks(scheduled));
  });

  it('expiração segue REPORT_TTL_HOURS da configuração', () => {
    const h = setup({ reportTtlHours: 3 });
    const r = runReportRun(h, h.cfg, { kind: 'weekly', confirm: true, now: NOW, print: h.print });
    expect(r.ok).toBe(true);
    expect(h.outbox.getByKey(KEY)!.expiresAt).toBe('2026-09-24T15:00:00.000Z');
  });

  it('segunda execução na mesma semana é recusada (preview e --confirm), sem duplicar report_mark nem fila', () => {
    const h = setup();
    expect(runReportRun(h, h.cfg, { kind: 'weekly', confirm: true, now: NOW, print: h.print }).ok).toBe(true);
    const before = dump(h);
    const runReport = vi.spyOn(Engine.prototype, 'runReport');
    for (const [confirm, now] of [[true, NOW], [false, NOW], [true, '2026-09-27T20:00:00Z']] as const) {
      h.out.length = 0;
      const r = runReportRun(h, h.cfg, { kind: 'weekly', confirm, now, print: h.print });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain('relatório semanal já foi gerado para este período');
        expect(r.reason).toContain(`report_mark de ${NOW}; item live #1 [pending]`);
      }
      expect(text(h.out)).toContain('já gerado neste período (live): sim');
    }
    expect(runReport).not.toHaveBeenCalled();
    expect(dump(h)).toBe(before);
    expect(marks(h)).toEqual([{ mode: 'live', key: KEY }]);
    expect(h.outbox.list()).toHaveLength(1);
  });

  it('relatório da semana já gerado pelo agendador também bloqueia', () => {
    const h = setup();
    h.engine.runReport('weekly', '2026-09-21T12:00:00Z'); // segunda da mesma semana ISO
    const r = runReportRun(h, h.cfg, { kind: 'weekly', confirm: true, now: NOW, print: h.print });
    expect(r.ok).toBe(false);
    expect(h.outbox.list()).toHaveLength(1);
  });

  it('item já na fila live sem report_mark (inconsistente) também é recusado', () => {
    const h = setup();
    h.outbox.enqueue({ dedupKey: KEY, kind: 'report_weekly', body: 'x', expiresAt: '2099-01-01T00:00:00Z' }, NOW);
    const before = dump(h);
    const r = runReportRun(h, h.cfg, { kind: 'weekly', confirm: true, now: NOW, print: h.print });
    expect(r.ok).toBe(false);
    expect(dump(h)).toBe(before);
  });

  it('relatório gerado em DRY_RUN não consome a semana do modo live', () => {
    const h = setup();
    const dryEngine = new Engine({ db: h.db, repo: h.repo, outbox: new Outbox(h.db, 'dry_run'), cfg: { ...h.cfg, dryRun: true }, log: h.log, announcementsHealth: () => h.health });
    dryEngine.runReport('weekly', NOW);
    const r = runReportRun(h, h.cfg, { kind: 'weekly', confirm: true, now: NOW, print: h.print });
    expect(r.ok).toBe(true);
    expect(marks(h)).toEqual([{ mode: 'dry_run', key: KEY }, { mode: 'live', key: KEY }]);
  });

  it('não inicia WhatsApp, não chama sender nem worker: o item termina pending', () => {
    const h = setup();
    const spies = (['claimNext', 'markSent', 'markUncertain', 'markFailed'] as const).map((m) => vi.spyOn(Outbox.prototype, m));
    for (const confirm of [false, true]) expect(runReportRun(h, h.cfg, { kind: 'weekly', confirm, now: NOW, print: h.print }).ok).toBe(true);
    expect(waCtor).not.toHaveBeenCalled();
    expect(workerRun).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(h.outbox.getByKey(KEY)).toMatchObject({ status: 'pending', attempts: 0, sentAt: null });
    expect(h.outbox.lastSentAt()).toBeNull();
  });
});
