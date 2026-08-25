#!/usr/bin/env python3

import argparse
import json
import math
import sqlite3
import sys
import time
from datetime import datetime
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
    p = argparse.ArgumentParser(description="Update sinks with HIGH confidence oracle verdicts")
    p.add_argument("yml_file", help="targets/<app>.yml")
    p.add_argument("--dry-run", action="store_true", help="Print targets without calling APIs")
    p.add_argument("--server-port", type=int, default=9000, help="report-server port")
    p.add_argument("--viewer-port", type=int, default=8000, help="report-web viewer port")
    p.add_argument(
        "--all-signatures", action="store_true",
        help="Add signatures from all violation/classify tables to the allowlist even when there are no HIGH-confidence sinks"
    )
    return p.parse_args()

def compute_oracle_verdict(row: dict) -> dict | None:

    obs5 = row.get('obs_type5') or 0
    obs4 = row.get('obs_type4') or 0
    obs2 = row.get('obs_type2') or 0
    obs1 = row.get('obs_type1') or 0
    obs_nv = row.get('obs_no_violation') or 0
    total = row.get('total_count') or 0
    has_xss = row.get('has_xss') == 1

    if obs5 > 0 or has_xss:
        D = 60
    elif obs4 > 0:
        D = 40
    elif obs2 > 0:
        D = 15
    else:
        D = 0

    E = min(15, int(math.log2(total + 1) * 3))

    n_distinct = sum(1 for x in [obs1, obs2, obs4, obs5] if x > 0)
    C = 5 if n_distinct == 1 else 0

    is_mixed = (obs4 > 0 or obs5 > 0) and obs1 > 0
    P = -5 if is_mixed else 0

    score = D + (20 if has_xss else 0) + E + C + P

    verdict = None
    confidence = None

    if obs5 > 0 or has_xss:
        verdict = 'TYPE5'
        confidence = 'HIGH'
    elif obs4 > 0:
        verdict = 'TYPE4'
        confidence = 'HIGH'
    elif obs2 > 0 and obs1 == 0:
        verdict = 'TYPE2'
        confidence = 'HIGH' if total >= 10 else 'MEDIUM' if total >= 3 else 'LOW'
    elif obs1 > 0 and obs2 == 0:
        verdict = 'TYPE1'
        confidence = 'HIGH' if total >= 20 else 'MEDIUM' if total >= 5 else 'LOW'
    elif obs1 > 0 and obs2 > 0:
        verdict = 'TYPE2'
        confidence = 'HIGH' if total >= 10 else 'MEDIUM' if total >= 3 else 'LOW'

    if not verdict and obs_nv > 0:
        verdict = 'NO_VIOLATION'
        confidence = 'HIGH' if obs_nv >= 10 else 'MEDIUM' if obs_nv >= 3 else 'LOW'

    if not verdict:
        return None

    return {
        'oracle_verdict': verdict,
        'oracle_confidence': confidence,
        'oracle_score': score,
        'oracle_mixed': is_mixed,
    }

def _is_patch_target(desired_verdict: str, state: dict) -> bool:

    is_patch_target = state.get('is_patch_target') or 0
    applied_verdict = state.get('applied_verdict')
    return (
        is_patch_target == 1
        or applied_verdict is None
        or desired_verdict != applied_verdict
    )

def load_high_confidence_sinks(reports_db: Path) -> list[dict]:

    conn = sqlite3.connect(reports_db)
    conn.row_factory = sqlite3.Row

    existing_state: dict[str, dict] = {}
    try:
        rows = conn.execute(
            "SELECT sink_key, patch_verdict, is_patch_target, applied_verdict FROM oracle_verdicts"
        ).fetchall()
        existing_state = {r['sink_key']: dict(r) for r in rows}
    except sqlite3.OperationalError:
        pass

    agg_rows = conn.execute("""
        SELECT
          sink_key,
          COUNT(CASE WHEN reclassified_verdict='TYPE5' THEN 1 END) AS obs_type5,
          COUNT(CASE WHEN reclassified_verdict='TYPE4' THEN 1 END) AS obs_type4,
          COUNT(CASE WHEN reclassified_verdict='TYPE2' THEN 1 END) AS obs_type2,
          COUNT(CASE WHEN reclassified_verdict='TYPE1' THEN 1 END) AS obs_type1,
          COUNT(CASE WHEN reclassified_verdict='NO_VIOLATION' THEN 1 END) AS obs_no_violation,
          COUNT(*) AS total_count,
          MAX(CASE WHEN xss_source_values IS NOT NULL AND xss_source_values != '[]' THEN 1 ELSE 0 END) AS has_xss
        FROM classify_reports
        WHERE sink_key IS NOT NULL
        GROUP BY sink_key
    """).fetchall()

    result = []
    for row in agg_rows:
        row_dict = dict(row)
        sink_key = row_dict['sink_key']
        oracle = compute_oracle_verdict(row_dict)
        if not oracle or oracle['oracle_confidence'] != 'HIGH':
            continue

        state = existing_state.get(sink_key, {})

        desired_verdict = state.get('patch_verdict') or oracle['oracle_verdict']
        if not _is_patch_target(desired_verdict, state):
            continue

        oracle['sink_key'] = sink_key
        result.append(oracle)

    conn.close()
    result.sort(key=lambda x: x['oracle_score'], reverse=True)
    return result

