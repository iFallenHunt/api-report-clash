import { describe, expect, it } from 'vitest';
import { Outbox } from '../src/outbox/queue.js';
import { runOutboxWorker, type Sender } from '../src/outbox/worker.js';
import { harness, NOW } from './helpers.js';

class FakeSender implements Sender {
  sent: string[] = [];
  failTimes = 0;
  ready = true;
  crashOnSend = false;
  isReady() {
    return this.ready;
  }
  async send(text: string) {
    if (this.crashOnSend) throw Object.assign(new Error('__crash__'), { crash: true });
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error('timeout simulado');
    }
    this.sent.push(text);
    return `msg-${this.sent.length}`;
  }
}

describe('fila de saída', () => {
  it('deduplica por chave e ignora itens já vencidos', () => {
    const h = harness();
    expect(h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'x', expiresAt: '2026-09-24T18:00:00Z' }, NOW)).toBe(true);
    expect(h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'y', expiresAt: '2026-09-24T18:00:00Z' }, NOW)).toBe(false);
    expect(h.outbox.enqueue({ dedupKey: 'b', kind: 'k', body: 'x', expiresAt: '2026-09-24T11:00:00Z' }, NOW)).toBe(false);
    expect(h.outbox.list()).toHaveLength(1);
  });

  it('envia, persiste id e respeita intervalo mínimo; reinício não reenvia', async () => {
    const h = harness({ mode: 'live', cfg: { delivery: { noticeTtlHours: 6, reportTtlHours: 12, maxAttempts: 3, minGapSeconds: 0, leaseSeconds: 120, maxChars: 3000 } } });
    const sender = new FakeSender();
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'msg A', expiresAt: '2099-01-01T00:00:00Z' });
    h.outbox.enqueue({ dedupKey: 'b', kind: 'k', body: 'msg B', expiresAt: '2099-01-01T00:00:00Z' });
    const r = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r.sent).toBe(2);
    expect(sender.sent).toEqual(['msg A', 'msg B']);
    expect(h.outbox.list('sent').map((i) => i.waMessageId).sort()).toEqual(['msg-1', 'msg-2']);
    // "reinício": novo worker sobre o mesmo banco não reenvia nada
    const again = await runOutboxWorker(new Outbox(h.db, 'live'), sender, h.cfg, h.log);
    expect(again.processed).toBe(0);
    expect(sender.sent).toHaveLength(2);
  });

  it('falha de envio: backoff limitado e depois failed; não envia em massa itens vencidos', async () => {
    const h = harness({ mode: 'live', cfg: { delivery: { noticeTtlHours: 6, reportTtlHours: 12, maxAttempts: 2, minGapSeconds: 0, leaseSeconds: 120, maxChars: 3000 } } });
    const sender = new FakeSender();
    sender.failTimes = 5;
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'msg A', expiresAt: '2099-01-01T00:00:00Z' });
    h.outbox.enqueue({ dedupKey: 'old', kind: 'k', body: 'antiga', fireAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z' }, '2026-01-01T00:00:00Z');
    const r1 = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r1.expired).toBe(1);
    expect(r1.retried).toBe(1);
    const item = h.outbox.list('pending')[0]!;
    expect(item.attempts).toBe(1);
    expect(new Date(item.fireAt).getTime()).toBeGreaterThan(Date.now() + 20_000); // reagendado com backoff
    // força elegibilidade e tenta de novo → esgota
    h.db.run("UPDATE outbox SET fire_at = ? WHERE dedup_key = 'a'", '2020-01-01T00:00:00Z');
    const r2 = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r2.failed).toBe(1);
    expect(h.outbox.list('failed')).toHaveLength(1);
    expect(sender.sent).toHaveLength(0);
  });

  it('queda durante o envio: item preso vira "uncertain" e NÃO é reenviado automaticamente', async () => {
    const h = harness({ mode: 'live', cfg: { delivery: { noticeTtlHours: 6, reportTtlHours: 12, maxAttempts: 3, minGapSeconds: 0, leaseSeconds: 1, maxChars: 3000 } } });
    const sender = new FakeSender();
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'msg A', expiresAt: '2099-01-01T00:00:00Z' });
    // simula: claim feito, processo morreu antes de markSent
    const claimed = h.outbox.claimNext(1)!;
    expect(claimed.status).toBe('sending');
    await new Promise((r) => setTimeout(r, 1100));
    const r = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r.recovered.map((i) => i.id)).toEqual([claimed.id]);
    expect(h.outbox.get(claimed.id)!.status).toBe('uncertain');
    expect(sender.sent).toHaveLength(0);
    // reenvio é decisão humana
    const re = h.outbox.requeue(claimed.id, 6)!;
    expect(re.status).toBe('pending');
    const r2 = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r2.sent).toBe(1);
  });

  it('WhatsApp desconectado pausa o worker sem perder itens', async () => {
    const h = harness({ mode: 'live' });
    const sender = new FakeSender();
    sender.ready = false;
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'msg A', expiresAt: '2099-01-01T00:00:00Z' });
    const r = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r.processed).toBe(0);
    expect(h.outbox.list('pending')).toHaveLength(1);
  });

  it('mensagem longa é dividida em partes numeradas', async () => {
    const h = harness({ mode: 'live', cfg: { delivery: { noticeTtlHours: 6, reportTtlHours: 12, maxAttempts: 3, minGapSeconds: 0, leaseSeconds: 120, maxChars: 500 } } });
    const sender = new FakeSender();
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: Array.from({ length: 20 }, (_, i) => `bloco ${i} ${'y'.repeat(60)}`).join('\n\n'), expiresAt: '2099-01-01T00:00:00Z' });
    await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(sender.sent.length).toBeGreaterThan(1);
    expect(sender.sent[0]).toMatch(/^\(1\/\d+\)/);
  });
});
