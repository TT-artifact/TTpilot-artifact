"""Scaffolding for agent-authored Playwright scripts.

The CLI agent (``claude --print``) imports these helpers so the script it writes
only needs interaction logic. This module enforces two policies the agent must
not be trusted to follow on its own:

1. UI-only interaction - :func:`agent_browser` yields a :class:`RestrictedPage`,
   a proxy that allows genuine user-facing actions (navigate, click, fill, type,
   press, keyboard) and BLOCKS direct JavaScript execution and internal-API
   invocation (``evaluate``, ``evaluate_handle``, ``add_script_tag``,
   ``set_content``, ``locator.evaluate`` ...). A sink may only be reached the way a
   real user would reach it, so a "triggered" result reflects a UI-reachable XSS,
   not a forced internal call.
2. Worker isolation - an init script sets ``window.__AGENT_RUN_ID`` on every
   document (it survives navigation), so the runtime Trusted Types policy tags
   this worker's reports and concurrent agents never cross-count.

Every allowed interaction is appended to a per-run JSONL trace (the value typed
into a field - i.e. the payload - is captured), so the parent can report exactly
what the agent did and which payloads it used.
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from playwright.sync_api import sync_playwright

from .report_checker import count_reports_with_payload


def count_triggered(db_path: str, sink_key: str, after_id: int, payload: str) -> int:
    """Number of reports for sink_key (since checkpoint) carrying this payload token."""
    return count_reports_with_payload(db_path, sink_key, after_id, payload)


def is_triggered(db_path: str, sink_key: str, after_id: int, payload: str) -> bool:
    """True once *this attempt's payload* has reached the sink (not an on-load value)."""
    return count_triggered(db_path, sink_key, after_id, payload) > 0


def _short(value: Any, limit: int = 500) -> str:
    s = value if isinstance(value, str) else repr(value)
    return s if len(s) <= limit else s[:limit] + "..."


class _Tracer:
    """Append-only JSONL writer for the interaction trace."""

    def __init__(self, path: Optional[str]) -> None:
        self._fh = open(path, "a", encoding="utf-8") if path else None
        self._seq = 0

    def log(self, action: str, args: tuple = (), kwargs: Optional[dict] = None) -> None:
        if self._fh is None:
            return
        self._seq += 1
        rec = {
            "seq": self._seq,
            "action": action,
            "args": [_short(a) for a in args],
            "kwargs": {k: _short(v) for k, v in (kwargs or {}).items()},
        }
        self._fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self._fh.flush()

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass


def load_trace(path: str) -> list[dict]:
    """Read a JSONL interaction trace produced by :class:`_Tracer`."""
    out: list[dict] = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
    except FileNotFoundError:
        pass
    return out


_BLOCKED_HINT = (
    "Direct JavaScript execution and internal-API calls are disabled. Trigger the "
    "sink through genuine UI actions only: navigate, click, fill, type, press, keyboard."
)

_PAGE_ALLOWED = frozenset({
    "goto", "reload", "go_back", "go_forward", "bring_to_front",
    "wait_for_timeout", "wait_for_selector", "wait_for_load_state", "wait_for_url",
    "click", "dblclick", "fill", "type", "press", "focus", "hover", "tap",
    "check", "uncheck", "select_option", "set_checked", "set_input_files",
    "drag_and_drop", "screenshot", "title", "content", "inner_text", "inner_html",
    "text_content", "get_attribute", "is_visible", "is_enabled", "is_checked",
})
_PAGE_LOCATOR_FACTORIES = frozenset({
    "locator", "get_by_role", "get_by_text", "get_by_label", "get_by_placeholder",
    "get_by_test_id", "get_by_title", "get_by_alt_text",
})
_INPUT_ACTIONS = frozenset({
    "fill", "type", "press_sequentially", "insert_text", "select_option",
})