def update_oracle_verdicts_api(sinks: list[dict], server_port: int, dry_run: bool = False) -> int:

    success_count = 0

    for sink in sinks:
        payload = {
            'sinkKey': sink['sink_key'],
            'oracle_verdict': sink['oracle_verdict'],
            'oracle_confidence': sink['oracle_confidence'],
            'oracle_score': sink['oracle_score'],
            'oracle_mixed': sink['oracle_mixed'],
            'is_patch_target': 1,
        }

        if dry_run:
            print(f"  [dry-run] POST /api/oracle-verdicts: {sink['sink_key']} ({sink['oracle_verdict']})")
            success_count += 1
            continue

        try:
            url = f"http://localhost:{server_port}/api/oracle-verdicts"
            resp = requests.post(url, json=payload, timeout=10)
            resp.raise_for_status()
            success_count += 1
        except Exception as e:
            print(f"  [warn] Failed to update {sink['sink_key']}: {e}")

    return success_count

def _collect_signatures(rows, signatures: set[str]) -> None:

    for row in rows:
        try:
            raw = json.loads(row['js_signature'])
            if isinstance(raw, list):
                signatures.update(raw)
            elif isinstance(raw, str):
                signatures.add(raw)
        except (json.JSONDecodeError, TypeError):
            pass

def _collect_url_signatures(rows, urls: set[str]) -> None:

    for row in rows:
        try:
            raw = json.loads(row['url_signature'])
            if isinstance(raw, list):
                urls.update(raw)
            elif isinstance(raw, str):
                urls.add(raw)
        except (json.JSONDecodeError, TypeError):
            pass

def load_js_signatures_for_sinks(reports_db: Path, sink_keys: list[str] | None = None) -> set[str]:

    conn = sqlite3.connect(reports_db)
    conn.row_factory = sqlite3.Row
    signatures: set[str] = set()

    if sink_keys is not None:
        for sink_key in sink_keys:
            rows = conn.execute(
                "SELECT js_signature FROM classify_reports "
                "WHERE sink_key = ? AND js_signature IS NOT NULL "
                "UNION "
                "SELECT js_signature FROM violation_reports "
                "WHERE sink_key = ? AND js_signature IS NOT NULL",
                (sink_key, sink_key)
            ).fetchall()
            _collect_signatures(rows, signatures)
    else:
        rows = conn.execute(
            "SELECT js_signature FROM classify_reports WHERE js_signature IS NOT NULL "
            "UNION "
            "SELECT js_signature FROM violation_reports WHERE js_signature IS NOT NULL"
        ).fetchall()
        _collect_signatures(rows, signatures)

    conn.close()
    return signatures

def add_js_signatures_api(signatures: set[str], server_port: int, dry_run: bool = False) -> int:

    success_count = 0

    for sig in sorted(signatures):
        if dry_run:
            display = sig if len(sig) <= 60 else sig[:60] + "..."
            print(f"  [dry-run] POST /api/js-signatures: {display}")
            success_count += 1
            continue

        try:
            url = f"http://localhost:{server_port}/api/js-signatures"
            resp = requests.post(
                url,
                json={'signature': sig, 'note': 'auto-added by 6_update_sinks'},
                timeout=10
            )
            resp.raise_for_status()
            success_count += 1
        except Exception as e:
            print(f"  [warn] Failed to add signature {sig[:40]}: {e}")

    return success_count

