import sqlite3
import os
import yaml
from contextlib import closing

_default_research_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RESEARCH_DIR = os.environ.get("RESEARCH_DIR", _default_research_dir)

def get_db_path(app_id: str) -> str:

    yml_path = os.path.join(RESEARCH_DIR, "targets", f"{app_id}.yml")
    if not os.path.exists(yml_path):
        raise FileNotFoundError(f"targets/{app_id}.yml not found")

    data = yaml.safe_load(open(yml_path))
    name = data["target"]["name"]
    db_path = os.path.join(RESEARCH_DIR, "out", "targets", name, "sinks.db")
    return db_path

def get_all_app_dbs() -> list[tuple[str, str]]:

    targets_dir = os.path.join(RESEARCH_DIR, "targets")
    result = []
    seen_paths = set()
    for f in sorted(os.listdir(targets_dir)):
        if not f.endswith(".yml"):
            continue
        app_id = f[:-4]
        try:
            db_path = get_db_path(app_id)
            if os.path.exists(db_path) and db_path not in seen_paths:
                seen_paths.add(db_path)
                result.append((app_id, db_path))
        except Exception:
            continue
    return result

def get_conn(db_path: str):

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn

def get_dashboard_stats():

    all_dbs = get_all_app_dbs()
    rows = []

    for app_id, db_path in all_dbs:
        try:
            conn = get_conn(db_path)
            row = conn.execute("""
                SELECT
                    ? as app,
                    COUNT(s.id)                                            AS total,
                    SUM(CASE WHEN s.status IN ('RECEIVER_MATCH','NO_RECEIVER') THEN 1 ELSE 0 END) AS target,
                    SUM(CASE WHEN s.verdict='TYPE5' THEN 1 ELSE 0 END)    AS type5,
                    SUM(CASE WHEN s.verdict='TYPE5' AND s.status IN ('RECEIVER_MATCH','NO_RECEIVER') THEN 1 ELSE 0 END) AS type5_target,
                    SUM(CASE WHEN s.verdict='TYPE4' THEN 1 ELSE 0 END)    AS type4,
                    SUM(CASE WHEN s.verdict='TYPE4' AND s.status IN ('RECEIVER_MATCH','NO_RECEIVER') THEN 1 ELSE 0 END) AS type4_target,
                    SUM(CASE WHEN s.verdict='TYPE3' THEN 1 ELSE 0 END)    AS type3,
                    SUM(CASE WHEN s.verdict='TYPE3' AND s.status IN ('RECEIVER_MATCH','NO_RECEIVER') THEN 1 ELSE 0 END) AS type3_target,
                    SUM(CASE WHEN s.verdict='TYPE2' THEN 1 ELSE 0 END)    AS type2,
                    SUM(CASE WHEN s.verdict='TYPE2' AND s.status IN ('RECEIVER_MATCH','NO_RECEIVER') THEN 1 ELSE 0 END) AS type2_target,
                    SUM(CASE WHEN s.verdict='TYPE1' THEN 1 ELSE 0 END)    AS type1,
                    SUM(CASE WHEN s.verdict='TYPE1' AND s.status IN ('RECEIVER_MATCH','NO_RECEIVER') THEN 1 ELSE 0 END) AS type1_target,
                    SUM(CASE WHEN s.verdict='NO_VIOLATION' THEN 1 ELSE 0 END) AS no_violation,
                    SUM(CASE WHEN s.verdict='NO_VIOLATION' AND s.status IN ('RECEIVER_MATCH','NO_RECEIVER') THEN 1 ELSE 0 END) AS no_violation_target,
                    COALESCE(sk.skipped, 0)                                AS skipped
                FROM sinks s
                LEFT JOIN (SELECT COUNT(*) AS skipped FROM skipped_sinks) sk ON 1=1
            """, (app_id,)).fetchone()
            rows.append(row)
            conn.close()
        except Exception:
            pass

    return rows

