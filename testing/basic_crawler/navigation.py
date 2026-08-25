import json
from contextlib import suppress
from urllib.parse import urlparse

from playwright.sync_api import Page

def navigate_to(page: Page, url: str) -> bool:

    try:
        parsed = urlparse(url)
        current = urlparse(page.url)

        if (parsed.scheme == current.scheme
                and parsed.netloc == current.netloc
                and parsed.path == current.path
                and parsed.fragment):

            page.evaluate(f"window.location.hash = {json.dumps('#' + parsed.fragment)}")

            with suppress(Exception):
                page.wait_for_load_state("networkidle", timeout=3000)
            return True

        page.goto(url, wait_until="domcontentloaded", timeout=15000)
    except Exception:
        return False

    with suppress(Exception):
        page.wait_for_load_state("networkidle", timeout=3000)

    return True

def click_with_classification(page: Page, el) -> str:

    before_url = page.url
    before_dom_len = page.evaluate("document.body.innerHTML.length")

    el.click(timeout=2000)
    page.wait_for_timeout(400)

    after_url = page.url
    after_dom_len = page.evaluate("document.body.innerHTML.length")

    if before_url != after_url:

        with suppress(Exception):
            page.wait_for_load_state("networkidle", timeout=3000)
        return "navigation"

    dom_delta = abs(after_dom_len - before_dom_len)
    if dom_delta > 2000:
        return "significant_local"

    return "local"
