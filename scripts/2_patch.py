#!/usr/bin/env python3

import argparse
import sqlite3
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

import requests
import yaml

class TeeLogger:

    def __init__(self, log_path: Path) -> None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        self._file = open(log_path, "w")
        self._stdout = sys.stdout

    def write(self, msg: str) -> None:
        self._stdout.write(msg)
        self._file.write(msg)

    def flush(self) -> None:
        self._stdout.flush()
        self._file.flush()

    def close(self) -> None:
        self._file.close()

def parse_args():
    p = argparse.ArgumentParser(description="Auto-patch sinks via viewer API")
    p.add_argument("yml_file", help="targets/<app>.yml")
    p.add_argument("--viewer-port", type=int, default=8000)
    return p.parse_args()

def start_viewer(script_dir: Path, port: int) -> None:
    print("Viewer is not running. Starting in background...")
    subprocess.run(
        [str(script_dir / "0_run-viewer.sh"), "start", "-b", "-p", str(port)],
        check=True,
    )
    time.sleep(3)

def wait_for_viewer(port: int, retries: int = 10) -> None:
    for _ in range(retries):
        try:
            r = requests.get(f"http://localhost:{port}/", timeout=3)
            if r.status_code < 500:
                return
        except requests.exceptions.ConnectionError:
            pass
        time.sleep(1)
    raise RuntimeError(f"Viewer is not responding (port {port})")

def count_lines(file_path: str) -> int:
    try:
        with open(file_path, "rb") as f:
            return f.read().count(b"\n")
    except OSError:
        return -1

def get_files_for_batch(sinks_db: Path, batch_ids: list[int]) -> list[str]:
    placeholders = ",".join("?" * len(batch_ids))
    conn = sqlite3.connect(sinks_db)
    rows = conn.execute(
        f"SELECT DISTINCT file FROM sinks WHERE id IN ({placeholders})", batch_ids
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]

def make_file_grouped_batches(sinks_db: Path, batch_size: int) -> list[list[int]]:

    conn = sqlite3.connect(sinks_db)
    rows = conn.execute(
        "SELECT id, file FROM sinks "
        "WHERE (status IN ('RECEIVER_MATCH', 'NO_RECEIVER', 'RECEIVER_UNRESOLVABLE') "
        "       OR patch_strategy = 'dispatchDynamic') "
        "AND patch_count = 0 "
        "ORDER BY file, id"
    ).fetchall()
    conn.close()

    file_groups: dict[str, list[int]] = defaultdict(list)
    for sink_id, file_path in rows:
        file_groups[file_path].append(sink_id)

    batches = []
    current_batch = []
    for ids in file_groups.values():
        if current_batch and len(current_batch) + len(ids) > batch_size:
            batches.append(current_batch)
            current_batch = []
        current_batch.extend(ids)
    if current_batch:
        batches.append(current_batch)

    return batches

