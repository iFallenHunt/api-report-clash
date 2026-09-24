import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlogSource } from '../src/collectors/announcements/blog.js';
import { classify, extractEvents, extractRewards, parseDateExpression } from '../src/collectors/announcements/extract.js';
import { htmlToBlocks } from '../src/collectors/announcements/html.js';
import { InboxSource } from '../src/collectors/announcements/inbox.js';
import { ingestPublication, runAnnouncementSource } from '../src/collectors/announcements/index.js';
import { SourceUnavailableError, type Publication } from '../src/collectors/announcements/types.js';
import { harness, NOW } from './helpers.js';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const PUB = '2026-09-09T09:48:44Z';

describe('interpretação de datas em prosa', () => {
  it('PT e EN com horário UTC → datetime', () => {
    expect(parseDateExpression('9 de setembro, às 8h (UTC)', PUB)).toMatchObject({ iso: '2026-09-09T08:00:00Z', precision: 'datetime', yearInferred: true });
    expect(parseDateExpression('September 22 at 08:00 UTC', PUB)).toMatchObject({ iso: '2026-09-22T08:00:00Z', precision: 'datetime' });
    expect(parseDateExpression('October 1st at 08:00 UTC', PUB)).toMatchObject({ iso: '2026-10-01T08:00:00Z', precision: 'datetime' });
  });
  it('sem horário → date; horário sem fuso → date com nota; sem ano e sem publicação → null', () => {
    expect(parseDateExpression('24 de setembro', PUB)).toMatchObject({ iso: '2026-09-24', precision: 'date' });
    expect(parseDateExpression('September 9 at 8am', PUB)).toMatchObject({ iso: '2026-09-09', precision: 'date', timeWithoutTz: true });
    expect(parseDateExpression('September 9 at 08:00 UTC', null)).toBeNull();
    expect(parseDateExpression('9 de setembro de 2027, às 8h UTC', null)).toMatchObject({ iso: '2027-09-09T08:00:00Z', yearInferred: false });
  });
  it('ano inferido da publicação atravessa a virada do ano', () => {
    expect(parseDateExpression('5 de janeiro', '2026-12-20T00:00:00Z')?.iso).toBe('2027-01-05');
    expect(parseDateExpression('20 de dezembro', '2027-01-03T00:00:00Z')?.iso).toBe('2026-12-20');
  });
});

