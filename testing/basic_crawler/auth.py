import json
import sys
from contextlib import suppress

import requests
from playwright.sync_api import Page

USERNAME_FIELD_SELECTOR = (
    "input[name=log], input[name=username], input[name*=user], "
    "input[name*=email], input[type=email]"
)

def auth_form(page: Page, creds: dict) -> bool:

    try:
        login_url = creds["login_url"]
        print(f"[auth] Navigating to {login_url}...")
        page.goto(login_url, wait_until="domcontentloaded", timeout=15000)

        try:
            page.wait_for_selector(
                "input[name*=user], input[name*=email], input[type=email], input[name=username]",
                timeout=10000,
            )
        except Exception:
            pass

        username = creds.get("email", creds.get("username", ""))
        print(f"[auth] Attempting login with username: {username}")
        username_field_found = False
        for sel in USERNAME_FIELD_SELECTOR.split(", "):
            el = page.locator(sel).first
            if el.is_visible():
                el.fill(username, timeout=2000)
                username_field_found = True
                break

        password_selector = None
        for sel in [
            "input[name=pwd]",
            "input[type=password]",
        ]:
            el = page.locator(sel).first
            try:
                if el.is_visible():
                    el.fill(creds["password"], timeout=2000)
                    password_selector = sel
                    break
            except Exception:
                continue

        scope = page
        if password_selector:
            try:
                form_scope = page.locator(f"form:has({password_selector})").first
                if form_scope.count() > 0:
                    scope = form_scope
            except Exception:
                pass

        submitted = False
        for sel in ["#wp-submit", "button[type=submit]", "input[type=submit]"]:
            el = scope.locator(sel).first
            try:
                if el.is_visible():
                    el.click(timeout=5000)
                    submitted = True
                    print(f"[auth] Submitted via {sel}")
                    break
            except Exception:
                continue
        if not submitted:
            page.keyboard.press("Enter")
            print("[auth] Submitted via Enter key")

        with suppress(Exception):
            page.wait_for_load_state("networkidle", timeout=5000)

        page.wait_for_timeout(1000)

        cookies = page.context.cookies()
        has_session = any(
            c['name'].startswith('.AspNetCore') or 'UMB_UCONTEXT' in c['name']
            or c['name'].startswith('wordpress_logged_in')
            or c['name'] == 'laravel_session' or c['name'].startswith('remember_web_')
            for c in cookies
        )
        if not has_session and username_field_found:

            login_form_gone = True
            for sel in USERNAME_FIELD_SELECTOR.split(", "):
                el = page.locator(sel).first
                try:
                    if el.is_visible():
                        login_form_gone = False
                        break
                except Exception:
                    continue
            has_session = login_form_gone
        print(f"[auth] Session detected: {has_session}")
        return has_session
    except Exception as e:
        print(f"[auth] Form auth failed: {e}")
        import traceback
        traceback.print_exc()
        return False

def auth_oauth_popup(page: Page, creds: dict) -> bool:

    try:
        login_url = creds["login_url"]
        username = creds.get("email", creds.get("username", ""))
        password = creds["password"]
        login_trigger = creds.get(
            "login_trigger", "a:has-text('Login'), button:has-text('Login')"
        )
        print(f"[auth] Navigating to {login_url}...")
        page.goto(login_url, wait_until="networkidle", timeout=20000)

        trigger = page.locator(login_trigger).first
        print(f"[auth] Waiting for login trigger to render: {login_trigger}")
        trigger.wait_for(state="attached", timeout=15000)
        print(f"[auth] Clicking login trigger: {login_trigger}")
        with page.context.expect_page(timeout=10000) as popup_info:
            trigger.click(force=True, timeout=15000)
        popup = popup_info.value
        popup.wait_for_load_state("networkidle", timeout=15000)

        for sel in USERNAME_FIELD_SELECTOR.split(", "):
            el = popup.locator(sel).first
            if el.is_visible():
                print(f"[auth] Found username input in popup: {sel}")
                el.fill(username, timeout=2000)
                break

        password_field = popup.locator("input[type=password]").first
        password_field.fill(password, timeout=2000)
        password_field.press("Enter")
        print("[auth] Submitted popup login form")

        popup.wait_for_event("close", timeout=15000)
        page.wait_for_timeout(1000)

        raw = page.evaluate("() => JSON.stringify(localStorage)")
        local_storage = json.loads(raw)
        has_oidc_user = any(k.startswith("oidc.user:") for k in local_storage)
        print(f"[auth] Session detected (oidc.user in localStorage): {has_oidc_user}")
        return has_oidc_user
    except Exception as e:
        print(f"[auth] OAuth popup auth failed: {e}")
        import traceback
        traceback.print_exc()
        return False

def auth_api(page: Page, creds: dict) -> bool:

    try:
        resp = requests.post(
            creds["login_url"],
            json={
                "email": creds.get("email", creds.get("username")),
                "password": creds["password"],
            },
            timeout=10,
        )
        resp.raise_for_status()

        data = resp.json()
        token = (
            data.get("token")
            or data.get("access_token")
            or (data.get("data") or {}).get("token")
        )

        if not token:
            print("[auth] No token in API response", file=sys.stderr)
            return False

        page.set_extra_http_headers({"Authorization": f"Bearer {token}"})

        base_url = creds.get("base_url", "http://localhost:8080/")
        page.goto(base_url, wait_until="domcontentloaded", timeout=15000)

        page.evaluate(
            "t => { localStorage.setItem('token', t);"
            " localStorage.setItem('auth_token', t); }",
            token,
        )

        return True
    except Exception as e:
        print(f"[auth] API auth failed: {e}", file=sys.stderr)
        return False
