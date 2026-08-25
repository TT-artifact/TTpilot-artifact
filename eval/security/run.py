#!/usr/bin/env python3
"""
Security evaluation: Run PoC against patched + unpatched containers.
Check if patched version detects XSS via TT violation reports.

Usage:
  python3 run.py poc/CVE-2021-32808.yml ../../targets/cve-CVE-2021-32808.yml \
    --patched-port 8080 --unpatched-port 8081 --backend-port 9000
"""

import argparse
import asyncio
import base64
import json
import sqlite3
import sys
import time
import zlib
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

import yaml
from playwright.async_api import async_playwright
from playwright.async_api import Page


PATCHED_PORT_DEFAULT = 8080
UNPATCHED_PORT_DEFAULT = 8081
BACKEND_PORT_DEFAULT = 9000


TABLE_VIOLATION_REPORTS = "violation_reports"
TABLE_CLASSIFY_REPORTS = "classify_reports"
COL_ID = "id"
COL_SINK_KEY = "sink_key"
COL_RECLASSIFIED_VERDICT = "reclassified_verdict"
COL_VALUE_PREVIEW = "value_preview"


WAIT_FOR_VIOLATIONS_SEC = 3
INTER_PAYLOAD_WAIT_SEC = 1
PAGE_INIT_TIMEOUT_MS = 60000
PAGE_NAVIGATION_TIMEOUT_MS = 30000
HTTP_CHECK_MAX_TIME_SEC = 3


VERDICT_DETECTED = "DETECTED"
VERDICT_DETECTED_UNBLOCKED = "DETECTED_UNBLOCKED"
VERDICT_MITIGATED = "MITIGATED"
VERDICT_MISSED = "MISSED"
VERDICT_POC_ISSUE = "POC_ISSUE"
VERDICT_POC_FAILED = "POC_FAILED"


@dataclass
class VerdictResult:
    """Encapsulates verdict logic and description."""
    name: str
    description: str

    @staticmethod
    def determine(
        xss_unpatched: int,
        xss_patched: int,
        has_violations: bool,
        total_payloads: int,
    ) -> "VerdictResult":
        """Determine verdict based on test results."""
        fully_confirmed_unpatched = xss_unpatched == total_payloads

        if fully_confirmed_unpatched and has_violations and xss_patched == 0:
            return VerdictResult(
                VERDICT_DETECTED,
                "All payloads detected: XSS in unpatched, fully blocked in patched, violations logged"
            )
        if fully_confirmed_unpatched and has_violations and xss_patched == total_payloads:
            return VerdictResult(
                VERDICT_DETECTED_UNBLOCKED,
                "Attack logged but not blocked: XSS still fires in patched for every payload despite TT violations"
            )
        if xss_unpatched > 0 and xss_patched > 0 and has_violations:
            return VerdictResult(
                VERDICT_MITIGATED,
                "Patch partially effective: some XSS caught, violations detected"
            )
        if xss_unpatched > 0 and not has_violations:
            return VerdictResult(
                VERDICT_MISSED,
                "Patch failed: XSS in unpatched but no violations in patched"
            )
        if xss_unpatched == 0 and has_violations:
            return VerdictResult(
                VERDICT_POC_ISSUE,
                "PoC issue: unpatched XSS didn't trigger but patched shows violations"
            )
        return VerdictResult(
            VERDICT_POC_FAILED,
            "PoC failed: no XSS triggered in unpatched version"
        )


@contextmanager
def sqlite_connection(db_path: Path):
    """Context manager for SQLite database connections."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def _execute_query(
    db_path: Path,
    query: str,
    params: tuple[Any, ...] = (),
    fetch_all: bool = True,
) -> list[Any] | Any:
    """Execute a query and return results. Returns [] on error."""
    if not db_path.exists():
        return [] if fetch_all else None

    try:
        with sqlite_connection(db_path) as conn:
            result = conn.execute(query, params)
            return result.fetchall() if fetch_all else result.fetchone()
    except Exception as e:
        print(f"  [warning] Database query failed: {e}", file=sys.stderr)
        return [] if fetch_all else None


def _cesium_hash(payload: str) -> str:
    """Compute Cesium Sandcastle #c= hash: baseHref attribute injection."""
    base_href = f'" />{payload}<base href="'
    arr = ["", "", base_href]
    inner = json.dumps(arr, separators=(",", ":"))[2:-2]
    raw = zlib.compress(inner.encode("utf-8"), level=9)
    raw_deflate = raw[2:-4]
    b64 = base64.b64encode(raw_deflate).decode().rstrip("=")
    return "#c=" + b64


