const Database = require('better-sqlite3');
const { SINK_STATUSES, SKIPPED_STATUSES } = require('./constants');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sinks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  app            TEXT    NOT NULL,
  sink_key       TEXT,
  file           TEXT    NOT NULL,
  line           INTEGER NOT NULL,
  col            INTEGER NOT NULL,
  kind           TEXT    NOT NULL,
  pattern        TEXT    NOT NULL,
  sink_type      TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  arg_type       TEXT,
  arg_constant   INTEGER,
  arg_value      TEXT,
  verdict        TEXT NOT NULL,
  verdict_reasons TEXT,
  html_tags      TEXT,
  original_snippet TEXT,
  node_start     INTEGER,
  node_end       INTEGER,
  arg_start      INTEGER,
  arg_end        INTEGER,
  patch_strategy TEXT,
  patch_wrapper  TEXT,
  refactor_suggestion TEXT,
  display_suggestion TEXT,
  alt_kinds      TEXT,
  hash           TEXT,
  patch_count    INTEGER DEFAULT 0,
  observation_mode TEXT NOT NULL DEFAULT 'continuous',
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skipped_sinks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app        TEXT NOT NULL,
  sink_key   TEXT,
  file       TEXT NOT NULL,
  line       INTEGER NOT NULL,
  col        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  pattern    TEXT NOT NULL,
  sink_type  TEXT NOT NULL,
  status     TEXT NOT NULL,
  original_snippet TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS edge_sinks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app        TEXT NOT NULL,
  sink_key   TEXT,
  file       TEXT NOT NULL,
  line       INTEGER NOT NULL,
  col        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  pattern    TEXT NOT NULL,
  sink_type  TEXT NOT NULL,
  status     TEXT NOT NULL,
  original_snippet TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sinks_app      ON sinks(app);
