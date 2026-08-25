"""Persistent, evidence-based state for resumable agent crawls."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional

TERMINAL_STATUSES = frozenset({"reachable", "fired_without_payload", "exhausted", "unreachable_static"})
RETRYABLE_STATUSES = frozenset({
    "pending", "infra_failed", "timeout", "usage_limited", "turn_limited",
})
ALL_STATUSES = TERMINAL_STATUSES | RETRYABLE_STATUSES | {"legacy_attempted"}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS crawl_runs (
  crawl_run_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS group_attempts (
  agent_run_id TEXT PRIMARY KEY,
  crawl_run_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  cache_key TEXT,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS sink_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sink_key TEXT NOT NULL,
  crawl_run_id TEXT,
  agent_run_id TEXT,
  status TEXT NOT NULL,
  evidence_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(sink_key, agent_run_id)
);
CREATE INDEX IF NOT EXISTS idx_sink_attempts_key ON sink_attempts(sink_key, created_at);
CREATE INDEX IF NOT EXISTS idx_sink_attempts_run ON sink_attempts(crawl_run_id, status);
CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
"""


class AgentStateStore:
    def __init__(self, path: str) -> None:
        self.path = path
        self._write_lock = threading.RLock()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @staticmethod
    def _locked(ex: sqlite3.OperationalError) -> bool:
        message = str(ex).lower()
        return "locked" in message or "busy" in message

    def _initialize(self) -> None:
        """Configure the database once; changing journal mode per connection needs a lock."""
        delays = (0.05, 0.1, 0.25, 0.5, 1.0, 2.0)
        for attempt in range(len(delays) + 1):
            try:
                with sqlite3.connect(self.path, timeout=30) as conn:
                    conn.execute("PRAGMA busy_timeout=30000")
                    conn.execute("PRAGMA journal_mode=WAL")
                    conn.execute("PRAGMA synchronous=NORMAL")
                    conn.executescript(_SCHEMA)
                return
            except sqlite3.OperationalError as ex:
                if not self._locked(ex) or attempt == len(delays):
                    raise
                time.sleep(delays[attempt])

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _write(self, operation) -> None:
        """Serialize writers and retry transient locks without rerunning paid agent work."""
        delays = (0.05, 0.1, 0.25, 0.5, 1.0, 2.0)
        with self._write_lock:
            for attempt in range(len(delays) + 1):
                try:
                    with self._connect() as conn:
                        operation(conn)
                    return
                except sqlite3.OperationalError as ex:
                    if not self._locked(ex) or attempt == len(delays):
                        raise
                    time.sleep(delays[attempt])

    def begin_run(self, crawl_run_id: str, config: dict[str, Any]) -> None:
        def operation(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT INTO crawl_runs(crawl_run_id,started_at,status,config_json) VALUES(?,?,?,?)",
                (crawl_run_id, int(time.time() * 1000), "running", json.dumps(config, sort_keys=True)),
            )
        self._write(operation)

    def finish_run(self, crawl_run_id: str, status: str, error: Optional[str] = None) -> None:
        def operation(conn: sqlite3.Connection) -> None:
            conn.execute(
                "UPDATE crawl_runs SET finished_at=?, status=?, error=? WHERE crawl_run_id=?",
                (int(time.time() * 1000), status, error, crawl_run_id),
            )
        self._write(operation)

    def begin_group(self, agent_run_id: str, crawl_run_id: str, source_file: str,
                    model: str, cache_key: str, cache_hit: bool) -> None:
        def operation(conn: sqlite3.Connection) -> None:
            conn.execute(
                """INSERT INTO group_attempts(agent_run_id,crawl_run_id,source_file,model,
                   started_at,status,cache_key,cache_hit) VALUES(?,?,?,?,?,?,?,?)""",
                (agent_run_id, crawl_run_id, source_file, model, int(time.time() * 1000),
                 "running", cache_key, int(cache_hit)),
            )
        self._write(operation)

    def finish_group(self, agent_run_id: str, status: str, turns: int = 0,
                     error: Optional[str] = None) -> None:
        def operation(conn: sqlite3.Connection) -> None:
            conn.execute(
                "UPDATE group_attempts SET finished_at=?,status=?,turns=?,error=? WHERE agent_run_id=?",
                (int(time.time() * 1000), status, turns, error, agent_run_id),
            )
        self._write(operation)

    def record_sink(self, sink_key: str, crawl_run_id: Optional[str],
                    agent_run_id: Optional[str], status: str,
                    evidence: Optional[dict[str, Any]] = None) -> None:
        if status not in ALL_STATUSES:
            raise ValueError(f"invalid sink status: {status}")
        self.record_sinks([(sink_key, crawl_run_id, agent_run_id, status, evidence)])

    def record_sinks(self, records: Iterable[tuple[str, Optional[str], Optional[str], str,
                                                    Optional[dict[str, Any]]]]) -> None:
        prepared = []
        now = int(time.time() * 1000)
        for sink_key, crawl_run_id, agent_run_id, status, evidence in records:
            if status not in ALL_STATUSES:
                raise ValueError(f"invalid sink status: {status}")
            prepared.append((sink_key, crawl_run_id, agent_run_id, status,
                             json.dumps(evidence or {}, sort_keys=True), now))
        if not prepared:
            return

        def operation(conn: sqlite3.Connection) -> None:
            conn.executemany(
                """INSERT INTO sink_attempts(sink_key,crawl_run_id,agent_run_id,status,
                   evidence_json,created_at) VALUES(?,?,?,?,?,?)
                   ON CONFLICT(sink_key,agent_run_id) DO UPDATE SET
                   status=excluded.status,evidence_json=excluded.evidence_json,
                   created_at=excluded.created_at""",
                prepared,
            )
        self._write(operation)

    def terminal_sinks(self) -> set[str]:
        marks = ",".join("?" for _ in TERMINAL_STATUSES)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT DISTINCT sink_key FROM sink_attempts WHERE status IN ({marks})",
                tuple(sorted(TERMINAL_STATUSES)),
            ).fetchall()
        return {str(row[0]) for row in rows}

    def attempts_for(self, sink_key: str) -> int:
        with self._connect() as conn:
            return int(conn.execute(
                "SELECT COUNT(*) FROM sink_attempts WHERE sink_key=?", (sink_key,)
            ).fetchone()[0])

    def latest_sink_states(self) -> dict[str, tuple[str, dict[str, Any]]]:
        """Return the newest disposition per sink for retry-policy decisions."""
        with self._connect() as conn:
            rows = conn.execute("""
                SELECT sink_key,status,evidence_json FROM (
                  SELECT sink_key,status,evidence_json,
                         ROW_NUMBER() OVER (
                           PARTITION BY sink_key ORDER BY created_at DESC,id DESC
                         ) AS rn
                  FROM sink_attempts
                ) WHERE rn=1
            """).fetchall()
        states: dict[str, tuple[str, dict[str, Any]]] = {}
        for row in rows:
            try:
                evidence = json.loads(row["evidence_json"] or "{}")
            except json.JSONDecodeError:
                evidence = {}
            states[str(row["sink_key"])] = (str(row["status"]), evidence)
        return states

    def migrate_attempted(self, attempted_path: str) -> int:
        src = Path(attempted_path)
        migrated = src.with_suffix(src.suffix + ".migrated")
        if not src.exists() or migrated.exists():
            return 0
        keys = [line.strip() for line in src.read_text(encoding="utf-8").splitlines() if line.strip()]
        now = int(time.time() * 1000)
        def operation(conn: sqlite3.Connection) -> None:
            conn.executemany(
                """INSERT OR IGNORE INTO sink_attempts
                   (sink_key,crawl_run_id,agent_run_id,status,evidence_json,created_at)
                   VALUES(?,NULL,?, 'legacy_attempted','{}',?)""",
                ((key, f"legacy:{key}", now) for key in keys),
            )
        self._write(operation)
        os.replace(src, migrated)
        return len(keys)

    def register_cache(self, cache_key: str, source_file: str, path: str, hit: bool) -> None:
        now = int(time.time() * 1000)
        def operation(conn: sqlite3.Connection) -> None:
            conn.execute(
                """INSERT INTO cache_entries(cache_key,source_file,path,created_at,last_used_at,hits)
                   VALUES(?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET
                   last_used_at=excluded.last_used_at,hits=cache_entries.hits+excluded.hits""",
                (cache_key, source_file, path, now, now, int(hit)),
            )
        self._write(operation)

    def summary(self, crawl_run_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT status,COUNT(*) n FROM sink_attempts WHERE crawl_run_id=? GROUP BY status",
                (crawl_run_id,),
            ).fetchall()
            groups = conn.execute(
                "SELECT model,COUNT(*) n,SUM(turns) turns,SUM(cache_hit) hits FROM group_attempts WHERE crawl_run_id=? GROUP BY model",
                (crawl_run_id,),
            ).fetchall()
        return {
            "sink_statuses": {row["status"]: row["n"] for row in rows},
            "models": {row["model"]: {"calls": row["n"], "turns": row["turns"] or 0,
                                      "cache_hits": row["hits"] or 0} for row in groups},
        }
