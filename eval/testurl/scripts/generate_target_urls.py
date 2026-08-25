#!/usr/bin/env python3
"""
Generate target_urls.yaml from testurl_*.json results.

Filtering conditions:
1. Only include is_page: true URLs
2. If filtered URLs <= 10: include all, regardless of policy_invocations
3. If filtered URLs > 10: exclude URLs with policy_invocations = 0
4. If still > 10 after step 3: deduplicate by policy_calls_by_name + sinks_by_name structure
5. If still > 10 after step 4: deduplicate by URL path, status, content-type, content-length

Usage:
    python3 generate_target_urls.py --json-file <path> --output <path>
"""

import json
import yaml
import argparse
import sys
from pathlib import Path


def make_http_fingerprint(item: dict) -> tuple:
    """Create a fingerprint based on URL path, status, content-type, content-length."""
    from urllib.parse import urlparse
    parsed_url = urlparse(item.get("url", ""))
    path = parsed_url.path
    status = item.get("status")
    content_type = item.get("content_type")
    content_length = item.get("content_length")
    return (path, status, content_type, content_length)


def make_fingerprint(item: dict) -> tuple:
    """Create a fingerprint based on policy_calls_by_name and sinks_by_name structure."""
    policy = tuple(sorted(item.get("policy_calls_by_name", {}).items()))
    sinks = tuple(sorted(item.get("sinks_by_name", {}).items()))
    return (policy, sinks)


def main():
    parser = argparse.ArgumentParser(description="Generate target_urls.yaml from testurl results")
    parser.add_argument("--json-file", required=True, help="Path to testurl_*.json file")
    parser.add_argument("--output", required=True, help="Output path for target_urls.yaml")

    args = parser.parse_args()

    try:
        with open(args.json_file) as f:
            data = json.load(f)
    except Exception as e:
        print(f"Error reading JSON: {e}", file=sys.stderr)
        sys.exit(1)

    page_items = [
        item
        for item in data.get("per_url", [])
        if item.get("is_page", False)
    ]

    if not page_items:
        print(f"Warning: No page URLs found in {args.json_file}")
        urls = []
        filter_applied = "no pages found"
        step2_count = 0
        step3_count = 0
    else:
        if len(page_items) <= 10:
            filtered_items = page_items
            filter_applied = "none (count <= 10)"
        else:
            with_policy = [
                item
                for item in page_items
                if item.get("policy_invocations", 0) > 0
            ]
            filter_applied = "policy_invocations > 0 (count > 10)"
            if len(with_policy) < 10:
                without_policy = [
                    item
                    for item in page_items
                    if item.get("policy_invocations", 0) == 0
                ]
                backfill = without_policy[: 10 - len(with_policy)]
                filtered_items = with_policy + backfill
                if backfill:
                    filter_applied += f" + backfilled {len(backfill)} policy_invocations=0 pages to reach 10"
            else:
                filtered_items = with_policy

        step2_count = len(filtered_items)

        step3_before = len(filtered_items)
        if len(filtered_items) > 10:
            seen: set[tuple] = set()
            deduped = []
            dropped = []
            for item in filtered_items:
                fp = make_fingerprint(item)
                if fp not in seen:
                    seen.add(fp)
                    deduped.append(item)
                else:
                    dropped.append(item)
            filter_applied += " + dedup by policy/sink structure"
            if len(deduped) < 10 and dropped:
                backfill = dropped[: 10 - len(deduped)]
                deduped = deduped + backfill
                filter_applied += f" + backfilled {len(backfill)} duplicate-structure pages to reach 10"
            filtered_items = deduped

        step3_count = len(filtered_items)

        step4_before = len(filtered_items)
        if len(filtered_items) > 10:
            seen: set[tuple] = set()
            deduped = []
            dropped = []
            for item in filtered_items:
                fp = make_http_fingerprint(item)
                if fp not in seen:
                    seen.add(fp)
                    deduped.append(item)
                else:
                    dropped.append(item)
            filter_applied += " + dedup by HTTP properties"
            if len(deduped) < 10 and dropped:
                backfill = dropped[: 10 - len(deduped)]
                deduped = deduped + backfill
                filter_applied += f" + backfilled {len(backfill)} duplicate-HTTP pages to reach 10"
            filtered_items = deduped

        urls = [item["url"] for item in filtered_items]

    try:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)

        output_data = {"urls": urls}
        with open(args.output, "w") as f:
            yaml.dump(output_data, f, default_flow_style=False, sort_keys=False)

        print(f"Generated {args.output}")
        print(f"  Step 1 (is_page): {len(page_items)}")
        if len(page_items) > 10:
            print(f"  Step 2 (policy>0): {step2_count}")
            print(f"  Step 3 (HTTP dedup): {step3_count}")
            print(f"  Step 4 (policy/sink dedup): {len(urls)}")
        print(f"  Final URLs: {len(urls)}")
        print(f"  Filter applied: {filter_applied}")

    except Exception as e:
        print(f"Error writing YAML: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