def main():
    args = parse_args()
    script_dir = Path(__file__).parent
    research_dir = script_dir.parent
    yml_path = Path(args.yml_file)

    with open(yml_path) as f:
        cfg = yaml.safe_load(f)

    target_name = cfg["target"]["name"]
    app_id = yml_path.stem
    sinks_db = research_dir / "out" / "targets" / target_name / "sinks.db"
    src_dir = research_dir / "out" / "targets" / target_name / "src"

    logs_dir = research_dir / "out" / "targets" / target_name / "logs"
    patch_log = logs_dir / "patch.log"
    tee = TeeLogger(patch_log)
    sys.stdout = tee

    start_time = None

    try:
        print("==========================================")
        print(f"Patch: {app_id}")
        print("==========================================")
        print(f"Name:    {target_name}")
        print(f"DB:      {sinks_db}")
        print(f"Viewer:  http://localhost:{args.viewer_port}")
        print()

        if not sinks_db.exists():
            print(f"Error: {sinks_db} not found.")
            print("Run 1_run-detect.sh first.")
            sys.exit(1)

        if not (src_dir / ".git").is_dir():
            print(f"Error: git repository not found at {src_dir}.")
            print("Run 1_run-detect.sh first.")
            sys.exit(1)

        subprocess.run(
            ["git", "-C", str(src_dir), "config", "user.name", "Anonymous Authors"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(src_dir), "config", "user.email", "anonymous@example.com"],
            check=True,
        )

        try:
            requests.get(f"http://localhost:{args.viewer_port}/", timeout=3)
        except requests.exceptions.ConnectionError:
            start_viewer(script_dir, args.viewer_port)
            wait_for_viewer(args.viewer_port)

        start_time = time.time()

        batch_size = 100
        batches = make_file_grouped_batches(sinks_db, batch_size)
        total_sinks = sum(len(b) for b in batches)
        print(f"Targets: {total_sinks} unpatched sinks "
              "(RECEIVER_MATCH + NO_RECEIVER + RECEIVER_UNRESOLVABLE "
              "+ PARAM_UNRESOLVABLE/dispatchDynamic, patch_count=0)")

        if not batches:
            print("No sinks to patch.")
            sys.exit(0)

        print("Calling patch API... (this may take a while)")
        url = f"http://localhost:{args.viewer_port}/sinks/{app_id}/patch"

        all_results = []
        final_data = {"branch": "", "commit": ""}
        all_line_changes: dict[str, tuple[int, int]] = {}

        for batch_idx, batch in enumerate(batches, 1):
            print(f"  Batch {batch_idx}: {len(batch)} findings")
            batch_files = get_files_for_batch(sinks_db, batch)
            before_counts = {f: count_lines(f) for f in batch_files}

            resp = requests.post(url, json=batch, timeout=300)
            if resp.status_code != 200:
                print(f"    Error {resp.status_code}: {resp.text}")
                resp.raise_for_status()

            after_counts = {f: count_lines(f) for f in batch_files}
            for f in batch_files:
                b, a = before_counts[f], after_counts[f]
                if b != a:
                    delta = a - b
                    sign = "+" if delta > 0 else ""
                    print(f"    [LINE CHANGED] {f}: {b} -> {a} ({sign}{delta})")
                    all_line_changes[f] = (b, a)

            data = resp.json()
            all_results.extend(data.get("results", []))
            if data.get("branch"):
                final_data["branch"] = data["branch"]
            if data.get("commit"):
                final_data["commit"] = data["commit"]

        final_data["results"] = all_results

        results = final_data.get("results", [])
        success = sum(1 for r in results if r.get("status") == "success")
        skipped = sum(1 for r in results if r.get("status") == "skipped")
        failed  = sum(1 for r in results if r.get("status") == "failed")

        print()
        print(f"  Branch:  {final_data.get('branch', 'N/A')}")
        print(f"  Commit:  {final_data.get('commit', 'N/A')}")
        print(f"  Success: {success}")
        print(f"  Skipped: {skipped}")
        print(f"  Failed:  {failed}")

        print()
        if all_line_changes:
            print(f"Files with line count changes ({len(all_line_changes)}):")
            for f, (b, a) in sorted(all_line_changes.items()):
                delta = a - b
                sign = "+" if delta > 0 else ""
                print(f"  {f}: {b} -> {a} ({sign}{delta})")
        else:
            print("No line count changes.")

        if failed > 0:
            print()
            print("Failed sink details:")
            for r in results:
                if r.get("status") == "failed":
                    print(f"  Sink ID: {r.get('id')}")
                    print(f"    File: {r.get('file')}")
                    print(f"    Line: {r.get('line')}")
                    print(f"    Kind: {r.get('kind')}")
                    print(f"    Error: {r.get('error', 'N/A')}")
                    print(f"    Message: {r.get('message', 'N/A')}")
        print()
        print(f"Done: out/targets/{target_name}/runtime/ docker-compose.yml + tt-policy.js generated")
        print(f"Next: ./scripts/3_run-app.sh {yml_path}")

    finally:
        elapsed_ms = int((time.time() - start_time) * 1000) if start_time else 0
        print(f"\nElapsed time: {elapsed_ms}ms")
        sys.stdout = tee._stdout
        tee.close()

if __name__ == "__main__":
    main()
