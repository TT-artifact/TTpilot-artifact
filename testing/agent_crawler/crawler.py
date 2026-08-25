"""Evidence-based, resumable orchestration for sandboxed agent crawls."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Optional

from playwright.sync_api import sync_playwright

from . import reachability
from .cli_runner import make_run_id, run_cli_agent_group, sandbox_preflight
from .payload import generate_payload
from .report_checker import count_agent_events, count_reports_with_payload, get_max_report_id, summarize_agent_reach
from .sink_loader import load_type3_sinks
from .state_store import AgentStateStore

logger = logging.getLogger(__name__)
PROMPT_VERSION = "agent-crawl-v2"
REACH_REACHABLE = "reachable"
REACH_FIRED_WITHOUT_PAYLOAD = "fired_without_payload"
REACH_NEVER_OBSERVED = "never_observed"
_LIMIT_MARKERS = (
    "session limit", "usage limit", "hit your limit", "you've hit your limit",
    "credit balance is too low", "out of extra usage",
)


def _crawl_run_id() -> str:
    return f"agent-crawl-{int(time.time() * 1000)}-{random.randint(0, 9999):04d}"


def _group_sinks(sinks: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    by_file: dict[str, list[dict[str, Any]]] = {}
    for sink in sinks:
        by_file.setdefault(sink["file"], []).append(sink)
    ordered = sorted(by_file.values(), key=lambda items: (_workflow_key(items[0]), items[0]["file"]))
    return [items[i:i + size] for items in ordered for i in range(0, len(items), size)]


def _workflow_key(sink: dict[str, Any]) -> str:
    """Coarse reusable UI workflow shared by otherwise file-scoped groups."""
    text = f"{sink.get('file', '')} {sink.get('kind', '')}".lower()
    rules = (
        ("tinymce", ("tinymce", "wplink")),
        ("elementor_editor", ("elementor", "editor", "widgets", "controls")),
        ("wordpress_media", ("media", "plupload", "upload", "attachment")),
        ("wordpress_plugin_theme", ("plugin-editor", "theme-editor")),
        ("wordpress_admin", ("wp-admin", "admin", "wp-includes")),
        ("frontend_preview", ("frontend", "preview", "assets/js/frontend")),
    )
    for name, markers in rules:
        if any(marker in text for marker in markers):
            return name
    return "generic"


@dataclass(frozen=True)
class AgentCrawlerConfig:
    base_url: str
    sinks_db_path: str
    reports_db_path: str
    source_root: str
    headless: bool = True
    auth_enabled: bool = False
    auth_type: Optional[str] = None
    auth_credentials: dict = field(default_factory=dict)
    max_workers: int = 3
    timeout_secs: int = 600
    project_root: str = ""
    venv_python: str = ""
    resume: bool = True
    group_size: int = 20
    model_fast: str = "haiku"
    model_escalation: str = "sonnet"
    max_turns: int = 20
    max_progress_turns: int = 32
    fast_turns: int = 20
    escalation_turns: int = 12
    fast_budget_usd: float = 0.75
    escalation_budget_usd: float = 1.50
    retry_timeouts: bool = False
    retry_stalled: bool = False


@dataclass(frozen=True)
class AgentResult:
    sink_key: str
    file: str
    line: int
    kind: str
    triggered: bool
    reach: str
    this_run: str
    provenance: str
    status: str
    payload: str = ""
    run_id: str = ""
    total_steps: int = 0
    urls_visited: tuple[str, ...] = ()
    actions_taken: int = 0
    action_types: dict[str, int] = field(default_factory=dict)
    interactions: tuple[dict, ...] = ()
    payloads: tuple[str, ...] = ()
    evidence: dict[str, Any] = field(default_factory=dict)
    model: str = ""
    attempts: int = 0
    last_error: str = ""


class AgentCrawler:
    def __init__(self, config: AgentCrawlerConfig) -> None:
        self.config = config
        self.project_root = config.project_root or os.getcwd()
        self.venv_python = config.venv_python or sys.executable
        self.out_dir = Path(config.reports_db_path).parent
        self.crawl_run_id = _crawl_run_id()
        self.run_dir = self.out_dir / "agent_runs" / self.crawl_run_id
        self.cache_dir = self.out_dir / "agent_cache"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / "traces").mkdir(exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.state = AgentStateStore(str(self.out_dir / "agent_crawl.db"))
        self.storage_state: Optional[str] = None
        self._reachability_hints: dict[str, dict[str, Any]] = {}
        self._abort_event = threading.Event()
        self._abort_lock = threading.Lock()
        self._abort_status = ""
        self._abort_reason = ""
        self._cache_lock = threading.RLock()

    def run(self) -> list[AgentResult]:
        sinks = load_type3_sinks(self.config.sinks_db_path)
        config_dict = asdict(self.config)
        config_dict["auth_credentials"] = {"configured": bool(self.config.auth_credentials)}
        self.state.begin_run(self.crawl_run_id, config_dict)
        self.state.migrate_attempted(str(self.out_dir / "attempted_sinks.txt"))
        try:
            ok, error = sandbox_preflight()
            if not ok:
                logger.error("[crawler] fail-closed preflight: %s", error)
                results = [self._infra_result(s, error) for s in sinks]
                self.state.finish_run(self.crawl_run_id, "infra_failed", error)
                return results
            ok, error = self._provenance_preflight()
            if not ok:
                logger.error("[crawler] provenance preflight: %s", error)
                results = [self._infra_result(s, error) for s in sinks]
                self.state.finish_run(self.crawl_run_id, "infra_failed", error)
                return results
            self.storage_state = self._prepare_storage_state()
            to_process, skipped = self._split_resumable(sinks)
            to_process, unreachable_results = self._filter_unreachable(sinks, to_process)
            results: list[AgentResult] = list(unreachable_results)
            groups = _group_sinks(to_process, self.config.group_size)
            with ThreadPoolExecutor(max_workers=self.config.max_workers) as executor:
                futures = {executor.submit(self._process_group, group): group for group in groups}
                for future in as_completed(futures):
                    group = futures[future]
                    try:
                        results.extend(future.result())
                    except Exception as ex:
                        logger.exception("[crawler] group failed: %s", group[0]["file"])
                        results.extend(self._infra_result(s, str(ex)) for s in group)
            results.extend(self._cumulative_result(s) for s in skipped)
            run_status = self._abort_status or "completed"
            run_error = self._abort_reason or None
            if self._abort_event.is_set():
                logger.warning(
                    "[crawler] queue stopped early status=%s reason=%s",
                    run_status, self._abort_reason,
                )
            self.state.finish_run(self.crawl_run_id, run_status, run_error)
            return sorted(results, key=lambda r: (r.file, r.line, r.sink_key))
        except Exception as ex:
            self.state.finish_run(self.crawl_run_id, "infra_failed", str(ex))
            raise

    def _split_resumable(self, sinks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        terminal = self.state.terminal_sinks() if self.config.resume else set()
        latest = self.state.latest_sink_states() if self.config.resume else {}
        process: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for sink in sinks:
            total, token, provenance = summarize_agent_reach(self.config.reports_db_path, sink["sink_key"])
            if token:
                if sink["sink_key"] not in terminal:
                    self.state.record_sink(sink["sink_key"], None, f"legacy-report:{sink['sink_key']}",
                                           "reachable", {"provenance": provenance})
                skipped.append(sink)
            elif sink["sink_key"] in terminal:
                skipped.append(sink)
            elif self._suppress_retry(latest.get(sink["sink_key"])):
                skipped.append(sink)
            else:
                process.append(sink)
        logger.info("[crawler] resume skip=%d process=%d", len(skipped), len(process))
        return process, skipped

    def _suppress_retry(self, latest: Optional[tuple[str, dict[str, Any]]]) -> bool:
        if not latest:
            return False
        status, evidence = latest
        if status == "timeout" and not self.config.retry_timeouts:
            return True
        if status == "turn_limited" and not self.config.retry_stalled:
            progress_fields = ("routes", "actions", "entry_urls", "selectors", "loaded_scripts")
            return not any(evidence.get(field) for field in progress_fields)
        return False

    def _filter_unreachable(
        self, all_sinks: list[dict[str, Any]], sinks: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[AgentResult]]:
        """Drop sinks whose source file is never loaded by the running app.

        Runs one browser-based reachability pass per crawl run (cached to disk
        by content hash), then skips agent work for any sink whose file was
        confirmed unreachable. Sinks in files that could not be confirmed
        (too few candidate pages checked) are left untouched - see
        :mod:`agent_crawler.reachability` for the conservative-by-design policy.

        ``all_sinks`` (the full, resume-independent sink set) determines the
        cache key so a partially-resumed run's smaller ``sinks`` subset does
        not force a fresh browser pass every time.
        """
        html_exts = (".html", ".htm")
        all_files = sorted({s["file"] for s in all_sinks if not s["file"].lower().endswith(html_exts)})
        if not all_files:
            return sinks, []
        seed_path = self.out_dir / "seed_urls.txt"
        cache_path = self.cache_dir / "reachability.json"
        try:
            data = reachability.load_or_compute(
                cache_path, self.config.source_root, self.config.base_url, all_files,
                seed_path if seed_path.exists() else None,
                headless=self.config.headless, storage_state=self.storage_state,
            )
        except Exception as ex:
            logger.warning("[crawler] reachability precheck failed, proceeding without it: %s", ex)
            return sinks, []
        file_info = data.get("files", {})
        self._reachability_hints = {f: i for f, i in file_info.items() if i.get("loaded")}
        kept: list[dict[str, Any]] = []
        unreachable: list[AgentResult] = []
        for sink in sinks:
            info = file_info.get(sink["file"])
            if info and info.get("loaded") is False:
                unreachable.append(self._unreachable_result(sink, data.get("candidate_urls", [])))
            else:
                kept.append(sink)
        if unreachable:
            logger.info(
                "[crawler] reachability precheck: %d/%d sinks confirmed unreachable (checked %d URLs), skipping agent",
                len(unreachable), len(sinks), len(data.get("candidate_urls", [])),
            )
        return kept, unreachable

    def _unreachable_result(self, sink: dict[str, Any], checked_urls: list[str]) -> AgentResult:
        self.state.record_sink(
            sink["sink_key"], self.crawl_run_id, f"reachability-precheck:{self.crawl_run_id}",
            "unreachable_static",
            {"checked_urls": checked_urls, "reason": "source file never requested by any checked page"},
        )
        base = self._cumulative_result(sink)
        return AgentResult(**{
            **asdict(base), "status": "unreachable_static",
            "last_error": f"reachability precheck: file not loaded by any of {len(checked_urls)} checked URLs",
        })

    def _cache_context(self, group: list[dict[str, Any]]) -> tuple[str, dict[str, Any], bool, Path]:
        src = self._source_path(group[0]["file"])
        digest = hashlib.sha256()
        digest.update(PROMPT_VERSION.encode())
        digest.update(self.config.base_url.encode())
        digest.update(str(self.config.auth_type).encode())
        if src.exists():
            digest.update(src.read_bytes())
        basename = src.name
        entry_files: list[str] = []
        for html in Path(self.config.source_root).rglob("*.html"):
            try:
                data = html.read_bytes()
            except OSError:
                continue
            if basename.encode() in data:
                digest.update(data)
                entry_files.append(str(html))
                if len(entry_files) >= 100:
                    break
        key = digest.hexdigest()
        path = self.cache_dir / f"{key}.json"
        context: dict[str, Any] = {}
        hit = False
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    context, hit = loaded, True
            except (OSError, json.JSONDecodeError):
                pass
        context.setdefault("entry_files", entry_files)
        workflow = _workflow_key(group[0])
        workflow_path = self.cache_dir / f"workflow-{workflow}.json"
        workflow_context: dict[str, Any] = {}
        with self._cache_lock:
            if workflow_path.exists():
                try:
                    loaded = json.loads(workflow_path.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        workflow_context = loaded
                except (OSError, json.JSONDecodeError):
                    pass
        context["workflow_key"] = workflow
        context["workflow"] = workflow_context
        hint = self._reachability_hints.get(group[0]["file"])
        if hint and hint.get("match_url"):
            confirmed_urls = [hint["match_url"], *workflow_context.get("entry_urls", [])]
            workflow_context["entry_urls"] = list(dict.fromkeys(confirmed_urls))
        self.state.register_cache(key, group[0]["file"], str(path), hit)
        return key, context, hit, path

    def _save_cache(self, cache_path: Path, cache: dict[str, Any]) -> None:
        workflow = str(cache.get("workflow_key") or "generic")
        workflow_path = self.cache_dir / f"workflow-{workflow}.json"
        with self._cache_lock:
            self._atomic_json(cache_path, cache)
            workflow_data = cache.get("workflow")
            if isinstance(workflow_data, dict):
                self._atomic_json(workflow_path, workflow_data)

    @staticmethod
    def _atomic_json(path: Path, value: dict[str, Any]) -> None:
        temporary = path.with_suffix(path.suffix + f".{threading.get_ident()}.tmp")
        temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path)

    @staticmethod
    def _merge_analysis(cache: dict[str, Any], analysis: Any) -> None:
        if not isinstance(analysis, dict):
            return
        workflow = cache.setdefault("workflow", {})
        for key in ("entry_urls", "authenticated_urls", "loaded_scripts", "selectors",
                    "actions", "preconditions", "failed_actions", "failures"):
            values = analysis.get(key)
            if isinstance(values, list):
                existing = workflow.setdefault(key, [])
                existing.extend(value for value in values if value not in existing)
        created = analysis.get("created_content")
        if isinstance(created, dict):
            workflow.setdefault("created_content", {}).update(
                {key: value for key, value in created.items() if value not in (None, "")}
            )
        failure_reason = analysis.get("failure_reason")
        if isinstance(failure_reason, str) and failure_reason:
            workflow["failure_reason"] = failure_reason
        cache.update(analysis)

    def _source_path(self, file_path: str) -> Path:
        candidate = Path(file_path)
        if candidate.is_absolute():
            try:
                candidate = candidate.relative_to(self.config.source_root)
            except ValueError:
                if "src" in candidate.parts:
                    candidate = Path(*candidate.parts[candidate.parts.index("src") + 1:])
        elif candidate.parts and candidate.parts[0] == "src":
            candidate = Path(*candidate.parts[1:])
        return Path(self.config.source_root) / candidate

    def _process_group(self, group: list[dict[str, Any]]) -> list[AgentResult]:
        if self._abort_event.is_set():
            return [self._aborted_result(s) for s in group]
        cache_key, cache, cache_hit, cache_path = self._cache_context(group)
        if self._abort_event.is_set():
            return [self._aborted_result(s) for s in group]
        fast = self._run_stage(group, self.config.model_fast,
                               min(self.config.fast_turns, self.config.max_turns),
                               cache_key, cache_hit, cache)
        analysis = fast.manifest.get("analysis") if isinstance(fast.manifest, dict) else None
        self._merge_analysis(cache, analysis)
        self._save_cache(cache_path, cache)
        observations = self._stage_observations(group, fast)
        unresolved = [
            s for s in group
            if observations[s["sink_key"]]["status"] in {"pending", "turn_limited"}
        ]
        final = fast
        fast_has_handoff = self._has_progress(fast)
        transcript = " ".join((fast.agent_output or "", fast.error or "")).lower()
        fast_has_infra_blocker = (
            "session-env" in transcript and ("erofs" in transcript or "read-only" in transcript)
        )
        if unresolved and not self._abort_event.is_set() and (
            fast.status == "completed"
            or (fast.status == "turn_limited" and fast_has_handoff)
        ) and not fast_has_infra_blocker:
            final = self._run_stage(
                unresolved, self.config.model_escalation,
                min(self.config.escalation_turns,
                    max(0, self.config.max_progress_turns - fast.turns_budget)),
                cache_key, True, cache,
            )
            self._merge_analysis(
                cache, final.manifest.get("analysis") if isinstance(final.manifest, dict) else None
            )
            self._save_cache(cache_path, cache)
            observations.update(self._stage_observations(unresolved, final, allow_exhausted=True))
        elif fast.status in {"completed", "turn_limited"}:
            observations.update(self._stage_observations(unresolved, fast, allow_exhausted=True))
        return [self._result_from_observation(s, observations[s["sink_key"]], fast, final) for s in group]

    @staticmethod
    def _has_progress(result) -> bool:
        if result.interactions or result.urls_visited:
            return True
        analysis = result.manifest.get("analysis") if isinstance(result.manifest, dict) else None
        if not isinstance(analysis, dict):
            return False
        fields = ("entry_urls", "authenticated_urls", "loaded_scripts", "selectors",
                  "actions", "created_content", "preconditions")
        return any(analysis.get(field) for field in fields)

    def _run_stage(self, sinks: list[dict[str, Any]], model: str, turns: int,
                   cache_key: str, cache_hit: bool, cache: dict[str, Any]):
        agent_run_id = make_run_id()
        payload = generate_payload(f"{sinks[0]['file']}#{agent_run_id}")
        self.state.begin_group(agent_run_id, self.crawl_run_id, sinks[0]["file"],
                               model, cache_key, cache_hit)
        result = run_cli_agent_group(
            sinks=sinks, base_url=self.config.base_url, source_root=self.config.source_root,
            reports_db_path=self.config.reports_db_path, project_root=self.project_root,
            venv_python=self.venv_python, run_id=agent_run_id,
            crawl_run_id=self.crawl_run_id, checkpoint_id=get_max_report_id(self.config.reports_db_path),
            payload=payload, run_dir=str(self.run_dir / "traces"), model=model,
            max_turns=turns, timeout_secs=self.config.timeout_secs,
            auth_credentials=self.config.auth_credentials if self.config.auth_enabled else None,
            storage_state=self.storage_state, headless=self.config.headless,
            cache_context=cache,
            max_budget_usd=(self.config.fast_budget_usd
                            if model == self.config.model_fast
                            else self.config.escalation_budget_usd),
        )
        status = result.status
        transcript = " ".join((result.agent_output or "", result.error or "")).lower()
        if any(marker in transcript for marker in _LIMIT_MARKERS):
            status = "usage_limited"
        self.state.finish_group(agent_run_id, status, (result.actual_turns or result.turns_budget), result.error)
        if status != result.status:
            result = replace(result, status=status)
        if status in {"usage_limited", "timeout"}:
            reason = result.error or (
                "Claude account/session usage limit reached"
                if status == "usage_limited" else "Claude CLI timed out"
            )
            self._request_abort(status, reason)
        return result

    def _request_abort(self, status: str, reason: str) -> None:
        """Stop starting paid work after a global limit or timeout is observed."""
        with self._abort_lock:
            if self._abort_event.is_set():
                return
            self._abort_status = status
            self._abort_reason = reason
            self._abort_event.set()
            logger.error("[crawler] stopping remaining queue: %s: %s", status, reason)

    def _provenance_preflight(self) -> tuple[bool, str]:
        """Fail before paid agent work when exact report attribution cannot work."""
        import sqlite3
        try:
            with sqlite3.connect(self.config.reports_db_path) as conn:
                columns = {
                    row[1] for row in conn.execute("PRAGMA table_info(agent_report_events)")
                }
        except sqlite3.Error as ex:
            return False, f"cannot inspect reports DB provenance schema: {ex}"
        required = {"event_id", "crawl_run_id", "agent_run_id", "sink_key", "value_preview"}
        missing = required - columns
        if missing:
            return False, f"agent_report_events schema missing: {sorted(missing)}"

        policy = self.out_dir / "runtime" / "tt-policy.js"
        try:
            policy_text = policy.read_text(encoding="utf-8")
        except OSError as ex:
            return False, f"cannot read runtime policy {policy}: {ex}"
        markers = ("__AGENT_RUN_ID", "__AGENT_CRAWL_RUN_ID", "agentCrawlRunId")
        absent = [marker for marker in markers if marker not in policy_text]
        if absent:
            return False, f"runtime policy lacks provenance markers: {absent}; regenerate policy"
        return True, ""

    def _stage_observations(self, sinks: list[dict[str, Any]], result,
                            allow_exhausted: bool = False) -> dict[str, dict[str, Any]]:
        manifest = {}
        if isinstance(result.manifest, dict):
            for item in result.manifest.get("sinks", []):
                if isinstance(item, dict) and isinstance(item.get("sink_key"), str):
                    manifest[item["sink_key"]] = item
        out: dict[str, dict[str, Any]] = {}
        records = []
        for sink in sinks:
            key = sink["sink_key"]
            hit = count_reports_with_payload(
                self.config.reports_db_path, key, 0, result.payload,
                agent_run_id=result.run_id, crawl_run_id=self.crawl_run_id,
            ) > 0
            fired = count_agent_events(
                self.config.reports_db_path, key, result.run_id, self.crawl_run_id
            ) > 0
            if not fired:
                self._warn_unattributed_report(key, result.run_id)
            evidence = manifest.get(key, {})
            if hit:
                status = "reachable"
            elif fired:
                status = "fired_without_payload"
            elif result.status != "completed":
                status = result.status
            elif allow_exhausted and self._valid_exhausted(evidence, result.interactions):
                status = "exhausted"
            else:
                status = "pending"
            records.append((key, self.crawl_run_id, result.run_id, status, evidence))
            out[key] = {"status": status, "evidence": evidence, "payload": result.payload,
                        "run_id": result.run_id, "model": result.model, "error": result.error}
        self.state.record_sinks(records)
        return out

    def _warn_unattributed_report(self, sink_key: str, agent_run_id: str) -> None:
        """Expose aggregate/event divergence without treating it as exact evidence."""
        import sqlite3
        try:
            with sqlite3.connect(self.config.reports_db_path) as conn:
                row = conn.execute(
                    "SELECT COUNT(*),COALESCE(SUM(count),0) FROM classify_reports "
                    "WHERE sink_key=? AND agent_run_id=?",
                    (sink_key, agent_run_id),
                ).fetchone()
        except sqlite3.Error as ex:
            logger.warning("[provenance] diagnostic query failed sink=%s: %s", sink_key, ex)
            return
        if row and row[0]:
            logger.error(
                "[provenance] aggregate report exists without exact event "
                "crawl_run=%s agent_run=%s sink=%s rows=%d hits=%d",
                self.crawl_run_id, agent_run_id, sink_key, row[0], row[1],
            )

    @staticmethod
    def _valid_exhausted(evidence: dict[str, Any], interactions: tuple[dict, ...]) -> bool:
        return bool(interactions and evidence.get("disposition") == "exhausted"
                    and evidence.get("reason") and (evidence.get("routes") or evidence.get("actions")))

    def _result_from_observation(self, sink: dict[str, Any], obs: dict[str, Any], first, final) -> AgentResult:
        cumulative_total, cumulative_token, provenance = summarize_agent_reach(
            self.config.reports_db_path, sink["sink_key"]
        )
        run_total, run_token, _ = summarize_agent_reach(
            self.config.reports_db_path, sink["sink_key"], crawl_run_id=self.crawl_run_id
        )
        reach = REACH_REACHABLE if cumulative_token else (
            REACH_FIRED_WITHOUT_PAYLOAD if cumulative_total else REACH_NEVER_OBSERVED
        )
        this_run = REACH_REACHABLE if run_token else (
            REACH_FIRED_WITHOUT_PAYLOAD if run_total else REACH_NEVER_OBSERVED
        )
        interactions = tuple(first.interactions) + (() if final is first else tuple(final.interactions))
        urls = tuple(dict.fromkeys((*first.urls_visited, *(() if final is first else final.urls_visited))))
        actions = dict(first.action_types)
        if final is not first:
            for name, count in final.action_types.items():
                actions[name] = actions.get(name, 0) + count
        return AgentResult(
            sink_key=sink["sink_key"], file=sink["file"], line=sink["line"], kind=sink["kind"],
            triggered=reach == REACH_REACHABLE, reach=reach, this_run=this_run,
            provenance=provenance, status=obs["status"], payload=obs["payload"],
            run_id=obs["run_id"], total_steps=(first.actual_turns or first.turns_budget) + (0 if final is first else (final.actual_turns or final.turns_budget)),
            urls_visited=urls, actions_taken=len(interactions), action_types=actions,
            interactions=interactions, payloads=tuple(dict.fromkeys((*first.payloads, *(() if final is first else final.payloads)))),
            evidence=obs["evidence"], model=obs["model"],
            attempts=self.state.attempts_for(sink["sink_key"]), last_error=obs["error"],
        )

    def _cumulative_result(self, sink: dict[str, Any]) -> AgentResult:
        total, token, provenance = summarize_agent_reach(self.config.reports_db_path, sink["sink_key"])
        reach = REACH_REACHABLE if token else (REACH_FIRED_WITHOUT_PAYLOAD if total else REACH_NEVER_OBSERVED)
        return AgentResult(sink_key=sink["sink_key"], file=sink["file"], line=sink["line"],
                           kind=sink["kind"], triggered=bool(token), reach=reach,
                           this_run=REACH_NEVER_OBSERVED, provenance=provenance,
                           status=reach, attempts=self.state.attempts_for(sink["sink_key"]))

    def _infra_result(self, sink: dict[str, Any], error: str) -> AgentResult:
        self.state.record_sink(sink["sink_key"], self.crawl_run_id,
                               f"infra:{self.crawl_run_id}:{sink['sink_key']}",
                               "infra_failed", {"error": error})
        base = self._cumulative_result(sink)
        return AgentResult(**{**asdict(base), "status": "infra_failed", "last_error": error})

    def _aborted_result(self, sink: dict[str, Any]) -> AgentResult:
        """Keep unstarted sinks retryable without creating a false failed attempt."""
        base = self._cumulative_result(sink)
        return AgentResult(**{
            **asdict(base),
            "status": "pending",
            "last_error": f"queue stopped before launch: {self._abort_status}: {self._abort_reason}",
        })

    def _prepare_storage_state(self) -> Optional[str]:
        if not self.config.auth_enabled:
            return None
        path = str(self.run_dir / "storage_state.json")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=self.config.headless)
            context = browser.new_context()
            page = context.new_page()
            try:
                from basic_crawler.auth import auth_api, auth_form, auth_oauth_popup
                auth_fn = {
                    "form": auth_form, "api": auth_api, "oauth_popup": auth_oauth_popup,
                }.get(self.config.auth_type)
                if auth_fn is None:
                    raise RuntimeError(f"unsupported auth_type: {self.config.auth_type!r}")
                if not auth_fn(page, self.config.auth_credentials):
                    raise RuntimeError("authentication failed")
                context.storage_state(path=path)
                return path
            finally:
                context.close()
                browser.close()
