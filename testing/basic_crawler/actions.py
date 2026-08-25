from contextlib import suppress

from playwright.sync_api import Page

from .navigation import click_with_classification

REVEAL_SELECTORS = [
    "[data-toggle]:visible",
    "[aria-expanded='false']:visible",
    "[role='tab']:visible",
    ".dropdown-toggle:visible",
    "details summary:visible",
    ".accordion-button:visible",
]

def run_reveal_round(page: Page) -> tuple:

    dom_before = page.evaluate("document.body.innerHTML.length")
    count = 0

    for sel in REVEAL_SELECTORS:
        for el in page.locator(sel).all()[:3]:
            with suppress(Exception):
                result = click_with_classification(page, el)
                count += 1
                if result == "navigation":

                    page.go_back()
                    with suppress(Exception):
                        page.wait_for_load_state("domcontentloaded", timeout=5000)

    dom_after = page.evaluate("document.body.innerHTML.length")
    return count, dom_after != dom_before

SAFE_INPUT_TYPES = {"text", "search", "email", "url"}
FILL_VALUE = "test input value"

def run_fill_round(page: Page) -> int:

    selectors = ", ".join(
        f"input[type={t}]:visible" for t in SAFE_INPUT_TYPES
    )
    selectors += ", textarea:visible, [contenteditable=true]:visible"

    count = 0
    for el in page.locator(selectors).all()[:5]:
        with suppress(Exception):
            el.fill(FILL_VALUE, timeout=2000)
            el.dispatch_event("input")
            el.dispatch_event("change")
            count += 1

    return count

def run_submit_round(page: Page, submit_count: int, max_per_page: int = 1) -> int:

    if submit_count >= max_per_page:
        return 0

    executed = 0
    for form in page.locator("form:visible").all()[:1]:
        with suppress(Exception):
            form.evaluate("f => f.requestSubmit()")
            page.wait_for_timeout(500)
            executed += 1

    return executed

ALLOWED_BUTTON_KEYWORDS = {
    "search", "filter", "view", "show", "open", "expand",
    "preview", "load", "next", "prev", "more", "detail",
    "tab", "menu", "toggle", "select", "check", "submit",
    "send", "add", "create", "new", "edit", "save", "update",
}

def is_safe_button(label: str) -> bool:

    label = label.strip().lower()
    if not label:
        return False
    return any(kw in label for kw in ALLOWED_BUTTON_KEYWORDS)

def get_dom_path(el) -> str:

    return (
        el.evaluate(
            """el => {
        const tags = [];
        let cur = el.parentElement;
        for (let i = 0; i < 3 && cur && cur !== document.body; i++) {
            tags.unshift(cur.tagName.toLowerCase());
            cur = cur.parentElement;
        }
        return tags.join('/');
    }"""
        )
        or ""
    )

def get_action_fingerprint(page: Page, el, page_pattern: str) -> tuple:

    btn_text = (el.text_content() or "").strip().lower()[:50]

    nearest_heading = el.evaluate(
        """el => {
        let cur = el;
        while (cur && cur !== document.body) {
            cur = cur.parentElement;
            const h = cur?.querySelector('h1,h2,h3,h4,legend');
            if (h) return h.textContent?.trim().slice(0, 30) ?? '';
        }
        return '';
    }"""
    ) or ""

    form_action = el.evaluate("el => el.closest('form')?.action ?? ''") or ""
    dom_path = get_dom_path(el)

    return (page_pattern, btn_text, nearest_heading[:30], form_action[:50], dom_path[:40])

def run_button_round(
    page: Page,
    page_pattern: str,
    action_budget: list,
    clicked_globally: set,
) -> tuple:

    button_count = 0
    significant_local_count = 0
    buttons = page.locator(
        "button:visible:not([type=submit]), [role=button]:visible"
    ).all()[:10]

    for btn in buttons:
        if action_budget[0] <= 0:
            break

        with suppress(Exception):
            label = (btn.text_content() or "").strip().lower()

            if not is_safe_button(label):
                continue

            fp = get_action_fingerprint(page, btn, page_pattern)

            if fp in clicked_globally:
                continue

            result = click_with_classification(page, btn)
            if result == "navigation":
                page.go_back()
                with suppress(Exception):
                    page.wait_for_load_state("domcontentloaded", timeout=5000)
            elif result == "significant_local":
                significant_local_count += 1
            clicked_globally.add(fp)
            action_budget[0] -= 1
            button_count += 1

    return button_count, significant_local_count
