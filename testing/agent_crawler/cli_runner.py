"""Run a Claude CLI agent (claude -p) per sink for XSS trigger attempts.

Each sink gets one ``claude --print`` agent. The agent reads source, writes a
Playwright script, and keeps trying until the sink fires or it exhausts ideas.
Browser ownership lives with the agent; the parent only supplies the run_id and
the checkpoint, and the agent uses :mod:`agent_crawler.agent_helper` so worker
isolation and verification are handled for it.
"""

import logging
import os
import random
import subprocess
import shutil
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .agent_helper import _INPUT_ACTIONS, load_trace
from .payload import generate_payload
from .report_checker import count_reports_with_payload, get_max_report_id

logger = logging.getLogger(__name__)

_RESULT_TRIGGERED = "RESULT: TRIGGERED"
_RESULT_NOT_TRIGGERED = "RESULT: NOT_TRIGGERED"

_INJECTION_TECHNIQUES = """INJECTION TECHNIQUES (pick what fits each sink; the payload token must end up in the sink's value):
- Text fields / editors: type the payload into inputs, textareas, or contenteditable
  areas (fill / keyboard.type). What you type IS the payload.
- File names / uploads: if a sink renders file names or uploaded content, create a
  LOCAL file whose NAME or CONTENT contains the payload (use Bash first, e.g.
  `printf '%s' '<PAYLOAD>' > /tmp/ttf.txt`, or embed the payload in the filename),
  then upload it via the app's file input:
  page.set_input_files("input[type=file]", "/tmp/ttf.txt"). Then open the folder /
  listing / preview so the name or content renders.
- Content creation (CMS page / markdown / note): create or edit a document whose body
  contains the payload, save it, then open the rendered view.
- URL / query / hash: if the app reads location (?q=, #...), navigate with the payload
  embedded in the URL."""

_INTEGRITY_RULES = """INTEGRITY (a trigger only counts if it happens through the real app):
- Do NOT modify, patch, rebuild, or redeploy the app or its source files. `docker`,
  `docker-compose`, `podman`, `kubectl` are BLOCKED and will error - do not attempt to
  copy files into the container or change what the server serves.
- Do NOT write to the reports database and do NOT POST/curl to the report server to
  fabricate a report. The only legitimate way a report appears is the browser's
  Trusted Types policy firing when your payload reaches the sink via the UI.
- Do NOT edit files under the source root to inject the payload. The payload must be
  delivered as USER INPUT (typing, upload, URL, created content) to the running app.
- A sink COUNTS AS TRIGGERED only when YOUR payload token reaches it (a genuine
  injection). Never claim a trigger without the token - a false "triggered" is worse
  than an honest "not triggered".
- BUT do NOT silently skip a sink just because its value looks static/hardcoded with no
  obvious user-input path. Still EXERCISE it through the UI so its code actually RUNS
  and emits a report to the DB (e.g. click the button that calls it, open the view that
  renders it, fire its event handler). Report such a sink as "fired, no injection path
  found" - distinct from an injected trigger. Downstream analysis classifies each sink
  from its report, so a sink that never fires leaves no data to classify. Only give up
  on a sink when you cannot make its code run at all through the UI."""

_AUTH_ENV_OVERRIDES = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")

_BLOCKED_BIN = str((Path(__file__).parent / "blocked_bin").resolve())


def _subscription_env() -> dict:
    """Env for the agent: subscription auth + docker/redeploy tools blocked via PATH."""
    env = {k: v for k, v in os.environ.items() if k not in _AUTH_ENV_OVERRIDES}
    env["PATH"] = _BLOCKED_BIN + os.pathsep + env.get("PATH", "")
    return env


def _claude_auth_bind_args() -> list[str]:
    """Allow Claude to refresh only its OAuth credential inside the sandbox.

    The root filesystem remains read-only.  Claude Code's subscription login may
    rotate the credential during a non-interactive invocation; denying that one
    write can make the CLI return before the first browser action.
    """
    credential = Path.home() / ".claude" / ".credentials.json"
    if not credential.is_file():
        return []
    resolved = str(credential.resolve())
    return ["--bind", resolved, resolved]


