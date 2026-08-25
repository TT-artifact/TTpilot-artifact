import logging
from dataclasses import dataclass

import requests
from zapv2 import ZAPv2

from basic_crawler import CrawlConfig

logger = logging.getLogger(__name__)

@dataclass(frozen=True)
class AuthMaterial:
    description: str
    matchstring: str
    replacement: str

def prepare_auth(config: CrawlConfig) -> AuthMaterial | None:

    if not config.auth_enabled or not config.auth_type:
        return None
    if config.auth_type == "api":
        return _prepare_api_auth(config)
    if config.auth_type == "form":
        return _prepare_form_auth(config)
    if config.auth_type == "oauth_popup":
        return _prepare_oauth_popup_auth(config)
    raise ValueError(f"Unsupported auth type: {config.auth_type}")

def apply_auth(zap: ZAPv2, material: AuthMaterial | None) -> None:
    if material is None:
        return
    zap.replacer.add_rule(
        description=material.description,
        enabled="true",
        matchtype="REQ_HEADER",
        matchregex="false",
        matchstring=material.matchstring,
        replacement=material.replacement,
    )
    logger.info("Injected cached authentication material into ZAP replacer")

def setup_auth(zap: ZAPv2, config: CrawlConfig) -> None:

    apply_auth(zap, prepare_auth(config))

def _prepare_api_auth(config: CrawlConfig) -> AuthMaterial:

    creds = config.auth_credentials
    login_url = creds.get("login_url")
    email = creds.get("email")
    password = creds.get("password")

    if not all([login_url, email, password]):
        raise ValueError("API auth requires: login_url, email, password")

    try:
        resp = requests.post(login_url, json={"email": email, "password": password}, timeout=10)
        resp.raise_for_status()
    except requests.HTTPError as e:
        raise RuntimeError(f"Login request failed with status {e.response.status_code}") from e
    except requests.RequestException as e:
        raise RuntimeError(f"Login request failed: {type(e).__name__}") from e

    token = resp.json().get("token")
    if not token:
        raise ValueError("Failed to extract token from login response")

    return AuthMaterial(
        "API Auth Bearer Token", "Authorization", f"Bearer {token}"
    )

def _prepare_form_auth(config: CrawlConfig) -> AuthMaterial:

    creds = config.auth_credentials
    login_url = creds.get("login_url")
    username = creds.get("username", creds.get("email", ""))
    password = creds.get("password")

    if not all([login_url, username, password]):
        raise ValueError("Form auth requires: login_url, username (or email), password")

    try:
        cookies_header = _login_via_playwright(login_url, username, password)
    except Exception as e:
        raise RuntimeError(f"Form login failed: {e}") from e

    material = AuthMaterial(
        "Form Auth Session Cookie", "Cookie", cookies_header
    )
    logger.info("Prepared session cookies for ZAP replacer")
    return material

def _login_via_playwright(login_url: str, username: str, password: str) -> str:

    from playwright.sync_api import sync_playwright
    from basic_crawler.auth import auth_form

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        context = browser.new_context()
        page = context.new_page()

        try:
            success = auth_form(
                page,
                {"login_url": login_url, "username": username, "password": password},
            )
            if not success:
                raise RuntimeError("auth_form returned False")

            cookies = context.cookies()
            if not cookies:
                raise RuntimeError("No cookies obtained after login")

            cookie_header = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
            return cookie_header
        finally:
            browser.close()

def _prepare_oauth_popup_auth(config: CrawlConfig) -> AuthMaterial:

    creds = config.auth_credentials
    login_url = creds.get("login_url")
    username = creds.get("username", creds.get("email", ""))
    password = creds.get("password")
    login_trigger = creds.get(
        "login_trigger", "a:has-text('Login'), button:has-text('Login')"
    )

    if not all([login_url, username, password]):
        raise ValueError("OAuth popup auth requires: login_url, username (or email), password")

    try:
        access_token = _login_via_oauth_popup(login_url, username, password, login_trigger)
    except Exception as e:
        raise RuntimeError(f"OAuth popup login failed: {e}") from e

    material = AuthMaterial(
        "OAuth Popup Bearer Token", "Authorization", f"Bearer {access_token}"
    )
    logger.info("Prepared OAuth access token for ZAP replacer")
    return material

def _login_via_oauth_popup(
    login_url: str, username: str, password: str, login_trigger: str
) -> str:

    import json

    from playwright.sync_api import sync_playwright

    from basic_crawler.auth import USERNAME_FIELD_SELECTOR

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        try:
            page.goto(login_url, wait_until="load", timeout=30000)

            trigger = page.locator(login_trigger).first
            trigger.wait_for(state="visible", timeout=30000)
            with context.expect_page(timeout=10000) as popup_info:
                trigger.click(force=True, timeout=15000)
            popup = popup_info.value
            popup.wait_for_load_state("networkidle", timeout=15000)

            for sel in USERNAME_FIELD_SELECTOR.split(", "):
                el = popup.locator(sel).first
                if el.is_visible():
                    el.fill(username, timeout=2000)
                    break

            password_field = popup.locator("input[type=password]").first
            password_field.fill(password, timeout=2000)
            password_field.press("Enter")

            popup.wait_for_event("close", timeout=15000)
            page.wait_for_timeout(1000)

            raw = page.evaluate("() => JSON.stringify(localStorage)")
            local_storage = json.loads(raw)
            oidc_keys = [k for k in local_storage if k.startswith("oidc.user:")]
            if not oidc_keys:
                raise RuntimeError("No OIDC user found in localStorage after popup login")

            user_obj = json.loads(local_storage[oidc_keys[0]])
            access_token = user_obj.get("access_token")
            if not access_token:
                raise RuntimeError("OIDC user object has no access_token")
            return access_token
        finally:
            browser.close()
