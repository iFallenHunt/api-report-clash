import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { nowIso } from '../domain/dates.js';
import { splitMessage } from '../messages/chunk.js';
import { UncertainDeliveryError, type DeliveryReceipt } from '../whatsapp/delivery.js';
import type { Outbox, OutboxItem } from './queue.js';

export interface Sender {
  /**
   * Envia um texto ao grupo configurado. Resolve com o recibo só quando o WhatsApp confirmou (null apenas
   * no DRY_RUN, que não envia). Lança erro comum se nada foi enviado e `UncertainDeliveryError` se a
   * mensagem pode ter sido enviada sem confirmação.
   */
  send(text: string): Promise<DeliveryReceipt | null>;
  isReady(): boolean;
}

/** Sender de DRY_RUN: registra e grava preview em disco; nunca envia. */
export class DryRunSender implements Sender {
  constructor(private readonly previewDir: string, private readonly log: Logger) {}
  isReady() {
    return true;
  }
  send(text: string): Promise<DeliveryReceipt | null> {
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
  /** Envios sem confirmação do WhatsApp: ficam `uncertain`, sem reenvio automático. */
  uncertain: number;
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
  const result: WorkerResult = { processed: 0, sent: 0, uncertain: 0, failed: 0, retried: 0, expired: 0, recovered: [] };
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
    const parts = splitMessage(item.body, cfg.delivery.maxChars);
    let confirmed = 0;
    let receipt: DeliveryReceipt | null = null;
    try {
      for (const part of parts) {
        if (confirmed > 0) outbox.extendLease(item.id, cfg.delivery.leaseSeconds);
        receipt = await sender.send(part);
        // no modo real, "sent" exige recibo de confirmação; um sender que não confirma é tratado como incerto
        if (outbox.mode === 'live' && !receipt) throw new UncertainDeliveryError('o sender retornou sem confirmação do WhatsApp');
        confirmed++;
      }
      outbox.markSent(item.id, receipt?.messageId ?? null);
      result.sent++;
      log.info({ id: item.id, kind: item.kind, parts: parts.length, mode: outbox.mode, message_id: receipt?.messageId, ack: receipt?.ack }, 'mensagem processada');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Depois de uma parte confirmada, qualquer retry reenviaria essa parte: o item inteiro fica incerto.
      if (err instanceof UncertainDeliveryError || confirmed > 0) {
        const reason = uncertainReason(err instanceof UncertainDeliveryError, confirmed, parts.length, msg);
        outbox.markUncertain(item.id, reason);
        result.uncertain++;
        log.error({ id: item.id, kind: item.kind, part: confirmed + 1, parts: parts.length, message_id: err instanceof UncertainDeliveryError ? err.messageId : null, reason },
          'entrega marcada como uncertain; sem reenvio automático (confira o grupo e use outbox:resend se necessário)');
        break;
      }
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

/** Motivo gravado em `last_error` de um item incerto, dizendo que parte falhou e o que pode ter chegado. */
function uncertainReason(afterSend: boolean, confirmed: number, total: number, error: string): string {
  const what = afterSend ? 'sem confirmação após envio' : 'falhou';
  if (total === 1) return `${what}: ${error}`;
  const before = confirmed === 0 ? ''
    : confirmed === 1 ? '; a parte 1 foi confirmada pelo WhatsApp e reenviar a duplicaria'
      : `; as partes 1–${confirmed} foram confirmadas pelo WhatsApp e reenviar as duplicaria`;
  return `parte ${confirmed + 1}/${total} ${what}${before}: ${error}`;
}
