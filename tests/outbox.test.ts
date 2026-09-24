import { describe, expect, it } from 'vitest';
import { Outbox } from '../src/outbox/queue.js';
import { runOutboxWorker, type Sender } from '../src/outbox/worker.js';
import { UncertainDeliveryError, type DeliveryReceipt } from '../src/whatsapp/delivery.js';
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
    return { messageId: `msg-${this.sent.length}`, ack: 1 };
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

/** Sender scriptado por parte: 'ok' confirma, 'uncertain' lança UncertainDeliveryError, 'fail' erro comum, 'null' sem recibo. */
class ScriptedSender implements Sender {
  calls: string[] = [];
  constructor(private script: ('ok' | 'uncertain' | 'fail' | 'null')[]) {}
  isReady() {
    return true;
  }
  async send(text: string): Promise<DeliveryReceipt | null> {
    this.calls.push(text);
    const step = this.script.shift() ?? 'ok';
    if (step === 'uncertain') throw new UncertainDeliveryError('sem ACK do WhatsApp após 30s (message_id=X)', { messageId: 'X' });
    if (step === 'fail') throw new Error('WhatsApp não está pronto');
    if (step === 'null') return null;
    return { messageId: `id-${this.calls.length}`, ack: 1 };
  }
}

describe('worker: sent só com confirmação do WhatsApp', () => {
  const delivery = (maxChars = 3000) => ({ delivery: { noticeTtlHours: 6, reportTtlHours: 12, maxAttempts: 3, minGapSeconds: 0, leaseSeconds: 120, maxChars } });
  const longBody = Array.from({ length: 20 }, (_, i) => `bloco ${i} ${'y'.repeat(60)}`).join('\n\n');

  it('item fica "sending" enquanto o envio não é confirmado e só vira "sent" depois', async () => {
    const h = harness({ mode: 'live', cfg: delivery() });
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'msg A', expiresAt: '2099-01-01T00:00:00Z' });
    let confirm!: (r: DeliveryReceipt) => void;
    const sender: Sender = { isReady: () => true, send: () => new Promise((r) => (confirm = r)) };
    const run = runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    await new Promise((r) => setImmediate(r));
    expect(h.outbox.getByKey('a')!.status).toBe('sending');
    confirm({ messageId: 'wa-1', ack: 1 });
    const r = await run;
    expect(r.sent).toBe(1);
    expect(h.outbox.getByKey('a')).toMatchObject({ status: 'sent', waMessageId: 'wa-1', leaseUntil: null });
  });

  it('UncertainDeliveryError → "uncertain", lease liberado, motivo gravado e SEM retry automático', async () => {
    const h = harness({ mode: 'live', cfg: delivery() });
    const sender = new ScriptedSender(['uncertain']);
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'msg A', expiresAt: '2099-01-01T00:00:00Z' });
    const r = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r).toMatchObject({ processed: 1, sent: 0, uncertain: 1, failed: 0, retried: 0 });
    const item = h.outbox.getByKey('a')!;
    expect(item).toMatchObject({ status: 'uncertain', leaseUntil: null, sentAt: null, attempts: 1 });
    expect(item.lastError).toBe('sem confirmação após envio: sem ACK do WhatsApp após 30s (message_id=X)');
    // ciclos seguintes não tocam no item
    for (let i = 0; i < 3; i++) expect((await runOutboxWorker(h.outbox, sender, h.cfg, h.log)).processed).toBe(0);
    expect(sender.calls).toHaveLength(1);
    expect(h.outbox.getByKey('a')!.status).toBe('uncertain');
  });

  it('sender real sem recibo não conta como enviado', async () => {
    const h = harness({ mode: 'live', cfg: delivery() });
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'msg A', expiresAt: '2099-01-01T00:00:00Z' });
    const r = await runOutboxWorker(h.outbox, new ScriptedSender(['null']), h.cfg, h.log);
    expect(r.uncertain).toBe(1);
    expect(h.outbox.getByKey('a')!.status).toBe('uncertain');
  });

  it('erro comum (antes de chamar sendMessage) continua com retry/backoff', async () => {
    const h = harness({ mode: 'live', cfg: delivery() });
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'msg A', expiresAt: '2099-01-01T00:00:00Z' });
    const r = await runOutboxWorker(h.outbox, new ScriptedSender(['fail']), h.cfg, h.log);
    expect(r).toMatchObject({ retried: 1, uncertain: 0 });
    expect(h.outbox.getByKey('a')).toMatchObject({ status: 'pending', lastError: 'WhatsApp não está pronto' });
  });

  it('multipart totalmente confirmado → "sent" com o id da última parte', async () => {
    const h = harness({ mode: 'live', cfg: delivery(500) });
    const sender = new ScriptedSender([]);
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: longBody, expiresAt: '2099-01-01T00:00:00Z' });
    const r = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r.sent).toBe(1);
    expect(sender.calls.length).toBeGreaterThan(2);
    expect(h.outbox.getByKey('a')).toMatchObject({ status: 'sent', waMessageId: `id-${sender.calls.length}` });
  });

  it('multipart parcialmente confirmado → "uncertain" explicando a parte; nada é reenviado', async () => {
    const h = harness({ mode: 'live', cfg: delivery(500) });
    const sender = new ScriptedSender(['ok', 'uncertain']);
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: longBody, expiresAt: '2099-01-01T00:00:00Z' });
    const r = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r).toMatchObject({ sent: 0, uncertain: 1, retried: 0 });
    expect(sender.calls).toHaveLength(2); // parou na parte 2; as seguintes não foram enviadas
    const item = h.outbox.getByKey('a')!;
    expect(item.status).toBe('uncertain');
    expect(item.lastError).toMatch(/^parte 2\/\d+ sem confirmação após envio; a parte 1 foi confirmada pelo WhatsApp e reenviar a duplicaria: sem ACK/);
    await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(sender.calls).toHaveLength(2);
  });

  it('multipart: erro comum depois de parte confirmada também vira "uncertain" (retry duplicaria a parte 1)', async () => {
    const h = harness({ mode: 'live', cfg: delivery(500) });
    const sender = new ScriptedSender(['ok', 'ok', 'fail']);
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: longBody, expiresAt: '2099-01-01T00:00:00Z' });
    const r = await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(r).toMatchObject({ uncertain: 1, retried: 0, failed: 0 });
    expect(h.outbox.getByKey('a')!.lastError).toMatch(/^parte 3\/\d+ falhou; as partes 1–2 foram confirmadas/);
  });

  it('renova o lease a cada parte de uma mensagem dividida', async () => {
    const h = harness({ mode: 'live', cfg: delivery(500) });
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: longBody, expiresAt: '2099-01-01T00:00:00Z' });
    const leases: (string | null)[] = [];
    const sender: Sender = {
      isReady: () => true,
      send: async () => {
        leases.push(h.outbox.getByKey('a')!.leaseUntil);
        await new Promise((r) => setTimeout(r, 5));
        return { messageId: 'x', ack: 1 };
      },
    };
    await runOutboxWorker(h.outbox, sender, h.cfg, h.log);
    expect(leases.length).toBeGreaterThan(2);
    expect(leases.at(-1)! > leases[0]!).toBe(true);
  });

  it('markUncertain grava status, motivo (limitado) e libera o lease', () => {
    const h = harness({ mode: 'live' });
    h.outbox.enqueue({ dedupKey: 'a', kind: 'k', body: 'x', expiresAt: '2099-01-01T00:00:00Z' });
    const it = h.outbox.claimNext(120)!;
    h.outbox.markUncertain(it.id, 'm'.repeat(900));
    expect(h.outbox.get(it.id)).toMatchObject({ status: 'uncertain', leaseUntil: null });
    expect(h.outbox.get(it.id)!.lastError).toHaveLength(500);
  });
});

