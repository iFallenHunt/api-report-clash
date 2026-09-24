import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { findDeclaredDuration } from '../src/collectors/announcements/extract.js';
import { runTestSend, type TestSender } from '../src/cli/test-send.js';
import { testConfig } from '../src/config.js';
import { declaredDurationText, displayStatus, durationText } from '../src/domain/dates.js';
import { eventSummaryLine, headline, whenLines } from '../src/messages/format.js';
import { buildMonthlyReport, buildWeeklyReport } from '../src/messages/reports.js';
import type { ClashEvent } from '../src/domain/types.js';
import { globalEvent, harness, NOW } from './helpers.js';

const TZ = 'America/Sao_Paulo';
const dateOnly = (startAt: string, endAt: string) => ({ startAt, startPrecision: 'date' as const, endAt, endPrecision: 'date' as const });

describe('duração: datas sem horário não geram duração', () => {
  it('22/09–28/09 e 01/09–01/10 mostram o período, sem "7 dias" nem "31 dias"', () => {
    expect(durationText(dateOnly('2026-09-22', '2026-09-28'))).toBeNull();
    expect(durationText(dateOnly('2026-09-01', '2026-10-01'))).toBeNull();
    const h = harness();
    const games = h.repo.applyEvent(globalEvent({ title: 'Jogos do Clã', category: 'clan_games', ...dateOnly('2026-09-22', '2026-09-28') }), { origin: 'manual', now: NOW }).event;
    const season = h.repo.applyEvent(globalEvent({ title: 'Temporada X', category: 'season', ...dateOnly('2026-09-01', '2026-10-01') }), { origin: 'manual', now: NOW }).event;
    const a = eventSummaryLine(games, TZ).join('\n');
    const b = eventSummaryLine(season, TZ).join('\n');
    expect(a).toContain('📅 ter., 22/09 a seg., 28/09 · horário não divulgado');
    expect(b).toContain('📅 ter., 01/09 a qui., 01/10 · horário não divulgado');
    expect(a).not.toContain('⏳');
    expect(b).not.toContain('⏳');
    expect(whenLines(games, TZ, new Date(NOW)).join('\n')).not.toContain('Duração');
  });

  it('duração declarada pela fonte é exibida com proveniência', () => {
    const ev = { extra: { declaredDuration: { value: '5 dias', quote: 'por cinco dias' } } };
    expect(declaredDurationText(ev)).toBe('5 dias (duração informada pela fonte)');
    expect(findDeclaredDuration('Todos os equipamentos ficam no nível máximo por cinco dias a partir do CV8')?.value).toBe('5 dias');
    expect(findDeclaredDuration('Mais uma rodada de 48 horas com os coletores')?.value).toBe('48 horas');
    expect(findDeclaredDuration('One more 48-hour run at 4x collectors')?.value).toBe('48 horas');
    // duração de outra coisa (o contrato), não do evento: não conta
    expect(findDeclaredDuration('Each Contract buys you 24 hours of access')).toBeNull();
    expect(durationText(dateOnly('2026-09-16', '2026-09-21'))).toBeNull();
  });
});

describe('estado no dia do início/término sem horário', () => {
  const games = { ...dateOnly('2026-09-22', '2026-09-28'), status: 'active' as const };
  it('no dia do término: "previsto para encerrar hoje", não "em andamento"', () => {
    expect(displayStatus(games, new Date('2026-09-28T13:00:00Z'), TZ)).toBe('ends_today_unknown_time'); // 10:00 BRT
    expect(displayStatus(games, new Date('2026-09-29T01:00:00Z'), TZ)).toBe('ends_today_unknown_time'); // 22:00 BRT do dia 28
    expect(displayStatus(games, new Date('2026-09-29T04:00:00Z'), TZ)).toBe('ended'); // 01:00 BRT do dia 29
    expect(displayStatus(games, new Date('2026-09-25T12:00:00Z'), TZ)).toBe('active');
  });
  it('na véspera à noite (já dia 22 em UTC) não afirma início; no dia: "previsto para começar hoje"', () => {
    expect(displayStatus(games, new Date('2026-09-22T01:00:00Z'), TZ)).toBe('scheduled'); // 22:00 BRT do dia 21
    expect(displayStatus(games, new Date('2026-09-22T12:00:00Z'), TZ)).toBe('starts_today_unknown_time');
    expect(displayStatus(dateOnly('2026-09-15', '2026-09-15') as never, new Date('2026-09-15T12:00:00Z'), TZ)).toBe('today_unknown_time');
  });
  it('sem horário de início não há aviso de "evento iniciado"', () => {
    const h = harness();
    const res = h.repo.applyEvent(globalEvent({ ...dateOnly('2026-09-25', '2026-10-01') }), { origin: 'collector:blog', now: NOW });
    h.engine.onEventApplied(res, NOW);
    h.engine.tick('2026-09-25T12:00:00Z');
    expect(h.outbox.list().map((i) => i.kind)).not.toContain('event_started');
  });
});

