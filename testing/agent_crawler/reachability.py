"""Static-ish reachability pre-filter for the agent crawler.

Before spending Claude turns/time trying to trigger a sink, check whether the
sink's source file is ever actually loaded by the running app. Large bundled
apps often ship a minified bundle instead of the individually instrumented
source files the sink scanner found - in that case no amount of agent effort
can reach the sink, and the pipeline should know that for free.

This check runs ONCE per crawler run (not per sink/group): it visits a small
set of candidate pages, records every script URL the browser actually
requests (initial load + a shallow click pass, to surface lazily-loaded
bundles), and matches that set against each sink's source file. Results are
cached to disk keyed by a content hash, so repeat runs are instant unless the
app source or candidate URL set changed.

False negatives (marking a genuinely reachable file as unreachable) are the
expensive mistake here - a missed XSS is worse than a wasted agent turn - so
the check is deliberately conservative: a file is only confirmed unreachable
when enough distinct candidate pages were checked to make that credible.
Anything checked with too few candidates stays "unknown" and is left for the
agent, same as before this filter existed.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from playwright.sync_api import sync_playwright

logger = logging.getLogger(__name__)

MIN_CANDIDATE_URLS = 4
MAX_CANDIDATE_URLS = 40
LOAD_WAIT_MS = 2500
CLICK_BUDGET = 6
CLICK_SETTLE_MS = 800
PER_PAGE_BUDGET_S = 25
MIN_FILES_FOR_BUNDLE_DETECTION = 5
BUNDLING_MATCH_RATE_THRESHOLD = 0.2


def _relative_path(file_path: str, source_root: Path) -> Optional[str]:
    try:
        return str(Path(file_path).relative_to(source_root)).replace(os.sep, "/")
    except ValueError:
        return None


def _load_candidate_urls(source_root: str, base_url: str, files: list[str],
                         seed_urls_path: Optional[Path]) -> list[str]:
    """Union of known crawl seed URLs and any HTML that textually references a
    target file's basename - the same discovery signal used to find sinks in
    the first place, just used here to decide what to check, not what to skip."""
    urls: list[str] = [base_url]
    if seed_urls_path and seed_urls_path.exists():
        for line in seed_urls_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and line not in urls:
                urls.append(line)
    root = Path(source_root)
    basenames = {Path(f).name for f in files}
    for html in root.rglob("*.html"):
        if len(urls) >= MAX_CANDIDATE_URLS:
            break
        try:
            text = html.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if not any(name in text for name in basenames):
            continue
        rel = _relative_path(str(html), root)
        if rel is None:
            continue
        url = base_url.rstrip("/") + "/" + rel
        if url not in urls:
            urls.append(url)
    return urls[:MAX_CANDIDATE_URLS]


def _dom_script_srcs(page: Any) -> set[str]:
    try:
        handles = page.locator("script[src]")
        count = min(handles.count(), 200)
    except Exception:
        return set()
    out: set[str] = set()
    for i in range(count):
        try:
            src = handles.nth(i).get_attribute("src", timeout=500)
        except Exception:
            continue
        if src:
            out.add(src)
    return out


def _shallow_click_pass(page: Any, deadline: float) -> None:
    """Best-effort clicks on a handful of visible controls to surface
    lazily-loaded scripts (menus, panels). Failures/navigations are swallowed -
    this is exploratory, not a verified interaction."""
    try:
        candidates = page.locator("button, [role=button], a[href]")
        count = min(candidates.count(), 30)
    except Exception:
        return
    clicked = 0
    for i in range(count):
        if clicked >= CLICK_BUDGET or time.monotonic() > deadline:
            break
        try:
            el = candidates.nth(i)
            if not el.is_visible(timeout=300):
                continue
            el.click(timeout=800)
            clicked += 1
            page.wait_for_timeout(CLICK_SETTLE_MS)
        except Exception:
            continue


def _capture_page_scripts(page: Any, url: str) -> set[str]:
    """Load one URL, do a shallow click pass, return every script URL requested."""
    seen: set[str] = set()

    def on_request(request: Any) -> None:
        if request.resource_type == "script":
            seen.add(request.url)

    page.on("request", on_request)
    deadline = time.monotonic() + PER_PAGE_BUDGET_S
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(LOAD_WAIT_MS)
        seen |= _dom_script_srcs(page)
        _shallow_click_pass(page, deadline)
    except Exception:
        pass
    finally:
        page.remove_listener("request", on_request)
    return seen


def classify_files(files: list[str], source_root: str, loaded_urls: set[str],
                   candidate_url_count: int) -> dict[str, Any]:
    """Pure decision logic: given what was actually requested, decide per-file
    loaded/unreachable/unknown. Kept separate from the Playwright I/O in
    :func:`compute_reachability` so the conservative-by-design policy (the
    MIN_CANDIDATE_URLS gate and the bundled-app bailout) is unit-testable
    without a browser."""
    have_enough_candidates = candidate_url_count >= MIN_CANDIDATE_URLS
    root = Path(source_root)
    matches: dict[str, Optional[str]] = {}
    for file_path in files:
        rel = _relative_path(file_path, root)
        basename = Path(file_path).name
        matches[file_path] = next((u for u in loaded_urls if basename in u or (rel and rel in u)), None)

    matched_count = sum(1 for match in matches.values() if match)
    match_rate = matched_count / len(files) if files else 1.0
    bundling_suspected = (
        have_enough_candidates
        and len(files) >= MIN_FILES_FOR_BUNDLE_DETECTION
        and match_rate < BUNDLING_MATCH_RATE_THRESHOLD
    )
    if bundling_suspected:
        logger.warning(
            "[reachability] only %d/%d files matched any of %d checked URLs - the app "
            "likely bundles most scripts into one file, so URL-based matching is not "
            "trustworthy here; leaving unmatched files as unknown instead of confirming "
            "unreachable",
            matched_count, len(files), candidate_url_count,
        )

    files_out: dict[str, Any] = {}
    for file_path in files:
        match = matches[file_path]
        if match:
            files_out[file_path] = {"loaded": True, "match_url": match}
        elif have_enough_candidates and not bundling_suspected:
            files_out[file_path] = {"loaded": False, "match_url": None}
        else:
            files_out[file_path] = {"loaded": None, "match_url": None}
    return {"files": files_out, "bundling_suspected": bundling_suspected}


def compute_reachability(source_root: str, base_url: str, files: list[str],
                         seed_urls_path: Optional[Path], headless: bool = True,
                         storage_state: Optional[str] = None) -> dict[str, Any]:
    """Visit candidate pages once, return per-file loaded/unreachable/unknown."""
    candidate_urls = _load_candidate_urls(source_root, base_url, files, seed_urls_path)
    loaded_urls: set[str] = set()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        try:
            context = browser.new_context(storage_state=storage_state)
            page = context.new_page()
            context.on("page", lambda popup: popup.close())
            page.on("dialog", lambda dialog: dialog.dismiss())
            for url in candidate_urls:
                loaded_urls |= _capture_page_scripts(page, url)
            context.close()
        finally:
            browser.close()

    classified = classify_files(files, source_root, loaded_urls, len(candidate_urls))
    return {"candidate_urls": candidate_urls, **classified}


def _cache_key(base_url: str, files: list[str], seed_urls_path: Optional[Path]) -> str:
    digest = hashlib.sha256()
    digest.update(base_url.encode())
    if seed_urls_path and seed_urls_path.exists():
        digest.update(seed_urls_path.read_bytes())
    for file_path in sorted(files):
        digest.update(file_path.encode())
        try:
            digest.update(Path(file_path).read_bytes())
        except OSError:
            pass
    return digest.hexdigest()


def load_or_compute(cache_path: Path, source_root: str, base_url: str, files: list[str],
                    seed_urls_path: Optional[Path], headless: bool = True,
                    storage_state: Optional[str] = None) -> dict[str, Any]:
    """Return cached reachability data if the app/files/candidates are unchanged,
    otherwise run the browser-based check once and persist the result."""
    key = _cache_key(base_url, files, seed_urls_path)
    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and cached.get("key") == key:
                return cached["data"]
        except (OSError, json.JSONDecodeError, KeyError):
            pass
    data = compute_reachability(source_root, base_url, files, seed_urls_path,
                                headless=headless, storage_state=storage_state)
    payload = {"key": key, "checked_at": int(time.time() * 1000), "data": data}
    tmp = cache_path.with_suffix(cache_path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, cache_path)
    return data