def get_app_stats(app):

    db_path = get_db_path(app)
    conn = get_conn(db_path)

    verdicts = conn.execute(
        "SELECT verdict, COUNT(*) AS cnt FROM sinks WHERE app = ? GROUP BY verdict",
        (app,)
    ).fetchall()
    sink_types = conn.execute(
        "SELECT sink_type, COUNT(*) AS cnt FROM sinks WHERE app = ? GROUP BY sink_type",
        (app,)
    ).fetchall()
    statuses = conn.execute(
        "SELECT status, COUNT(*) AS cnt FROM sinks WHERE app = ? GROUP BY status",
        (app,)
    ).fetchall()
    kinds = conn.execute(
        "SELECT kind, COUNT(*) AS cnt FROM sinks WHERE app = ? GROUP BY kind ORDER BY kind",
        (app,)
    ).fetchall()
    conn.close()

    return {
        "verdicts": {row["verdict"]: row["cnt"] for row in verdicts},
        "sink_types": {row["sink_type"]: row["cnt"] for row in sink_types},
        "statuses": {row["status"]: row["cnt"] for row in statuses},
        "kinds": {row["kind"]: row["cnt"] for row in kinds}
    }

def get_findings(apps=None, verdicts=None, sink_types=None, statuses=None, kinds=None, offset=0, limit=50):

    apps = apps or []
    verdicts = verdicts or []
    sink_types = sink_types or []
    statuses = statuses or []
    kinds = kinds or []

    if not apps:

        all_rows = []
        for app_id, db_path in get_all_app_dbs():
            conn = get_conn(db_path)
            query_rows = conn.execute("""
                SELECT id, app, verdict, sink_key, kind, file, line, col, status, sink_type, original_snippet
                FROM sinks
                WHERE ? IN ('', app)  -- Always true to disable app filtering
                ORDER BY CASE verdict
                  WHEN 'TYPE5' THEN 1 WHEN 'TYPE4' THEN 2
                  WHEN 'TYPE3' THEN 3 WHEN 'TYPE2' THEN 4
                  WHEN 'TYPE1' THEN 5 END,
                  line, col
            """, ('',)).fetchall()
            all_rows.extend(query_rows)
            conn.close()

        if verdicts:
            all_rows = [r for r in all_rows if r["verdict"] in verdicts]
        if sink_types:
            all_rows = [r for r in all_rows if r["sink_type"] in sink_types]
        if statuses:
            all_rows = [r for r in all_rows if r["status"] in statuses]
        if kinds:
            all_rows = [r for r in all_rows if r["kind"] in kinds]

        all_rows = sorted(all_rows, key=lambda r: (
            {'TYPE5': 1, 'TYPE4': 2, 'TYPE3': 3, 'TYPE2': 4, 'TYPE1': 5}.get(r["verdict"], 6),
            r["line"],
            r["col"]
        ))

        return all_rows[offset:offset+limit]
    else:

        all_rows = []
        for app in apps:
            try:
                db_path = get_db_path(app)
                conn = get_conn(db_path)

                where_clauses = []
                params = []

                if verdicts:
                    placeholders = ",".join("?" * len(verdicts))
                    where_clauses.append(f"verdict IN ({placeholders})")
                    params.extend(verdicts)

                if sink_types:
                    placeholders = ",".join("?" * len(sink_types))
                    where_clauses.append(f"sink_type IN ({placeholders})")
                    params.extend(sink_types)

                if statuses:
                    placeholders = ",".join("?" * len(statuses))
                    where_clauses.append(f"status IN ({placeholders})")
                    params.extend(statuses)

                if kinds:
                    placeholders = ",".join("?" * len(kinds))
                    where_clauses.append(f"kind IN ({placeholders})")
                    params.extend(kinds)

                where = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""

                query = f"""
                    SELECT id, app, verdict, sink_key, kind, file, line, col, status, sink_type, original_snippet
                    FROM sinks
                    {where}
                    ORDER BY CASE verdict
                      WHEN 'CRITICAL' THEN 1 WHEN 'CAUTION' THEN 2
                      WHEN 'ADVISORY' THEN 3 WHEN 'WATCH'   THEN 4 END,
                      line, col
                """

                query_rows = conn.execute(query, params).fetchall()
                all_rows.extend(query_rows)
                conn.close()
            except Exception:
                continue

        return all_rows[offset:offset+limit]

def get_findings_count(apps=None, verdicts=None, sink_types=None, statuses=None, kinds=None):

    all_rows = get_findings(apps, verdicts, sink_types, statuses, kinds, offset=0, limit=999999)
    return len(all_rows)

