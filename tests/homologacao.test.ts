import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlogSource } from '../src/collectors/announcements/blog.js';
import { extractEvents, extractRewards, fixEndBeforeStart, inferYear, parseDateExpression } from '../src/collectors/announcements/extract.js';
import { ingestPublication } from '../src/collectors/announcements/index.js';
import { richTextToBlocks } from '../src/collectors/announcements/html.js';
import type { Block, Publication } from '../src/collectors/announcements/types.js';
import { rewardsLines } from '../src/domain/rewards.js';
import { harness, NOW } from './helpers.js';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const parse = (file: string, locale = 'pt') => new BlogSource(locale).parsePost(fx(file), { id: `blog:${locale}:${file}`, url: `https://supercell.com/${file}`, title: 'x', publishedAt: null });

describe('inferência do ano (janela de evidência: 90 dias antes, 200 dias depois da publicação)', () => {
  it('dezembro → janeiro e janeiro → dezembro', () => {
    expect(inferYear(5, 1, '2026-12-20T00:00:00Z')).toBe(2027);
    expect(inferYear(20, 12, '2027-01-03T00:00:00Z')).toBe(2026);
    expect(inferYear(31, 12, '2026-12-31T23:00:00Z')).toBe(2026);
    expect(inferYear(1, 1, '2026-12-31T23:00:00Z')).toBe(2027);
  });

  it('evento futuro anunciado com meses de antecedência', () => {
    expect(parseDateExpression('15 de março', '2026-09-01T00:00:00Z')?.iso).toBe('2027-03-15'); // +195 dias
    expect(parseDateExpression('June 10', '2026-12-01T00:00:00Z')?.iso).toBe('2027-06-10'); // +191 dias
    expect(parseDateExpression('10 de agosto', '2026-09-01T00:00:00Z')?.iso).toBe('2026-08-10'); // passado recente
  });

  it('sem evidência suficiente a data fica pendente, com motivo registrado', () => {
    const issues: string[] = [];
    expect(parseDateExpression('15 de maio', '2026-09-01T00:00:00Z', issues)).toBeNull(); // -109 ou +256 dias
    expect(issues[0]).toMatch(/ano sem evidência suficiente/);
    const i2: string[] = [];
    expect(parseDateExpression('9 de setembro, às 8h (UTC)', null, i2)).toBeNull();
    expect(i2[0]).toMatch(/publicação sem data/);
    // ano explícito dispensa inferência
    expect(parseDateExpression('15 de maio de 2027', '2026-09-01T00:00:00Z')?.iso).toBe('2027-05-15');
  });

  it('intervalo que atravessa o ano ("December 28 - January 4")', () => {
    const blocks: Block[] = [
      { type: 'paragraph', text: 'December 28 - January 4: Winter Rush - Collect snowflakes.' },
      { type: 'paragraph', text: 'December 20-31: Holiday Skins - x.' },
      { type: 'paragraph', text: 'January 2-9: Clan Games - y.' },
    ];
    for (const publishedAt of ['2026-12-15T00:00:00Z', '2027-01-02T00:00:00Z']) {
      const ev = extractEvents({ id: 'blog:en:w', sourceKind: 'blog', url: 'u', locale: 'en', title: 'Winter Season', publishedAt, blocks });
      const rush = ev.find((e) => e.input.title === 'Winter Rush')!.input;
      expect([rush.startAt, rush.endAt]).toEqual(['2026-12-28', '2027-01-04']);
      expect(ev.find((e) => e.input.title === 'Clan Games')!.input.startAt).toBe('2027-01-02');
    }
  });

  it('término rotulado anterior ao início: ano seguinte se plausível, senão pendente', () => {
    const pub: Publication = { id: 'blog:pt:n', sourceKind: 'blog', url: 'u', locale: 'pt', title: 'Evento de medalhas de Ano-Novo', publishedAt: '2026-12-30T09:00:00Z', blocks: [{ type: 'list', items: ['Início do evento: 30 de dezembro, às 8h (UTC)', 'Término do evento: 6 de janeiro, às 8h (UTC)'] }] };
    expect(extractEvents(pub)[0]!.input).toMatchObject({ startAt: '2026-12-30T08:00:00Z', endAt: '2027-01-06T08:00:00Z' });
    const issues: string[] = [];
    const s = { iso: '2026-09-10', precision: 'date' as const, yearInferred: false, timeWithoutTz: false };
    expect(fixEndBeforeStart(s, { ...s, iso: '2026-09-01' }, issues)).toBeNull();
    expect(issues[0]).toMatch(/anterior ao início/);
  });

  it('data rotulada sem evidência de ano: evento criado sem data e pendência "year_ambiguous"', () => {
    const h = harness();
    const pub: Publication = { id: 'blog:pt:amb', sourceKind: 'blog', url: 'https://supercell.com/amb', locale: 'pt', title: 'Evento de medalhas Distante', publishedAt: '2026-09-01T00:00:00Z', blocks: [{ type: 'list', items: ['Início do evento: 15 de maio, às 8h (UTC)', 'Término do evento: 29 de maio, às 8h (UTC)'] }] };
    ingestPublication(pub, h.repo, h.engine, h.log, NOW);
    const ev = h.repo.allEvents()[0]!;
    expect(ev.startAt).toBeNull();
    expect(ev.status).toBe('announced');
    expect(h.repo.openReviews().some((r) => r.kind === 'year_ambiguous')).toBe(true);
  });
});