def _claude_runtime_bind_args(run_cwd: str) -> list[str]:
    """Give Claude's Bash tool a per-run writable session environment.

    Claude Code creates ``~/.claude/session-env/<session-id>`` before every Bash
    command.  With a read-only root that mkdir fails before the requested command
    starts, so bind only that runtime directory rather than all of ~/.claude.
    """
    host_dir = Path(run_cwd) / ".claude-session-env"
    host_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = Path.home() / ".claude" / "session-env"
    if not target.is_dir():
        raise RuntimeError(f"Claude session-env mount target is missing: {target}")
    return ["--bind", str(host_dir), str(target)]


@dataclass(frozen=True)
class CliRunResult:
    triggered: bool
    payload: str
    agent_output: str
    run_id: str
    interactions: tuple[dict, ...] = ()
    urls_visited: tuple[str, ...] = ()
    payloads: tuple[str, ...] = ()
    action_types: dict[str, int] = field(default_factory=dict)
    status: str = "completed"
    error: str = ""
    model: str = ""
    turns_budget: int = 0
    actual_turns: int = 0
    usage: dict[str, Any] = field(default_factory=dict)
    manifest: dict[str, Any] = field(default_factory=dict)


def make_run_id() -> str:
    """Unique per-attempt worker isolation marker: agent-<ms>-<rand4>."""
    return f"agent-{int(time.time() * 1000)}-{random.randint(0, 9999):04d}"


def _summarize_trace(trace: list[dict]) -> tuple[tuple, tuple, tuple, dict]:
    """Reduce a raw interaction trace to (interactions, urls, payloads, action_types)."""
    urls: list[str] = []
    payloads: list[str] = []
    action_types: dict[str, int] = {}
    for entry in trace:
        action = entry.get("action", "")
        args = entry.get("args", [])
        action_types[action] = action_types.get(action, 0) + 1
        if action == "goto" and args:
            urls.append(args[0])
        base = action.split(".")[-1]
        if base in _INPUT_ACTIONS and args:
            payloads.append(args[-1])
    seen: set[str] = set()
    uniq_payloads = tuple(p for p in payloads if not (p in seen or seen.add(p)))
    return tuple(trace), tuple(dict.fromkeys(urls)), uniq_payloads, action_types


def _extract_agent_reasoning(output: str) -> str:
    """Return the agent's explanation - everything before the final RESULT: line."""
    for marker in (_RESULT_TRIGGERED, _RESULT_NOT_TRIGGERED):
        idx = output.rfind(marker)
        if idx != -1:
            return output[:idx].strip()
    return output.strip()


