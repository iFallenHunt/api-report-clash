import { CalendarRepo } from './calendar/repo.js';
import { announcementsHealth, runAnnouncementSource } from './collectors/announcements/index.js';
import { BlogSource } from './collectors/announcements/blog.js';
import { InboxSource } from './collectors/announcements/inbox.js';
import type { AnnouncementSource } from './collectors/announcements/types.js';
import { CocClient } from './collectors/coc/client.js';
import { ClanPoller } from './collectors/coc/poll.js';
import type { AppConfig } from './config.js';
import { Db, migrate } from './db/index.js';
import type { Logger } from './logger.js';
import { Outbox } from './outbox/queue.js';
import { Engine } from './scheduler/engine.js';

/** Monta as dependências da aplicação (sem iniciar agendador nem WhatsApp). */
export function buildApp(cfg: AppConfig, log: Logger) {
  const db = new Db(cfg.dbPath);
  migrate(db);
  const repo = new CalendarRepo(db);
  const outbox = new Outbox(db, cfg.dryRun ? 'dry_run' : 'live');
  const engine = new Engine({ db, repo, outbox, cfg, log, announcementsHealth: () => announcementsHealth(db) });

  const sources: AnnouncementSource[] = [];
  if (cfg.sources.blog) sources.push(new BlogSource(cfg.sources.locale));
  if (cfg.sources.inbox) sources.push(new InboxSource(cfg.sources.locale));

  const pollAnnouncements = async () => {
    const results = [];
    for (const s of sources) results.push(await runAnnouncementSource(s, db, repo, engine, log));
    return results;
  };

  let clanPoller: ClanPoller | null = null;
  if (cfg.coc.token && cfg.coc.clanTag) {
    const client = new CocClient({ base: cfg.coc.base, token: cfg.coc.token });
    clanPoller = new ClanPoller({ client, clanTag: cfg.coc.clanTag, db, repo, outbox, cfg, log });
  } else {
    log.warn('COC_API_TOKEN e/ou CLAN_TAG ausentes: coleta do clã (guerra/liga/raide) desativada');
  }

  return { db, repo, outbox, engine, sources, pollAnnouncements, clanPoller };
}

export type App = ReturnType<typeof buildApp>;
