import { describe, expect, it, vi } from 'vitest';
import { startHealthServer } from '../src/http/health.js';
import { deliveryProblems, pingMonitor, shouldRestartWhatsApp } from '../src/monitor.js';
import { harness } from './helpers.js';

const MIN = 60_000;
// segunda 05/10/2026, 09:00 em Brasília = 12:00Z
const WEEKLY_AT = '2026-10-05T12:00:00.000Z';

describe('monitoramento de entrega', () => {
  it('WhatsApp subindo não é problema; fora além do limite é; pedindo QR é sempre', () => {
    const grace = 10 * MIN;
    expect(deliveryProblems({ wa: { ready: false, needsQr: false, notReadyForMs: 4 * MIN }, overdue: [], waGraceMs: grace })).toEqual([]);
    expect(deliveryProblems({ wa: { ready: false, needsQr: false, notReadyForMs: 11 * MIN }, overdue: [], waGraceMs: grace })[0]).toContain('whatsapp_fora: sem conexão há 11 min');
    expect(deliveryProblems({ wa: { ready: false, needsQr: true, notReadyForMs: 1 * MIN }, overdue: [], waGraceMs: grace })[0]).toContain('whatsapp_precisa_de_qr');
    expect(deliveryProblems({ wa: null, overdue: [], waGraceMs: grace })).toEqual([]);
  });

  it('reinício ordenado só quando está fora sem pedir QR (QR não se resolve reiniciando)', () => {
    expect(shouldRestartWhatsApp({ ready: false, needsQr: false, notReadyForMs: 11 * MIN }, 10 * MIN)).toBe(true);
    expect(shouldRestartWhatsApp({ ready: false, needsQr: true, notReadyForMs: 60 * MIN }, 10 * MIN)).toBe(false);
    expect(shouldRestartWhatsApp({ ready: true, needsQr: false, notReadyForMs: 0 }, 10 * MIN)).toBe(false);
    expect(shouldRestartWhatsApp(null, 10 * MIN)).toBe(false);
  });

  it('semanal: gerado mas não entregue vira problema 15 min depois; entregue (sent) deixa de ser; some depois de 24 h', () => {
    const h = harness({ mode: 'live', cfg: { dryRun: false } });
    const at = (min: number) => new Date(new Date(WEEKLY_AT).getTime() + min * MIN).toISOString();
    expect(h.engine.overdueReports(at(10))).toEqual([]); // ainda no prazo
    expect(h.engine.overdueReports(at(20))).toEqual([{ kind: 'weekly', key: 'report:weekly:2026-W41', scheduledAt: WEEKLY_AT, status: 'não gerado' }]);
    h.engine.runReport('weekly', WEEKLY_AT);
    expect(h.engine.overdueReports(at(20))[0]).toMatchObject({ key: 'report:weekly:2026-W41', status: 'pending' });
    const p = deliveryProblems({ wa: { ready: true, needsQr: false, notReadyForMs: 0 }, overdue: h.engine.overdueReports(at(20)), waGraceMs: 10 * MIN });
    expect(p).toEqual(['relatorio_nao_entregue: report:weekly:2026-W41 (previsto 2026-10-05T12:00:00.000Z; pending)']);
    h.db.run("UPDATE outbox SET status = 'sent' WHERE dedup_key = 'report:weekly:2026-W41'");
    expect(h.engine.overdueReports(at(20))).toEqual([]);
    h.db.run("UPDATE outbox SET status = 'uncertain' WHERE dedup_key = 'report:weekly:2026-W41'");
    expect(h.engine.overdueReports(at(60))[0]!.status).toBe('uncertain'); // entrega sem confirmação também alerta
    expect(h.engine.overdueReports(at(25 * 60))).toEqual([]);
  });

  it('ping: tudo OK → GET na URL; com problema → POST /fail com a lista; falha de rede não derruba nada', async () => {
    const log = harness().log;
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetchImpl: typeof fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url instanceof Request ? url.url : url.toString(), method: init?.method, body: init?.body });
      return Promise.resolve(new Response('OK'));
    });
    await pingMonitor('https://hc-ping.com/abc', [], log, fetchImpl);
    await pingMonitor('https://hc-ping.com/abc/', ['whatsapp_fora', 'relatorio_nao_entregue'], log, fetchImpl);
    expect(calls).toEqual([
      { url: 'https://hc-ping.com/abc', method: 'GET', body: undefined },
      { url: 'https://hc-ping.com/abc/fail', method: 'POST', body: 'whatsapp_fora\nrelatorio_nao_entregue' },
    ]);
    const offline: typeof fetch = () => Promise.reject(new Error('offline'));
    await expect(pingMonitor('https://hc-ping.com/abc', [], log, offline)).resolves.toBeUndefined();
  });

  it('/health responde 503 com os problemas quando ok=false', async () => {
    const log = harness().log;
    let state: { ok: boolean; problems: string[] } = { ok: true, problems: [] };
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = startHealthServer(port, () => state, log)!;
    await new Promise((r) => server.once('listening', r));
    try {
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      state = { ok: false, problems: ['whatsapp_precisa_de_qr'] };
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, problems: ['whatsapp_precisa_de_qr'] });
    } finally {
      server.close();
    }
  });
});
