import { CalendarRepo } from '../src/calendar/repo.js';
import { testConfig, type AppConfig } from '../src/config.js';
import { Db, migrate } from '../src/db/index.js';
import { silentLogger } from '../src/logger.js';
import { Outbox, type OutboxMode } from '../src/outbox/queue.js';
import { Engine } from '../src/scheduler/engine.js';
import type { EventInput } from '../src/domain/types.js';

export function memDb(): Db {
  const db = new Db(':memory:');
  migrate(db);
  return db;
}

export function harness(opts: { mode?: OutboxMode; cfg?: Partial<AppConfig>; db?: Db; health?: { lastOkAt: string | null; lastFailed: boolean } } = {}) {
  const db = opts.db ?? memDb();
  const cfg = testConfig({ ...(opts.cfg ?? {}), dryRun: (opts.mode ?? 'dry_run') === 'dry_run' });
  const repo = new CalendarRepo(db);
  const outbox = new Outbox(db, opts.mode ?? 'dry_run');
  const health = opts.health ?? { lastOkAt: '2026-09-24T10:00:00Z', lastFailed: false };
  const engine = new Engine({ db, repo, outbox, cfg, log: silentLogger, announcementsHealth: () => health });
  return { db, cfg, repo, outbox, engine, log: silentLogger, health };
}

export const NOW = '2026-09-24T12:00:00Z';

export function globalEvent(over: Partial<EventInput> = {}): EventInput {
  return {
    category: 'medal_event',
    scope: 'global',
    title: 'Evento de Medalhas Teste',
    startAt: '2026-10-01T08:00:00Z',
    startPrecision: 'datetime',
    endAt: '2026-10-14T08:00:00Z',
    endPrecision: 'datetime',
    rewardsStatus: 'unverified',
    primarySourceUrl: 'https://supercell.com/en/games/clashofclans/pt/blog/news/teste',
    ...over,
  };
}
