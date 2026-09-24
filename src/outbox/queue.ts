import type { Db } from '../db/index.js';
import { nowIso } from '../domain/dates.js';

export type OutboxMode = 'dry_run' | 'live';
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'expired' | 'superseded' | 'uncertain' | 'dry_run';

export interface OutboxItem {
  id: number;
  mode: OutboxMode;
  dedupKey: string;
  kind: string;
  eventId: string | null;
  body: string;
  fireAt: string;
  expiresAt: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  leaseUntil: string | null;
  sentAt: string | null;
  waMessageId: string | null;
  createdAt: string;
}

interface OutboxRow {
  id: number; mode: string; dedup_key: string; kind: string; event_id: string | null; body: string; fire_at: string; expires_at: string;
  status: string; attempts: number; last_error: string | null; lease_until: string | null; sent_at: string | null; wa_message_id: string | null; created_at: string;
}

function toItem(r: OutboxRow): OutboxItem {
  return {
    id: r.id, mode: r.mode as OutboxMode, dedupKey: r.dedup_key, kind: r.kind, eventId: r.event_id, body: r.body, fireAt: r.fire_at, expiresAt: r.expires_at,
    status: r.status as OutboxStatus, attempts: r.attempts, lastError: r.last_error, leaseUntil: r.lease_until, sentAt: r.sent_at, waMessageId: r.wa_message_id, createdAt: r.created_at,
  };
}

export interface EnqueueInput {
  dedupKey: string;
  kind: string;
  eventId?: string | null;
  body: string;
  fireAt?: string;
  expiresAt: string;
}

/**
 * Fila de saída persistente. A unicidade é por (mode, dedup_key): execuções em DRY_RUN
 * registram suas próprias entradas e nunca consomem a deduplicação do modo real.
 */
export class Outbox {
  constructor(private readonly db: Db, readonly mode: OutboxMode) {}

