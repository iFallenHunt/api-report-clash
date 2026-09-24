-- Eventos (globais e do clã). Datas em UTC ISO-8601. Precisão independente para início e término.
CREATE TABLE events (
  id TEXT PRIMARY KEY,                       -- id opaco estável (evt_xxx)
  canonical_key TEXT,                        -- chave de correspondência entre fontes (categoria + datas)
  category TEXT NOT NULL,                    -- season|medal_event|special_event|challenge|clan_games|update|cwl|war|raid_weekend|other
  scope TEXT NOT NULL,                       -- global|clan
  title TEXT NOT NULL,
  description TEXT,
  start_at TEXT,
  start_precision TEXT NOT NULL DEFAULT 'unknown',   -- datetime|date|unknown
  end_at TEXT,
  end_precision TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL,                      -- announced|scheduled|active|ended|cancelled
  rewards_status TEXT NOT NULL DEFAULT 'unverified', -- known|not_announced|unverified
  rewards_json TEXT NOT NULL DEFAULT '[]',
  primary_source_url TEXT,
  field_locks TEXT NOT NULL DEFAULT '[]',    -- campos confirmados manualmente; coletor não sobrescreve
  relevant_revision INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_start ON events(start_at);
CREATE INDEX idx_events_canonical ON events(canonical_key);

-- Histórico de alterações relevantes (nunca criado por last_checked_at).
CREATE TABLE event_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  origin TEXT NOT NULL,                      -- collector:<fonte> | manual | clan
  changes_json TEXT NOT NULL,                -- {campo: {from, to}}
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_event_versions_event ON event_versions(event_id, revision);

-- Publicações (artigos) de fontes oficiais. Uma publicação pode anunciar vários eventos.
CREATE TABLE publications (
  id TEXT PRIMARY KEY,                       -- <fonte>:<locale>:<slug ou id>
  source_kind TEXT NOT NULL,                 -- blog|inbox|manual
  url TEXT NOT NULL,
  locale TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

-- Relação N:N evento <-> publicação, com os campos efetivamente confirmados por aquela fonte.
CREATE TABLE event_sources (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  segment_key TEXT NOT NULL DEFAULT '',      -- distingue vários eventos no mesmo artigo
  confirmed_fields_json TEXT NOT NULL,       -- ["start_at","end_at",...]
  collected_at TEXT NOT NULL,
  PRIMARY KEY (event_id, publication_id, segment_key)
);

-- Pendências para revisão humana (extração não confiável, conflitos com campos travados).
CREATE TABLE review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                        -- rewards_unverified|field_conflict|date_without_tz|unparsed
  field TEXT,
  current_value TEXT,
  proposed_value TEXT,
  source_url TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_review_open ON review_queue(resolved_at);

-- Último estado observado do clã na API (guerra, liga, raide).
CREATE TABLE clan_state (
  kind TEXT NOT NULL,                        -- war|cwl|raid
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);

-- Fila de saída persistente. Unicidade por (mode, dedup_key): DRY_RUN não consome a dedup real.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,                        -- dry_run|live
  dedup_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT,
  body TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|sending|sent|failed|expired|superseded|uncertain|dry_run
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_until TEXT,
  sent_at TEXT,
  wa_message_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (mode, dedup_key)
);
CREATE INDEX idx_outbox_status ON outbox(mode, status, fire_at);

-- Execuções dos coletores (sucesso/falha), para distinguir "fonte indisponível" de "sem novidades".
CREATE TABLE collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  error TEXT,
  items INTEGER NOT NULL DEFAULT 0
);

-- Marcas de relatórios gerados (dedup por mode) e snapshot para "o que mudou".
CREATE TABLE report_marks (
  mode TEXT NOT NULL,
  key TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (mode, key)
);
