#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import io
import logging
import sqlite3
from pathlib import Path

from codeql_utils import decode_bqrs

logger = logging.getLogger(__name__)

def parse_dataflow_csv(csv_text: str) -> list[dict]:

    reader = csv.reader(io.StringIO(csv_text))
    try:
        header = next(reader)
    except StopIteration:
        return []

    if len(header) < 4:
        raise RuntimeError(
            f"Unexpected BQRS schema: {header}. Expected 4 columns."
        )

    records: list[dict] = []
    for row in reader:
        if len(row) < 4:
            continue
        try:
            parts = row[3].split("||")
            if len(parts) < 5:
                logger.warning("Skipping row with malformed col3: %s", row[3])
                continue

            sink_kind = parts[0]
            source_kind = parts[1]
            file_path = parts[2]
            line = int(parts[3])
            col = int(parts[4])

            source_file = parts[5] if len(parts) > 5 else ""
            source_line = int(parts[6]) if len(parts) > 6 else 0
            source_col = int(parts[7]) if len(parts) > 7 else 0

            records.append({
                "sink_code": row[0],
                "source_code": row[1],
                "source_kind": source_kind,
                "sink_kind": sink_kind,
                "sink_file": file_path,
                "sink_line": line,
                "sink_col": col,
                "source_file": source_file,
                "source_line": source_line,
                "source_col": source_col,
            })
        except (ValueError, IndexError) as exc:
            logger.warning("Skipping malformed row %s: %s", row, exc)

    return records

def save_to_db(records: list[dict], db_path: Path, app_name: str) -> int:

    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS dataflow_paths (
            sink_file TEXT,
            sink_line INTEGER,
            sink_col INTEGER,
            sink_kind TEXT,
            source_kind TEXT,
            source_code TEXT,
            source_file TEXT,
            source_line INTEGER,
            source_col INTEGER
        )
    """)

    inserted = 0
    for r in records:
        conn.execute("""
            INSERT INTO dataflow_paths
            (sink_file, sink_line, sink_col, sink_kind, source_kind, source_code,
             source_file, source_line, source_col)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            r["sink_file"], r["sink_line"], r["sink_col"], r["sink_kind"],
            r["source_kind"], r["source_code"], r["source_file"],
            r["source_line"], r["source_col"]
        ))
        inserted += 1

    conn.commit()
    conn.close()
    return inserted

def main() -> None:
    parser = argparse.ArgumentParser(
        description="SinkDataFlowPaths BQRS -> unified DB"
    )
    parser.add_argument("--bqrs-file", required=True, type=Path)
    parser.add_argument("--out-db", required=True, type=Path)
    parser.add_argument("--app-name", required=True)
    parser.add_argument("-v", "--verbose", action="store_true")

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    csv_text = decode_bqrs(args.bqrs_file)
    records = parse_dataflow_csv(csv_text)
    logger.info("Parsed %d dataflow path records", len(records))

    if not records:
        logger.info("No dataflow paths to insert")
        return

    count = save_to_db(records, args.out_db, args.app_name)
    logger.info("Inserted %d dataflow paths into %s", count, args.out_db)

if __name__ == "__main__":
    main()