async def execute_poc_steps(
    page: Any, steps: list[dict], xss_payload: str, port: int, payload_index: int = 1
) -> tuple[bool, str | None]:
    """Execute PoC steps on a page.

    Args:
        page: Playwright page object
        steps: List of PoC steps to execute
        xss_payload: XSS payload string
        port: Target port number
        payload_index: 1-based payload index for substitution (default: 1)
    """
    alert_triggered = False
    alert_text = None

    def on_dialog(dialog):
        nonlocal alert_triggered, alert_text
        alert_triggered = True
        alert_text = dialog.message
        asyncio.create_task(dialog.dismiss())

    def on_popup(page):
        asyncio.create_task(page.close())

    page.on("dialog", on_dialog)
    page.on("popup", on_popup)

    try:
        for step in steps:
            if isinstance(step, dict):
                if "navigate" in step:
                    nav_config = step["navigate"]
                    if isinstance(nav_config, str):
                        url = nav_config
                        wait_until = step.get("wait_until", "load")
                        timeout = step.get("timeout", 60000)
                    else:
                        url = nav_config.get("url")
                        wait_until = nav_config.get("wait_until", "load")
                        timeout = nav_config.get("timeout", 60000)

                    url = url.replace("{PORT}", str(port))
                    url = url.replace("{PAYLOAD_INDEX}", str(payload_index))
                    url = url.replace("{XSS_PAYLOAD}", xss_payload)

                    xss_payload_encoded = quote(xss_payload, safe="")
                    url = url.replace("{XSS_PAYLOAD_ENCODED}", xss_payload_encoded)

                    xss_payload_b64 = base64.b64encode(xss_payload.encode()).decode()
                    xss_payload_b64_encoded = quote(xss_payload_b64, safe="")
                    xss_payload_b64url = base64.urlsafe_b64encode(xss_payload.encode()).decode().rstrip("=")
                    xss_payload_b64url_encoded = quote(xss_payload_b64url, safe="")

                    url = url.replace("{XSS_PAYLOAD_B64URL_ENCODED}", xss_payload_b64url_encoded)
                    url = url.replace("{XSS_PAYLOAD_B64URL}", xss_payload_b64url)
                    url = url.replace("{XSS_PAYLOAD_B64_ENCODED}", xss_payload_b64_encoded)
                    url = url.replace("{XSS_PAYLOAD_B64}", xss_payload_b64)

                    url = url.replace("{XSS_PAYLOAD_CESIUM_HASH}", _cesium_hash(xss_payload))

                    try:
                        await page.goto(url, wait_until=wait_until, timeout=timeout)
                        try:
                            await page.wait_for_load_state("networkidle", timeout=5000)
                        except Exception:
                            pass
                        await asyncio.sleep(2.0)
                    except Exception:
                        if wait_until == "load":
                            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
                            try:
                                await page.wait_for_load_state("networkidle", timeout=5000)
                            except Exception:
                                pass
                            await asyncio.sleep(2.0)
                        else:
                            raise
                elif "navigate_with_hash" in step:
                    cfg = step["navigate_with_hash"]
                    url = cfg["url"].replace("{PORT}", str(port))
                    hash_js = cfg["hash_js"]
                    hash_js = hash_js.replace("{PORT}", str(port))
                    hash_js = hash_js.replace("{PAYLOAD_INDEX}", str(payload_index))
                    hash_js = hash_js.replace("{XSS_PAYLOAD}", xss_payload)
                    xss_payload_b64 = base64.b64encode(xss_payload.encode()).decode()
                    hash_js = hash_js.replace("{XSS_PAYLOAD_B64}", xss_payload_b64)
                    hash_js = hash_js.replace("{XSS_PAYLOAD_JSON}", json.dumps(xss_payload))
                    hash_fragment = await page.evaluate(hash_js)
                    wait_until = cfg.get("wait_until", "load")
                    timeout = cfg.get("timeout", 30000)
                    try:
                        await page.goto(url + hash_fragment, wait_until=wait_until, timeout=timeout)
                    except Exception:
                        if wait_until == "load":
                            await page.goto(url + hash_fragment, wait_until="domcontentloaded", timeout=15000)
                        else:
                            raise
                elif "refresh" in step:
                    try:
                        await page.reload(wait_until="load", timeout=60000)
                    except Exception as e:
                        if "load" in str(e).lower():
                            await page.reload(wait_until="domcontentloaded", timeout=15000)
                        else:
                            raise
                elif "fill" in step:
                    selector = step["fill"].get("selector")
                    value = step["fill"].get("value", "")
                    value = value.replace("{PAYLOAD_INDEX}", str(payload_index))
                    value = value.replace("{XSS_PAYLOAD}", xss_payload)
                    xss_payload_b64 = base64.b64encode(xss_payload.encode()).decode()
                    value = value.replace("{XSS_PAYLOAD_B64}", xss_payload_b64)
                    await page.fill(selector, value)
                elif "click" in step:
                    selector = step["click"]
                    await page.click(selector)
                elif "wait_ms" in step:
                    await asyncio.sleep(step["wait_ms"] / 1000.0)
                elif "evaluate" in step:
                    js_code = step["evaluate"]
                    js_code = js_code.replace("{PORT}", str(port))
                    js_code = js_code.replace("{PAYLOAD_INDEX}", str(payload_index))
                    js_code = js_code.replace("{XSS_PAYLOAD}", xss_payload)
                    xss_payload_b64 = base64.b64encode(xss_payload.encode()).decode()
                    js_code = js_code.replace("{XSS_PAYLOAD_B64}", xss_payload_b64)
                    xss_payload_json = json.dumps(xss_payload)
                    js_code = js_code.replace("{XSS_PAYLOAD_JSON}", xss_payload_json)
                    await page.evaluate(js_code)
                elif "get_page_content" in step:
                    try:
                        await page.content()
                    except Exception:
                        pass
    except Exception as e:
        print(f"  [warning] PoC step failed: {e}", file=sys.stderr)

    return alert_triggered, alert_text


