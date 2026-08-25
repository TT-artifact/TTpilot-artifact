#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

RESEARCH_ROOT = Path(__file__).resolve().parents[2]
POLL_INTERVAL_S = 2.0
MIN_TIMEOUT_S = 60.0
TIMEOUT_MULTIPLIER = 4.0

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("yml_file")
    parser.add_argument("--timeout", type=float, default=None,
                        help="override the computed max wait, in seconds")
    return parser.parse_args()

def wait_for_http(url: str, deadline: float) -> bool:

    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=5)
            return True
        except urllib.error.HTTPError:
            return True
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            time.sleep(POLL_INTERVAL_S)
    return False

def wait_for_login_form(login_url: str, deadline: float) -> bool:
    sys.path.insert(0, str(RESEARCH_ROOT / "testing"))
    from basic_crawler.auth import USERNAME_FIELD_SELECTOR
    from playwright.sync_api import sync_playwright

    start = time.monotonic()
    attempt = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_context().new_page()
            while time.monotonic() < deadline:
                attempt += 1
                elapsed = time.monotonic() - start
                remaining = deadline - time.monotonic()
                print(f"[wait]   attempt {attempt} ({elapsed:.0f}s elapsed, {remaining:.0f}s remaining)...",
                      flush=True)
                try:

                    page.goto(login_url, wait_until="load", timeout=20000)

                    page.wait_for_selector(USERNAME_FIELD_SELECTOR, timeout=15000)
                    return True
                except Exception:
                    time.sleep(POLL_INTERVAL_S)
            return False
        finally:
            browser.close()

def main() -> int:
    args = parse_args()
    cfg = yaml.safe_load(open(args.yml_file, encoding="utf-8"))
    crawl = cfg.get("crawl", {})
    base_url = crawl.get("base_url", "http://localhost:8080/")
    auth = crawl.get("auth", {})
    init_wait_sec = cfg.get("serve", {}).get("docker", {}).get("init_wait_sec", 10)
    max_wait = args.timeout if args.timeout is not None else max(MIN_TIMEOUT_S, init_wait_sec * TIMEOUT_MULTIPLIER)
    deadline = time.monotonic() + max_wait

    print(f"[wait] Waiting for {base_url} to respond (up to {max_wait:.0f}s)...")
    if not wait_for_http(base_url, deadline):
        print(f"[wait] TIMEOUT: {base_url} did not respond within {max_wait:.0f}s")
        return 1
    print("[wait] base_url is responding")

    if auth.get("enabled") and auth.get("type") == "form":
        login_url = auth.get("credentials", {}).get("login_url", base_url)
        print(f"[wait] Waiting for the login form at {login_url} to render...")
        if not wait_for_login_form(login_url, deadline):
            print(f"[wait] TIMEOUT: The login form did not appear within {max_wait:.0f}s "
                  f"(the app may still be initializing or the wrong image may be running)")
            return 1
        print("[wait] Login form detected")

    print("[wait] App is ready")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
