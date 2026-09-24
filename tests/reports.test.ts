import { describe, expect, it } from 'vitest';
import { buildMonthlyReport, buildWeeklyReport } from '../src/messages/reports.js';
import { noticeStarted } from '../src/messages/notices.js';
import { globalEvent, harness, NOW } from './helpers.js';

const TZ = 'America/Sao_Paulo';

function seeded() {
  const h = harness();
  const mk = (o: Parameters<typeof globalEvent>[0]) => h.repo.applyEvent(globalEvent(o), { origin: 'manual', now: NOW }).event;
  mk({ title: 'Ativo com prêmios', startAt: '2026-09-20T08:00:00Z', endAt: '2026-09-27T08:00:00Z', rewards: [{ label: 'Medalhas', quantity: 300, tier: 'free' }, { label: 'Visual', tier: 'paid' }], rewardsStatus: 'known' });
  mk({ title: 'Começa em 3 dias', category: 'clan_games', startAt: '2026-09-27', startPrecision: 'date', endAt: '2026-10-03', endPrecision: 'date', rewardsStatus: 'not_announced' });
  mk({ title: 'Outubro sem verificação', category: 'season', startAt: '2026-10-03T08:00:00Z', endAt: '2026-11-01T08:00:00Z', rewardsStatus: 'unverified' });
  mk({ title: 'Anunciado sem data', category: 'special_event', startAt: null, startPrecision: 'unknown', endAt: null, endPrecision: 'unknown' });
  mk({ title: 'Início conhecido, fim não', category: 'challenge', startAt: '2026-10-10T08:00:00Z', endAt: null, endPrecision: 'unknown' });
  const c = mk({ title: 'Cancelado', category: 'challenge', startAt: '2026-10-05T08:00:00Z', endAt: '2026-10-06T08:00:00Z' });
  h.repo.cancelEvent(c.id, 'teste', 'manual', NOW);
  h.repo.applyEvent({ category: 'war', scope: 'clan', title: 'Guerra de clãs vs Exemplo', startAt: '2026-09-25T10:00:00Z', startPrecision: 'datetime', endAt: '2026-09-26T10:00:00Z', endPrecision: 'datetime', rewardsStatus: 'not_announced' }, { origin: 'clan', now: NOW });
  return h;
}

describe('relatórios', () => {
  it('semanal: em andamento, próximos 7 dias, encerramentos, anunciados; sem tabelas markdown; negrito simples', () => {
    const h = seeded();
    const txt = buildWeeklyReport(h.repo.allEvents(), { tz: TZ, now: new Date(NOW), announcementsCheckedAt: '2026-09-24T10:00:00Z', announcementsUnavailable: false });
    expect(txt).toContain('*RESUMO DA SEMANA*');
    expect(txt).toContain('Ativo com prêmios');
    expect(txt).toContain('💳 há itens pagos');
    expect(txt).toContain('Começa em 3 dias');
    expect(txt).toContain('📅 dom., 27/09 a sáb., 03/10 · horário não divulgado');
    expect(txt).toContain('Guerra de clãs vs Exemplo');
    // link único no rodapé em vez de repetido em cada item
    expect(txt.match(/https:\/\/supercell\.com\/en\/games\/clashofclans\/pt\/blog\/news\/teste/g)).toHaveLength(1);
    expect(txt).toContain('🔗 Fonte oficial:');
    expect(txt).toContain('Encerram nesta semana');
    expect(txt).toContain('Anunciado sem data');
    expect(txt).not.toContain('Outubro sem verificação'); // fora dos 7 dias
    expect(txt).not.toContain('Cancelado');
    expect(txt).toContain('Anúncios oficiais verificados em 24/09 às 07:00');
    expect(txt).toContain('🕒 Horário de Brasília');
    expect(txt).not.toMatch(/\|.*\|/);
    expect(txt).not.toContain('**');
  });

  it('mensal: ordem cronológica, calendário parcial, cancelados, término desconhecido', () => {
    const h = seeded();
    const txt = buildMonthlyReport(h.repo.allEvents(), '2026-10', { tz: TZ, now: new Date(NOW), announcementsCheckedAt: null, announcementsUnavailable: true });
    expect(txt).toContain('*CALENDÁRIO DE OUTUBRO DE 2026*');
    const iGames = txt.indexOf('Começa em 3 dias');
    const iSeason = txt.indexOf('Outubro sem verificação');
    const iChal = txt.indexOf('Início conhecido, fim não');
    expect(iGames).toBeGreaterThan(0);
    expect(iGames).toBeLessThan(iSeason);
    expect(iSeason).toBeLessThan(iChal);
    expect(txt).toContain('término não divulgado');
    expect(txt).toContain('Recompensas não verificadas');
    expect(txt).toContain('Recompensas ainda não divulgadas');
    expect(txt).toContain('~Cancelado~');
    expect(txt).toContain('Calendário parcial');
    expect(txt).toContain('não pôde ser consultada');
  });

  it('aviso individual segue a estrutura pedida', () => {
    const h = seeded();
    const ev = h.repo.allEvents().find((e) => e.title === 'Ativo com prêmios')!;
    const txt = noticeStarted(ev, TZ, new Date(NOW));
    expect(txt.split('\n')[0]).toBe('🏅 *EVENTO INICIADO: Ativo com prêmios*');
    expect(txt).toContain('📅 Início: dom., 20 de set. às 05:00');
    expect(txt).toContain('🏁 Término: dom., 27 de set. às 05:00');
    expect(txt).toContain('⏳ Duração: 7 dias');
    expect(txt).toContain('⌛ Termina em: 2 dias e 20 horas');
    expect(txt).toContain('• 300x Medalhas');
    expect(txt).toContain('💳 *Passe/conteúdo pago:*');
    expect(txt).toContain('🔗 Fonte: https://supercell.com/');
    expect(txt.trim().endsWith('🕒 Horário de Brasília')).toBe(true);
  });
});
