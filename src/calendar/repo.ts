import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { canonicalKeyFor, newEventId, titleKey } from '../domain/canonical.js';
import { computeStatus, nowIso } from '../domain/dates.js';
import { normalizeRewards, rewardsEqual } from '../domain/rewards.js';
import {
  RELEVANT_FIELDS,
  type ClashEvent,
  type EventInput,
  type EventStatus,
  type RelevantField,
  type Reward,
} from '../domain/types.js';

interface EventRow {
  id: string;
  canonical_key: string | null;
  category: string;
  scope: string;
  title: string;
  description: string | null;
  start_at: string | null;
  start_precision: string;
  end_at: string | null;
  end_precision: string;
  status: string;
  rewards_status: string;
  rewards_json: string;
  primary_source_url: string | null;
  field_locks: string;
  relevant_revision: number;
  first_seen_at: string;
  updated_at: string;
  last_checked_at: string | null;
  extra_json: string;
}

export function rowToEvent(r: EventRow): ClashEvent {
  return {
    id: r.id,
    canonicalKey: r.canonical_key,
    category: r.category as ClashEvent['category'],
    scope: r.scope as ClashEvent['scope'],
    title: r.title,
    description: r.description,
    startAt: r.start_at,
    startPrecision: r.start_precision as ClashEvent['startPrecision'],
    endAt: r.end_at,
    endPrecision: r.end_precision as ClashEvent['endPrecision'],
    status: r.status as EventStatus,
    rewardsStatus: r.rewards_status as ClashEvent['rewardsStatus'],
    rewards: JSON.parse(r.rewards_json) as Reward[],
    primarySourceUrl: r.primary_source_url,
    fieldLocks: JSON.parse(r.field_locks) as string[],
    relevantRevision: r.relevant_revision,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
    lastCheckedAt: r.last_checked_at,
    extra: JSON.parse(r.extra_json) as Record<string, unknown>,
  };
}

export interface PublicationInput {
  id: string;
  sourceKind: 'blog' | 'inbox' | 'manual';
  url: string;
  locale: string;
  title: string;
  publishedAt: string | null;
  payload: unknown;
}

export interface ApplyOptions {
  /** Origem da alteração: "collector:blog", "collector:inbox", "manual", "clan". */
  origin: string;
  /** Publicação da qual os dados vieram (coletores). */
  publication?: { id: string; segmentKey?: string };
  /** Campos efetivamente confirmados pela fonte (para event_sources). */
  confirmedFields?: string[];
  /** Importação manual: trava os campos fornecidos contra sobrescrita do coletor. */
  lockFields?: string[];
  now?: string;
}

export interface ApplyResult {
  event: ClashEvent;
  created: boolean;
  /** Alterações em campos relevantes ({campo: {from, to}}); vazio se nada relevante mudou. */
  changes: Partial<Record<RelevantField, { from: unknown; to: unknown }>>;
  conflicts: string[];
}

export class CalendarRepo {
  constructor(private readonly db: Db) {}

  getEvent(id: string): ClashEvent | undefined {
    const r = this.db.get<EventRow>('SELECT * FROM events WHERE id = ?', id);
    return r ? rowToEvent(r) : undefined;
  }