async def _redirect_jsdelivr_to_unpkg(route: Any) -> None:
    """Serve cdn.jsdelivr.net/npm/* requests from unpkg.com instead (same npm packages)."""
    new_url = route.request.url.replace("https://cdn.jsdelivr.net/npm/", "https://unpkg.com/", 1)
    await route.continue_(url=new_url)


async def _serve_mock_attacker_page(route: Any) -> None:
    """Fulfill requests to placeholder attacker-hosted URLs (attacker.com, an
    eval-local xss_payload.html) with synthetic HTML, standing in for the
    "attacker's server response" step of PoCs like CVE-2023-49086 - real
    attacker.com doesn't exist to host anything, and the target-hosted
    xss_payload.html was never created. Access-Control-Allow-Origin: * mirrors
    what a real attacker would set on their own server - cross-origin
    XHR/fetch (e.g. cacti's `$.get(href)` in loadPageNoHeader) can't read a
    cross-origin response body without it."""
    raw_payload_b64 = None
    for query_part in urlparse(route.request.url).query.split("&"):
        if query_part.startswith("p="):
            raw_payload_b64 = query_part[2:]
            break


    payload_b64 = raw_payload_b64 or base64.b64encode(b"<img src=1 onerror=alert(document.domain)>").decode()
    for _ in range(2):
        decoded_payload_b64 = unquote(payload_b64)
        if decoded_payload_b64 == payload_b64:
            break
        payload_b64 = decoded_payload_b64
    try:
        payload_padding = "=" * (-len(payload_b64) % 4)
        payload_html = base64.urlsafe_b64decode((payload_b64 + payload_padding).encode()).decode()
    except Exception:
        payload_html = "<img src=1 onerror=alert(document.domain)>"
    await route.fulfill(
        status=200,
        content_type="text/html",
        headers={"Access-Control-Allow-Origin": "*"},
        body=f"<html><body>{payload_html}</body></html>",
    )


