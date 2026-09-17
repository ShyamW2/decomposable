-- One database per song workspace (workspaces/<songId>/analysis.db).
-- Copy the folder to another machine and the analysis opens there (ADR-002).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS song (
  song_id      TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  duration     REAL,
  sample_rate  INTEGER,
  channels     INTEGER
);

-- The analysis document: append-only, provenance on every row (ADR-004).
CREATE TABLE IF NOT EXISTS event (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  song_id         TEXT NOT NULL,
  at              TEXT NOT NULL,
  producer_plugin TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  layer           TEXT NOT NULL,
  confidence      REAL,
  t_start         REAL,
  t_end           REAL,
  payload         TEXT NOT NULL,
  -- Set when a re-run of the producer invalidates this event and its descendants.
  superseded_at   TEXT
);

-- The derivation edge. Kept as its own table (not only as JSON on the event) so
-- that invalidating the descendants of an event is one recursive query.
CREATE TABLE IF NOT EXISTS event_input (
  event_id TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  input_id TEXT NOT NULL,
  PRIMARY KEY (event_id, input_id)
);

CREATE INDEX IF NOT EXISTS event_layer_time ON event (layer, t_start, t_end);
CREATE INDEX IF NOT EXISTS event_producer   ON event (producer_plugin, producer_version);
CREATE INDEX IF NOT EXISTS event_input_rev  ON event_input (input_id);