def _build_prompt(
    sink: dict[str, Any],
    base_url: str,
    source_root: str,
    reports_db_path: str,
    checkpoint_id: int,
    venv_python: str,
    payload: str,
    run_id: str,
    testing_root: str,
    trace_path: str,
    storage_state: Optional[str] = None,
    headless: bool = True,
    auth_credentials: Optional[dict] = None,
) -> str:
    auth_section = ""
    if auth_credentials:
        login_url = auth_credentials.get("login_url", "")
        username = auth_credentials.get("email", auth_credentials.get("username", ""))
        password = auth_credentials.get("password", "")
        auth_section = f"""
AUTH (an authenticated session is already preloaded via storage_state; use this
only if you are still redirected to a login page):
- Login URL: {login_url}
- Username: {username}
- Password: {password}
"""

    return f"""You are a web security expert. Trigger this XSS sink in a running web app
by driving a real browser and interacting with the page. Read the app source to
understand how the sink is reached, then make it fire.

TARGET SINK:
- File: {sink['file']}
- Line: {sink['line']}, Col: {sink.get('col', '?')}
- Kind: {sink['kind']}
- sink_key: {sink['sink_key']}
- Snippet: {sink.get('original_snippet', '')}

APP & PATHS:
- App URL: {base_url}
- Source root (read these to plan): {source_root}
- Reports DB: {reports_db_path}
- Python (with Playwright + helpers): {venv_python}

FIND THE ENTRY PAGE FIRST (base_url is only a starting point):
The sink lives in {sink['file']} ({Path(sink['file']).name}). That code may NOT be
loaded on base_url - you must open the page that actually loads it before you can
trigger it.
- If the app serves files statically, a source file's path relative to the source
  root usually maps straight to a URL path. e.g. <root>/Apps/Foo/bar.js is served
  at {base_url}Apps/Foo/bar.js, and the page that loads it is that directory's
  index (e.g. {base_url}Apps/Foo/).
- Confirm which HTML page loads the sink's script by grepping the source:
    grep -rl "{Path(sink['file']).name}" --include=*.html {source_root}
  then open that page's URL.
- Navigate there, wait for load, and confirm the sink's script is present before
  interacting. If the mapping is unclear (bundled/SPA app), start at base_url and
  follow links/UI toward the sink's feature.

ISOLATION & VERIFICATION (do not change these values):
- run_id:       {run_id}
- checkpoint:   {checkpoint_id}
- payload:      {payload}
{auth_section}
HOW TO DRIVE THE BROWSER:
You MUST open the browser through the provided helper - it guarantees the run_id
marker on every page (so your hit is attributed to you) and loads the
authenticated session. Do NOT call playwright's launch() yourself.

INTERACTION RULES (enforced - not just guidance):
- Trigger the sink the way a real USER would: navigate, click, fill, type, press,
  keyboard input. The value you type into a field IS your payload.
- Direct JavaScript execution and calling the app's internal JS APIs are DISABLED.
  The page object is restricted: page.evaluate, page.evaluate_handle,
  page.add_script_tag, page.set_content, locator.evaluate, page.wait_for_function,
  etc. will RAISE an error. Do not try to inject or call app internals via JS.
- If a method raises "is disabled", switch to a genuine UI action instead.
- Every interaction you make is recorded automatically; you do not manage that.

{_INJECTION_TECHNIQUES}

{_INTEGRITY_RULES}

HOW TO VERIFY:
After each interaction, call is_triggered(...) with the values above. It returns
True only when a report carrying YOUR payload token reached this sink since the
checkpoint - a value the app produces on its own does NOT count, so your injected
payload must actually flow into the sink. Keep trying DIFFERENT approaches
(routes, inputs, UI flows) until it returns True, or until you are confident the
payload cannot reach this sink through the UI.

SCRIPT TEMPLATE (run with: {venv_python} <script.py>):
```python
import sys
sys.path.insert(0, {testing_root!r})
from agent_crawler.agent_helper import agent_browser, is_triggered

DB = {reports_db_path!r}
SINK_KEY = {sink['sink_key']!r}
CHECKPOINT = {checkpoint_id}
RUN_ID = {run_id!r}
PAYLOAD = {payload!r}
STORAGE_STATE = {storage_state!r}
TRACE = {trace_path!r}

with agent_browser(RUN_ID, storage_state=STORAGE_STATE, headless={headless}, trace_path=TRACE) as page:
    page.goto({base_url!r}, wait_until="domcontentloaded", timeout=15000)
    page.wait_for_timeout(2000)
    print("TRIGGERED" if is_triggered(DB, SINK_KEY, CHECKPOINT, PAYLOAD) else "NOT_TRIGGERED")
```

RULES:
- The app is already running at {base_url} - do NOT start or stop it.
- Never navigate to .js or .css file URLs (they download instead of loading).
- For [contenteditable] elements use page.focus() + page.keyboard.press()/type(),
  never page.fill().
- Try up to a few different approaches before giving up.

At the very end of your response, output exactly one of these two lines:
{_RESULT_TRIGGERED}
{_RESULT_NOT_TRIGGERED}
"""