def load_url_signatures_for_sinks(reports_db: Path, sink_keys: list[str] | None = None) -> set[str]:

    conn = sqlite3.connect(reports_db)
    conn.row_factory = sqlite3.Row
    urls: set[str] = set()

    if sink_keys is not None:
        for sink_key in sink_keys:
            rows = conn.execute(
                "SELECT url_signature FROM classify_reports "
                "WHERE sink_key = ? AND url_signature IS NOT NULL "
                "UNION "
                "SELECT url_signature FROM violation_reports "
                "WHERE sink_key = ? AND url_signature IS NOT NULL",
                (sink_key, sink_key)
            ).fetchall()
            _collect_url_signatures(rows, urls)
    else:
        rows = conn.execute(
            "SELECT url_signature FROM classify_reports WHERE url_signature IS NOT NULL "
            "UNION "
            "SELECT url_signature FROM violation_reports WHERE url_signature IS NOT NULL"
        ).fetchall()
        _collect_url_signatures(rows, urls)

    conn.close()
    return urls

def add_url_signatures_api(urls: set[str], server_port: int, dry_run: bool = False) -> int:

    success_count = 0

    for url in sorted(urls):
        if dry_run:
            print(f"  [dry-run] POST /api/url-signatures: {url[:80]}")
            success_count += 1
            continue

        try:
            endpoint = f"http://localhost:{server_port}/api/url-signatures"
            resp = requests.post(
                endpoint,
                json={'url': url, 'note': 'auto-added by 6_update_sinks'},
                timeout=10
            )
            resp.raise_for_status()
            success_count += 1
        except Exception as e:
            print(f"  [warn] Failed to add URL {url[:60]}: {e}")

    return success_count

def apply_oracle_patch_api(sinks: list[dict], app_id: str, viewer_port: int, dry_run: bool = False) -> dict:

    sink_keys = [s['sink_key'] for s in sinks]

    if dry_run:
        print(f"  [dry-run] POST /sinks/{app_id}/oracle-patch with {len(sink_keys)} sinks")
        return {'status': 'dry-run', 'sink_count': len(sink_keys)}

    try:
        url = f"http://localhost:{viewer_port}/sinks/{app_id}/oracle-patch"
        resp = requests.post(url, json=sink_keys, timeout=300)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        detail = ""
        if 'resp' in locals():
            try:
                body = resp.json()
                detail = body.get('detail') if isinstance(body, dict) else body
            except (ValueError, AttributeError):
                detail = resp.text.strip()
        suffix = f" - server detail: {detail}" if detail else ""
        raise RuntimeError(f"Failed to apply oracle patch: {e}{suffix}") from e

def regenerate_policy_api(app_id: str, viewer_port: int, dry_run: bool = False) -> dict:

    if dry_run:
        print(f"  [dry-run] POST /sinks/{app_id}/regenerate-policy")
        return {'status': 'dry-run'}

    try:
        url = f"http://localhost:{viewer_port}/sinks/{app_id}/regenerate-policy"
        resp = requests.post(url, timeout=60)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        raise RuntimeError(f"Failed to regenerate policy: {e}") from e