  /** Insere se ainda não existir a mesma chave neste modo. Retorna true se enfileirou. */
  enqueue(input: EnqueueInput, now = nowIso()): boolean {
    if (input.expiresAt <= now) return false; // nunca enfileira algo já vencido
    const res = this.db.run(
      `INSERT OR IGNORE INTO outbox (mode, dedup_key, kind, event_id, body, fire_at, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      this.mode, input.dedupKey, input.kind, input.eventId ?? null, input.body, input.fireAt ?? now, input.expiresAt, now,
    );
    return res.changes > 0;
  }

  has(dedupKey: string): boolean {
    return !!this.db.get('SELECT id FROM outbox WHERE mode = ? AND dedup_key = ?', this.mode, dedupKey);
  }

  getByKey(dedupKey: string): OutboxItem | undefined {
    const r = this.db.get<OutboxRow>('SELECT * FROM outbox WHERE mode = ? AND dedup_key = ?', this.mode, dedupKey);
    return r ? toItem(r) : undefined;
  }

  get(id: number): OutboxItem | undefined {
    const r = this.db.get<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id);
    return r ? toItem(r) : undefined;
  }

  list(status?: OutboxStatus, limit = 50): OutboxItem[] {
    const rows = status
      ? this.db.all<OutboxRow>('SELECT * FROM outbox WHERE mode = ? AND status = ? ORDER BY id DESC LIMIT ?', this.mode, status, limit)
      : this.db.all<OutboxRow>('SELECT * FROM outbox WHERE mode = ? ORDER BY id DESC LIMIT ?', this.mode, limit);
    return rows.map(toItem);
  }

  /** Invalida mensagens pendentes de um evento (mudança de datas/cancelamento). */
  supersedePending(eventId: string, kinds?: string[], now = nowIso()): number {
    if (kinds?.length) {
      const placeholders = kinds.map(() => '?').join(',');
      const res = this.db.run(
        `UPDATE outbox SET status = 'superseded', last_error = ? WHERE mode = ? AND event_id = ? AND status = 'pending' AND kind IN (${placeholders})`,
        `superseded at ${now}`, this.mode, eventId, ...kinds,
      );
      return res.changes as number;
    }
    const res = this.db.run(
      `UPDATE outbox SET status = 'superseded', last_error = ? WHERE mode = ? AND event_id = ? AND status = 'pending'`,
      `superseded at ${now}`, this.mode, eventId,
    );
    return res.changes as number;
  }

  /** Vence itens pendentes cujo prazo passou. Nunca serão enviados. */
  expireStale(now = nowIso()): number {
    const res = this.db.run(
      `UPDATE outbox SET status = 'expired' WHERE mode = ? AND status = 'pending' AND expires_at <= ?`,
      this.mode, now,
    );
    return res.changes as number;
  }

  /**
   * Recuperação após queda: itens presos em "sending" com lease vencido viram "uncertain".
   * O WhatsApp pode ter aceitado a mensagem sem que o resultado fosse persistido; por isso
   * NÃO há reenvio automático (evita duplicata). Reenvio só manual via CLI.
   */
  recoverStuck(now = nowIso()): OutboxItem[] {
    const rows = this.db.all<OutboxRow>(
      `SELECT * FROM outbox WHERE mode = ? AND status = 'sending' AND (lease_until IS NULL OR lease_until <= ?)`,
      this.mode, now,
    );
    for (const r of rows) {
      this.db.run(
        `UPDATE outbox SET status = 'uncertain', last_error = ? WHERE id = ?`,
        `lease expirado em ${now}; entrega incerta (processo caiu durante o envio)`, r.id,
      );
    }
    return rows.map(toItem);
  }

  /** Reserva o próximo item elegível (fire_at <= now) para envio. */
  claimNext(leaseSeconds: number, now = nowIso()): OutboxItem | undefined {
    return this.db.transaction(() => {
      const r = this.db.get<OutboxRow>(
        `SELECT * FROM outbox WHERE mode = ? AND status = 'pending' AND fire_at <= ? AND expires_at > ? ORDER BY fire_at, id LIMIT 1`,
        this.mode, now, now,
      );
      if (!r) return undefined;
      const lease = new Date(new Date(now).getTime() + leaseSeconds * 1000).toISOString();
      this.db.run(`UPDATE outbox SET status = 'sending', lease_until = ?, attempts = attempts + 1 WHERE id = ?`, lease, r.id);
      return { ...toItem(r), status: 'sending', attempts: r.attempts + 1, leaseUntil: lease };
    });
  }

  markSent(id: number, waMessageId: string | null, now = nowIso()) {
    this.db.run(`UPDATE outbox SET status = ?, sent_at = ?, wa_message_id = ?, lease_until = NULL WHERE id = ?`,
      this.mode === 'dry_run' ? 'dry_run' : 'sent', now, waMessageId, id);
  }

  /** Falha de envio: reagenda com backoff ou marca como failed ao esgotar tentativas. */
  markFailed(item: OutboxItem, error: string, maxAttempts: number, now = nowIso()): 'retry' | 'failed' {
    if (item.attempts >= maxAttempts) {
      this.db.run(`UPDATE outbox SET status = 'failed', last_error = ?, lease_until = NULL WHERE id = ?`, error.slice(0, 500), item.id);
      return 'failed';
    }
    const backoffMs = Math.min(30_000 * 2 ** (item.attempts - 1), 8 * 60_000);
    const next = new Date(new Date(now).getTime() + backoffMs).toISOString();
    this.db.run(`UPDATE outbox SET status = 'pending', last_error = ?, lease_until = NULL, fire_at = ? WHERE id = ?`, error.slice(0, 500), next, item.id);
    return 'retry';
  }

  /** Reenvio manual de um item failed/uncertain/expired: cria nova entrada com sufixo. */
  requeue(id: number, ttlHours: number, now = nowIso()): OutboxItem | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    const expiresAt = new Date(new Date(now).getTime() + ttlHours * 3600_000).toISOString();
    const key = `${item.dedupKey}#resend${item.attempts}-${Date.now()}`;
    this.db.run(
      `INSERT INTO outbox (mode, dedup_key, kind, event_id, body, fire_at, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      this.mode, key, item.kind, item.eventId, item.body, now, expiresAt, now,
    );
    return this.list('pending', 1)[0];
  }

  lastSentAt(): string | null {
    const r = this.db.get<{ sent_at: string | null }>(
      `SELECT MAX(sent_at) AS sent_at FROM outbox WHERE mode = ? AND status IN ('sent','dry_run')`, this.mode,
    );
    return r?.sent_at ?? null;
  }
}
