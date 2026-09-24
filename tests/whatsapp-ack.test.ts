import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { ackClientFrom, extractMessageId, sendAndWaitForAck } from '../src/whatsapp/ack.js';
import { UncertainDeliveryError } from '../src/whatsapp/delivery.js';

const GROUP = '120363000000000000@g.us';

/** `Message` como o whatsapp-web.js 1.34.7 entrega ao Node (`id: MessageId`, `ack: MessageAck`). */
function waMsg(id: string, o: { remote?: string; fromMe?: boolean; serialized?: string | null; ack?: number } = {}) {
  const remote = o.remote ?? GROUP;
  const fromMe = o.fromMe ?? true;
  const serialized = o.serialized === undefined ? `${fromMe}_${remote}_${id}` : o.serialized;
  return { id: { fromMe, remote, id, ...(serialized === null ? {} : { _serialized: serialized }) }, ack: o.ack ?? 0 };
}

/** Cliente falso: EventEmitter real (conta listeners) e `sendMessage` controlável. Nunca envia nada. */
class FakeWa extends EventEmitter {
  reply: () => Promise<unknown> = () => Promise.resolve(waMsg('ABC'));
  sendMessage = vi.fn((_chatId: string, _text: string) => this.reply());
  ack(message: unknown, ack: number) {
    this.emit('message_ack', message, ack);
  }
  listeners_() {
    return this.listenerCount('message_ack');
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function send(wa: FakeWa, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  let settled = false;
  const p = sendAndWaitForAck(ackClientFrom(wa), GROUP, 'texto', { timeoutMs: opts.timeoutMs ?? 1_000, log: silentLogger, signal: opts.signal });
  void p.then(() => (settled = true), () => (settled = true));
  return { p, settled: () => settled };
}

describe('extractMessageId (formatos do whatsapp-web.js 1.34.7)', () => {
  it('MessageId completo, com _serialized (WhatsApp Web antigo)', () => {
    expect(extractMessageId(waMsg('3EB0AA', { serialized: `true_${GROUP}_3EB0AA` }))).toEqual({ id: '3EB0AA', remote: GROUP, fromMe: true, serialized: `true_${GROUP}_3EB0AA` });
  });

  it('MessageId sem _serialized (WhatsApp Web 2.3000.1043xxx+): correlaciona por id/remote/fromMe', () => {
    expect(extractMessageId(waMsg('3EB0AA', { serialized: null }))).toEqual({ id: '3EB0AA', remote: GROUP, fromMe: true, serialized: null });
    // campos minificados como `$1` não são interpretados
    expect(extractMessageId({ id: { fromMe: true, remote: GROUP, id: '3EB0AA', $1: 'x' } })?.serialized).toBeNull();
  });

  it('sem os campos necessários não há id correlacionável', () => {
    for (const v of [undefined, null, 'x', {}, { id: null }, { id: 'true_x_y' }, { id: { remote: GROUP, fromMe: true } },
      { id: { id: '', remote: GROUP, fromMe: true } }, { id: { id: 'A', fromMe: true } }, { id: { id: 'A', remote: { _serialized: GROUP }, fromMe: true } },
      { id: { id: 'A', remote: GROUP } }, { id: { _serialized: `true_${GROUP}_A` } }]) {
      expect(extractMessageId(v)).toBeNull();
    }
  });
});

describe('sendAndWaitForAck', () => {
  it('não resolve logo após sendMessage; só resolve com ACK_SERVER da própria mensagem', async () => {
    const wa = new FakeWa();
    const s = send(wa);
    await tick();
    expect(wa.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.settled()).toBe(false);
    wa.ack(waMsg('ABC'), 1);
    await expect(s.p).resolves.toEqual({ messageId: `true_${GROUP}_ABC`, ack: 1 });
    expect(wa.listeners_()).toBe(0);
  });

  it('ignora ACK de outra mensagem, de outro chat e de mensagem recebida', async () => {
    const wa = new FakeWa();
    const s = send(wa);
    await tick();
    wa.ack(waMsg('OUTRA'), 3);
    wa.ack(waMsg('ABC', { remote: '999@g.us' }), 3);
    wa.ack(waMsg('ABC', { fromMe: false }), 3);
    wa.ack({ id: 'lixo' }, 3);
    await tick();
    expect(s.settled()).toBe(false);
    wa.ack(waMsg('ABC', { serialized: null }), 2); // o evento pode vir sem _serialized
    await expect(s.p).resolves.toMatchObject({ ack: 2 });
  });

  it('ACK_PENDING (0) não confirma: termina em timeout incerto', async () => {
    const wa = new FakeWa();
    const s = send(wa, { timeoutMs: 50 });
    await tick();
    wa.ack(waMsg('ABC'), 0);
    const err = await s.p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UncertainDeliveryError);
    expect((err as UncertainDeliveryError).message).toMatch(/sem ACK do WhatsApp após 0s \(message_id=/);
    expect((err as UncertainDeliveryError).messageId).toBe(`true_${GROUP}_ABC`);
    expect(wa.listeners_()).toBe(0);
  });

  it('ACK_ERROR (-1) vira entrega incerta, não falha comum', async () => {
    const wa = new FakeWa();
    const s = send(wa);
    await tick();
    wa.ack(waMsg('ABC'), -1);
    await expect(s.p).rejects.toThrow(/reportou erro no envio \(ack=-1\)/);
    expect(wa.listeners_()).toBe(0);
  });

  it('timeout sem nenhum ACK remove o listener', async () => {
    const wa = new FakeWa();
    await expect(send(wa, { timeoutMs: 30 }).p).rejects.toBeInstanceOf(UncertainDeliveryError);
    expect(wa.listeners_()).toBe(0);
  });

  it('sendMessage sem Message ID (undefined, null, objeto sem id) → incerto, sem esperar ACK', async () => {
    for (const ret of [undefined, null, {}, { id: { _serialized: undefined } }]) {
      const wa = new FakeWa();
      wa.reply = () => Promise.resolve(ret);
      const err = await send(wa, { timeoutMs: 60_000 }).p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UncertainDeliveryError);
      expect((err as Error).message).toMatch(/sem Message ID correlacionável/);
      expect(wa.listeners_()).toBe(0);
    }
  });

  it('mensagem retornada para outro chat não é aceita', async () => {
    const wa = new FakeWa();
    wa.reply = () => Promise.resolve(waMsg('ABC', { remote: '999@g.us', ack: 1 }));
    await expect(send(wa).p).rejects.toThrow(/não é deste envio/);
  });

  it('erro lançado por sendMessage → incerto (pode ter ocorrido depois de enfileirar); listener removido', async () => {
    const wa = new FakeWa();
    wa.reply = () => Promise.reject(new Error('Protocol error: Target closed'));
    const err = await send(wa).p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UncertainDeliveryError);
    expect((err as Error).message).toMatch(/sendMessage lançou erro depois de chamado: Protocol error/);
    expect(wa.listeners_()).toBe(0);
  });

  it('sendMessage travado respeita o mesmo prazo', async () => {
    const wa = new FakeWa();
    wa.reply = () => new Promise(() => undefined);
    await expect(send(wa, { timeoutMs: 30 }).p).rejects.toThrow(/sendMessage não retornou/);
    expect(wa.listeners_()).toBe(0);
  });

  it('ACK que chega antes de sendMessage retornar não se perde', async () => {
    const wa = new FakeWa();
    let release!: () => void;
    wa.reply = () => new Promise((r) => (release = () => r(waMsg('ABC'))));
    const s = send(wa);
    await tick();
    wa.ack(waMsg('OUTRA'), 1);
    wa.ack(waMsg('ABC'), 1);
    release();
    await expect(s.p).resolves.toMatchObject({ ack: 1 });
  });

  it('ACK_SERVER já presente no retorno confirma na hora', async () => {
    const wa = new FakeWa();
    wa.reply = () => Promise.resolve(waMsg('ABC', { ack: 1 }));
    await expect(send(wa).p).resolves.toMatchObject({ ack: 1 });
  });

  it('envios concorrentes: cada ACK confirma só a sua mensagem; nenhum listener sobra', async () => {
    const wa = new FakeWa();
    wa.reply = () => Promise.resolve(waMsg('M1'));
    const a = send(wa);
    await tick();
    wa.reply = () => Promise.resolve(waMsg('M2'));
    const b = send(wa);
    await tick();
    expect(wa.listeners_()).toBe(2);
    wa.ack(waMsg('M2'), 1);
    await expect(b.p).resolves.toMatchObject({ messageId: `true_${GROUP}_M2` });
    expect(a.settled()).toBe(false);
    wa.ack(waMsg('M1'), 1);
    await expect(a.p).resolves.toMatchObject({ messageId: `true_${GROUP}_M1` });
    expect(wa.listeners_()).toBe(0);
  });

  it('envios sucessivos não acumulam listeners', async () => {
    const wa = new FakeWa();
    for (let i = 0; i < 20; i++) {
      wa.reply = () => Promise.resolve(waMsg(`M${i}`, { ack: 1 }));
      await send(wa).p;
    }
    expect(wa.listeners_()).toBe(0);
  });

  it('encerramento: antes do envio é erro comum (nada enviado); durante a espera é incerto', async () => {
    const before = new AbortController();
    before.abort();
    const wa1 = new FakeWa();
    const err1 = await send(wa1, { signal: before.signal }).p.catch((e: unknown) => e);
    expect(err1).not.toBeInstanceOf(UncertainDeliveryError);
    expect(wa1.sendMessage).not.toHaveBeenCalled();

    const during = new AbortController();
    const wa2 = new FakeWa();
    const s = send(wa2, { signal: during.signal, timeoutMs: 60_000 });
    await tick();
    during.abort();
    await expect(s.p).rejects.toThrow(/encerrado enquanto aguardava/);
    expect(wa2.listeners_()).toBe(0);
  });
});