def main():
    args = parse_args()
    script_dir = Path(__file__).parent
    research_dir = script_dir.parent
    yml_path = Path(args.yml_file)

    if not yml_path.exists():
        print(f"Error: {yml_path} not found")
        sys.exit(1)

    with open(yml_path) as f:
        cfg = yaml.safe_load(f)

    target_name = cfg.get("target", {}).get("name", "unknown")
    app_id = yml_path.stem
    reports_db = research_dir / "out" / "targets" / target_name / "reports.db"

    logs_dir = research_dir / "out" / "targets" / target_name / "logs"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    update_log = logs_dir / f"update_sinks_{timestamp}.log"
    tee = TeeLogger(update_log)
    sys.stdout = tee
    start_time = time.time()

    try:
        print("==========================================")
        print(f"Update Sinks with Oracle Verdicts: {app_id}")
        print("==========================================")
        print(f"Name:         {target_name}")
        print(f"Reports DB:   {reports_db}")
        print(f"Server:       http://localhost:{args.server_port}")
        print(f"Viewer:       http://localhost:{args.viewer_port}")
        print(f"Dry-run:      {args.dry_run}")
        print()

        if not reports_db.exists():
            print(f"Error: {reports_db} not found")
            print("Run scripts/5_crawl_zap_hybrid.py first.")
            sys.exit(1)

        print("Loading HIGH confidence sinks...")
        sinks = load_high_confidence_sinks(reports_db)
        print(f"Found {len(sinks)} HIGH confidence sinks\n")

        if not sinks and not args.all_signatures:
            print("No HIGH confidence sinks found.")
            print("(Use --all-signatures to add signatures from violation_reports anyway)")
            sys.exit(0)

        if sinks:
            print("Targets:")
            for s in sinks:
                print(f"  {s['sink_key']:50s} {s['oracle_verdict']:15s} {s['oracle_confidence']:8s} score={s['oracle_score']}")
            print()

        signatures = load_js_signatures_for_sinks(reports_db)
        url_signatures = load_url_signatures_for_sinks(reports_db)

        if signatures:
            print("Signatures to add:")
            for sig in sorted(signatures):
                print(f"  {sig}")
            print()

        if url_signatures:
            print("URL Signatures to add:")
            for url in sorted(url_signatures):
                print(f"  {url}")
            print()

        if args.dry_run:
            print("(dry-run mode: no API calls will be made)")
            sys.exit(0)

        print("Adding JS signatures to allowlist...")
        sig_added = 0
        if signatures:
            sig_added = add_js_signatures_api(signatures, args.server_port, args.dry_run)
            print(f"  Added: {sig_added}/{len(signatures)}\n")
        else:
            print("  No signatures found\n")

        print("Adding URL signatures to allowlist...")
        url_sig_added = 0
        if url_signatures:
            url_sig_added = add_url_signatures_api(url_signatures, args.server_port, args.dry_run)
            print(f"  Added: {url_sig_added}/{len(url_signatures)}\n")
        else:
            print("  No URL signatures found\n")

        if not sinks:
            if sig_added or url_sig_added:
                print("Regenerating tt-policy.js with updated signatures...")
                regen_result = regenerate_policy_api(app_id, args.viewer_port, args.dry_run)
                print(f"  Status: {regen_result.get('status', 'N/A')}\n")
            else:
                print("No HIGH confidence sinks, no signatures added; skipping policy regen.")
            sys.exit(0)

        print("Updating oracle verdicts via report-server API...")
        success = update_oracle_verdicts_api(sinks, args.server_port, args.dry_run)
        print(f"  Updated: {success}/{len(sinks)}\n")

        print("Applying oracle patches via report-web API...")
        result = apply_oracle_patch_api(sinks, app_id, args.viewer_port, args.dry_run)

        print(f"  Branch:  {result.get('branch', 'N/A')}")
        print(f"  Commit:  {result.get('commit', 'N/A')}")
        if 'results' in result:
            success = sum(1 for r in result['results'] if r.get('status') == 'success')
            skipped = sum(1 for r in result['results'] if r.get('status') == 'skipped')
            failed = sum(1 for r in result['results'] if r.get('status') == 'failed')
            print(f"  Success: {success}")
            print(f"  Skipped: {skipped}")
            print(f"  Failed:  {failed}")
            for r in result['results']:
                if r.get('status') == 'skipped':
                    sk = r.get('sink_key') or f"id={r.get('id', '?')}"
                    reason = r.get('message') or r.get('note') or 'already in requested state'
                    print(f"    SKIPPED {sk}: {reason}")

            for r in result['results']:
                if r.get('status') == 'failed':
                    sk = r.get('sink_key') or f"id={r.get('id', '?')}"
                    print(f"    FAILED  {sk}: {r.get('message', 'unknown error')}")
        print()

        print("Regenerating tt-policy.js with updated signatures...")
        regen_result = regenerate_policy_api(app_id, args.viewer_port, args.dry_run)
        print(f"  Status: {regen_result.get('status', 'N/A')}\n")

        print(f"Complete: generated docker-compose.yml and tt-policy.js under out/targets/{target_name}/runtime/")
        print(f"Next step: ./scripts/3_run-app.sh {yml_path}")
    finally:
        elapsed_ms = int((time.time() - start_time) * 1000)
        print(f"\nElapsed time: {elapsed_ms}ms")
        sys.stdout = tee._stdout
        tee.close()

if __name__ == "__main__":
    main()
