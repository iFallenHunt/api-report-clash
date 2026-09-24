import { describe, expect, it } from 'vitest';
import { Outbox } from '../src/outbox/queue.js';
import { Engine } from '../src/scheduler/engine.js';
import { NOW, globalEvent, harness } from './helpers.js';

function keys(h: ReturnType<typeof harness>, status?: string) {
  return h.db
    .all<{ dedup_key: string; status: string }>('SELECT dedup_key, status FROM outbox WHERE mode = ? ORDER BY id', h.outbox.mode)
    .filter((r) => !status || r.status === status)
    .map((r) => r.dedup_key);
}

describe('motor de avisos', () => {
  it('evento novo após o relatório semanal gera aviso de anúncio (uma vez)', () => {
    const h = harness();
    h.engine.runReport('weekly', NOW);
    const res = h.repo.applyEvent(globalEvent(), { origin: 'collector:blog', now: NOW });
    h.engine.onEventApplied(res, NOW);
    h.engine.onEventApplied(res, NOW); // repetição não duplica
    expect(keys(h)).toEqual([h.engine.reportKey('weekly', NOW), `event_announced:${res.event.id}`]);
    const body = h.outbox.list('pending').find((i) => i.kind === 'event_announced')!.body;
    expect(body).toContain('NOVO ANÚNCIO');
    expect(body).toContain('ainda não começou');
  });

  it('anunciado ≠ iniciado: o início só é avisado na transição, e correção de recompensa não repete', () => {
    const h = harness();
    const res = h.repo.applyEvent(globalEvent({ startAt: '2026-09-24T12:30:00Z', endAt: '2026-10-05T12:00:00Z' }), { origin: 'collector:blog', publication: { id: 'p1' }, now: NOW });
    h.engine.onEventApplied(res, NOW);
    expect(keys(h)).toEqual([`event_announced:${res.event.id}`]);

    h.engine.tick('2026-09-24T12:31:00Z');
    expect(keys(h)).toContain(`event_started:${res.event.id}`);
    const startedCount = () => h.db.get<{ n: number }>("SELECT COUNT(*) n FROM outbox WHERE kind = 'event_started'")!.n;
    expect(startedCount()).toBe(1);

    // correção de recompensas: gera "atualizado", não repete "iniciado"
    const fix = h.repo.applyEvent(globalEvent({ startAt: '2026-09-24T12:30:00Z', endAt: '2026-10-05T12:00:00Z', rewards: [{ label: 'Medalhas', quantity: 500, tier: 'free' }], rewardsStatus: 'known' }), { origin: 'collector:blog', publication: { id: 'p1' }, now: '2026-09-24T12:40:00Z' });
    h.engine.onEventApplied(fix, '2026-09-24T12:40:00Z');
    h.engine.tick('2026-09-24T12:41:00Z');
    expect(startedCount()).toBe(1);
    expect(keys(h)).toContain(`event_updated:${fix.event.id}:r${fix.event.relevantRevision}`);
  });

  it('evento que já começou ao ser anunciado não recebe "iniciado" depois', () => {
    const h = harness();
    const res = h.repo.applyEvent(globalEvent({ startAt: '2026-09-20T08:00:00Z', endAt: '2026-10-05T08:00:00Z' }), { origin: 'collector:blog', now: NOW });
    h.engine.onEventApplied(res, NOW);
    h.engine.tick('2026-09-24T12:05:00Z');
    expect(keys(h, 'pending')).toEqual([`event_announced:${res.event.id}`]);
    expect(h.outbox.list('pending')[0]!.body).toContain('já está em andamento');
  });

  it('mudança de horário invalida lembrete pendente e avisa a alteração', () => {
    const h = harness({ cfg: { reminders: { leadGlobalHours: 24, leadClanHours: 2, anchors: ['end'] } } });
    const res = h.repo.applyEvent(globalEvent({ startAt: '2026-09-10T08:00:00Z', endAt: '2026-09-25T08:00:00Z' }), { origin: 'collector:blog', publication: { id: 'p1' }, now: NOW });
    h.engine.onEventApplied(res, NOW);
    h.engine.tick(NOW); // faltam 20h para o fim → lembrete de 24h dispara
    const remKey = `reminder:${res.event.id}:end:24`;
    expect(keys(h, 'pending')).toContain(remKey);
    const rem = h.outbox.list('pending').find((i) => i.dedupKey === remKey)!;
    expect(rem.expiresAt).toBe('2026-09-25T08:00:00.000Z');
    expect(rem.body).toContain('TERMINA EM');

    // fonte confirma novo término: lembrete antigo fica superseded, aviso de alteração é enfileirado
    const changed = h.repo.applyEvent(globalEvent({ startAt: '2026-09-10T08:00:00Z', endAt: '2026-09-28T08:00:00Z' }), { origin: 'collector:blog', publication: { id: 'p1' }, now: '2026-09-24T13:00:00Z' });
    h.engine.onEventApplied(changed, '2026-09-24T13:00:00Z');
    expect(h.outbox.get(rem.id)!.status).toBe('superseded');
    expect(keys(h, 'pending')).toContain(`event_changed:${res.event.id}:r${changed.event.relevantRevision}`);
    const body = h.outbox.list('pending').find((i) => i.kind === 'event_changed')!.body;
    expect(body).toContain('ALTERAÇÃO CONFIRMADA');
    expect(body).toContain('Mudou: término');

    // novo lembrete só quando chegar a hora do novo término (e com a mesma chave? não: chave já usada → precisa nova)
    h.engine.tick('2026-09-27T09:00:00Z');
    // a chave de lembrete é por (evento, âncora, antecedência); a versão anterior foi superseded, então
    // um novo lembrete precisa de outra chave — o motor não recria a mesma chave (dedup) por desenho
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) n FROM outbox WHERE kind = ? AND status = ?', 'reminder', 'pending')!.n).toBe(0);
  });

  it('cancelamento confirmado invalida tudo pendente e avisa', () => {
    const h = harness();
    const res = h.repo.applyEvent(globalEvent({ startAt: '2026-09-25T08:00:00Z', endAt: '2026-10-05T08:00:00Z' }), { origin: 'collector:blog', now: NOW });
    h.engine.onEventApplied(res, NOW);
    const before = h.repo.getEvent(res.event.id)!;
    const cancelled = h.repo.cancelEvent(res.event.id, 'adiado', 'manual', NOW)!;
    h.engine.onEventApplied({ event: cancelled, created: false, changes: { status: { from: before.status, to: 'cancelled' } }, conflicts: [] }, NOW);
    expect(keys(h, 'pending')).toEqual([`event_cancelled:${res.event.id}`]);
    expect(h.outbox.get(1)!.status).toBe('superseded');
    // após cancelar, o tick não agenda lembretes nem "iniciado"
    h.engine.tick('2026-09-25T08:01:00Z');
    h.engine.tick('2026-10-04T09:00:00Z');
    expect(keys(h, 'pending')).toEqual([`event_cancelled:${res.event.id}`]);
  });

  it('lembretes: evento curto não recebe; lembrete de início exige conhecimento prévio; encerrado não recebe', () => {
    const h = harness({ cfg: { reminders: { leadGlobalHours: 24, leadClanHours: 2, anchors: ['start', 'end'] } } });
    // curto (6h < 2×24h)
    const short = h.repo.applyEvent(globalEvent({ title: 'Curto', startAt: '2026-09-25T08:00:00Z', endAt: '2026-09-25T14:00:00Z' }), { origin: 'collector:blog', now: NOW });
    // início em 10h, mas só conhecido agora (depois do ponto de 24h) → sem lembrete de início
    const late = h.repo.applyEvent(globalEvent({ title: 'Tarde', category: 'season', startAt: '2026-09-24T22:00:00Z', endAt: '2026-10-24T22:00:00Z' }), { origin: 'collector:blog', now: NOW });
    // já encerrado
    const ended = h.repo.applyEvent(globalEvent({ title: 'Velho', category: 'challenge', startAt: '2026-09-01T08:00:00Z', endAt: '2026-09-10T08:00:00Z' }), { origin: 'collector:blog', now: NOW });
    h.engine.tick(NOW);
    const pend = keys(h, 'pending');
    expect(pend.some((k) => k.includes(short.event.id))).toBe(false);
    expect(pend.some((k) => k.includes(late.event.id))).toBe(false);
    expect(pend.some((k) => k.includes(ended.event.id))).toBe(false);

    // conhecido com antecedência: lembrete de início dispara a 24h
    const early = h.repo.applyEvent(globalEvent({ title: 'Cedo', category: 'clan_games', startAt: '2026-09-30T08:00:00Z', endAt: '2026-10-06T08:00:00Z' }), { origin: 'collector:blog', now: NOW });
    h.engine.tick('2026-09-29T09:00:00Z');
    expect(keys(h, 'pending')).toContain(`reminder:${early.event.id}:start:24`);
    // e o de término a 24h do fim, expirando no fim
    h.engine.tick('2026-10-05T09:00:00Z');
    const endRem = h.outbox.list('pending').find((i) => i.dedupKey === `reminder:${early.event.id}:end:24`)!;
    expect(endRem).toBeDefined();
    expect(endRem.expiresAt).toBe('2026-10-06T08:00:00.000Z');
  });

  it('lembrete é suprimido a ±1h do relatório semanal', () => {
    // semanal: segunda 09:00 America/Sao_Paulo = 12:00Z; 2026-09-28 é segunda
    const h = harness();
    const ev = h.repo.applyEvent(globalEvent({ startAt: '2026-09-10T08:00:00Z', endAt: '2026-09-29T08:00:00Z' }), { origin: 'collector:blog', now: NOW });
    h.engine.tick('2026-09-28T11:30:00Z');
    expect(keys(h, 'pending')).not.toContain(`reminder:${ev.event.id}:end:24`);
    h.engine.tick('2026-09-28T14:00:00Z');
    expect(keys(h, 'pending')).toContain(`reminder:${ev.event.id}:end:24`);
  });

  it('relatórios: dedup por período, catch-up só dentro da janela, atualização mensal só com mudanças', () => {
    const h = harness();
    expect(h.engine.runReport('monthly', NOW)).toBe(true);
    expect(h.engine.runReport('monthly', '2026-09-25T12:00:00Z')).toBe(false);
    expect(h.engine.runReport('weekly', NOW)).toBe(true);
    expect(h.engine.runReport('weekly', '2026-09-26T12:00:00Z')).toBe(false);
    expect(h.engine.runMonthlyUpdate('2026-09-25T15:00:00Z')).toBe(false); // nada mudou

    const res = h.repo.applyEvent(globalEvent({ startAt: '2026-09-28T08:00:00Z', endAt: '2026-09-30T08:00:00Z' }), { origin: 'collector:blog', now: '2026-09-25T15:00:00Z' });
    h.engine.onEventApplied(res, '2026-09-25T15:00:00Z');
    expect(h.engine.runMonthlyUpdate('2026-09-25T15:00:00Z')).toBe(true);
    const upd = h.outbox.list('pending').find((i) => i.kind === 'report_monthly_update')!;
    expect(upd.body).toContain('ATUALIZAÇÃO DO CALENDÁRIO');
    expect(upd.body).toContain('Novos');
    expect(h.engine.runMonthlyUpdate('2026-09-25T16:00:00Z')).toBe(false); // mesmas mudanças não repetem

    // catch-up: relatório semanal previsto para segunda 12:00Z; reinício às 14:00Z (dentro de 6h) gera; às 20:00Z não
    const h2 = harness();
    h2.engine.catchUp('2026-09-28T14:00:00Z');
    expect(keys(h2)).toContain('report:weekly:2026-W40');
    const h3 = harness();
    h3.engine.catchUp('2026-09-28T20:00:00Z');
    expect(keys(h3)).toEqual([]);
  });

  it('DRY_RUN não consome a deduplicação do modo real; ao ativar, só o que é atual entra', () => {
    const h = harness({ mode: 'dry_run' });
    const res = h.repo.applyEvent(globalEvent({ startAt: '2026-09-24T12:30:00Z', endAt: '2026-10-05T08:00:00Z' }), { origin: 'collector:blog', now: NOW });
    h.engine.onEventApplied(res, NOW);
    h.engine.runReport('weekly', NOW);
    h.engine.tick('2026-09-24T12:31:00Z'); // iniciado
    expect(keys(h).length).toBe(3);

    // mesmo banco, agora em modo real
    const live = new Outbox(h.db, 'live');
    const engineLive = new Engine({ db: h.db, repo: h.repo, outbox: live, cfg: { ...h.cfg, dryRun: false }, log: h.log, announcementsHealth: () => h.health });
    expect(live.list()).toEqual([]); // estoque do dry-run não vaza
    // muito tempo depois: o "iniciado" já não é atual (fora do TTL) → não é gerado; o semanal do período é novo no modo live
    engineLive.tick('2026-09-25T12:00:00Z');
    expect(live.list().map((i) => i.dedupKey)).toEqual([]);
    engineLive.runReport('weekly', '2026-09-25T12:00:00Z');
    expect(live.list().map((i) => i.dedupKey)).toEqual(['report:weekly:2026-W39']);
    // itens do dry-run permanecem no seu modo, intocados
    expect(keys(h).length).toBe(3);
  });
});
