from playwright.sync_api import Page

MAX_SCROLL_ROUNDS = 3

def run_scroll_round(page: Page) -> bool:

    changed = False
    prev_height = page.evaluate("document.body.scrollHeight")

    for _ in range(MAX_SCROLL_ROUNDS):
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(800)

        new_height = page.evaluate("document.body.scrollHeight")

        if new_height > prev_height:
            changed = True
            prev_height = new_height
        else:
            break

    page.evaluate("window.scrollTo(0, 0)")

    return changed