CREATE INDEX IF NOT EXISTS idx_sinks_kind     ON sinks(kind);
CREATE INDEX IF NOT EXISTS idx_sinks_status   ON sinks(status);
CREATE INDEX IF NOT EXISTS idx_sinks_verdict  ON sinks(verdict);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sinks_key ON sinks(app, sink_key);
CREATE INDEX IF NOT EXISTS idx_sinks_hash     ON sinks(app, hash);
CREATE INDEX IF NOT EXISTS idx_skipped_app    ON skipped_sinks(app);
CREATE INDEX IF NOT EXISTS idx_skipped_kind   ON skipped_sinks(kind);
CREATE INDEX IF NOT EXISTS idx_edge_app       ON edge_sinks(app);
CREATE INDEX IF NOT EXISTS idx_edge_kind      ON edge_sinks(kind);
`;

function openDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(SCHEMA);

  try {
    db.exec("ALTER TABLE sinks ADD COLUMN observation_mode TEXT NOT NULL DEFAULT 'continuous'");
  } catch {  }
  return db;
}

function resolveSinkId(finding) {
  return finding.sinkCode
    ?? (finding.sinkHash ? `S-${finding.sinkHash}:${finding.kind}` : null);
}

function mapSinkRow(app, f) {
  const sinkId = resolveSinkId(f);
  return {
    app,
    sink_key:       sinkId,
    hash:           f.sinkHash ?? null,
    file:           f.file,
    line:           f.line,
    col:            f.col,
    kind:           f.kind,
    pattern:        f.pattern,
    sinkType:       f.sinkType,
    status:         f.status,
    argType:        f.argType ?? null,
    argConstant:    f.argConstant ? 1 : 0,
    argValue:       f.argValue ?? null,
    verdict:            f.verdict ?? null,
    verdictReasons:     f.verdictReasons ? JSON.stringify(f.verdictReasons) : null,
    htmlTags:           f.htmlTags ? JSON.stringify(f.htmlTags) : null,
    originalSnippet:    f.original_snippet ?? null,
    node_start:         f.node_start ?? null,
    node_end:           f.node_end ?? null,
    arg_start:          f.arg_start ?? null,
    arg_end:            f.arg_end ?? null,
    patch_strategy:     f.patch_strategy ?? null,
    patch_wrapper:      f.patch_wrapper ?? null,
    observationMode:    f.observationMode ?? 'continuous',
    refactorSuggestion: f.refactorSuggestion ?? null,
    displaySuggestion:  f.displaySuggestion ?? null,
    altKinds:           f.altKinds ? JSON.stringify(f.altKinds) : null,
  };
}

function mapMinimalRow(app, f) {
  const sinkId = resolveSinkId(f);
  return {
    app,
    sink_key: sinkId,
    file:     f.file,
    line:    f.line,
    col:     f.col,
    kind:    f.kind,
    pattern: f.pattern,
    sinkType: f.sinkType,
    status:  f.status,
    originalSnippet: f.original_snippet ?? null,
  };
}

function mergeFindings(findings) {
  const { SINK_TYPE_SEVERITY } = require('./constants');
  const result = [];
  const unresolvableGroups = new Map();

  for (const f of findings) {
    if (!SINK_STATUSES.has(f.status) || f.status !== 'RECEIVER_UNRESOLVABLE') {
      result.push(f);
      continue;
    }
    const key = `${f.file}:${f.line}:${f.col}`;
    if (!unresolvableGroups.has(key)) unresolvableGroups.set(key, []);
    unresolvableGroups.get(key).push(f);
  }

  for (const [, group] of unresolvableGroups) {
    if (group.length === 1) { result.push(group[0]); continue; }
    const sorted = [...group].sort((a, b) => {
      const diff = (SINK_TYPE_SEVERITY[b.sinkType] ?? 0) - (SINK_TYPE_SEVERITY[a.sinkType] ?? 0);
      return diff !== 0 ? diff : a.kind.localeCompare(b.kind);
    });
    const primary = sorted[0];
    const altKinds = sorted.slice(1).map(f => f.kind);
    result.push({ ...primary, altKinds });
  }
  return result;
}

function writeFindings(db, app, findings) {
  const deleteActive = db.prepare('DELETE FROM sinks WHERE app = ? AND sink_key = ?');
  const deleteSkipped = db.prepare('DELETE FROM skipped_sinks WHERE app = ? AND sink_key = ?');
  const deleteEdge = db.prepare('DELETE FROM edge_sinks WHERE app = ? AND sink_key = ?');
  const insertSink = db.prepare(`
    INSERT INTO sinks
      (app, sink_key, hash, file, line, col, kind, pattern, sink_type, status, arg_type, arg_constant, arg_value,
       verdict, verdict_reasons, html_tags, original_snippet, node_start, node_end, arg_start, arg_end, patch_strategy, patch_wrapper,
       observation_mode, refactor_suggestion, display_suggestion, alt_kinds)
    VALUES
      (@app, @sink_key, @hash, @file, @line, @col, @kind, @pattern, @sinkType, @status, @argType, @argConstant, @argValue,
       @verdict, @verdictReasons, @htmlTags, @originalSnippet, @node_start, @node_end, @arg_start, @arg_end, @patch_strategy, @patch_wrapper,
       @observationMode, @refactorSuggestion, @displaySuggestion, @altKinds)
    ON CONFLICT(app, sink_key) DO UPDATE SET
      hash = excluded.hash,
      file = excluded.file,
      line = excluded.line,
      col = excluded.col,
      kind = excluded.kind,
      pattern = excluded.pattern,
      sink_type = excluded.sink_type,
      status = excluded.status,
      arg_type = excluded.arg_type,
      arg_constant = excluded.arg_constant,
      arg_value = excluded.arg_value,
      html_tags = excluded.html_tags,
      node_start = excluded.node_start,
      node_end = excluded.node_end,
      arg_start = excluded.arg_start,
      arg_end = excluded.arg_end,
      patch_strategy = excluded.patch_strategy,
      patch_wrapper = excluded.patch_wrapper,
      refactor_suggestion = excluded.refactor_suggestion,
      display_suggestion  = excluded.display_suggestion,
      alt_kinds = excluded.alt_kinds
  `);

  const insertSkipped = db.prepare(`
    INSERT OR REPLACE INTO skipped_sinks
      (app, sink_key, file, line, col, kind, pattern, sink_type, status, original_snippet)
    VALUES
      (@app, @sink_key, @file, @line, @col, @kind, @pattern, @sinkType, @status, @originalSnippet)
  `);

  const insertEdge = db.prepare(`
    INSERT OR REPLACE INTO edge_sinks
      (app, sink_key, file, line, col, kind, pattern, sink_type, status, original_snippet)
    VALUES
      (@app, @sink_key, @file, @line, @col, @kind, @pattern, @sinkType, @status, @originalSnippet)
  `);

  const run = db.transaction((findings) => {
    const merged = mergeFindings(findings);
    const seenKeys = new Set();
    for (const f of merged) {
      const sinkId = resolveSinkId(f);
      if (!sinkId) {
        throw new Error(`missing sink identity after occurrence allocation: ${f.file}:${f.line}:${f.col}:${f.kind}`);
      }
      if (seenKeys.has(sinkId)) {
        throw new Error(`duplicate sink identity after occurrence allocation: ${sinkId}`);
      }
      seenKeys.add(sinkId);
      if (SINK_STATUSES.has(f.status)) {
        deleteSkipped.run(app, sinkId);
        deleteEdge.run(app, sinkId);
        insertSink.run(mapSinkRow(app, f));
      } else if (SKIPPED_STATUSES.has(f.status)) {
        deleteActive.run(app, sinkId);
        deleteSkipped.run(app, sinkId);
        deleteEdge.run(app, sinkId);
        insertSkipped.run(mapMinimalRow(app, f));
      } else {
        deleteActive.run(app, sinkId);
        deleteSkipped.run(app, sinkId);
        deleteEdge.run(app, sinkId);
        insertEdge.run(mapMinimalRow(app, f));
      }
    }
  });

  run(findings);
  return mergeFindings(findings).filter(f => SINK_STATUSES.has(f.status)).length;
}

function clearApp(db, app) {
  db.transaction(() => {
    db.prepare('DELETE FROM sinks WHERE app = ?').run(app);
    db.prepare('DELETE FROM skipped_sinks WHERE app = ?').run(app);
    db.prepare('DELETE FROM edge_sinks WHERE app = ?').run(app);
  })();
}

function clearFile(db, app, file) {
  db.transaction(() => {
    db.prepare('DELETE FROM sinks WHERE app = ? AND file = ?').run(app, file);
    db.prepare('DELETE FROM skipped_sinks WHERE app = ? AND file = ?').run(app, file);
    db.prepare('DELETE FROM edge_sinks WHERE app = ? AND file = ?').run(app, file);
  })();
}

module.exports = { openDb, writeFindings, clearApp, clearFile };
