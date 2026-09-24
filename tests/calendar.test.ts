import { describe, expect, it } from 'vitest';
import { NOW, globalEvent, harness } from './helpers.js';

describe('calendário: correspondência, versões e campos travados', () => {
  it('mesmo evento vindo de duas fontes/idiomas não duplica (chave por categoria + datas)', () => {
    const { repo } = harness();
    const pt = repo.applyEvent(globalEvent({ title: 'Evento de medalhas Explosão' }), { origin: 'collector:blog', publication: { id: 'blog:pt:explosao' }, confirmedFields: ['start_at', 'end_at'], now: NOW });
    const en = repo.applyEvent(globalEvent({ title: 'Equipment Blast Medal Event' }), { origin: 'collector:inbox', publication: { id: 'inbox:en:abc' }, confirmedFields: ['start_at', 'end_at'], now: NOW });
    expect(en.created).toBe(false);
    expect(en.event.id).toBe(pt.event.id);
    expect(repo.allEvents()).toHaveLength(1);
    expect(repo.eventSources(pt.event.id).map((s) => s.publicationId).sort()).toEqual(['blog:pt:explosao', 'inbox:en:abc']);
    // o coletor não troca o título de um evento existente por outro idioma/fonte: nada relevante mudou
    expect(en.changes).toEqual({});
    expect(en.event.title).toBe('Evento de medalhas Explosão');
  });

  it('um anúncio com vários eventos gera eventos distintos ligados à mesma publicação', () => {
    const { repo } = harness();
    const a = repo.applyEvent(globalEvent({ title: 'Desafio A', category: 'challenge', startAt: '2026-10-01', startPrecision: 'date', endAt: '2026-10-10', endPrecision: 'date' }), { origin: 'collector:blog', publication: { id: 'blog:pt:temporada', segmentKey: 's1' }, now: NOW });
    const b = repo.applyEvent(globalEvent({ title: 'Desafio B', category: 'challenge', startAt: '2026-10-11', startPrecision: 'date', endAt: '2026-10-20', endPrecision: 'date' }), { origin: 'collector:blog', publication: { id: 'blog:pt:temporada', segmentKey: 's2' }, now: NOW });
    expect(a.event.id).not.toBe(b.event.id);
    expect(repo.findEventByPublication('blog:pt:temporada', 's1')?.id).toBe(a.event.id);
    expect(repo.findEventByPublication('blog:pt:temporada', 's2')?.id).toBe(b.event.id);
    // re-coleta do mesmo artigo reencontra pelo vínculo (mesmo sem mudança de datas)
    const again = repo.applyEvent(globalEvent({ title: 'Desafio A', category: 'challenge', startAt: '2026-10-01', startPrecision: 'date', endAt: '2026-10-10', endPrecision: 'date' }), { origin: 'collector:blog', publication: { id: 'blog:pt:temporada', segmentKey: 's1' }, now: NOW });
    expect(again.created).toBe(false);
    expect(again.event.id).toBe(a.event.id);
  });

  it('teaser sem datas seguido do anúncio com datas atualiza o mesmo evento (título na mesma categoria)', () => {
    const { repo } = harness();
    const teaser = repo.applyEvent(globalEvent({ title: 'Evento de medalhas Explosão!', startAt: null, startPrecision: 'unknown', endAt: null, endPrecision: 'unknown' }), { origin: 'collector:blog', publication: { id: 'blog:pt:teaser' }, now: NOW });
    expect(teaser.event.status).toBe('announced');
    const full = repo.applyEvent(globalEvent({ title: 'Evento de medalhas Explosão' }), { origin: 'collector:blog', publication: { id: 'blog:pt:completo' }, now: NOW });
    expect(full.created).toBe(false);
    expect(full.event.id).toBe(teaser.event.id);
    expect(full.event.status).toBe('scheduled');
    expect(full.event.relevantRevision).toBe(2);
  });

  it('coleta parcial não apaga datas nem recompensas conhecidas; last_checked_at não gera versão', () => {
    const { repo } = harness();
    const first = repo.applyEvent(globalEvent({ rewards: [{ label: 'Medalhas', quantity: 100, tier: 'free' }], rewardsStatus: 'known' }), { origin: 'collector:blog', publication: { id: 'p1' }, now: NOW });
    const partial = repo.applyEvent(globalEvent({ endAt: null, endPrecision: 'unknown', rewards: [], rewardsStatus: 'unverified' }), { origin: 'collector:blog', publication: { id: 'p1' }, now: '2026-09-24T13:00:00Z' });
    expect(partial.changes).toEqual({});
    expect(partial.event.endAt).toBe('2026-10-14T08:00:00Z');
    expect(partial.event.rewards).toHaveLength(1);
    expect(partial.event.rewardsStatus).toBe('known');
    expect(partial.event.relevantRevision).toBe(first.event.relevantRevision);
    expect(partial.event.lastCheckedAt).toBe('2026-09-24T13:00:00Z');
    expect(repo.versions(first.event.id)).toHaveLength(1);
  });

  it('importação manual complementa evento existente, trava campos e coletor posterior não sobrescreve (conflito vai para revisão)', () => {
    const { repo } = harness();
    const collected = repo.applyEvent(globalEvent(), { origin: 'collector:blog', publication: { id: 'p1' }, now: NOW });
    const manual = repo.applyEvent(
      { id: collected.event.id, category: 'medal_event', scope: 'global', title: collected.event.title, rewards: [{ label: 'Minério', quantity: 500, tier: 'free' }, { label: 'Visual', tier: 'paid' }], rewardsStatus: 'known' },
      { origin: 'manual', lockFields: ['rewards', 'rewardsStatus'], now: NOW },
    );
    expect(manual.created).toBe(false);
    expect(repo.allEvents()).toHaveLength(1);
    expect(manual.event.rewardsStatus).toBe('known');
    expect(manual.event.fieldLocks).toEqual(['rewards', 'rewardsStatus']);

    // coletor volta com recompensas diferentes, "known": não sobrescreve, registra conflito
    const later = repo.applyEvent(globalEvent({ rewards: [{ label: 'Outra coisa', tier: 'unknown' }], rewardsStatus: 'known' }), { origin: 'collector:blog', publication: { id: 'p1' }, now: NOW });
    expect(later.conflicts).toEqual(['rewards']);
    expect(later.event.rewards.map((r) => r.label).sort()).toEqual(['Minério', 'Visual']);
    const reviews = repo.openReviews();
    expect(reviews.some((r) => r.kind === 'field_conflict' && r.field === 'rewards')).toBe(true);
  });

  it('cancelamento explícito preserva-se mesmo com datas ativas', () => {
    const { repo } = harness();
    const ev = repo.applyEvent(globalEvent({ startAt: '2026-09-20T08:00:00Z', endAt: '2026-09-30T08:00:00Z' }), { origin: 'collector:blog', now: NOW });
    expect(ev.event.status).toBe('active');
    const c = repo.cancelEvent(ev.event.id, 'adiado pela Supercell', 'manual', NOW)!;
    expect(c.status).toBe('cancelled');
    const re = repo.applyEvent(globalEvent({ startAt: '2026-09-20T08:00:00Z', endAt: '2026-09-30T08:00:00Z' }), { origin: 'collector:blog', now: NOW });
    expect(re.event.status).toBe('cancelled');
  });

  it('mudança de datas incrementa revisão e registra diff', () => {
    const { repo } = harness();
    const a = repo.applyEvent(globalEvent(), { origin: 'collector:blog', publication: { id: 'p1' }, now: NOW });
    const b = repo.applyEvent(globalEvent({ endAt: '2026-10-16T08:00:00Z' }), { origin: 'collector:blog', publication: { id: 'p1' }, now: NOW });
    expect(b.changes.endAt).toEqual({ from: '2026-10-14T08:00:00Z', to: '2026-10-16T08:00:00Z' });
    expect(b.event.relevantRevision).toBe(a.event.relevantRevision + 1);
    expect(repo.versions(a.event.id).map((v) => v.revision)).toEqual([1, 2]);
  });
});
