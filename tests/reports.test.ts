import { describe, expect, it } from 'vitest';
import { buildMonthlyReport, buildWeeklyReport } from '../src/messages/reports.js';
import { leagueName, type ClanReport } from '../src/messages/clan-report.js';
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
    expect(txt).not.toContain('Calendário parcial');
    expect(txt).toContain('não pôde ser consultada');
  });

  it('mensal: sem cosméticos e sem notas de rodapé quando os anúncios foram verificados', () => {
    const h = seeded();
    h.repo.applyEvent(globalEvent({ title: 'Paisagem de outubro', category: 'cosmetic', startAt: '2026-10-03', startPrecision: 'date', endAt: '2026-10-31', endPrecision: 'date' }), { origin: 'manual', now: NOW });
    const txt = buildMonthlyReport(h.repo.allEvents(), '2026-10', { tz: TZ, now: new Date(NOW), announcementsCheckedAt: '2026-09-24T10:00:00Z', announcementsUnavailable: false });
    expect(txt).not.toContain('Cosméticos e ofertas na loja');
    expect(txt).not.toContain('Paisagem de outubro');
    expect(txt).not.toContain('Calendário parcial');
    expect(txt).not.toContain('ainda dependem de revisão manual');
    expect(txt).not.toContain('Anúncios oficiais verificados');
    expect(txt).not.toContain('⚠️ A fonte oficial');
    expect(txt).toContain('🕒 Horário de Brasília');
  });

  it('mensal: evento do mês anterior que termina no dia 1 fica de fora; o que começa no dia 1 entra', () => {
    const h = seeded();
    h.repo.applyEvent(globalEvent({ title: 'Temporada de setembro', category: 'season', startAt: '2026-09-01', startPrecision: 'date', endAt: '2026-10-01', endPrecision: 'date' }), { origin: 'manual', now: NOW });
    h.repo.applyEvent(globalEvent({ title: 'Atravessa outubro', category: 'challenge', startAt: '2026-09-28', startPrecision: 'date', endAt: '2026-10-02', endPrecision: 'date' }), { origin: 'manual', now: NOW });
    h.repo.applyEvent(globalEvent({ title: 'Temporada de outubro', category: 'season', startAt: '2026-10-01', startPrecision: 'date', endAt: '2026-10-25', endPrecision: 'date' }), { origin: 'manual', now: NOW });
    const txt = buildMonthlyReport(h.repo.allEvents(), '2026-10', { tz: TZ, now: new Date('2026-10-01T12:00:00Z'), announcementsCheckedAt: '2026-10-01T11:00:00Z', announcementsUnavailable: false });
    expect(txt).not.toContain('Temporada de setembro');
    expect(txt).toContain('Atravessa outubro');
    expect(txt).toContain('Temporada de outubro');
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

  function clan(over: Partial<ClanReport> = {}): ClanReport {
    const round = (n: number, state: 'preparation' | 'inWar' | 'warEnded', opp: string, oppTag: string, start: string, end: string, stars: [number, number] = [0, 0]) => ({
      key: `2026-10:#W${n}`, state, teamSize: 15, attacksPerMember: 1, preparationStartTime: null, startTime: start, endTime: end, cwlRound: n, cwlSeason: '2026-10',
      clan: { name: 'Clãdestino', tag: '#2GG', stars: stars[0], destructionPercentage: stars[0] * 3, attacks: 15 },
      opponent: { name: opp, tag: oppTag, stars: stars[1], destructionPercentage: stars[1] * 3, attacks: 15 },
    });
    return {
      info: { name: 'Clãdestino', tag: '#2GG', level: 15, members: 18, warLeague: 'Gold League II', capitalLeague: 'Silver League III', capitalHallLevel: 9, warWins: 66, warLosses: 118, warTies: 0, warWinStreak: 1, isWarLogPublic: true },
      updatedAt: '2026-10-01T11:55:00Z',
      currentWar: null,
      warLog: [{ result: 'win', endTime: '2026-09-30T12:19:11Z', teamSize: 20, opponent: { name: 'TEAM ACE VN', tag: '#2PV', stars: 10, destructionPercentage: 17.45 }, clan: { stars: 31, destructionPercentage: 56.25, attacks: 14 } }],
      cwl: {
        group: { season: '2026-10', state: 'inWar', rounds: 7, clans: ['Clãdestino', 'PINOY', 'Purple Sage'], clanDetails: [{ name: 'Clãdestino', tag: '#2GG', level: 15, members: 15 }, { name: 'PINOY', tag: '#PIN', level: 6, members: 18 }, { name: 'Purple Sage', tag: '#PUR', level: 20, members: 15 }] },
        rounds: [round(2, 'preparation', 'Purple Sage', '#PUR', '2026-10-03T17:19:35Z', '2026-10-04T17:19:35Z'), round(1, 'warEnded', 'PINOY', '#PIN', '2026-10-02T17:19:35Z', '2026-10-03T17:19:35Z', [30, 25])],
      },
      raid: { key: '2026-09-25T07:00:00Z', state: 'ended', startTime: '2026-09-25T07:00:00Z', endTime: '2026-09-28T07:00:00Z', capitalTotalLoot: 152610, raidsCompleted: 2, totalAttacks: 60, enemyDistrictsDestroyed: 16, offensiveReward: 119, defensiveReward: 148 },
      ...over,
    };
  }

  it('nomes de liga da API em português', () => {
    expect(leagueName('Gold League II')).toBe('Ouro II');
    expect(leagueName('Crystal League I')).toBe('Cristal I');
    expect(leagueName('Champion League III')).toBe('Campeão III');
    expect(leagueName('Unranked')).toBe('sem liga');
    expect(leagueName('Legend League')).toBe('Lenda');
  });

  it('mensal com dados da API: seção do clã com liga, rodadas com horário real, histórico e raides; Liga genérica do blog vira só o período', () => {
    const h = seeded();
    h.repo.applyEvent(globalEvent({ title: 'Liga das Guerras de Clãs', category: 'cwl', startAt: '2026-10-01', startPrecision: 'date', endAt: '2026-10-11', endPrecision: 'date' }), { origin: 'manual', now: NOW });
    h.repo.applyEvent({ id: 'clan_cwl_x', category: 'cwl', scope: 'clan', title: 'Liga de Guerra 2026-10 · rodada 1 vs PINOY', startAt: '2026-10-02T17:19:35Z', startPrecision: 'datetime', endAt: '2026-10-03T17:19:35Z', endPrecision: 'datetime', rewardsStatus: 'not_announced' }, { origin: 'clan', now: NOW });
    const now = new Date('2026-10-01T12:00:00Z');
    const txt = buildMonthlyReport(h.repo.allEvents(), '2026-10', { tz: TZ, now, announcementsCheckedAt: '2026-10-01T11:00:00Z', announcementsUnavailable: false, clan: clan() });
    expect(txt).toContain('*NOSSO CLÃ* · Clãdestino');
    expect(txt).toContain('• Nível 15 · 18 membros');
    expect(txt).toContain('🏆 Liga de Guerra: Ouro II · 🏰 Capital: Prata III (Centro da Capital nível 9)');
    expect(txt).toContain('📊 Guerras: 66 vitórias · 118 derrotas · 0 empates · sequência atual: 1 vitória');
    expect(txt).toContain('*LIGA DE GUERRA DE OUTUBRO*');
    expect(txt).toContain('• Período: 01/10 a 11/10 (segundo a Supercell)');
    expect(txt).toContain('• Grupo com 3 clãs: Purple Sage (nv. 20), Clãdestino (nv. 15), PINOY (nv. 6)');
    // rodadas em ordem, encerrada com placar, próxima com horários reais
    expect(txt.indexOf('Rodada 1 · vs PINOY (nv. 6) · 15x15 · ✅ Vitória 30⭐ x 25⭐ (90,0% x 75,0%)')).toBeGreaterThan(0);
    expect(txt).toContain('• Rodada 2 · vs Purple Sage (nv. 20) · 15x15');
    expect(txt).toContain('⏳ Preparação até sáb., 03 de out. às 14:19');
    expect(txt).toContain('• ⭐ Até agora: 1 vitória em 1 rodada, 30 estrelas');
    expect(txt).toContain('• Rodadas 3 a 7: adversário e horário saem quando a rodada começar');
    expect(txt).toContain('✅ Vitória vs TEAM ACE VN (30/09) · 31⭐ x 10⭐ (56,3% x 17,5%)');
    expect(txt).toContain('152.610 de ouro da capital · 60 ataques · 2 raides concluídas · 16 distritos destruídos');
    // sem duplicar: nem o item genérico da Liga nem o evento do clã aparecem em "Eventos confirmados"
    const events = txt.slice(txt.indexOf('Eventos confirmados'));
    expect(events).not.toContain('Liga das Guerras de Clãs');
    expect(events).not.toContain('rodada 1 vs PINOY');
    expect(txt).not.toContain('Dados do clã de');
  });

  it('dados do clã velhos aparecem com alerta; sem dados da API o relatório fica como antes', () => {
    const h = seeded();
    const now = new Date('2026-10-01T12:00:00Z');
    const stale = buildWeeklyReport(h.repo.allEvents(), { tz: TZ, now, announcementsCheckedAt: null, announcementsUnavailable: false, clan: clan({ updatedAt: '2026-10-01T09:00:00Z' }) });
    expect(stale).toContain('⚠️ Dados do clã de qui., 01 de out. às 06:00: a API do Clash não respondeu desde então.');
    expect(stale).toContain('*LIGA DE GUERRA DE OUTUBRO*');
    expect(stale).not.toContain('Período:'); // a Liga de setembro do blog não serve de período para a de outubro
    const without = buildWeeklyReport(h.repo.allEvents(), { tz: TZ, now: new Date(NOW), announcementsCheckedAt: null, announcementsUnavailable: false });
    expect(without).not.toContain('NOSSO CLÃ');
    expect(without).toContain('Guerra de clãs vs Exemplo');
  });
});
