import type { CalendarRepo } from '../../calendar/repo.js';
import type { Db } from '../../db/index.js';
import { nowIso } from '../../domain/dates.js';
import type { Logger } from '../../logger.js';
import type { Engine } from '../../scheduler/engine.js';
import { extractEvents } from './extract.js';
import type { AnnouncementSource, Publication } from './types.js';

export interface CollectorRunResult {
  source: string;
  ok: boolean;
  error?: string;
  publications: number;
  changedPublications: number;
  eventsCreated: number;
  eventsUpdated: number;
}

export function recordRunStart(db: Db, source: string, now = nowIso()): number {
  const r = db.run('INSERT INTO collector_runs (source, started_at) VALUES (?, ?)', source, now);
  return Number(r.lastInsertRowid);
}

export function recordRunEnd(db: Db, id: number, ok: boolean, error: string | null, items: number, now = nowIso()) {
  db.run('UPDATE collector_runs SET finished_at = ?, ok = ?, error = ?, items = ? WHERE id = ?', now, ok ? 1 : 0, error, items, id);
}

/** Última execução bem-sucedida e se a última tentativa falhou (para o rodapé dos relatórios). */
export function announcementsHealth(db: Db): { lastOkAt: string | null; lastFailed: boolean } {
  const ok = db.get<{ finished_at: string | null }>(
    "SELECT finished_at FROM collector_runs WHERE source LIKE 'announcements:%' AND ok = 1 ORDER BY id DESC LIMIT 1",
  );
  const last = db.get<{ ok: number | null }>("SELECT ok FROM collector_runs WHERE source LIKE 'announcements:%' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1");
  return { lastOkAt: ok?.finished_at ?? null, lastFailed: last ? last.ok === 0 : false };
}

/**
 * Processa uma publicação já obtida: registra, detecta mudança de conteúdo, extrai eventos e
 * aplica ao calendário. Retorna quantos eventos foram criados/atualizados.
 */
export function ingestPublication(pub: Publication, repo: CalendarRepo, engine: Engine | null, log: Logger, now = nowIso()): { created: number; updated: number; changed: boolean } {
  const { changed, isNew } = repo.upsertPublication(
    { id: pub.id, sourceKind: pub.sourceKind, url: pub.url, locale: pub.locale, title: pub.title, publishedAt: pub.publishedAt, payload: { title: pub.title, publishedAt: pub.publishedAt, blocks: pub.blocks } },
    now,
  );
  if (!changed && !isNew) return { created: 0, updated: 0, changed: false };
  let created = 0;
  let updated = 0;
  const extracted = extractEvents(pub);
  for (const ex of extracted) {
    const res = repo.applyEvent(ex.input, { origin: `collector:${pub.sourceKind}`, publication: { id: pub.id, segmentKey: ex.segmentKey }, confirmedFields: ex.confirmedFields, now });
    if (res.created) created++;
    else if (Object.keys(res.changes).length) updated++;
    for (const note of ex.notes) {
      const isRewards = note.startsWith('recompensas');
      // já confirmadas com prêmios (não só loja) por outra fonte ou importação manual
      if (isRewards && res.event.rewardsStatus === 'known' && res.event.rewards.some((r) => r.kind !== 'shop')) continue;
      const kind = isRewards ? 'rewards_unverified' : note.includes('fuso') ? 'date_without_tz' : note.startsWith('ano ') ? 'year_ambiguous' : 'unparsed';
      repo.addReview({ eventId: res.event.id, kind, sourceUrl: pub.url, note }, now);
    }
    engine?.onEventApplied(res, now);
    log.info({ event: res.event.id, title: res.event.title, created: res.created, changes: Object.keys(res.changes), conflicts: res.conflicts, publication: pub.id }, 'evento processado');
  }
  if (extracted.length === 0) {
    // Omissão visível: toda publicação sem evento reconhecido vira pendência (uma vez por publicação).
    repo.addReview({ kind: 'no_events', proposedValue: pub.id, sourceUrl: pub.url, note: `publicação "${pub.title}" sem datas rotuladas nem itens de calendário reconhecíveis; confira se anuncia algum evento` }, now);
    log.info({ publication: pub.id, title: pub.title }, 'publicação sem eventos reconhecíveis (pendência registrada)');
  }
  return { created, updated, changed: true };
}

export async function runAnnouncementSource(source: AnnouncementSource, db: Db, repo: CalendarRepo, engine: Engine | null, log: Logger, opts: { maxItems?: number } = {}): Promise<CollectorRunResult> {
  const runId = recordRunStart(db, `announcements:${source.kind}`);
  const result: CollectorRunResult = { source: source.kind, ok: false, publications: 0, changedPublications: 0, eventsCreated: 0, eventsUpdated: 0 };
  try {
    const listings = (await source.list()).slice(0, opts.maxItems ?? 20);
    result.publications = listings.length;
    for (const l of listings) {
      const pub = await source.fetch(l);
      const r = ingestPublication(pub, repo, engine, log);
      if (r.changed) result.changedPublications++;
      result.eventsCreated += r.created;
      result.eventsUpdated += r.updated;
    }
    result.ok = true;
    recordRunEnd(db, runId, true, null, result.publications);
  } catch (err) {
    // Falha de coleta NUNCA altera eventos existentes; apenas fica registrada.
    result.error = err instanceof Error ? err.message : String(err);
    recordRunEnd(db, runId, false, result.error, result.publications);
    log.warn({ source: source.kind, err: result.error }, 'fonte de anúncios indisponível ou com estrutura inesperada');
  }
  return result;
}