def sandbox_preflight() -> tuple[bool, str]:
    """Fail closed unless Claude and Bubblewrap are executable."""
    if not shutil.which("claude"):
        return False, "claude CLI not found"
    if not shutil.which("bwrap"):
        return False, "bwrap not found"
    try:
        probe = subprocess.run(
            ["bwrap", "--ro-bind", "/", "/", "--proc", "/proc",
             "--dev", "/dev", "true"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception as ex:
        return False, f"bwrap preflight failed: {ex}"
    if probe.returncode:
        return False, f"bwrap preflight failed: {(probe.stderr or probe.stdout)[-500:]}"
    return True, ""


def _run_claude(prompt: str, project_root: str, timeout_secs: int, *,
                model: str, max_turns: int, work_dir: str,
                max_budget_usd: float = 0.35) -> tuple[str, str, str, dict[str, Any]]:
    """Run Claude in a read-only-root Bubblewrap sandbox."""
    ok, error = sandbox_preflight()
    if not ok:
        return "", "infra_failed", error, {}
    cmd = [
        "claude", "--print", "--safe-mode", "--no-session-persistence", "--exclude-dynamic-system-prompt-sections", "--dangerously-skip-permissions",
        "--allowedTools", "Bash,Read,Write", "--model", model,
        "--max-turns", str(max_turns), "--max-budget-usd", str(max_budget_usd),
        "--output-format", "stream-json", "--verbose", prompt,
    ]
    run_cwd = str(Path(work_dir).resolve())
    sandbox_cmd = [
        "bwrap", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/tmp", *_claude_auth_bind_args(),
        *_claude_runtime_bind_args(run_cwd),
        "--bind", run_cwd, run_cwd, "--chdir", run_cwd,
        "--", *cmd,
    ]
    try:
        result = subprocess.run(sandbox_cmd, capture_output=True, text=True,
                                timeout=timeout_secs, cwd=run_cwd, env=_subscription_env())
        Path(run_cwd, "claude_stream.jsonl").write_text(
            result.stdout or "", encoding="utf-8"
        )
        Path(run_cwd, "claude_stderr.log").write_text(
            result.stderr or "", encoding="utf-8"
        )
        events: list[dict[str, Any]] = []
        for line in result.stdout.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                events.append(item)
        data = next((item for item in reversed(events) if item.get("type") == "result"),
                    events[-1] if events else {})
        raw_result = data.get("result")
        output = raw_result if isinstance(raw_result, str) else result.stdout
        is_error = bool(data.get("is_error"))
        subtype = str(data.get("subtype") or "")
        if subtype == "error_max_turns" or data.get("terminal_reason") == "max_turns":
            status = "turn_limited"
        elif "budget" in subtype or data.get("terminal_reason") == "max_budget_usd":
            status = "usage_limited"
        else:
            status = (
                "completed"
                if result.returncode == 0 and output.strip() and not is_error
                else "infra_failed"
            )
        usage = {key: data.get(key) for key in (
            "num_turns", "usage", "total_cost_usd", "duration_ms",
            "stop_reason", "subtype", "is_error", "session_id",
        ) if key in data}
        usage["stream_events"] = len(events)
        error_parts: list[str] = []
        if status != "completed":
            if data.get("subtype"):
                error_parts.append(str(data["subtype"]))
            if isinstance(data.get("error"), str) and data["error"].strip():
                error_parts.append(data["error"].strip())
            if isinstance(raw_result, str) and raw_result.strip():
                error_parts.append(raw_result.strip())
            if result.stderr.strip():
                error_parts.append(result.stderr.strip())
            if not error_parts:
                error_parts.append(f"claude exited with code {result.returncode} and no result")
        error = " | ".join(dict.fromkeys(error_parts))[-4000:]
        if error and status == "infra_failed":
            logger.error("[cli] Claude failed: %s", error)
        elif error:
            logger.warning("[cli] Claude stopped at turn budget: %s", error)
        return output, status, error, usage
    except subprocess.TimeoutExpired:
        Path(run_cwd, "claude_stderr.log").write_text(
            f"timed out after {timeout_secs}s\n", encoding="utf-8"
        )
        return "", "timeout", f"timed out after {timeout_secs}s", {}
    except Exception as ex:
        logger.error(f"[cli] Agent failed: {ex}")
        return "", "infra_failed", str(ex), {}


def _build_group_prompt(
    sinks: list[dict[str, Any]],
    base_url: str,
    source_root: str,
    reports_db_path: str,
    checkpoint_id: int,
    venv_python: str,
    payload: str,
    run_id: str,
    testing_root: str,
    trace_path: str,
    storage_state: Optional[str] = None,
    headless: bool = True,
    auth_credentials: Optional[dict] = None,
) -> str:
    """Prompt for triggering MANY sinks (all in one source file) in a single agent run."""
    src_file = sinks[0]["file"]
    basename = Path(src_file).name

    auth_section = ""
    if auth_credentials:
        login_url = auth_credentials.get("login_url", "")
        username = auth_credentials.get("email", auth_credentials.get("username", ""))
        password = auth_credentials.get("password", "")
        auth_section = f"""
AUTH (authenticated session preloaded via storage_state; use only if redirected
to a login page): Login URL: {login_url} | Username: {username} | Password: {password}
"""

    sink_lines = "\n".join(
        f"  - {s['sink_key']}  ({s['kind']} at line {s['line']}): {s.get('original_snippet', '')[:80]}"
        for s in sinks
    )
    sink_keys = [s["sink_key"] for s in sinks]

    return f"""You are a web security expert. The following XSS sinks ALL live in one source
file: {src_file} ({basename}). Your job is to trigger as MANY of them as you can by
driving a real browser. This is NOT a one-shot task - you will iterate: analyze the
sink, attempt, read what actually happened, then refine and attempt again.

TARGET SINKS ({len(sinks)}):
{sink_lines}

APP & PATHS:
- App URL: {base_url}
- Source root: {source_root}
- Reports DB: {reports_db_path}
- Python (with Playwright + helpers): {venv_python}

ISOLATION & VERIFICATION (do not change):
- run_id:     {run_id}
- checkpoint: {checkpoint_id}
- payload:    {payload}   (one shared token; inject it into inputs/content this file renders)
{auth_section}
INTERACTION RULES (enforced): UI actions only - navigate, click, fill, type, press,
keyboard. Direct JS execution (page.evaluate, add_script_tag, set_content,
locator.evaluate, ...) is DISABLED and will RAISE. Reach each sink like a real user.

METHODOLOGY - follow this loop; do NOT try to write one perfect script up front:

BROWSER-FIRST BUDGET (mandatory): your first browser attempt must finish within
your first 3 tool calls. Before it, you may perform at most ONE bounded source read
or search; use the supplied cache and entry-page candidates instead of rediscovering
the application. A response that analyzes source without a traced browser attempt
is incomplete. After the first attempt, use its diagnostics to decide whether one
additional source read or a revised attempt is necessary.

1. UNDERSTAND THE SINK (Read / grep the source):
   Read {basename} around each target line. For each sink work out: the enclosing
   function and what CALLS it, the event/condition that reaches it (a click handler?
   a route/hash? a save? a "dirty" flag guard?), and which user input flows into it.

2. FIND THE ENTRY PAGE + RECON (look before you act):
   Find the HTML that loads {basename}:  grep -rl "{basename}" --include=*.html {source_root}
   Then run a RECON script (below) that navigates a candidate URL and prints
   observe_page(page). READ its JSON output: confirm {basename} appears in `scripts`
   (the sink code is actually loaded here) and note the real `buttons`/`inputs`
   (their id/name/role/text) you can drive. If {basename} is not in `scripts`, this
   is the wrong page - try another URL/route.
   SPA / SLOW APPS: use wait_until="domcontentloaded" (NOT "networkidle" - a live app
   never goes idle and the goto will time out), then wait a few seconds for the app
   to render before recon. If a first-run/storage/cookie SPLASH MODAL covers the UI
   (e.g. draw.io shows "Save diagrams to:" - click its "Decide later" text), DISMISS
   it first; otherwise every real control is behind it and nothing is clickable.

3. ATTEMPT: write a trigger script that drives those real elements, injects PAYLOAD,
   and prints HIT plus diagnostics. Run it and read the output.

4. DIAGNOSE & REPEAT: if HIT is empty, use the diagnostics + re-read the source to
   find what you missed (an unmet precondition, a wrong selector, a required prior
   step, a redirect to another page). Adjust and run again. Keep looping until you
   trigger the sinks or you have genuinely exhausted distinct approaches.

   PROGRESS RULE: an attempt counts as progress only when it discovers a new URL,
   successful UI action, target script, report, sink disposition, selector, or
   concrete precondition. After THREE consecutive attempts with none of these changes,
   stop retrying the same route. Record the blocker and reusable workflow in the
   manifest instead of spending the remaining turns on equivalent attempts.

5. COVERAGE (do NOT skip unreachable-looking sinks): for every target sink you could
   not INJECT (its value is static/hardcoded, no user-input path), still drive the UI
   so the sink's code RUNS at least once - click the handler, open the view that
   renders it, navigate the route that executes it. Firing it emits a report the
   downstream pipeline needs to classify the sink. These count as "fired, no injection
   path", NOT as injected HITs. Only leave a sink untouched if you cannot make its code
   run at all through the UI. Report at the end which sinks were injected vs only fired.

STRATEGY: one injection often fires several sinks in the same file - inject broadly
(every relevant field/route/content), then check every sink each attempt. Separately,
make sure every remaining sink at least FIRES (step 5) so it is recorded.

{_INJECTION_TECHNIQUES}

{_INTEGRITY_RULES}

RECON SCRIPT (run with: {venv_python} <recon.py>; edit the URL as you learn more):
```python
import sys, json
sys.path.insert(0, {testing_root!r})
from agent_crawler.agent_helper import agent_browser, observe_page

with agent_browser({run_id!r}, storage_state={storage_state!r}, headless={headless}) as page:
    page.goto({base_url!r}, wait_until="domcontentloaded", timeout=15000)
    page.wait_for_timeout(2000)
    print(json.dumps(observe_page(page), indent=2)[:6000])
```

ATTEMPT SCRIPT (run with: {venv_python} <attempt.py>):
```python
import sys
sys.path.insert(0, {testing_root!r})
from agent_crawler.agent_helper import agent_browser, is_triggered, observe_page

DB = {reports_db_path!r}
CHECKPOINT = {checkpoint_id}
RUN_ID = {run_id!r}
PAYLOAD = {payload!r}
STORAGE_STATE = {storage_state!r}
TRACE = {trace_path!r}
SINK_KEYS = {sink_keys!r}

with agent_browser(RUN_ID, storage_state=STORAGE_STATE, headless={headless}, trace_path=TRACE) as page:
    page.goto({base_url!r}, wait_until="domcontentloaded", timeout=15000)
    page.wait_for_timeout(2000)
    hit = [k for k in SINK_KEYS if is_triggered(DB, k, CHECKPOINT, PAYLOAD)]
    print("HIT:", len(hit), "/", len(SINK_KEYS), hit)
    if not hit:
        state = observe_page(page)
        print("DIAG url:", state["url"])
        print("DIAG sink_script_loaded:", any({basename!r} in s for s in state["scripts"]))
        print("DIAG buttons:", [b.get("text") or b.get("id") for b in state["buttons"]][:20])
        print("DIAG inputs:", [i.get("id") or i.get("name") or i.get("placeholder") for i in state["inputs"]][:20])
```

RULES: app already running at {base_url}; never navigate to .js/.css URLs; for
[contenteditable] use focus()+keyboard, not fill(). The TRACE path must be set only
on the real ATTEMPT scripts (not recon), so injected payloads are recorded.

At the very end, output exactly one line:
{_RESULT_TRIGGERED}
{_RESULT_NOT_TRIGGERED}
"""


def run_cli_agent_group(
    sinks: list[dict[str, Any]],
    base_url: str,
    source_root: str,
    reports_db_path: str,
    project_root: str,
    venv_python: str,
    run_id: str,
    crawl_run_id: str,
    checkpoint_id: int,
    payload: str,
    run_dir: str,
    model: str = "haiku",
    max_turns: int = 12,
    timeout_secs: int = 300,
    auth_credentials: Optional[dict] = None,
    storage_state: Optional[str] = None,
    headless: bool = True,
    cache_context: Optional[dict[str, Any]] = None,
    max_budget_usd: float = 0.35,
) -> CliRunResult:
    """Run one sandboxed Claude agent for a same-source-file sink group."""
    work_dir = Path(run_dir) / run_id
    work_dir.mkdir(parents=True, exist_ok=True)
    trace_path = str(work_dir / "trace.jsonl")
    manifest_path = work_dir / "sink_manifest.json"
    testing_root = str((Path(project_root) / "testing").resolve())
    prompt = _build_group_prompt(
        sinks, base_url, source_root, reports_db_path, checkpoint_id,
        venv_python, payload, run_id, testing_root, trace_path, storage_state,
        headless, auth_credentials,
    )
    prompt += f"""

CRAWL RUN: {crawl_run_id}
Use agent_browser(RUN_ID, crawl_run_id={crawl_run_id!r}, ...) in every attempt.
OUTPUT LIMITS: source reads <=200 lines; searches <=100 matches; command output <=8KB;
DOM observation <=6KB; error output <=100 lines. Do not read whole minified bundles.
CACHED ANALYSIS (verify before use):
{json.dumps(cache_context or {}, ensure_ascii=False)[:8000]}

The `workflow` cache may come from another source file that uses the same application
screen. Reuse its authenticated URL, created post/page IDs, selectors and successful
actions. Do not repeat login or broad admin reconnaissance unless verification shows
that cached state is stale. Never repeat an action listed in `failed_actions` without
a materially different precondition or selector.

Before finishing, write {str(manifest_path)!r} as JSON with this exact shape:
{{"sinks": [{{"sink_key": "...", "disposition": "exhausted|pending",
"routes": ["..."], "actions": ["..."], "reason": "..."}}],
"analysis": {{"entry_urls": [], "authenticated_urls": [], "loaded_scripts": [],
"selectors": [], "actions": [], "created_content": {{"post_id": null,
"edit_url": null}}, "preconditions": [], "failed_actions": [],
"failure_reason": "", "failures": []}}}}
Only use exhausted after a real traced UI attempt. Omit no target sink.
"""
    logger.info("[cli] model=%s turns=%s group=%s", model, max_turns, run_id)
    output, status, error, usage = _run_claude(
        prompt, project_root, timeout_secs, model=model,
        max_turns=max_turns, work_dir=str(work_dir), max_budget_usd=max_budget_usd,
    )
    interactions, urls_visited, payloads, action_types = _summarize_trace(load_trace(trace_path))
    manifest: dict[str, Any] = {}
    try:
        loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            manifest = loaded
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return CliRunResult(
        triggered=False, payload=payload, agent_output=output, run_id=run_id,
        interactions=interactions, urls_visited=urls_visited, payloads=payloads,
        action_types=action_types, status=status, error=error, model=model,
        turns_budget=max_turns, actual_turns=int(usage.get("num_turns") or 0), usage=usage, manifest=manifest,
    )
