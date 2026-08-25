const DDL = `
CREATE TABLE IF NOT EXISTS classify_reports (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at            INTEGER NOT NULL,
  tt_type                TEXT NOT NULL,
  sink_key               TEXT,
  sink_kind              TEXT,
  value_preview          TEXT,
  value_length           INTEGER,
  page_url               TEXT,
  client_timestamp       INTEGER,
  stack                  TEXT,
  reclassified_verdict   TEXT,
  verdict_reasons        TEXT,
  count                  INTEGER NOT NULL DEFAULT 1,
  source_values          TEXT,
  xss_source_values      TEXT,
  js_signature           TEXT,
  url_signature          TEXT,
  caller_location        TEXT,
  agent_run_id           TEXT
);
CREATE INDEX IF NOT EXISTS idx_classify_sink_key  ON classify_reports(sink_key);
CREATE INDEX IF NOT EXISTS idx_classify_sink_kind ON classify_reports(sink_kind);
CREATE INDEX IF NOT EXISTS idx_classify_verdict   ON classify_reports(reclassified_verdict);
CREATE INDEX IF NOT EXISTS idx_classify_caller_location ON classify_reports(caller_location);
CREATE TABLE IF NOT EXISTS agent_report_events (
  event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at    INTEGER NOT NULL,
  crawl_run_id   TEXT,
  agent_run_id   TEXT NOT NULL,
  sink_key       TEXT,
  value_preview  TEXT,
  page_url       TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_report_events(crawl_run_id, agent_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_sink ON agent_report_events(sink_key);
CREATE TABLE IF NOT EXISTS violation_reports (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at            INTEGER NOT NULL,
  tt_type                TEXT NOT NULL,
  sink_key               TEXT,
  sink_kind              TEXT,
  value_preview          TEXT,
  value_length           INTEGER,
  page_url               TEXT,
  client_timestamp       INTEGER,
  stack                  TEXT,
  reclassified_verdict   TEXT,
  verdict_reasons        TEXT,
  count                  INTEGER NOT NULL DEFAULT 1,
  source_values          TEXT,
  xss_source_values      TEXT,
  js_signature           TEXT,
  url_signature          TEXT,
  sanitized_value_preview TEXT,
  caller_location        TEXT,
  agent_run_id           TEXT
);
CREATE INDEX IF NOT EXISTS idx_violation_sink_key  ON violation_reports(sink_key);
CREATE INDEX IF NOT EXISTS idx_violation_sink_kind ON violation_reports(sink_kind);
CREATE INDEX IF NOT EXISTS idx_violation_verdict   ON violation_reports(reclassified_verdict);
CREATE TABLE IF NOT EXISTS oracle_verdicts (
  sink_key           TEXT PRIMARY KEY,
  oracle_verdict     TEXT,
  oracle_confidence  TEXT,
  oracle_score       INTEGER,
  oracle_mixed       INTEGER NOT NULL DEFAULT 0,
  patch_verdict      TEXT,
  is_patch_target    INTEGER NOT NULL DEFAULT 0,
  applied_verdict    TEXT,
  applied_at         INTEGER,
  updated_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS js_signatures (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT    NOT NULL UNIQUE,
  sink_key  TEXT,
  sink_id   INTEGER,
  note      TEXT,
  added_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS url_signatures (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  url       TEXT    NOT NULL UNIQUE,
  sri       TEXT,
  note      TEXT,
  added_at  INTEGER NOT NULL
);
`;

function initSchema(db) {
  db.exec(DDL);
  db.exec('DROP INDEX IF EXISTS idx_classify_dedup');
  db.exec(`
    CREATE UNIQUE INDEX idx_classify_dedup
    ON classify_reports(tt_type, COALESCE(sink_key,''), COALESCE(reclassified_verdict,''), COALESCE(value_preview,''))
  `);
  db.exec('DROP INDEX IF EXISTS idx_violation_dedup');
  db.exec(`
    CREATE UNIQUE INDEX idx_violation_dedup
    ON violation_reports(tt_type, COALESCE(sink_key,''), COALESCE(reclassified_verdict,''), COALESCE(value_preview,''))
  `);

  try { db.exec('ALTER TABLE classify_reports ADD COLUMN caller_location TEXT'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_classify_caller_location ON classify_reports(caller_location)'); } catch {}
  try { db.exec('ALTER TABLE violation_reports ADD COLUMN caller_location TEXT'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_violation_caller_location ON violation_reports(caller_location)'); } catch {}

  try { db.exec('ALTER TABLE classify_reports ADD COLUMN agent_run_id TEXT'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_classify_agent_run_id ON classify_reports(agent_run_id)'); } catch {}
  try { db.exec('ALTER TABLE violation_reports ADD COLUMN agent_run_id TEXT'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_violation_agent_run_id ON violation_reports(agent_run_id)'); } catch {}

  try { db.exec('ALTER TABLE oracle_verdicts ADD COLUMN applied_verdict TEXT'); } catch {}
  try { db.exec('ALTER TABLE oracle_verdicts ADD COLUMN applied_at INTEGER'); } catch {}
}

module.exports = { initSchema };
