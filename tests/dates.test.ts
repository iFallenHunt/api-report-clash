import { describe, expect, it } from 'vitest';
import { computeStatus, durationText, formatWhen, humanDuration } from '../src/domain/dates.js';
import { splitMessage } from '../src/messages/chunk.js';

const TZ = 'America/Sao_Paulo';

describe('datas e fuso', () => {
  it('exibe UTC no horário de Brasília', () => {
    // 08:00 UTC = 05:00 em São Paulo (UTC-3)
    expect(formatWhen('2026-09-09T08:00:00Z', 'datetime', TZ)).toBe('qua., 09 de set. às 05:00');
  });

  it('data sem horário não inventa hora', () => {
    expect(formatWhen('2026-09-09', 'date', TZ)).toBe('qua., 09 de set. (horário não informado)');
    expect(formatWhen('2026-09-09', 'unknown', TZ)).toBeNull();
    expect(formatWhen(null, 'datetime', TZ)).toBeNull();
  });

  it('duração só com datas confirmadas', () => {
    expect(durationText({ startAt: '2026-09-09T08:00:00Z', startPrecision: 'datetime', endAt: '2026-09-22T08:00:00Z', endPrecision: 'datetime' })).toBe('13 dias');
    expect(durationText({ startAt: '2026-09-09T08:00:00Z', startPrecision: 'datetime', endAt: '2026-09-09T14:30:00Z', endPrecision: 'datetime' })).toBe('6 horas e 30 minutos');
    // só datas: contar dias do calendário não é duração transcorrida
    expect(durationText({ startAt: '2026-09-09', startPrecision: 'date', endAt: '2026-09-15', endPrecision: 'date' })).toBeNull();
    // mistura de precisões ou término desconhecido: sem duração
    expect(durationText({ startAt: '2026-09-09T08:00:00Z', startPrecision: 'datetime', endAt: '2026-09-15', endPrecision: 'date' })).toBeNull();
    expect(durationText({ startAt: '2026-09-09T08:00:00Z', startPrecision: 'datetime', endAt: null, endPrecision: 'unknown' })).toBeNull();
  });

  it('humaniza durações', () => {
    expect(humanDuration(90 * 60_000)).toBe('1 hora e 30 minutos');
    expect(humanDuration(60 * 60_000)).toBe('1 hora');
    expect(humanDuration(2 * 24 * 3600_000 + 3 * 3600_000)).toBe('2 dias e 3 horas');
    expect(humanDuration(45 * 60_000)).toBe('45 minutos');
  });

  it('estado derivado das datas, cancelado preservado', () => {
    const ev = { startAt: '2026-09-09T08:00:00Z', startPrecision: 'datetime' as const, endAt: '2026-09-22T08:00:00Z', endPrecision: 'datetime' as const, status: 'scheduled' as const };
    expect(computeStatus(ev, new Date('2026-09-01T00:00:00Z'))).toBe('scheduled');
    expect(computeStatus(ev, new Date('2026-09-10T00:00:00Z'))).toBe('active');
    expect(computeStatus(ev, new Date('2026-09-23T00:00:00Z'))).toBe('ended');
    expect(computeStatus({ ...ev, status: 'cancelled' }, new Date('2026-09-10T00:00:00Z'))).toBe('cancelled');
    expect(computeStatus({ ...ev, startAt: null, startPrecision: 'unknown', endAt: null, endPrecision: 'unknown' }, new Date())).toBe('announced');
    // início conhecido, término desconhecido: ativo após o início, nunca "ended" por suposição
    expect(computeStatus({ ...ev, endAt: null, endPrecision: 'unknown' }, new Date('2027-01-01T00:00:00Z'))).toBe('active');
  });

  it('precisão "date" considera o dia inteiro', () => {
    const ev = { startAt: '2026-09-09', startPrecision: 'date' as const, endAt: '2026-09-10', endPrecision: 'date' as const, status: 'scheduled' as const };
    expect(computeStatus(ev, new Date('2026-09-10T23:00:00Z'))).toBe('active');
    expect(computeStatus(ev, new Date('2026-09-11T00:00:01Z'))).toBe('ended');
  });
});

describe('divisão de mensagens', () => {
  it('mantém mensagens curtas intactas', () => {
    expect(splitMessage('oi', 3000)).toEqual(['oi']);
  });
  it('divide em partes numeradas por blocos', () => {
    const blocks = Array.from({ length: 30 }, (_, i) => `bloco ${i} ${'x'.repeat(80)}`);
    const parts = splitMessage(blocks.join('\n\n'), 600);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toMatch(/^\(1\/\d+\)\n/);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(600);
    expect(parts.join('\n').includes('bloco 29')).toBe(true);
  });
});