class RestrictedKeyboard:
    """Keyboard proxy: allows real key events, logs typed text (payloads)."""

    _ALLOWED = frozenset({"type", "press", "insert_text", "down", "up"})

    def __init__(self, keyboard: Any, tracer: _Tracer) -> None:
        object.__setattr__(self, "_kb", keyboard)
        object.__setattr__(self, "_tracer", tracer)

    def __getattr__(self, name: str):
        if name not in self._ALLOWED:
            raise RuntimeError(f"keyboard.{name} is disabled. {_BLOCKED_HINT}")
        real = getattr(self._kb, name)

        def wrapper(*args, **kwargs):
            self._tracer.log(f"keyboard.{name}", args, kwargs)
            return real(*args, **kwargs)

        return wrapper


class RestrictedLocator:
    """Locator proxy: allows UI actions, blocks evaluate-family, propagates itself."""

    _ALLOWED = frozenset({
        "click", "dblclick", "fill", "type", "press", "press_sequentially",
        "focus", "hover", "tap", "check", "uncheck", "select_option", "set_checked",
        "set_input_files", "scroll_into_view_if_needed", "wait_for", "clear",
        "count", "text_content", "inner_text", "inner_html", "get_attribute",
        "is_visible", "is_enabled", "is_checked", "screenshot", "highlight",
    })
    _FACTORIES = frozenset({
        "first", "last", "nth", "locator", "filter", "get_by_role", "get_by_text",
        "get_by_label", "get_by_placeholder", "get_by_test_id", "get_by_title",
        "get_by_alt_text",
    })

    def __init__(self, locator: Any, tracer: _Tracer, desc: str) -> None:
        object.__setattr__(self, "_loc", locator)
        object.__setattr__(self, "_tracer", tracer)
        object.__setattr__(self, "_desc", desc)

    def __getattr__(self, name: str):
        if name in self._FACTORIES:
            real = getattr(self._loc, name)
            if callable(real):
                def factory(*args, **kwargs):
                    return RestrictedLocator(real(*args, **kwargs), self._tracer, self._desc)
                return factory
            return RestrictedLocator(real, self._tracer, self._desc)

        if name in self._ALLOWED:
            real = getattr(self._loc, name)
            if not callable(real):
                return real

            def wrapper(*args, **kwargs):
                self._tracer.log(name, (self._desc, *args), kwargs)
                return real(*args, **kwargs)

            return wrapper

        raise RuntimeError(f"locator.{name} is disabled. {_BLOCKED_HINT}")


class RestrictedPage:
    """Page proxy exposing only UI-facing methods; all JS-execution paths denied."""

    def __init__(self, page: Any, tracer: _Tracer) -> None:
        object.__setattr__(self, "_page", page)
        object.__setattr__(self, "_tracer", tracer)

    @property
    def url(self) -> str:
        return self._page.url

    @property
    def keyboard(self) -> RestrictedKeyboard:
        return RestrictedKeyboard(self._page.keyboard, self._tracer)

    @property
    def mouse(self) -> Any:
        return self._page.mouse

    def __getattr__(self, name: str):
        if name in _PAGE_LOCATOR_FACTORIES:
            real = getattr(self._page, name)

            def factory(*args, **kwargs):
                desc = f"{name}({', '.join(_short(a) for a in args)})"
                return RestrictedLocator(real(*args, **kwargs), self._tracer, desc)

            return factory

        if name in _PAGE_ALLOWED:
            real = getattr(self._page, name)
            if not callable(real):
                return real

            def wrapper(*args, **kwargs):
                self._tracer.log(name, args, kwargs)
                return real(*args, **kwargs)

            return wrapper

        raise RuntimeError(f"page.{name} is disabled. {_BLOCKED_HINT}")