  listEvents(opts: { scope?: 'global' | 'clan'; includeEnded?: boolean } = {}): ClashEvent[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.scope) {
      where.push('scope = ?');
      params.push(opts.scope);
    }
    if (!opts.includeEnded) where.push("status NOT IN ('ended','cancelled')");
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY start_at IS NULL, start_at, title`;
    return this.db.all<EventRow>(sql, ...params).map(rowToEvent);
  }

  allEvents(): ClashEvent[] {
    return this.db.all<EventRow>('SELECT * FROM events ORDER BY start_at IS NULL, start_at, title').map(rowToEvent);
  }

  // ---------- Publicações e fontes ----------

  upsertPublication(p: PublicationInput, now = nowIso()): { changed: boolean; isNew: boolean } {
    const payloadJson = JSON.stringify(p.payload);
    const hash = createHash('sha256').update(payloadJson).digest('hex');
    const existing = this.db.get<{ content_hash: string }>('SELECT content_hash FROM publications WHERE id = ?', p.id);
    if (!existing) {
      this.db.run(
        `INSERT INTO publications (id, source_kind, url, locale, title, published_at, content_hash, first_seen_at, last_seen_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.id, p.sourceKind, p.url, p.locale, p.title, p.publishedAt, hash, now, now, payloadJson,
      );
      return { changed: true, isNew: true };
    }
    const changed = existing.content_hash !== hash;
    this.db.run(
      'UPDATE publications SET title = ?, published_at = ?, content_hash = ?, last_seen_at = ?, payload_json = ? WHERE id = ?',
      p.title, p.publishedAt, hash, now, payloadJson, p.id,
    );
    return { changed, isNew: false };
  }

  linkEventSource(eventId: string, publicationId: string, segmentKey: string, confirmedFields: string[], now = nowIso()) {
    // Publicação referenciada sem registro prévio (ex.: testes ou vínculo direto): cria um registro mínimo.
    this.db.run(
      `INSERT OR IGNORE INTO publications (id, source_kind, url, locale, title, published_at, content_hash, first_seen_at, last_seen_at, payload_json)
       VALUES (?, ?, '', ?, '', NULL, '', ?, ?, '{}')`,
      publicationId, publicationId.split(':')[0] ?? 'manual', publicationId.split(':')[1] ?? '', now, now,
    );
    this.db.run(
      `INSERT INTO event_sources (event_id, publication_id, segment_key, confirmed_fields_json, collected_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id, publication_id, segment_key) DO UPDATE SET confirmed_fields_json = excluded.confirmed_fields_json, collected_at = excluded.collected_at`,
      eventId, publicationId, segmentKey, JSON.stringify(confirmedFields), now,
    );
  }

  eventSources(eventId: string): { publicationId: string; url: string; sourceKind: string; segmentKey: string; confirmedFields: string[]; collectedAt: string }[] {
    return this.db
      .all<{ publication_id: string; url: string; source_kind: string; segment_key: string; confirmed_fields_json: string; collected_at: string }>(
        `SELECT es.publication_id, p.url, p.source_kind, es.segment_key, es.confirmed_fields_json, es.collected_at
         FROM event_sources es JOIN publications p ON p.id = es.publication_id WHERE es.event_id = ?`,
        eventId,
      )
      .map((r) => ({
        publicationId: r.publication_id,
        url: r.url,
        sourceKind: r.source_kind,
        segmentKey: r.segment_key,
        confirmedFields: JSON.parse(r.confirmed_fields_json) as string[],
        collectedAt: r.collected_at,
      }));
  }

  findEventByPublication(publicationId: string, segmentKey: string): ClashEvent | undefined {
    const r = this.db.get<EventRow>(
      `SELECT e.* FROM events e JOIN event_sources es ON es.event_id = e.id
       WHERE es.publication_id = ? AND es.segment_key = ? LIMIT 1`,
      publicationId, segmentKey,
    );
    return r ? rowToEvent(r) : undefined;
  }

  // ---------- Revisão humana ----------

  addReview(item: { eventId?: string | null; kind: string; field?: string; currentValue?: unknown; proposedValue?: unknown; sourceUrl?: string | null; note?: string }, now = nowIso()) {
    // evita duplicar pendência aberta idêntica
    const dup = this.db.get(
      `SELECT id FROM review_queue WHERE resolved_at IS NULL AND kind = ? AND IFNULL(event_id,'') = ? AND IFNULL(field,'') = ? AND IFNULL(proposed_value,'') = ?`,
      item.kind, item.eventId ?? '', item.field ?? '', item.proposedValue === undefined ? '' : JSON.stringify(item.proposedValue),
    );
    if (dup) return;
    this.db.run(
      `INSERT INTO review_queue (event_id, kind, field, current_value, proposed_value, source_url, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      item.eventId ?? null, item.kind, item.field ?? null,
      item.currentValue === undefined ? null : JSON.stringify(item.currentValue),
      item.proposedValue === undefined ? null : JSON.stringify(item.proposedValue),
      item.sourceUrl ?? null, item.note ?? null, now,
    );
  }

  openReviews() {
    return this.db.all<{ id: number; event_id: string | null; kind: string; field: string | null; current_value: string | null; proposed_value: string | null; source_url: string | null; note: string | null; created_at: string }>(
      'SELECT * FROM review_queue WHERE resolved_at IS NULL ORDER BY id',
    );
  }

  resolveReview(id: number, now = nowIso()) {
    this.db.run('UPDATE review_queue SET resolved_at = ? WHERE id = ?', now, id);
  }

  // ---------- Núcleo: aplicar entrada de evento ----------

  /**
   * Localiza o evento correspondente (id explícito → vínculo com a publicação → chave canônica →
   * título na mesma categoria) e aplica a entrada respeitando campos travados e coleta parcial.
   */
  applyEvent(input: EventInput, opts: ApplyOptions): ApplyResult {
    const now = opts.now ?? nowIso();
    const isManual = opts.origin === 'manual';
    return this.db.transaction(() => {
      const existing = this.resolveTarget(input, opts);
      const conflicts: string[] = [];

      if (!existing) {
        const ev = this.buildNew(input, now, isManual ? (opts.lockFields ?? []) : []);
        this.insert(ev);
        this.insertVersion(ev, opts.origin, { created: true }, now);
        if (opts.publication) {
          this.linkEventSource(ev.id, opts.publication.id, opts.publication.segmentKey ?? '', opts.confirmedFields ?? [], now);
        }
        return { event: ev, created: true, changes: {}, conflicts };
      }

      const merged: ClashEvent = { ...existing, rewards: [...existing.rewards], fieldLocks: [...existing.fieldLocks], extra: { ...existing.extra } };
      const locks = new Set(existing.fieldLocks);

      const propose = <K extends keyof ClashEvent>(field: K, value: ClashEvent[K] | undefined, provided: boolean) => {
        if (!provided) return;
        const same = JSON.stringify(value) === JSON.stringify(existing[field]);
        if (same) return;
        if (!isManual && locks.has(field)) {
          conflicts.push(field);
          this.addReview({ eventId: existing.id, kind: 'field_conflict', field, currentValue: existing[field], proposedValue: value, sourceUrl: input.primarySourceUrl ?? existing.primarySourceUrl, note: `Coletor (${opts.origin}) propôs valor diferente para campo travado` }, now);
          return;
        }
        (merged as unknown as Record<string, unknown>)[field] = value;
      };

      // Categoria/título: o coletor só "melhora" (de genérica para específica); nunca troca por outra fonte/idioma.
      const generic = (c: string) => c === 'other' || c === 'special_event';
      const upgrade = !isManual && generic(existing.category) && !generic(input.category);
      propose('category', input.category, isManual || upgrade);
      propose('title', input.title, isManual || upgrade);
      propose('description', input.description ?? null, input.description !== undefined && (isManual || !existing.description || upgrade));

      // Datas: coleta parcial (precisão unknown) nunca apaga uma data conhecida; coletor nunca
      // rebaixa datetime → date no mesmo dia (ex.: calendário mensal só com dias vs post com horário).
      const sameDay = (a: string | null, b: string | null) => !!a && !!b && a.slice(0, 10) === b.slice(0, 10);
      const startProvided = input.startAt !== undefined && (isManual || (input.startPrecision ?? 'unknown') !== 'unknown');
      const startDowngrade = !isManual && existing.startPrecision === 'datetime' && input.startPrecision === 'date' && sameDay(existing.startAt, input.startAt ?? null);
      if (startProvided && !startDowngrade) {
        propose('startAt', input.startAt ?? null, true);
        propose('startPrecision', input.startPrecision ?? (input.startAt ? 'datetime' : 'unknown'), true);
      }
      const endProvided = input.endAt !== undefined && (isManual || (input.endPrecision ?? 'unknown') !== 'unknown');
      const endDowngrade = !isManual && existing.endPrecision === 'datetime' && input.endPrecision === 'date' && sameDay(existing.endAt, input.endAt ?? null);
      if (endProvided && !endDowngrade) {
        propose('endAt', input.endAt ?? null, true);
        propose('endPrecision', input.endPrecision ?? (input.endAt ? 'datetime' : 'unknown'), true);
      }

      // Recompensas: o coletor só substitui quando afirma "known"; "unverified" nunca apaga dados.
      const rewardsProvided = input.rewards !== undefined || input.rewardsStatus !== undefined;
      if (rewardsProvided) {
        const status = input.rewardsStatus ?? (input.rewards?.length ? 'known' : existing.rewardsStatus);
        const rewards = normalizeRewards(input.rewards ?? []);
        const canApply = isManual || status === 'known' || (status === 'not_announced' && existing.rewardsStatus !== 'known');
        if (canApply) {
          if (!rewardsEqual(rewards, existing.rewards) || status !== existing.rewardsStatus) {
            if (!isManual && (locks.has('rewards') || locks.has('rewardsStatus'))) {
              conflicts.push('rewards');
              this.addReview({ eventId: existing.id, kind: 'field_conflict', field: 'rewards', currentValue: existing.rewards, proposedValue: rewards, sourceUrl: input.primarySourceUrl ?? existing.primarySourceUrl, note: 'Coletor propôs recompensas diferentes das confirmadas manualmente' }, now);
            } else {
              merged.rewards = rewards;
              merged.rewardsStatus = status;
            }
          }
        }
      }

      if (input.primarySourceUrl && !existing.primarySourceUrl) merged.primarySourceUrl = input.primarySourceUrl;
      if (input.extra) merged.extra = { ...merged.extra, ...input.extra };
      if (isManual && opts.lockFields?.length) merged.fieldLocks = Array.from(new Set([...merged.fieldLocks, ...opts.lockFields]));

      // Status: cancelamento só explícito (manual/fonte confirmada); demais derivados das datas.
      if (input.status === 'cancelled') merged.status = 'cancelled';
      else if (isManual && input.status && existing.status === 'cancelled') merged.status = input.status;
      merged.status = computeStatus(merged, new Date(now));
      merged.canonicalKey = input.canonicalKey ?? canonicalKeyFor({ ...merged });
      merged.lastCheckedAt = now;

      const changes = diffRelevant(existing, merged);
      if (Object.keys(changes).length) {
        merged.relevantRevision = existing.relevantRevision + 1;
        merged.updatedAt = now;
      }
      this.update(merged);
      if (Object.keys(changes).length) this.insertVersion(merged, opts.origin, changes, now);
      if (opts.publication) {
        this.linkEventSource(merged.id, opts.publication.id, opts.publication.segmentKey ?? '', opts.confirmedFields ?? [], now);
      }
      return { event: merged, created: false, changes, conflicts };
    });
  }

  /** Atualiza só o status derivado (usado pelo tick do agendador); gera versão se mudou. */
  refreshStatus(ev: ClashEvent, now = nowIso()): { event: ClashEvent; changed: boolean } {
    const next = computeStatus(ev, new Date(now));
    if (next === ev.status) return { event: ev, changed: false };
    const merged = { ...ev, status: next, relevantRevision: ev.relevantRevision + 1, updatedAt: now };
    this.update(merged);
    this.insertVersion(merged, 'scheduler', { status: { from: ev.status, to: next } }, now);
    return { event: merged, changed: true };
  }

  cancelEvent(id: string, reason: string, origin = 'manual', now = nowIso()): ClashEvent | undefined {
    const ev = this.getEvent(id);
    if (!ev || ev.status === 'cancelled') return ev;
    const merged: ClashEvent = { ...ev, status: 'cancelled', relevantRevision: ev.relevantRevision + 1, updatedAt: now, extra: { ...ev.extra, cancelReason: reason } };
    this.update(merged);
    this.insertVersion(merged, origin, { status: { from: ev.status, to: 'cancelled' } }, now);
    return merged;
  }

  lockFields(id: string, fields: string[]): ClashEvent | undefined {
    const ev = this.getEvent(id);
    if (!ev) return undefined;
    const merged = { ...ev, fieldLocks: Array.from(new Set([...ev.fieldLocks, ...fields])) };
    this.update(merged);
    return merged;
  }

  versions(eventId: string) {
    return this.db.all<{ revision: number; origin: string; changes_json: string; created_at: string }>(
      'SELECT revision, origin, changes_json, created_at FROM event_versions WHERE event_id = ? ORDER BY revision',
      eventId,
    );
  }

  // ---------- internos ----------

  private resolveTarget(input: EventInput, opts: ApplyOptions): ClashEvent | undefined {
    if (input.id) {
      const byId = this.getEvent(input.id);
      if (byId) return byId;
    }
    if (opts.publication) {
      const byPub = this.findEventByPublication(opts.publication.id, opts.publication.segmentKey ?? '');
      if (byPub) return byPub;
    }
    // Um mesmo artigo pode anunciar vários eventos: outro segmento da MESMA publicação nunca é o mesmo evento.
    const samePub = new Set<string>(
      opts.publication
        ? this.db.all<{ event_id: string }>('SELECT event_id FROM event_sources WHERE publication_id = ? AND segment_key <> ?', opts.publication.id, opts.publication.segmentKey ?? '').map((r) => r.event_id)
        : [],
    );
    const eligible = (c: ClashEvent) => !samePub.has(c.id);
    const key = input.canonicalKey ?? canonicalKeyFor({ ...input, startPrecision: input.startPrecision ?? 'unknown', endPrecision: input.endPrecision ?? 'unknown' });
    const byKey = this.db.all<EventRow>('SELECT * FROM events WHERE canonical_key = ? AND scope = ?', key, input.scope).map(rowToEvent).find(eligible);
    if (byKey) return byKey;
    // Mesmas datas (dia) com título semelhante e categoria compatível (igual, ou uma delas genérica)
    // (ex.: item "Explosão de Espólios da WWE" do calendário mensal vs post "Evento de medalhas Explosão de Espólios da WWE").
    const sDay = input.startAt && (input.startPrecision ?? 'unknown') !== 'unknown' ? input.startAt.slice(0, 10) : null;
    if (sDay) {
      const sameDay = this.db
        .all<EventRow>("SELECT * FROM events WHERE scope = ? AND substr(start_at, 1, 10) = ? AND status <> 'cancelled'", input.scope, sDay)
        .map(rowToEvent);
      const eDay = input.endAt && (input.endPrecision ?? 'unknown') !== 'unknown' ? input.endAt.slice(0, 10) : null;
      const hit = sameDay.find(
        (c) => eligible(c) && categoriesCompatible(c.category, input.category) && (!eDay || !c.endAt || c.endAt.slice(0, 10) === eDay) && titleOverlap(c.title, input.title) >= 0.6,
      );
      if (hit) return hit;
    }
    // Mesmo título (normalizado) na mesma categoria, ainda não encerrado: ex. teaser sem datas seguido do anúncio com datas.
    const tk = titleKey(input.title);
    if (tk) {
      const candidates = this.db
        .all<EventRow>("SELECT * FROM events WHERE category = ? AND scope = ? AND status NOT IN ('ended','cancelled')", input.category, input.scope)
        .map(rowToEvent);
      const hit = candidates.find((c) => eligible(c) && titleKey(c.title) === tk && (!c.startAt || !input.startAt || c.startAt.slice(0, 10) === input.startAt.slice(0, 10)));
      if (hit) return hit;
    }
    return undefined;
  }

  private buildNew(input: EventInput, now: string, locks: string[]): ClashEvent {
    const ev: ClashEvent = {
      id: input.id ?? newEventId(),
      canonicalKey: null,
      category: input.category,
      scope: input.scope,
      title: input.title,
      description: input.description ?? null,
      startAt: input.startAt ?? null,
      startPrecision: input.startPrecision ?? (input.startAt ? 'datetime' : 'unknown'),
      endAt: input.endAt ?? null,
      endPrecision: input.endPrecision ?? (input.endAt ? 'datetime' : 'unknown'),
      status: 'announced',
      rewardsStatus: input.rewardsStatus ?? (input.rewards?.length ? 'known' : 'unverified'),
      rewards: normalizeRewards(input.rewards ?? []),
      primarySourceUrl: input.primarySourceUrl ?? null,
      fieldLocks: locks,
      relevantRevision: 1,
      firstSeenAt: now,
      updatedAt: now,
      lastCheckedAt: now,
      extra: input.extra ?? {},
    };
    ev.status = input.status === 'cancelled' ? 'cancelled' : computeStatus(ev, new Date(now));
    ev.canonicalKey = input.canonicalKey ?? canonicalKeyFor(ev);
    return ev;
  }

  private insert(ev: ClashEvent) {
    this.db.run(
      `INSERT INTO events (id, canonical_key, category, scope, title, description, start_at, start_precision, end_at, end_precision, status,
        rewards_status, rewards_json, primary_source_url, field_locks, relevant_revision, first_seen_at, updated_at, last_checked_at, extra_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ev.id, ev.canonicalKey, ev.category, ev.scope, ev.title, ev.description, ev.startAt, ev.startPrecision, ev.endAt, ev.endPrecision, ev.status,
      ev.rewardsStatus, JSON.stringify(ev.rewards), ev.primarySourceUrl, JSON.stringify(ev.fieldLocks), ev.relevantRevision, ev.firstSeenAt, ev.updatedAt, ev.lastCheckedAt, JSON.stringify(ev.extra),
    );
  }

  private update(ev: ClashEvent) {
    this.db.run(
      `UPDATE events SET canonical_key = ?, category = ?, scope = ?, title = ?, description = ?, start_at = ?, start_precision = ?, end_at = ?, end_precision = ?, status = ?,
        rewards_status = ?, rewards_json = ?, primary_source_url = ?, field_locks = ?, relevant_revision = ?, updated_at = ?, last_checked_at = ?, extra_json = ?
       WHERE id = ?`,
      ev.canonicalKey, ev.category, ev.scope, ev.title, ev.description, ev.startAt, ev.startPrecision, ev.endAt, ev.endPrecision, ev.status,
      ev.rewardsStatus, JSON.stringify(ev.rewards), ev.primarySourceUrl, JSON.stringify(ev.fieldLocks), ev.relevantRevision, ev.updatedAt, ev.lastCheckedAt, JSON.stringify(ev.extra),
      ev.id,
    );
  }

  private insertVersion(ev: ClashEvent, origin: string, changes: Record<string, unknown>, now: string) {
    this.db.run(
      'INSERT INTO event_versions (event_id, revision, origin, changes_json, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ev.id, ev.relevantRevision, origin, JSON.stringify(changes), JSON.stringify(ev), now,
    );
  }
}

const GENERIC_CATEGORIES = new Set(['other', 'special_event']);
export function categoriesCompatible(a: string, b: string): boolean {
  return a === b || GENERIC_CATEGORIES.has(a) || GENERIC_CATEGORIES.has(b);
}

/** Sobreposição de palavras (sem ruído) relativa ao título menor: 1.0 = um contém o outro. */
export function titleOverlap(a: string, b: string): number {
  const ta = new Set(titleKey(a).split('-').filter((w) => w.length > 2));
  const tb = new Set(titleKey(b).split('-').filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

export function diffRelevant(a: ClashEvent, b: ClashEvent): ApplyResult['changes'] {
  const out: ApplyResult['changes'] = {};
  for (const f of RELEVANT_FIELDS) {
    const av = a[f];
    const bv = b[f];
    const same = f === 'rewards' ? rewardsEqual(av as Reward[], bv as Reward[]) : JSON.stringify(av) === JSON.stringify(bv);
    if (!same) out[f] = { from: av, to: bv };
  }
  return out;
}