def get_finding_in_app(app_id: str, finding_id: int):

    try:
        db_path = get_db_path(app_id)
        conn = get_conn(db_path)
        row = conn.execute("SELECT * FROM sinks WHERE id = ?", (finding_id,)).fetchone()
        conn.close()
        return row
    except Exception:
        return None

def get_finding_by_id(finding_id):

    for app_id, db_path in get_all_app_dbs():
        try:
            conn = get_conn(db_path)
            row = conn.execute("SELECT * FROM sinks WHERE id = ?", (finding_id,)).fetchone()
            conn.close()
            if row:
                return row
        except Exception:
            continue

    return None

def get_all_apps():

    return [app_id for app_id, _ in get_all_app_dbs()]

def get_findings_stats():

    all_verdicts = {}
    all_sink_types = {}
    all_kinds = {}
    all_statuses = {}

    for app_id, db_path in get_all_app_dbs():
        try:
            conn = get_conn(db_path)

            verdicts = conn.execute(
                "SELECT verdict, COUNT(*) AS cnt FROM sinks GROUP BY verdict"
            ).fetchall()
            for row in verdicts:
                v = row["verdict"]
                all_verdicts[v] = all_verdicts.get(v, 0) + row["cnt"]

            sink_types = conn.execute(
                "SELECT sink_type, COUNT(*) AS cnt FROM sinks GROUP BY sink_type"
            ).fetchall()
            for row in sink_types:
                st = row["sink_type"]
                all_sink_types[st] = all_sink_types.get(st, 0) + row["cnt"]

            kinds = conn.execute(
                "SELECT kind, COUNT(*) AS cnt FROM sinks GROUP BY kind ORDER BY kind"
            ).fetchall()
            for row in kinds:
                k = row["kind"]
                all_kinds[k] = all_kinds.get(k, 0) + row["cnt"]

            statuses = conn.execute(
                "SELECT status, COUNT(*) AS cnt FROM sinks GROUP BY status"
            ).fetchall()
            for row in statuses:
                s = row["status"]
                all_statuses[s] = all_statuses.get(s, 0) + row["cnt"]

            conn.close()
        except Exception:
            continue

    return {
        "verdicts": all_verdicts,
        "sink_types": all_sink_types,
        "kinds": all_kinds,
        "statuses": all_statuses
    }

def get_filtered_counts(apps=None, verdicts=None, sink_types=None, statuses=None, kinds=None):

    apps = apps or []
    verdicts = verdicts or []
    sink_types = sink_types or []
    statuses = statuses or []
    kinds = kinds or []

    all_rows = get_findings(apps, None, None, None, None, offset=0, limit=999999)

    verdict_counts = {}
    sink_type_counts = {}
    kind_counts = {}
    status_counts = {}
    app_counts = {}

    for row in all_rows:
        v = row["verdict"]
        verdict_counts[v] = verdict_counts.get(v, 0) + 1

        st = row["sink_type"]
        sink_type_counts[st] = sink_type_counts.get(st, 0) + 1

        k = row["kind"]
        kind_counts[k] = kind_counts.get(k, 0) + 1

        s = row["status"]
        status_counts[s] = status_counts.get(s, 0) + 1

        a = row["app"]
        app_counts[a] = app_counts.get(a, 0) + 1

    return {
        "verdicts": verdict_counts,
        "sink_types": sink_type_counts,
        "kinds": kind_counts,
        "statuses": status_counts,
        "apps": app_counts
    }

def _validate_table(table: str) -> str:

    allowed_tables = {"classify_reports", "violation_reports"}
    if table not in allowed_tables:
        raise ValueError(f"Invalid table name: {table}")
    return table

def _validate_column(column: str) -> str:

    allowed_columns = {"reclassified_verdict", "tt_type", "sink_kind"}
    if column not in allowed_columns:
        raise ValueError(f"Invalid column name: {column}")
    return column

def get_report_db_path(app_id: str) -> str:

    db_path = get_db_path(app_id)
    return os.path.join(os.path.dirname(db_path), "reports.db")

def get_all_report_app_dbs() -> list[tuple[str, str]]:

    result = []
    seen_paths = set()
    for app_id, _ in get_all_app_dbs():
        try:
            report_db_path = get_report_db_path(app_id)
            if os.path.exists(report_db_path) and report_db_path not in seen_paths:
                seen_paths.add(report_db_path)
                result.append((app_id, report_db_path))
        except Exception:
            continue
    return result