async def run_poc_for_payload(
    browser: Any, base_port: int, steps: list[dict], payload: str, payload_index: int = 1
) -> dict:
    """Execute PoC for a single payload and return result.

    Args:
        browser: Playwright browser instance
        base_port: Base port for the target
        steps: PoC steps to execute
        payload: XSS payload to test
        payload_index: 1-based payload index (default: 1)
    """
    page = await browser.new_page()

    alerts = []
    def on_console(msg):
        if any(keyword in msg.text for keyword in ["[PUT]", "[LOGIN]", "ALERT_TRIGGERED:", "status: 5", "status: 4", "error", "Error"]):
            print(f"[console] {msg.text}", file=sys.stderr)

        if "ALERT_TRIGGERED:" in msg.text:
            text = msg.text.replace("ALERT_TRIGGERED:", "").strip()
            if text and text not in ("null", "undefined", ""):
                alerts.append(text)

    page.on("console", on_console)
    def on_pageerror(exc):
        print(f"[PAGEERROR] {exc}", file=sys.stderr)
        stack = getattr(exc, "stack", None)
        if stack:
            print(f"[PAGEERROR-STACK] {stack}", file=sys.stderr)

    page.on("pageerror", on_pageerror)


    await page.route("https://cdn.jsdelivr.net/npm/**", _redirect_jsdelivr_to_unpkg)


    await page.route("**://attacker.com/**", _serve_mock_attacker_page)
    await page.route(
        lambda url: urlparse(url).path == "/xss_payload.html" and f":{base_port}" in url,
        _serve_mock_attacker_page,
    )


    alert_triggered, alert_text = await execute_poc_steps(page, steps, payload, base_port, payload_index)


    await asyncio.sleep(WAIT_FOR_VIOLATIONS_SEC)
    await page.close()
    return {
        "payload": payload,
        "xss_triggered": alert_triggered,
        "alert_text": alert_text,
    }


async def run_poc(
    patched_port: int, unpatched_port: int, poc_cfg: dict
) -> list[dict]:
    """Run PoC against patched and unpatched containers for all payloads."""
    steps = poc_cfg.get("steps", [])
    payloads = poc_cfg.get("payloads") or [poc_cfg.get("xss_payload", "<img src=x onerror=alert(1)>")]

    async with async_playwright() as p:


        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-features=LocalNetworkAccessChecks,"
                "PrivateNetworkAccessSendPreflights,"
                "PrivateNetworkAccessRespectPreflightResults,"
                "BlockInsecurePrivateNetworkRequests",
            ],
        )

        payload_results = []
        for payload_index, payload in enumerate(payloads, 1):
            print(f"  Testing payload {payload_index}/{len(payloads)}: {payload[:60]}...")


            unpatched_result = await run_poc_for_payload(browser, unpatched_port, steps, payload, payload_index)
            print(f"    Unpatched -> Alert: {unpatched_result['xss_triggered']}")


            patched_result = await run_poc_for_payload(browser, patched_port, steps, payload, payload_index)
            print(f"    Patched -> Alert: {patched_result['xss_triggered']}")

            payload_results.append({
                "payload": payload,
                "unpatched": unpatched_result,
                "patched": patched_result,
            })

            await asyncio.sleep(INTER_PAYLOAD_WAIT_SEC)

        await browser.close()
        return payload_results