describe('relatórios: títulos, seções vazias e revisão manual de recompensas', () => {
  function events(): ClashEvent[] {
    const h = harness();
    h.repo.applyEvent(globalEvent({ title: 'Jogos do Clã', category: 'clan_games', ...dateOnly('2026-09-22', '2026-09-28'), rewardsStatus: 'unverified' }), { origin: 'manual', now: NOW });
    h.repo.applyEvent(globalEvent({ title: 'WWE: Temporada', category: 'season', ...dateOnly('2026-09-01', '2026-10-01'), rewardsStatus: 'unverified' }), { origin: 'manual', now: NOW });
    h.repo.applyEvent(globalEvent({ title: 'Desafio do John Cena', category: 'challenge', ...dateOnly('2026-09-01', '2026-09-30') }), { origin: 'manual', now: NOW });
    return h.repo.allEvents();
  }
  const ctx = (now: string) => ({ tz: TZ, now: new Date(now), announcementsCheckedAt: NOW, announcementsUnavailable: false });

  it('semanal no dia 28/09: Jogos do Clã "previsto para encerrar hoje", fora de "Em andamento"; sem seção vazia', () => {
    const txt = buildWeeklyReport(events(), ctx('2026-09-28T12:00:00Z'));
    const emAndamento = txt.slice(txt.indexOf('Em andamento'), txt.indexOf('Encerram nesta semana'));
    expect(emAndamento).not.toContain('Jogos do Clã');
    expect(txt).toContain('• Jogos do Clã — previsto para encerrar hoje; horário não informado');
    expect(txt).not.toContain('Começam nos próximos 7 dias'); // seção vazia omitida
    expect(txt).not.toContain('Nenhum início confirmado');
    expect(txt).not.toMatch(/⏳ (7|31|30) dias/);
    expect(txt).toContain('ainda dependem de revisão manual');
  });

  it('sem título redundante ("Jogos do Clã · Jogos do Clã", "Desafio … · Desafio")', () => {
    expect(headline({ title: 'Jogos do Clã', category: 'clan_games' })).toBe('*Jogos do Clã*');
    expect(headline({ title: 'Desafio do John Cena', category: 'challenge' })).toBe('*Desafio do John Cena*');
    expect(headline({ title: 'Evento de medalhas Explosão', category: 'medal_event' })).toBe('*Evento de medalhas Explosão*');
    expect(headline({ title: 'Liga das Guerras de Clãs', category: 'cwl' })).toBe('*Liga das Guerras de Clãs*');
    expect(headline({ title: 'WWE: Temporada', category: 'season' })).toBe('*WWE: Temporada*');
    expect(headline({ title: 'Corrida do Clã', category: 'special_event' })).toBe('*Corrida do Clã* · Evento especial');
    const txt = buildMonthlyReport(events(), '2026-09', ctx('2026-09-24T18:00:00Z'));
    expect(txt).not.toMatch(/\* · (Jogos do Clã|Desafio)\b/);
  });

  it('semana sem nada: uma linha, sem títulos de seção vazios', () => {
    const txt = buildWeeklyReport([], ctx('2026-09-28T12:00:00Z'));
    expect(txt).toContain('Nenhum evento confirmado para esta semana até agora.');
    expect(txt).not.toContain('Em andamento');
  });
});

describe('envio de teste do WhatsApp isolado', () => {
  function fake() {
    const sent: string[] = [];
    const s: TestSender = { start: vi.fn(async () => undefined), waitReady: vi.fn(async () => true), send: vi.fn(async (t: string) => { sent.push(t); return 'id-1'; }), stop: vi.fn(async () => undefined) };
    return { s, sent };
  }
  const cfg = () => {
    const c = testConfig();
    return { ...c, dryRun: true, wa: { ...c.wa, groupId: '123@g.us', expectedGroupName: 'Teste Bot' } };
  };

  it('com DRY_RUN=true e autorização específica, envia exatamente UMA mensagem de teste', async () => {
    const { s, sent } = fake();
    const r = await runTestSend(cfg(), { confirm: true, groupArg: 'Teste Bot', createSender: () => s });
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Teste do bot de relatórios');
    expect(s.stop).toHaveBeenCalledTimes(1);
  });

  it('recusa sem --confirm, com nome divergente ou sem nome esperado, sem sequer iniciar o WhatsApp', async () => {
    for (const [c, o] of [
      [cfg(), { confirm: false, groupArg: 'Teste Bot' }],
      [cfg(), { confirm: true, groupArg: 'Grupo Real do Clã' }],
      [{ ...cfg(), wa: { ...cfg().wa, expectedGroupName: undefined } }, { confirm: true, groupArg: 'Teste Bot' }],
    ] as const) {
      const { s } = fake();
      const r = await runTestSend(c, { ...o, createSender: () => s });
      expect(r.ok).toBe(false);
      expect(s.start).not.toHaveBeenCalled();
    }
  });

  it('o módulo não importa fila, motor de avisos, agendador nem banco', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'test-send.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => l.startsWith('import'));
    expect(imports).toEqual(["import type { AppConfig } from '../config.js';"]);
    const cli = readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'index.ts'), 'utf8');
    // o ramo do teste retorna antes de buildApp()
    expect(cli.indexOf("if (cmd === 'wa:test-send')")).toBeLessThan(cli.indexOf('const app = buildApp(cfg, log);'));
  });
});