def get_report_summary(db_path: str) -> dict:

    try:
        with closing(get_conn(db_path)) as conn:
            classify_count = conn.execute(
                "SELECT COUNT(*) as cnt FROM classify_reports"
            ).fetchone()["cnt"]

            violation_count = conn.execute(
                "SELECT COUNT(*) as cnt FROM violation_reports"
            ).fetchone()["cnt"]

            unique_sinks = conn.execute(
                "SELECT COUNT(DISTINCT sink_key) as cnt FROM classify_reports WHERE sink_key IS NOT NULL"
            ).fetchone()["cnt"]

            verdict_dist = conn.execute(
                "SELECT reclassified_verdict, COUNT(*) as cnt FROM classify_reports GROUP BY reclassified_verdict"
            ).fetchall()

            verdict_counts = {row["reclassified_verdict"]: row["cnt"] for row in verdict_dist if row["reclassified_verdict"]}

            return {
                "classify_count": classify_count,
                "violation_count": violation_count,
                "unique_sinks": unique_sinks,
                "verdict_counts": verdict_counts
            }
    except Exception:
        return {
            "classify_count": 0,
            "violation_count": 0,
            "unique_sinks": 0,
            "verdict_counts": {}
        }

def get_reports(db_path: str, table: str, verdicts=None, tt_types=None, sink_kinds=None, offset: int = 0, limit: int = 50) -> list:

    table = _validate_table(table)
    verdicts = verdicts or []
    tt_types = tt_types or []
    sink_kinds = sink_kinds or []

    try:
        with closing(get_conn(db_path)) as conn:
            where_clauses = []
            params = []

            if verdicts:
                placeholders = ",".join("?" * len(verdicts))
                where_clauses.append(f"reclassified_verdict IN ({placeholders})")
                params.extend(verdicts)

            if tt_types:
                placeholders = ",".join("?" * len(tt_types))
                where_clauses.append(f"tt_type IN ({placeholders})")
                params.extend(tt_types)

            if sink_kinds:
                placeholders = ",".join("?" * len(sink_kinds))
                where_clauses.append(f"sink_kind IN ({placeholders})")
                params.extend(sink_kinds)

            where = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""

            query = f"""
                SELECT * FROM {table}
                {where}
                ORDER BY received_at DESC
                LIMIT ? OFFSET ?
            """
            params.extend([limit, offset])

            rows = conn.execute(query, params).fetchall()
            return [dict(row) for row in rows]
    except Exception:
        return []

def get_report_count(db_path: str, table: str, verdicts=None, tt_types=None, sink_kinds=None) -> int:

    table = _validate_table(table)
    verdicts = verdicts or []
    tt_types = tt_types or []
    sink_kinds = sink_kinds or []

    try:
        with closing(get_conn(db_path)) as conn:
            where_clauses = []
            params = []

            if verdicts:
                placeholders = ",".join("?" * len(verdicts))
                where_clauses.append(f"reclassified_verdict IN ({placeholders})")
                params.extend(verdicts)

            if tt_types:
                placeholders = ",".join("?" * len(tt_types))
                where_clauses.append(f"tt_type IN ({placeholders})")
                params.extend(tt_types)

            if sink_kinds:
                placeholders = ",".join("?" * len(sink_kinds))
                where_clauses.append(f"sink_kind IN ({placeholders})")
                params.extend(sink_kinds)

            where = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""
            query = f"SELECT COUNT(*) as cnt FROM {table} {where}"

            return conn.execute(query, params).fetchone()["cnt"]
    except Exception:
        return 0

def get_report_distinct_values(db_path: str, table: str, column: str) -> list[str]:

    table = _validate_table(table)
    column = _validate_column(column)

    try:
        with closing(get_conn(db_path)) as conn:
            rows = conn.execute(
                f"SELECT DISTINCT {column} FROM {table} WHERE {column} IS NOT NULL ORDER BY {column}"
            ).fetchall()
            return [row[column] for row in rows]
    except Exception:
        return []