def get_new_violations(reports_db: Path, before_ids: list[int]) -> list[dict]:
    """Query new violation reports since before_ids snapshot."""
    if not before_ids:

        query = f"""
            SELECT DISTINCT
              {COL_ID}, {COL_SINK_KEY}, {COL_RECLASSIFIED_VERDICT}, {COL_VALUE_PREVIEW}
            FROM {TABLE_VIOLATION_REPORTS}
            ORDER BY {COL_ID} DESC
        """
        rows = _execute_query(reports_db, query)
    else:
        placeholders = ",".join("?" * len(before_ids))
        query = f"""
            SELECT DISTINCT
              {COL_ID}, {COL_SINK_KEY}, {COL_RECLASSIFIED_VERDICT}, {COL_VALUE_PREVIEW}
            FROM {TABLE_VIOLATION_REPORTS}
            WHERE {COL_ID} NOT IN ({placeholders})
            ORDER BY {COL_ID} DESC
        """
        rows = _execute_query(reports_db, query, tuple(before_ids))
    return [dict(r) for r in rows] if rows else []


def get_violation_ids_before(reports_db: Path) -> list[int]:
    """Get list of violation_reports IDs before PoC execution."""
    query = f"SELECT {COL_ID} FROM {TABLE_VIOLATION_REPORTS}"
    rows = _execute_query(reports_db, query)
    return [r[0] for r in rows] if rows else []


def get_classify_ids_before(reports_db: Path) -> list[int]:
    """Get list of classify_reports IDs before PoC execution."""
    query = f"SELECT {COL_ID} FROM {TABLE_CLASSIFY_REPORTS}"
    rows = _execute_query(reports_db, query)
    return [r[0] for r in rows] if rows else []


def get_new_classify_count(reports_db: Path, before_ids: list[int]) -> int:
    """Count new classify_reports added after before_ids snapshot."""
    if not before_ids:

        query = f"SELECT COUNT(*) FROM {TABLE_CLASSIFY_REPORTS}"
        result = _execute_query(reports_db, query, fetch_all=False)
    else:
        placeholders = ",".join("?" * len(before_ids))
        query = f"SELECT COUNT(*) FROM {TABLE_CLASSIFY_REPORTS} WHERE {COL_ID} NOT IN ({placeholders})"
        result = _execute_query(reports_db, query, tuple(before_ids), fetch_all=False)

    return result[0] if result else 0


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description="Security evaluation")
    parser.add_argument("poc_yml", help="PoC YAML file")
    parser.add_argument("target_yml", help="Target YAML file")
    parser.add_argument("--patched-port", type=int, default=PATCHED_PORT_DEFAULT)
    parser.add_argument("--unpatched-port", type=int, default=UNPATCHED_PORT_DEFAULT)
    parser.add_argument("--backend-port", type=int, default=BACKEND_PORT_DEFAULT)
    parser.add_argument("--reports-db", type=Path, default=None)
    return parser.parse_args()


def load_config(poc_yml: str, target_yml: str) -> tuple[dict, dict, str, str, list, Path]:
    """Load configuration from YAML files."""
    with open(poc_yml) as f:
        poc_cfg = yaml.safe_load(f)

    with open(target_yml) as f:
        target_cfg = yaml.safe_load(f)

    cve_id = poc_cfg.get("cve", "UNKNOWN")
    target_name = target_cfg.get("target", {}).get("name", "unknown")
    payloads = poc_cfg.get("payloads") or [poc_cfg.get("xss_payload", "<img src=x onerror=alert(1)>")]

    research_root = Path(__file__).parent.parent.parent
    reports_db = research_root / "out" / "targets" / target_name / "eval" / "security" / "runtime" / "reports.db"

    print(f"CVE: {cve_id}")
    print(f"Target: {target_name}")
    print(f"Payloads: {len(payloads)}")
    for i, payload in enumerate(payloads, 1):
        print(f"  {i}. {payload[:60]}...")
    print()

    return poc_cfg, target_cfg, cve_id, target_name, payloads, reports_db