@contextmanager
def agent_browser(
    run_id: str,
    crawl_run_id: Optional[str] = None,
    storage_state: Optional[str] = None,
    headless: bool = True,
    trace_path: Optional[str] = None,
) -> Iterator[RestrictedPage]:
    """Yield a :class:`RestrictedPage` with run_id pre-injected and tracing enabled.

    Args:
        run_id: Worker isolation marker injected into every document.
        storage_state: Path to a Playwright storage_state JSON for an
            authenticated session, or None for an anonymous context.
        headless: Launch Chromium headless.
        trace_path: JSONL file to append the interaction trace to (None disables).
    """
    tracer = _Tracer(trace_path)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(storage_state=storage_state)
        context.add_init_script(
            f"window.__AGENT_RUN_ID = {run_id!r};"
            f"window.__AGENT_CRAWL_RUN_ID = {crawl_run_id!r};"
        )
        try:
            context.set_default_timeout(15000)
        except Exception:
            pass
        page = context.new_page()
        try:
            page.on("dialog", lambda d: _safe_dismiss(d))
        except Exception:
            pass
        try:
            yield RestrictedPage(page, tracer)
        finally:
            tracer.close()
            for closer in (context.close, browser.close):
                try:
                    closer()
                except Exception:
                    pass


def _safe_dismiss(dialog: Any) -> None:
    try:
        dialog.dismiss()
    except Exception:
        pass


_RECON_MAX = 30
_RECON_MAX_SCRIPTS = 80
_RECON_PROBE_MS = 600
_RECON_BUDGET_S = 8.0


def _collect_locator(real: Any, selector: str, fields: tuple, limit: int, deadline: float) -> list:
    """Per-element attributes via nth() + ONLY timeout-guarded reads.

    Deliberately avoids count()/query_selector_all: those take no timeout and hang
    forever on SPAs that block the main world (draw.io). nth(i)+inner_text/get_attribute
    with an explicit timeout instead RAISE on a jammed/absent element, so we stop at the
    first failing index and never hang. A wall-clock deadline bounds the total.
    """
    out: list = []
    loc = real.locator(selector)
    for i in range(limit):
        if time.monotonic() > deadline:
            break
        el = loc.nth(i)
        rec: dict = {}
        for j, f in enumerate(fields):
            try:
                if f == "text":
                    rec["text"] = ((el.inner_text(timeout=_RECON_PROBE_MS) or "").strip())[:40]
                else:
                    rec[f] = el.get_attribute(f, timeout=_RECON_PROBE_MS)
            except Exception:
                rec[f] = None
                if j == 0:
                    return out
        out.append(rec)
    return out


def observe_page(page: Any) -> dict:
    """Read-only snapshot of the current page for the agent to plan from.

    Returns ``{url, title, buttons, inputs, links, scripts}`` - the interactive
    elements (with usable selectors: id/name/role/text) and the loaded script URLs,
    so the agent can confirm the sink's file is present and pick real selectors
    instead of guessing. Built ONLY from timeout-guarded Playwright locator reads
    (isolated world), so it returns bounded/partial data - and can never hang the
    agent - even on SPAs that block main-world evaluate (draw.io/mxGraph).
    """
    real = getattr(page, "_page", page)
    deadline = time.monotonic() + _RECON_BUDGET_S

    try:
        url = real.url
    except Exception:
        url = None
    try:
        title = (real.locator("title").text_content(timeout=_RECON_PROBE_MS) or "").strip() or None
    except Exception:
        title = None

    buttons = _collect_locator(
        real, "button, [role=button], input[type=submit], input[type=button]",
        ("text", "id", "name", "type", "role"), _RECON_MAX, deadline)
    inputs = _collect_locator(
        real, "input, textarea, [contenteditable], select",
        ("id", "name", "type", "placeholder"), _RECON_MAX, deadline)
    links = _collect_locator(real, "a[href]", ("text", "href"), _RECON_MAX, deadline)

    scripts: list = []
    sc = real.locator("script[src]")
    for i in range(_RECON_MAX_SCRIPTS):
        if time.monotonic() > deadline:
            break
        try:
            src = sc.nth(i).get_attribute("src", timeout=_RECON_PROBE_MS)
        except Exception:
            break
        if src:
            scripts.append(src)

    return {"url": url, "title": title, "buttons": buttons,
            "inputs": inputs, "links": links, "scripts": scripts}