def get_reports_grouped_by_sink(db_path: str, table: str, verdicts=None, tt_types=None, sink_kinds=None, offset: int = 0, limit: int = 50) -> list:

    table = _validate_table(table)
    verdicts = verdicts or []
    tt_types = tt_types or []
    sink_kinds = sink_kinds or []

    try:
        with closing(get_conn(db_path)) as conn:
            where_clauses = []
            params = []

            if verdicts:
                placeholders = ",".join("?" * len(verdicts))
                where_clauses.append(f"reclassified_verdict IN ({placeholders})")
                params.extend(verdicts)

            if tt_types:
                placeholders = ",".join("?" * len(tt_types))
                where_clauses.append(f"tt_type IN ({placeholders})")
                params.extend(tt_types)

            if sink_kinds:
                placeholders = ",".join("?" * len(sink_kinds))
                where_clauses.append(f"sink_kind IN ({placeholders})")
                params.extend(sink_kinds)

            where = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""

            query = f"""
                SELECT
                    sink_key,
                    tt_type,
                    sink_kind,
                    COUNT(*) as total_count,
                    MAX(received_at) as latest_received,
                    GROUP_CONCAT(DISTINCT reclassified_verdict) as verdicts
                FROM {table}
                {where}
                GROUP BY sink_key, tt_type, sink_kind
                ORDER BY latest_received DESC
                LIMIT ? OFFSET ?
            """

            params.extend([limit, offset])
            rows = conn.execute(query, params).fetchall()
            result = []
            for row in rows:
                row_dict = dict(row)

                if row_dict.get('sink_key'):
                    try:
                        oracle_query = "SELECT oracle_verdict FROM oracle_verdicts WHERE sink_key = ?"
                        oracle_result = conn.execute(oracle_query, (row_dict['sink_key'],)).fetchone()
                        row_dict['oracle_verdict'] = oracle_result[0] if oracle_result else None
                    except Exception:
                        row_dict['oracle_verdict'] = None
                else:
                    row_dict['oracle_verdict'] = None
                result.append(row_dict)
            return result
    except Exception as e:
        import traceback
        traceback.print_exc()
        return []

def get_reports_grouped_by_sink_count(db_path: str, table: str, verdicts=None, tt_types=None, sink_kinds=None) -> int:

    table = _validate_table(table)
    verdicts = verdicts or []
    tt_types = tt_types or []
    sink_kinds = sink_kinds or []

    try:
        with closing(get_conn(db_path)) as conn:
            where_clauses = []
            params = []

            if verdicts:
                placeholders = ",".join("?" * len(verdicts))
                where_clauses.append(f"reclassified_verdict IN ({placeholders})")
                params.extend(verdicts)

            if tt_types:
                placeholders = ",".join("?" * len(tt_types))
                where_clauses.append(f"tt_type IN ({placeholders})")
                params.extend(tt_types)

            if sink_kinds:
                placeholders = ",".join("?" * len(sink_kinds))
                where_clauses.append(f"sink_kind IN ({placeholders})")
                params.extend(sink_kinds)

            where = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""

            query = f"""
                SELECT COUNT(*) as cnt
                FROM (
                    SELECT 1
                    FROM {table}
                    {where}
                    GROUP BY sink_key, tt_type, sink_kind
                )
            """

            result = conn.execute(query, params).fetchone()
            return result[0] if result else 0
    except Exception:
        return 0

def get_reports_by_sink(db_path: str, table: str, sink_key: str) -> list:

    table = _validate_table(table)
    try:
        with closing(get_conn(db_path)) as conn:
            query = f"""
                SELECT * FROM {table}
                WHERE sink_key = ?
                ORDER BY received_at DESC
            """
            rows = conn.execute(query, (sink_key,)).fetchall()
            return [dict(row) for row in rows]
    except Exception:
        return []

def get_reports_by_sink_null(db_path: str, table: str) -> list:

    table = _validate_table(table)
    try:
        with closing(get_conn(db_path)) as conn:
            query = f"""
                SELECT * FROM {table}
                WHERE sink_key IS NULL
                ORDER BY received_at DESC
            """
            rows = conn.execute(query).fetchall()
            return [dict(row) for row in rows]
    except Exception:
        return []

def get_oracle_verdicts(db_path: str) -> list:

    try:
        with closing(get_conn(db_path)) as conn:
            rows = conn.execute(
                "SELECT * FROM oracle_verdicts ORDER BY sink_key"
            ).fetchall()
            return [dict(row) for row in rows]
    except Exception:
        return []