describe('extração a partir de publicações reais (fixtures)', () => {
  it('post de evento de medalhas (EN): datas em UTC, recompensas não verificadas', () => {
    const src = new BlogSource('en');
    const pub = src.parsePost(fx('blog-post-equipment-blast-en.html'), { id: 'blog:en:equipment-blast-medal-event', url: 'https://supercell.com/x', title: 'x', publishedAt: null });
    expect(pub.publishedAt).toBe('2026-09-09T09:48:44.027Z');
    const ev = extractEvents(pub);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.input).toMatchObject({ category: 'medal_event', title: 'Equipment Blast Medal Event', startAt: '2026-09-09T08:00:00Z', startPrecision: 'datetime', endAt: '2026-09-22T08:00:00Z', endPrecision: 'datetime', rewardsStatus: 'unverified' });
    expect(ev[0]!.confirmedFields).toEqual(expect.arrayContaining(['start_at', 'end_at', 'year_inferred_from_publish_date']));
    expect(ev[0]!.notes.some((n) => n.startsWith('recompensas'))).toBe(true);
  });

  it('mesmo post em PT produz as mesmas datas (chave canônica igual)', () => {
    const pub = new BlogSource('pt').parsePost(fx('blog-post-equipment-blast-pt.html'), { id: 'blog:pt:x', url: 'https://supercell.com/pt', title: 'x', publishedAt: null });
    const ev = extractEvents(pub);
    expect(ev[0]!.input).toMatchObject({ category: 'medal_event', startAt: '2026-09-09T08:00:00Z', endAt: '2026-09-22T08:00:00Z' });
  });

  it('post de temporada (calendário mensal) gera um evento por item, em EN e PT', () => {
    for (const [file, locale] of [['blog-post-wwe-season-en.html', 'en'], ['blog-post-wwe-season-pt.html', 'pt']] as const) {
      const pub = new BlogSource(locale).parsePost(fx(file), { id: `blog:${locale}:s`, url: 'https://supercell.com/s', title: 'x', publishedAt: null });
      const ev = extractEvents(pub);
      expect(ev.length).toBeGreaterThanOrEqual(20);
      expect(ev[0]!.input.category).toBe('season');
      // término vem da frase explícita "terminar em 1º de outubro" / "ends on October 1st", não dos itens
      expect(ev[0]!.input).toMatchObject({ startAt: '2026-09-01', endAt: '2026-10-01', startPrecision: 'date', endPrecision: 'date' });
      expect(ev[0]!.confirmedFields).toContain('start_at_derived_from_calendar_items');
      expect(ev[0]!.confirmedFields).not.toContain('end_at_derived_from_calendar_items');
      const cats = ev.map((e) => e.input.category);
      expect(cats).toContain('clan_games');
      expect(cats).toContain('cwl');
      expect(cats).toContain('challenge');
      const games = ev.find((e) => e.input.category === 'clan_games')!.input;
      expect(games).toMatchObject({ startAt: '2026-09-22', endAt: '2026-09-28', startPrecision: 'date', endPrecision: 'date' });
      // dois itens com o mesmo título em datas diferentes são eventos distintos
      const boosts = ev.filter((e) => /collector boosts|coletores de recursos/i.test(e.input.title));
      expect(boosts).toHaveLength(2);
      expect(new Set(ev.map((e) => e.segmentKey)).size).toBe(ev.length);
      // item de um único dia
      const single = ev.find((e) => /mash-a-rama|mistur-a-rama/i.test(e.input.title))!.input;
      expect(single.startAt).toBe('2026-09-15');
      expect(single.endAt).toBe('2026-09-15');
    }
  });

  it('listagem do blog em PT traz título, URL e data ISO', () => {
    const list = new BlogSource('pt').parseListing(fx('blog-listing-pt.html'));
    expect(list.length).toBeGreaterThan(3);
    expect(list[0]).toMatchObject({ id: 'blog:pt:evento-de-medalhas-explosao-de-espolios-da-wwe', publishedAt: '2026-09-09T09:48:44.656Z' });
    expect(list[0]!.url).toMatch(/^https:\/\/supercell\.com\/en\/games\/clashofclans\/pt\/blog\/news\//);
  });

  it('inbox do jogo (PT): HTML → blocos, datas iguais às do blog', async () => {
    const src = new InboxSource('pt');
    const list = src.parseListing(fx('inbox-pt.json'));
    const item = list.find((l) => /Explos/.test(l.title))!;
    const pub = await src.fetch(item);
    expect(pub.blocks.some((b) => b.type === 'list' && b.items.some((i) => i.startsWith('Início do evento')))).toBe(true);
    const ev = extractEvents(pub);
    expect(ev[0]!.input).toMatchObject({ startAt: '2026-09-09T08:00:00Z', endAt: '2026-09-22T08:00:00Z', primarySourceUrl: null });
  });
});

describe('recompensas estruturadas', () => {
  it('só extrai listas sob um título de recompensas; quantidade e pago/grátis explícitos', () => {
    const blocks = htmlToBlocks('<h3>Recompensas</h3><ul><li>1.200x Medalhas: completar a trilha</li><li>Visual Lendário: Passe Ouro</li><li>Poção grátis</li></ul><h3>Outra seção</h3><ul><li>Não é recompensa</li></ul>');
    const r = extractRewards(blocks);
    expect(r).toEqual([
      { label: '1.200x Medalhas', quantity: 1200, condition: 'completar a trilha', tier: 'unknown' },
      { label: 'Visual Lendário', condition: 'Passe Ouro', tier: 'paid' },
      { label: 'Poção grátis', tier: 'free' },
    ]);
  });
  it('classificação por palavras-chave', () => {
    expect(classify('Jogos do Clã')).toBe('clan_games');
    expect(classify('Liga das Guerras de Clãs')).toBe('cwl');
    expect(classify('Upcoming Balance Adjustment')).toBe('update');
    expect(classify('Hero Skin: Kane')).toBe('cosmetic');
    expect(classify('Visual de herói Cody Rhodes (Rei Bárbaro)')).toBe('cosmetic');
    expect(classify('Gold Pass')).toBe('other');
  });
});

