#!/usr/bin/env python3
"""
Extract unique page URLs from reports.db (classify_reports and violation_reports tables).

Usage:
    python3 get_page_urls.py --db <path> [--base-url <url>] [--target-url <url>]

Args:
    --db: Path to reports.db
    --base-url: Original base URL (used as prefix to identify and replace URLs)
    --target-url: Target URL to remap base_url to (e.g., for different ports)

Output:
    JSON array of unique page URLs to stdout
"""

import sqlite3
import json
import argparse
import sys
import os
import contextlib


def get_page_urls(db_path: str, base_url: str | None = None, target_url: str | None = None) -> list[str]:
    """
    Extract unique page URLs from reports.db.

    Args:
        db_path: Path to reports.db
        base_url: Base URL to match for remapping (e.g., 'http://localhost:8080/')
        target_url: Target URL to remap to (e.g., 'http://localhost:8081/')

    Returns:
        Sorted list of unique page URLs
    """
    db_path = os.path.realpath(db_path)

    if not os.path.exists(db_path):
        print(f"Warning: Database not found: {db_path}", file=sys.stderr)
        return []

    try:
        with contextlib.closing(sqlite3.connect(db_path)) as conn:
            cursor = conn.cursor()

            urls = set()


            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = {row[0] for row in cursor.fetchall()}

            if 'classify_reports' in tables:
                cursor.execute("SELECT DISTINCT page_url FROM classify_reports WHERE page_url IS NOT NULL")
                for row in cursor.fetchall():
                    url = row[0]
                    if url:
                        urls.add(url.strip())

            if 'violation_reports' in tables:
                cursor.execute("SELECT DISTINCT page_url FROM violation_reports WHERE page_url IS NOT NULL")
                for row in cursor.fetchall():
                    url = row[0]
                    if url:
                        urls.add(url.strip())


        if base_url and target_url:
            base = base_url.rstrip('/')
            target = target_url.rstrip('/')
            urls = {
                (target + url[len(base):]) if url.startswith(base) else url
                for url in urls
            }

        result = sorted(urls)


        if not result and target_url:
            result = [target_url.rstrip('/') + '/']

        return result

    except Exception as e:
        print(f"Warning: {type(e).__name__} querying database: {e}", file=sys.stderr)
        if target_url:
            return [target_url.rstrip('/') + '/']
        return []


def main():
    parser = argparse.ArgumentParser(
        description='Extract unique page URLs from reports.db'
    )
    parser.add_argument('--db', required=True, help='Path to reports.db')
    parser.add_argument('--base-url', help='Base URL to match for remapping')
    parser.add_argument('--target-url', help='Target URL to remap base_url to')

    args = parser.parse_args()

    urls = get_page_urls(args.db, args.base_url, args.target_url)
    print(json.dumps(urls))


if __name__ == '__main__':
    main()
