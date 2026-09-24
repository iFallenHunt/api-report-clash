import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { nowIso } from '../domain/dates.js';
import { splitMessage } from '../messages/chunk.js';
import type { Outbox, OutboxItem } from './queue.js';

export interface Sender {
  /** Envia um texto ao grupo configurado. Deve lançar erro em falha. Retorna id da mensagem quando disponível. */
  send(text: string): Promise<string | null>;
  isReady(): boolean;
}

/** Sender de DRY_RUN: registra e grava preview em disco; nunca envia. */
export class DryRunSender implements Sender {
  constructor(private readonly previewDir: string, private readonly log: Logger) {}
  isReady() {
    return true;
  }
  send(text: string): Promise<string | null> {
    mkdirSync(this.previewDir, { recursive: true });
    const file = join(this.previewDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    writeFileSync(file, text, 'utf8');
    this.log.info({ file, chars: text.length }, '[DRY_RUN] mensagem gerada (não enviada)');
    return Promise.resolve(null);
  }
}

export interface WorkerResult {
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  expired: number;
  recovered: OutboxItem[];
}

/**
 * Um ciclo do worker: recupera itens presos, vence itens antigos e envia os elegíveis,
 * um por vez, com intervalo mínimo. Tentativas limitadas + expiração = a entrega NÃO é garantida.
 */
export async function runOutboxWorker(outbox: Outbox, sender: Sender, cfg: AppConfig, log: Logger, now = nowIso()): Promise<WorkerResult> {
  const result: WorkerResult = { processed: 0, sent: 0, failed: 0, retried: 0, expired: 0, recovered: [] };
  result.recovered = outbox.recoverStuck(now);
  for (const it of result.recovered) log.warn({ id: it.id, kind: it.kind }, 'item preso em "sending" marcado como entrega incerta; reenvie manualmente se necessário');
  result.expired = outbox.expireStale(now);
  if (result.expired) log.info({ expired: result.expired }, 'itens vencidos descartados');
  if (!sender.isReady()) {
    log.debug('sender indisponível; worker aguardando');
    return result;
  }
  const minGapMs = cfg.delivery.minGapSeconds * 1000;
  // limite por ciclo para não despejar mensagens em massa após indisponibilidade
  const maxPerCycle = 5;
  while (result.processed < maxPerCycle) {
    const last = outbox.lastSentAt();
    if (last && Date.now() - new Date(last).getTime() < minGapMs) break;
    const item = outbox.claimNext(cfg.delivery.leaseSeconds);
    if (!item) break;
    result.processed++;
    try {
      const parts = splitMessage(item.body, cfg.delivery.maxChars);
      let lastId: string | null = null;
      for (const part of parts) lastId = await sender.send(part);
      outbox.markSent(item.id, lastId);
      result.sent++;
      log.info({ id: item.id, kind: item.kind, parts: parts.length, mode: outbox.mode }, 'mensagem processada');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const outcome = outbox.markFailed(item, msg, cfg.delivery.maxAttempts);
      if (outcome === 'failed') result.failed++;
      else result.retried++;
      log.error({ id: item.id, kind: item.kind, attempts: item.attempts, outcome, err: msg }, 'falha no envio');
      break; // após falha, espera o próximo ciclo (backoff)
    }
    if (minGapMs > 0) break; // um envio por ciclo quando há intervalo mínimo
  }
  return result;
}