describe('auditoria das publicações reais (fixtures de 2026-09-24)', () => {
  it('calendário da temporada: 24 itens + a temporada, datas idênticas em PT e EN', () => {
    const pt = extractEvents(parse('blog-post-wwe-season-pt.html'));
    const en = extractEvents(parse('blog-post-wwe-season-en.html', 'en'));
    expect(pt).toHaveLength(25);
    expect(en).toHaveLength(25);
    const dates = (l: typeof pt) => l.map((e) => `${e.input.startAt}..${e.input.endAt}`).sort();
    expect(dates(pt)).toEqual(dates(en));
  });

  it('itens distintos do mesmo artigo com as mesmas datas nunca se fundem', () => {
    const h = harness();
    const pub = parse('blog-post-wwe-season-pt.html');
    ingestPublication({ ...pub, publishedAt: '2026-09-01T08:00:22Z' }, h.repo, h.engine, h.log, NOW);
    const titles = h.repo.allEvents().map((e) => e.title);
    expect(titles).toHaveLength(25);
    for (const t of ['Baús da WWE', 'Bilhete dourado', 'Tropas temporárias', 'Figurinhas da WWE para o bate-papo global', 'Visuais de herói e paisagem da WWE', 'Desafio do John Cena', 'WWE: Em Busca do John Cena entra no ringue']) {
      expect(titles).toContain(t);
    }
  });

  it('item do calendário e post dedicado se fundem em qualquer ordem, mantendo horário e categoria do post', () => {
    for (const order of [['season', 'medal'], ['medal', 'season']]) {
      const h = harness();
      const pubs = { season: parse('blog-post-wwe-season-pt.html'), medal: parse('blog-post-equipment-blast-pt.html') };
      for (const k of order) ingestPublication(pubs[k as 'season' | 'medal'], h.repo, h.engine, h.log, NOW);
      const blast = h.repo.allEvents().filter((e) => /Explos/.test(e.title));
      expect(blast).toHaveLength(1);
      expect(blast[0]).toMatchObject({ category: 'medal_event', startAt: '2026-09-09T08:00:00Z', startPrecision: 'datetime', endAt: '2026-09-22T08:00:00Z' });
      expect(blast[0]!.title).toMatch(/^Evento de medalhas/);
      expect(h.repo.allEvents()).toHaveLength(25);
    }
  });

  it('evento de medalhas Fascinante: tabela da loja vira itens de loja com preço e limite, não prêmios', () => {
    const ev = extractEvents(parse('blog-pt-o-evento-de-medalhas-fascinante-esta-na-area.html'));
    expect(ev).toHaveLength(1);
    const r = ev[0]!.input.rewards!;
    expect(r.every((x) => x.kind === 'shop')).toBe(true);
    expect(r).toHaveLength(28); // 30 linhas, 2 repetidas idênticas
    expect(r).toContainEqual({ label: 'Equipamento épico do Duque Dracônico (Baralho Vingativo)', kind: 'shop', tier: 'unknown', price: '3.090 medalhas de missões', limit: 1 });
    expect(r).toContainEqual({ label: '150.000 de ouro', kind: 'shop', tier: 'unknown', price: '15 medalhas de missões', limit: 20 });
    expect(ev[0]!.notes.some((n) => n.includes('só traz o catálogo da loja'))).toBe(true);
    const text = rewardsLines('known', r, 'https://x').join('\n');
    expect(text).toContain('Recompensas do caminho do evento: não foi possível verificar');
    expect(text).toContain('🛒 *Loja do evento*');
    expect(text).toContain('… e mais 20 itens');
    expect(text).not.toContain('🎁 *Recompensas*');
  });

  it('evento de medalhas Explosão: tabelas de probabilidade dos baús são ignoradas', () => {
    for (const [f, l] of [['blog-post-equipment-blast-pt.html', 'pt'], ['blog-post-equipment-blast-en.html', 'en']] as const) {
      const ev = extractEvents(parse(f, l));
      expect(ev[0]!.input.rewards).toEqual([]);
      expect(ev[0]!.input.rewardsStatus).toBe('unverified');
    }
  });

  it('publicações sem evento reconhecível viram pendência "no_events"', () => {
    const h = harness();
    ingestPublication(parse('blog-pt-a-retrospectiva-do-chefe-chegou.html'), h.repo, h.engine, h.log, NOW);
    expect(h.repo.allEvents()).toHaveLength(0);
    expect(h.repo.openReviews().map((r) => r.kind)).toEqual(['no_events']);
  });

  it('listas aninhadas do rich-text mantêm separação entre título e subitens', () => {
    const blocks = richTextToBlocks({ nodeType: 'document', content: [{ nodeType: 'unordered-list', content: [{ nodeType: 'list-item', content: [
      { nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Equipamentos épicos' }] },
      { nodeType: 'unordered-list', content: [
        { nodeType: 'list-item', content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Primeiro' }] }] },
        { nodeType: 'list-item', content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Segundo' }] }] },
      ] },
    ] }] }] });
    expect(blocks).toEqual([{ type: 'list', items: ['Equipamentos épicos: Primeiro; Segundo'] }]);
  });
});

describe('formatos estruturados de recompensa', () => {
  it('tabela de caminho com colunas grátis/pago vira prêmios com condição e tier', () => {
    const r = extractRewards([
      { type: 'heading', level: 3, text: 'Recompensas do caminho' },
      { type: 'table', rows: [['Nível', 'Grátis', 'Bilhete de evento'], ['1', '500 minérios brilhantes', 'Poção de herói'], ['2', '-', 'Visual de herói']] },
    ]);
    expect(r).toEqual([
      { label: '500 minérios brilhantes', tier: 'free', condition: 'Nível 1' },
      { label: 'Poção de herói', tier: 'paid', condition: 'Nível 1' },
      { label: 'Visual de herói', tier: 'paid', condition: 'Nível 2' },
    ]);
  });

  it('tabela de probabilidade é ignorada mesmo sob título de recompensas; lista de loja sem tabela vira loja', () => {
    const r = extractRewards([
      { type: 'heading', level: 3, text: 'Recompensas dos baús' },
      { type: 'paragraph', text: 'Probabilidade das recompensas do centro da vila 6' },
      { type: 'table', rows: [['Recompensa', 'Probabilidade (%)'], ['Poção', '60,61']] },
      { type: 'heading', level: 3, text: 'Loja do Comerciante' },
      { type: 'list', items: ['Minério estelar', 'Livro dos heróis'] },
    ]);
    expect(r).toEqual([
      { label: 'Minério estelar', kind: 'shop', tier: 'unknown' },
      { label: 'Livro dos heróis', kind: 'shop', tier: 'unknown' },
    ]);
  });

  it('"comprar com medalhas" não é pago; passe explícito é', () => {
    const r = extractRewards([
      { type: 'heading', level: 3, text: 'Recompensas' },
      { type: 'list', items: ['Baralho Vingativo: você pode comprá-lo com medalhas', 'Visual exclusivo: Passe Ouro', 'Livro: grátis para todos'] },
    ]);
    expect(r.map((x) => x.tier)).toEqual(['unknown', 'paid', 'free']);
  });
});