def analyze_findings(
    reports_db: Path,
    payload_results: list[dict],
    payloads: list[str],
    before_violation_ids: list[int],
    before_classify_ids: list[int],
) -> tuple[VerdictResult, list[dict], int]:
    """Analyze test findings and determine verdict."""
    print("Checking for new violations in patched container...")
    new_violations = get_new_violations(reports_db, before_violation_ids)
    new_classify_count = get_new_classify_count(reports_db, before_classify_ids)
    print(f"  {len(new_violations)} new violations")
    print(f"  {new_classify_count} new classify reports")
    if new_violations:
        for v in new_violations[:3]:
            print(f"    - {v[COL_SINK_KEY]} ({v[COL_RECLASSIFIED_VERDICT]})")
    print()

    xss_unpatched = sum(1 for r in payload_results if r["unpatched"]["xss_triggered"])
    xss_patched = sum(1 for r in payload_results if r["patched"]["xss_triggered"])
    has_violations = len(new_violations) > 0

    verdict = VerdictResult.determine(xss_unpatched, xss_patched, has_violations, len(payloads))
    return verdict, new_violations, new_classify_count


def format_output(
    cve_id: str,
    target_name: str,
    payloads: list[str],
    payload_results: list[dict],
    new_violations: list[dict],
    new_classify_count: int,
    verdict: VerdictResult,
) -> dict:
    """Format test results as JSON output."""
    xss_unpatched = sum(1 for r in payload_results if r["unpatched"]["xss_triggered"])
    xss_patched = sum(1 for r in payload_results if r["patched"]["xss_triggered"])

    payload_output = [
        {
            "payload": r["payload"],
            "unpatched": r["unpatched"],
            "patched": {
                "xss_triggered": r["patched"]["xss_triggered"],
                "alert_text": r["patched"]["alert_text"],
            },
        }
        for r in payload_results
    ]

    return {
        "cve": cve_id,
        "target": target_name,
        "timestamp": datetime.now().isoformat(),
        "summary": {
            "total_payloads": len(payloads),
            "xss_triggered_unpatched": xss_unpatched,
            "xss_triggered_patched": xss_patched,
            "violations_detected": len(new_violations),
            "classify_reports_new": new_classify_count,
            "result": verdict.name,
        },
        "payloads": payload_output,
        "patched": {"tt_violations": new_violations},
    }


def save_results(output: dict, cve_id: str) -> Path:
    """Save results to file."""
    target_name = output.get("target", "unknown")
    research_root = Path(__file__).parent.parent.parent
    results_dir = research_root / "out" / "targets" / target_name / "eval" / "security" / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    result_file = results_dir / f"{cve_id}_{int(time.time())}.json"
    with open(result_file, "w") as f:
        json.dump(output, f, indent=2)
    return result_file


async def main() -> int:
    """Main entry point."""
    args = parse_args()
    poc_cfg, target_cfg, cve_id, target_name, payloads, reports_db = load_config(
        args.poc_yml, args.target_yml
    )
    if args.reports_db is not None:
        reports_db = args.reports_db


    print("Snapshotting reports...")
    before_violation_ids = get_violation_ids_before(reports_db)
    before_classify_ids = get_classify_ids_before(reports_db)
    print(f"  {len(before_violation_ids)} existing violations")
    print(f"  {len(before_classify_ids)} existing classify reports")
    print()

    print("Executing PoC...")
    payload_results = await run_poc(args.patched_port, args.unpatched_port, poc_cfg)
    print()

    verdict, new_violations, new_classify_count = analyze_findings(
        reports_db, payload_results, payloads, before_violation_ids, before_classify_ids
    )

    output = format_output(
        cve_id, target_name, payloads, payload_results, new_violations, new_classify_count, verdict
    )

    print(f"Result: {verdict.name}")
    xss_unpatched = sum(1 for r in payload_results if r["unpatched"]["xss_triggered"])
    xss_patched = sum(1 for r in payload_results if r["patched"]["xss_triggered"])
    print(
        f"Summary: {xss_unpatched}/{len(payloads)} unpatched XSS, "
        f"{xss_patched}/{len(payloads)} patched XSS, {len(new_violations)} violations detected"
    )
    print()
    print(json.dumps(output, indent=2))

    result_file = save_results(output, cve_id)
    print(f"\nResult saved: {result_file}")

    return 0 if verdict.name in (VERDICT_DETECTED, VERDICT_MITIGATED) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
