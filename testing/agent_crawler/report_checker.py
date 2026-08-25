"""Report queries with exact agent-event provenance and legacy fallbacks."""
from __future__ import annotations

import re
import sqlite3
import time
from pathlib import Path
from typing import Optional

_TOKEN_RE = re.compile(r"tt-[0-9a-f]{6}-[0-9a-f]{4}", re.IGNORECASE)
_RETRY_DELAYS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.0)


def _locked(ex: sqlite3.OperationalError) -> bool:
    message = str(ex).lower()
    return "locked" in message or "busy" in message


def _read(db_path: str, operation):
    """Run a short read-only query while the report server continues writing."""
    uri = Path(db_path).resolve().as_uri() + "?mode=ro"
    for attempt in range(len(_RETRY_DELAYS) + 1):
        try:
            with sqlite3.connect(uri, uri=True, timeout=30, isolation_level=None) as conn:
                conn.execute("PRAGMA busy_timeout=30000")
                conn.execute("PRAGMA query_only=ON")
                return operation(conn)
        except sqlite3.OperationalError as ex:
            if not _locked(ex) or attempt == len(_RETRY_DELAYS):
                raise
            time.sleep(_RETRY_DELAYS[attempt])


def _has_table(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def get_max_report_id(db_path: str) -> int:
    value = _read(db_path, lambda conn: conn.execute(
        "SELECT MAX(id) FROM classify_reports"
    ).fetchone()[0])
    return int(value or 0)


def count_reports_with_payload(db_path: str, sink_key: str, after_id: int, payload: str,
                               agent_run_id: Optional[str] = None,
                               crawl_run_id: Optional[str] = None) -> int:
    def query(conn: sqlite3.Connection) -> int:
        if agent_run_id and _has_table(conn, "agent_report_events"):
            sql = "SELECT COUNT(*) FROM agent_report_events WHERE sink_key=? AND agent_run_id=? AND value_preview LIKE ?"
            args: list[object] = [sink_key, agent_run_id, f"%{payload}%"]
            if crawl_run_id:
                sql += " AND crawl_run_id=?"
                args.append(crawl_run_id)
            return int(conn.execute(sql, args).fetchone()[0])
        return int(conn.execute(
            "SELECT COUNT(*) FROM classify_reports WHERE sink_key=? AND id>? AND value_preview LIKE ?",
            (sink_key, after_id, f"%{payload}%"),
        ).fetchone()[0])
    return _read(db_path, query)


def count_agent_events(db_path: str, sink_key: str, agent_run_id: str,
                       crawl_run_id: Optional[str] = None) -> int:
    def query(conn: sqlite3.Connection) -> int:
        if not _has_table(conn, "agent_report_events"):
            return int(conn.execute(
                "SELECT COUNT(*) FROM classify_reports WHERE sink_key=? AND agent_run_id=?",
                (sink_key, agent_run_id),
            ).fetchone()[0])
        sql = "SELECT COUNT(*) FROM agent_report_events WHERE sink_key=? AND agent_run_id=?"
        args: list[object] = [sink_key, agent_run_id]
        if crawl_run_id:
            sql += " AND crawl_run_id=?"
            args.append(crawl_run_id)
        return int(conn.execute(sql, args).fetchone()[0])
    return _read(db_path, query)


def summarize_agent_reach(db_path: str, sink_key: str, after_id: int = 0,
                         crawl_run_id: Optional[str] = None) -> tuple[int, int, str]:
    def query(conn: sqlite3.Connection):
        if _has_table(conn, "agent_report_events"):
            sql = "SELECT value_preview FROM agent_report_events WHERE sink_key=?"
            args: list[object] = [sink_key]
            if crawl_run_id:
                sql += " AND crawl_run_id=?"
                args.append(crawl_run_id)
            rows = conn.execute(sql, args).fetchall()
            if rows:
                return len(rows), sum(1 for (v,) in rows if v and _TOKEN_RE.search(v)), "exact_event"
            if crawl_run_id:
                return 0, 0, "exact_event"
        rows = conn.execute(
            "SELECT value_preview FROM classify_reports WHERE sink_key=? AND agent_run_id LIKE 'agent-%' AND id>?",
            (sink_key, after_id),
        ).fetchall()
        return len(rows), sum(1 for (v,) in rows if v and _TOKEN_RE.search(v)), "legacy_aggregate"
    return _read(db_path, query)


def summarize_sink_reach(db_path: str, sink_key: str, after_id: int = 0) -> tuple[int, int]:
    """Backward-compatible cumulative agent reach summary."""
    total, token, _ = summarize_agent_reach(db_path, sink_key, after_id)
    return total, token
