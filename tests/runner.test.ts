import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRunner } from '../src/scheduler/runner.js';
import { harness } from './helpers.js';

describe('agendador', () => {
  afterEach(() => vi.useRealTimers());

  it('coleta de anúncios que falha tenta de novo em 5 minutos, sem esperar o intervalo normal', async () => {
    vi.useFakeTimers();
    const h = harness();
    const results = [[{ ok: false }], [{ ok: true }]];
    const poll = vi.fn(() => Promise.resolve(results.shift() ?? [{ ok: true }]));
    const sender = { isReady: () => false, send: () => Promise.reject(new Error('não usado')) };
    const runner = startRunner({ cfg: h.cfg, log: h.log, engine: h.engine, outbox: h.outbox, sender, pollAnnouncements: poll, pollClan: null });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(poll).toHaveBeenCalledTimes(2); // retry, bem antes dos 60 min
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(poll).toHaveBeenCalledTimes(2); // deu certo: volta ao intervalo normal
    runner.stop();
  });
});
