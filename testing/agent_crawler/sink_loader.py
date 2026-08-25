"""Load TYPE3 sinks from sinks.db."""

import sqlite3
from typing import Any


def load_type3_sinks(db_path: str) -> list[dict[str, Any]]:
    """
    Load all TYPE3 sinks from sinks.db.

    Returns all sinks with verdict = 'TYPE3', regardless of status.
    """
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        cur.execute(
            """
            SELECT id, sink_key, file, line, col, kind, original_snippet, verdict
            FROM sinks
            WHERE verdict = 'TYPE3'
            ORDER BY id
            """
        )

        rows = cur.fetchall()
        result = [dict(row) for row in rows]

    return result