describe('ingestão e falha de fonte', () => {
  function pub(over: Partial<Publication> = {}): Publication {
    return { id: 'blog:pt:a', sourceKind: 'blog', url: 'https://supercell.com/a', locale: 'pt', title: 'Evento de medalhas Teste', publishedAt: NOW, blocks: [{ type: 'list', items: ['Início do evento: 1 de outubro, às 8h (UTC)', 'Término do evento: 14 de outubro, às 8h (UTC)'] }], ...over };
  }

  it('um artigo com vários eventos cria vários eventos ligados à publicação; reprocesso sem mudança não gera nada', () => {
    const h = harness();
    const p = pub({ title: 'Temporada Teste', blocks: [
      { type: 'paragraph', text: 'De 1º a 30 de outubro: tropas temporárias. Descrição.' },
      { type: 'paragraph', text: 'De 5 a 11 de outubro: Jogos do Clã. Ganhe pontos.' },
      { type: 'paragraph', text: '20 de outubro: personalização. Volta à loja.' },
    ] });
    const r1 = ingestPublication(p, h.repo, h.engine, h.log, NOW);
    expect(r1.created).toBe(4); // temporada + 3 itens
    const games = h.repo.allEvents().find((e) => e.category === 'clan_games')!;
    expect(h.repo.eventSources(games.id)[0]!.publicationId).toBe('blog:pt:a');
    const r2 = ingestPublication(p, h.repo, h.engine, h.log, '2026-09-24T13:00:00Z');
    expect(r2).toEqual({ created: 0, updated: 0, changed: false });
    expect(h.repo.allEvents()).toHaveLength(4);
  });

  it('mesmo evento em blog e inbox: um só evento com duas fontes', () => {
    const h = harness();
    ingestPublication(pub(), h.repo, h.engine, h.log, NOW);
    ingestPublication(pub({ id: 'inbox:pt:999', sourceKind: 'inbox', url: 'https://clashofclans.inbox.supercell.com/#999' }), h.repo, h.engine, h.log, NOW);
    const all = h.repo.allEvents();
    expect(all).toHaveLength(1);
    expect(h.repo.eventSources(all[0]!.id).map((s) => s.sourceKind).sort()).toEqual(['blog', 'inbox']);
    expect(all[0]!.primarySourceUrl).toBe('https://supercell.com/a');
  });

  it('calendário mensal (só dias) não rebaixa a precisão do post dedicado (com horário)', () => {
    const h = harness();
    ingestPublication(pub(), h.repo, h.engine, h.log, NOW);
    ingestPublication(pub({ id: 'blog:pt:calendario', url: 'https://supercell.com/cal', title: 'Temporada de Outubro', blocks: [
      { type: 'paragraph', text: 'De 1º a 14 de outubro: Evento de medalhas Teste. Colete ingressos.' },
      { type: 'paragraph', text: 'De 1º a 31 de outubro: visuais. X.' },
      { type: 'paragraph', text: 'De 20 a 26 de outubro: Jogos do Clã. Y.' },
    ] }), h.repo, h.engine, h.log, NOW);
    const medal = h.repo.allEvents().filter((e) => e.category === 'medal_event');
    expect(medal).toHaveLength(1);
    expect(medal[0]!.startPrecision).toBe('datetime');
    expect(medal[0]!.startAt).toBe('2026-10-01T08:00:00Z');
    expect(h.repo.eventSources(medal[0]!.id)).toHaveLength(2);
  });

  it('fonte indisponível: registra falha, não altera eventos, relatório indica indisponibilidade', async () => {
    const h = harness();
    ingestPublication(pub(), h.repo, h.engine, h.log, NOW);
    const before = JSON.stringify(h.repo.allEvents());
    const broken = { kind: 'blog' as const, list: async () => { throw new SourceUnavailableError('HTTP 503'); }, fetch: async () => { throw new Error('x'); } };
    const r = await runAnnouncementSource(broken, h.db, h.repo, h.engine, h.log);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('503');
    expect(JSON.stringify(h.repo.allEvents())).toBe(before);
    const run = h.db.get<{ ok: number; error: string }>('SELECT ok, error FROM collector_runs ORDER BY id DESC LIMIT 1')!;
    expect(run.ok).toBe(0);
    // estrutura inesperada também é falha explícita, não "sem eventos"
    const weird = { kind: 'blog' as const, list: async () => new BlogSource('pt').parseListing('<html>sem next data</html>'), fetch: async () => { throw new Error('x'); } };
    const r2 = await runAnnouncementSource(weird, h.db, h.repo, h.engine, h.log);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('__NEXT_DATA__');
  });

  it('publicação antiga na primeira coleta não gera aviso de "novo anúncio"', () => {
    const h = harness();
    ingestPublication(pub({ publishedAt: '2026-09-01T08:00:00Z' }), h.repo, h.engine, h.log, NOW);
    expect(h.outbox.list()).toHaveLength(0);
    ingestPublication(pub({ id: 'blog:pt:novo', title: 'Desafio Novo', publishedAt: '2026-09-24T11:30:00Z', blocks: [{ type: 'list', items: ['Início: 2 de outubro, às 8h (UTC)', 'Fim: 3 de outubro, às 8h (UTC)'] }] }), h.repo, h.engine, h.log, NOW);
    expect(h.outbox.list().map((i) => i.kind)).toEqual(['event_announced']);
  });
});
