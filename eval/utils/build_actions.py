#!/usr/bin/env python3
"""
Convert page URLs from reports.db to Playwright actions for regression testing.

Usage:
    python3 build_actions.py --db <reports.db> --base-url <url> --target-url <url> --out <actions.json>

Process:
    1. Extract unique page URLs from reports.db using get_page_urls()
    2. Filter: remove external domains, fragments, non-http URLs
    3. Convert each URL to navigate + snapshot action pair
    4. Write Action[] JSON to output file
"""

import json
import argparse
import sys
import os
from urllib.parse import urlparse
from typing import Any

sys.path.insert(0, os.path.dirname(__file__))
from get_combined_urls import get_combined_urls


def build_actions(
    target_dir: str,
    base_url: str,
    target_url: str,
) -> list[dict[str, Any]]:
    """
    Build Action[] from combined URLs (seed_urls.txt + reports.db).

    Args:
        target_dir: Path to target directory (contains seed_urls.txt and/or reports.db)
        base_url: Original base URL (e.g., http://localhost:8080/)
        target_url: Target URL for remapping (e.g., http://localhost:8081/)

    Returns:
        List of Action dicts [{"type": "navigate", "url": ...}, {"type": "snapshot", ...}, ...]
    """


    urls = get_combined_urls(target_dir, base_url, target_url)

    if not urls:
        print("Warning: No URLs extracted", file=sys.stderr)
        return []


    actions: list[dict[str, Any]] = []
    for url in urls:
        actions.append({
            "type": "navigate",
            "url": url,
        })
        actions.append({
            "type": "snapshot",
            "description": f"page: {url}",
        })

    return actions


def main():
    parser = argparse.ArgumentParser(
        description='Convert combined URLs (seed_urls.txt + reports.db) to regression test actions'
    )
    parser.add_argument('--target-dir', required=True, help='Path to target directory')
    parser.add_argument('--base-url', required=True, help='Original base URL (e.g., http://localhost:8080/)')
    parser.add_argument('--target-url', required=True, help='Target URL for remapping (e.g., http://localhost:8081/)')
    parser.add_argument('--out', required=True, help='Output actions.json file')

    args = parser.parse_args()

    try:
        actions = build_actions(args.target_dir, args.base_url, args.target_url)


        os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
        with open(args.out, 'w') as f:
            json.dump(actions, f, indent=2)

        num_pages = sum(1 for a in actions if a['type'] == 'navigate')
        print(f"Generated {len(actions)} actions from {args.target_dir}", file=sys.stderr)
        print(f"Unique pages: {num_pages}", file=sys.stderr)
        print(f"Output: {args.out}", file=sys.stderr)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
