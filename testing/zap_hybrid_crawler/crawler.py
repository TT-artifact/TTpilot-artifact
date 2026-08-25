from __future__ import annotations

import logging
import hashlib
import json
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

import requests

from basic_crawler import CrawlConfig, CrawlStats
from basic_crawler.url_utils import is_same_origin, normalize_url
from zap_crawler.auth import AuthMaterial, apply_auth, prepare_auth
from .zap_manager import HybridZapManager

from .client_api import ClientSpiderAPI

logger = logging.getLogger(__name__)

REPORT_SERVER_URL = "http://localhost:9000/tt-report/stats"
REPORT_SERVER_AUTHORITY = "localhost:9000"

_STATIC_SUFFIXES = {
    ".7z", ".avi", ".bmp", ".css", ".eot", ".flac", ".gif", ".gz",
    ".ico", ".jpeg", ".jpg", ".js", ".map", ".mkv", ".mov", ".mp3",
    ".mp4", ".mpeg", ".ogg", ".otf", ".pdf", ".png", ".svg", ".tar",
    ".tif", ".tiff", ".ttf", ".wav", ".webm", ".webp", ".woff",
    ".woff2", ".zip",
}

@dataclass(frozen=True)
class HybridZapConfig:
    spider_max_duration_sec: int
    client_max_duration_sec: int
    max_crawl_depth: int = 0
    max_children: int = 0
    spider_max_depth: int = 5
    spider_max_children: int = 10
    number_of_browsers: int = 1
    initial_load_time_sec: int = 0
    page_load_time_sec: int = 0
    action_wait_time_sec: int = 0
    shutdown_time_sec: int = 10
    scope_check: str = "STRICT"
    logout_avoidance: bool = True
    explicit_seed_grace_sec: int = 5
    preparation_script: str | None = None
    client_scan_max_duration_sec: int = 600
    client_restart_every_scans: int = 25
    progress_interval_sec: int = 30
    zap_max_heap_mb: int = 4096
    zap_memory_limit_mb: int = 8192
    zap_pids_limit: int = 2048
    client_workers: int = 1

    def __post_init__(self) -> None:
        if self.spider_max_duration_sec < 0:
            raise ValueError("spider_max_duration_sec must be zero (unlimited) or positive")
        if self.client_max_duration_sec < 0:
            raise ValueError("client_max_duration_sec must be zero (unlimited) or positive")
        if self.client_scan_max_duration_sec <= 0:
            raise ValueError("client_scan_max_duration_sec must be greater than zero")
        if self.client_restart_every_scans <= 0:
            raise ValueError("client_restart_every_scans must be greater than zero")
        if self.progress_interval_sec <= 0:
            raise ValueError("progress_interval_sec must be greater than zero")
        if self.spider_max_depth < 0:
            raise ValueError("spider_max_depth must be zero (unlimited) or positive")
        if self.spider_max_children < 0:
            raise ValueError("spider_max_children must be zero (unlimited) or positive")
        if min(self.zap_max_heap_mb, self.zap_memory_limit_mb, self.zap_pids_limit) <= 0:
            raise ValueError("ZAP resource limits must be greater than zero")
        if self.client_workers <= 0:
            raise ValueError("client_workers must be greater than zero")

@dataclass
class PhaseStats:
    name: str
    unique_urls: int = 0
    requests: int = 0
    elapsed_sec: float = 0.0
    unique_sinks: int | None = 0
    unique_reports: int | None = 0
    total_reports: int | None = 0
    timed_out: bool = False
    urls: list[str] = field(default_factory=list)
    scans_started: int = 0
    scan_failures: int = 0
    scans_completed: int = 0
    scans_retried: int = 0
    scan_timeouts: int = 0
    zap_restarts: int = 0
    source_counts: dict[str, int] = field(default_factory=dict)

@dataclass
class HybridCrawlResult:
    traditional_spider: PhaseStats
    client_spider: PhaseStats
    combined: CrawlStats
    source_counts: dict[str, int]

@dataclass(frozen=True)
class _ReportSnapshot:
    sinks: int
    unique: int
    total: int

@dataclass(frozen=True)
class _AttemptResult:
    completed: bool
    timed_out: bool
    retryable: bool
    requests: int = 0
    urls: tuple[str, ...] = ()

def is_client_document_url(url: str, base_url: str) -> bool:

    if not is_same_origin(url, base_url):
        return False
    parsed = urlparse(url)
    path = parsed.path.lower()
    if path.endswith("/tt-bootstrap.js") or path.startswith("/tt-report"):
        return False
    return Path(path).suffix.lower() not in _STATIC_SUFFIXES

def build_client_queue(
    base_url: str, discovered_urls: list[str], explicit_seeds: list[str]
) -> list[tuple[str, str]]:

    queue: list[tuple[str, str]] = []
    normal_seen: set[str] = set()

    def add_normal(url: str, source: str) -> None:
        if not is_client_document_url(url, base_url):
            return
        normalized = normalize_url(url)
        if normalized not in normal_seen:
            normal_seen.add(normalized)
            queue.append((url, source))

    add_normal(base_url, "base")
    for url in discovered_urls:
        add_normal(url, "discovered")

    seed_seen: set[str] = set()
    for url in explicit_seeds:
        if not is_client_document_url(url, base_url):
            continue
        normalized = normalize_url(url)
        if normalized not in seed_seen:
            seed_seen.add(normalized)
            queue.append((url, "explicit_seed"))
    return queue

def round_robin_shards(
    queue: list[tuple[str, str]], workers: int
) -> list[list[tuple[str, str]]]:

    shards: list[list[tuple[str, str]]] = [[] for _ in range(workers)]
    for i, item in enumerate(queue):
        shards[i % workers].append(item)
    return shards

class HybridZapCrawler:
    def __init__(
        self,
        config: CrawlConfig,
        hybrid: HybridZapConfig,
        *,
        zap_port: int = 8090,
        api_key: str | None = None,
        zap_image: str = "zap-hybrid-chrome",
        browser_id: str = "chrome-headless",
        checkpoint_path: str | Path | None = None,
        resume: bool = False,
        checkpoint_scope: str | None = None,
    ) -> None:
        self.config = config
        self.hybrid = hybrid
        self.zap_port = zap_port
        self.api_key = api_key
        self.zap_image = zap_image
        self.browser_id = browser_id
        self.checkpoint_path = Path(checkpoint_path) if checkpoint_path else None
        self.resume = resume
        self.checkpoint_scope = checkpoint_scope
        self._active_api: ClientSpiderAPI | None = None
        self._active_scan_id: str | None = None

    def crawl(self, *, traditional_only: bool = False) -> HybridCrawlResult:
        overall_start = time.time()
        auth_before = self._report_snapshot()
        auth_material = prepare_auth(self.config)
        auth_after = self._report_snapshot()

        checkpoint = self._load_checkpoint() if self.resume else None
        if checkpoint:
            queue = [(str(url), str(source)) for url, source in checkpoint["queue"]]
            fingerprint = self._queue_fingerprint(queue)
            if checkpoint.get("fingerprint") != fingerprint:
                raise ValueError("Hybrid ZAP checkpoint does not match the current target/options")
            traditional = self._phase_from_dict(checkpoint["traditional"])
            initial = self._shift_snapshot_for_auth(
                self._snapshot_from_dict(checkpoint.get("initial_report")),
                auth_before,
                auth_after,
            )
            after_traditional = self._shift_snapshot_for_auth(
                self._snapshot_from_dict(checkpoint.get("client_baseline")),
                auth_before,
                auth_after,
            )
            checkpoint["initial_report"] = self._snapshot_dict(initial)
            checkpoint["client_baseline"] = self._snapshot_dict(after_traditional)
            checkpoint["overall_elapsed_sec"] = float(
                checkpoint.get("overall_elapsed_sec", 0.0)
            ) + (time.time() - overall_start)
            self._write_checkpoint(checkpoint)
            logger.info(
                "[client] resuming checkpoint at %d/%d",
                int(checkpoint.get("next_index", 0)),
                len(queue),
            )
        else:
            initial = auth_after
            manager = self._new_manager()
            with manager as zap:
                apply_auth(zap, auth_material)
                self._configure_passthrough(zap, manager.api_key)
                traditional = self._run_traditional(zap)
            after_traditional = self._report_snapshot()
            self._set_report_delta(traditional, initial, after_traditional)
            queue = build_client_queue(
                self.config.base_url,
                traditional.urls,
                self.config.seed_urls,
            )
            checkpoint = self._initial_checkpoint(
                queue, traditional, initial, after_traditional
            )
            checkpoint["overall_elapsed_sec"] = time.time() - overall_start
            self._write_checkpoint(checkpoint)

        if traditional_only:
            combined = CrawlStats(
                pages_visited=traditional.unique_urls,
                elapsed_sec=float(checkpoint.get("overall_elapsed_sec", 0.0)),
                reports_collected=self._delta_value(initial, after_traditional, "total"),
                unique_reports_collected=self._delta_value(initial, after_traditional, "unique"),
                unique_sinks_collected=self._delta_value(initial, after_traditional, "sinks"),
                unique_urls_discovered=traditional.unique_urls,
                requests_made=traditional.requests,
                visited_urls=traditional.urls,
            )
            return HybridCrawlResult(
                traditional, PhaseStats(name="client_spider"), combined, {}
            )

        run_client = (
            self._run_client_chunks_parallel
            if self.hybrid.client_workers > 1
            else self._run_client_chunks
        )
        client = run_client(
            queue,
            auth_material,
            checkpoint,
            overall_start=overall_start,
        )
        after_client = self._report_snapshot()
        self._set_report_delta(client, after_traditional, after_client)

        all_urls = sorted(set(traditional.urls) | set(client.urls))
        combined = CrawlStats(
            pages_visited=len(all_urls),
            elapsed_sec=float(checkpoint.get("overall_elapsed_sec", 0.0)),
            reports_collected=self._delta_value(initial, after_client, "total"),
            unique_reports_collected=self._delta_value(initial, after_client, "unique"),
            unique_sinks_collected=self._delta_value(initial, after_client, "sinks"),
            unique_urls_discovered=len(all_urls),
            requests_made=traditional.requests + client.requests,
            visited_urls=all_urls,
        )
        checkpoint["completed"] = True
        checkpoint["client"] = asdict(client)
        checkpoint["combined"] = asdict(combined)
        self._write_checkpoint(checkpoint)
        return HybridCrawlResult(traditional, client, combined, dict(client.source_counts))

    def _new_manager(self, worker_id: int = 0) -> HybridZapManager:
        scan_duration_min = max(
            1, math.ceil(self.hybrid.client_scan_max_duration_sec / 60)
        )
        return HybridZapManager(
            api_key=self.api_key,
            zap_port=self.zap_port + worker_id,
            zap_image=self.zap_image,
            max_heap_mb=self.hybrid.zap_max_heap_mb,
            memory_limit_mb=self.hybrid.zap_memory_limit_mb,
            pids_limit=self.hybrid.zap_pids_limit,
            internal_proxy_port=9999 + worker_id,
            client_options={
                "initialLoadTime": self.hybrid.initial_load_time_sec,
                "pageLoadTime": self.hybrid.page_load_time_sec,
                "actionWaitTime": self.hybrid.action_wait_time_sec,
                "shutdownTime": self.hybrid.shutdown_time_sec,
                "maxChildren": self.hybrid.max_children,
                "maxDuration": scan_duration_min,
                "logoutAvoidance": self.hybrid.logout_avoidance,
            },
        )

    def _run_traditional(self, zap) -> PhaseStats:
        stats = PhaseStats(name="traditional_spider")
        start = time.time()
        deadline = (
            math.inf
            if self.hybrid.spider_max_duration_sec == 0
            else start + self.hybrid.spider_max_duration_sec
        )

        if self.hybrid.spider_max_depth > 0:
            try:
                zap.spider.set_option_max_depth(self.hybrid.spider_max_depth)
            except Exception as exc:
                logger.warning("Failed to set spider max depth to %d: %s", self.hybrid.spider_max_depth, exc)
        if self.hybrid.spider_max_children > 0:
            try:
                zap.spider.set_option_max_children(self.hybrid.spider_max_children)
            except Exception as exc:
                logger.warning("Failed to set spider max children to %d: %s", self.hybrid.spider_max_children, exc)
        start_requests = self._request_count(zap)
        seeds = list(dict.fromkeys([self.config.base_url, *self.config.seed_urls]))
        scan_urls: set[str] = set()

        for seed in seeds:
            if time.time() >= deadline:
                stats.timed_out = True
                break
            try:
                scan_id = str(zap.spider.scan(seed, recurse=True, subtreeonly=False))
                stats.scans_started += 1
                while True:
                    if time.time() >= deadline:
                        stats.timed_out = True
                        try:
                            zap.spider.stop(scan_id)
                        except Exception:
                            zap.spider.stop_all_scans()
                        break
                    status = int(zap.spider.status(scan_id))
                    if status >= 100:
                        break
                    time.sleep(1)
                try:
                    scan_urls.update(zap.spider.results(scan_id) or [])
                except Exception:
                    pass
            except Exception as exc:
                stats.scan_failures += 1
                logger.warning("Traditional Spider failed for %s: %s", seed, exc)

        core_urls = self._core_urls(zap)
        stats.urls = sorted(scan_urls | set(core_urls))
        stats.unique_urls = len(stats.urls)
        stats.requests = max(0, self._request_count(zap) - start_requests)
        stats.elapsed_sec = time.time() - start
        return stats

    def _run_client_worker(
        self,
        *,
        worker_id: int,
        worker_queue: list[tuple[str, str]],
        auth_material: AuthMaterial | None,
        phase_start: float,
        deadline: float,
        overall_start: float,
        state: dict,
        save_state: Callable[[dict], None],
    ) -> PhaseStats:

        stats = self._phase_from_dict(
            state.get("client", {"name": "client_spider"})
        )
        prior_elapsed = stats.elapsed_sec
        index = int(state.get("next_index", 0))
        retry_pending = bool(state.get("retry_pending", False))
        manager_started = False
        label = f"client w{worker_id}"

        def save_checkpoint() -> None:
            stats.elapsed_sec = prior_elapsed + (time.time() - phase_start)
            state["client"] = asdict(stats)
            save_state(state)

        while index < len(worker_queue):
            manager = self._new_manager(worker_id)
            if manager_started:
                stats.zap_restarts += 1
                logger.info("[%s] restarting ZAP (restart=%d)", label, stats.zap_restarts)
            manager_started = True
            finalized_in_chunk = 0
            restart_for_retry = False

            with manager as zap:
                apply_auth(zap, auth_material)
                self._configure_passthrough(zap, manager.api_key)
                api = ClientSpiderAPI(manager.zap_port, manager.api_key)
                api.validate()
                api.configure(
                    max_children=self.hybrid.max_children,
                    max_duration_min=max(
                        1,
                        math.ceil(self.hybrid.client_scan_max_duration_sec / 60),
                    ),
                    logout_avoidance=self.hybrid.logout_avoidance,
                )
                self._load_preparation_script(zap)

                while (
                    index < len(worker_queue)
                    and finalized_in_chunk < self.hybrid.client_restart_every_scans
                ):
                    url, source = worker_queue[index]
                    if time.time() >= deadline and source != "explicit_seed":
                        stats.timed_out = True
                        index += 1
                        state["next_index"] = index
                        state["retry_pending"] = False
                        save_checkpoint()
                        continue

                    attempt = 2 if retry_pending else 1
                    state.update(
                        current_index=index,
                        current_url=url,
                        current_source=source,
                        current_attempt=attempt,
                        last_status="running",
                    )
                    save_checkpoint()
                    try:
                        result = self._run_client_attempt(
                            zap,
                            api,
                            url=url,
                            source=source,
                            index=index,
                            total=len(worker_queue),
                            attempt=attempt,
                            phase_start=phase_start,
                            overall_start=overall_start,
                            label=label,
                        )
                    except BaseException:
                        state["last_status"] = "interrupted"
                        save_checkpoint()
                        raise
                    stats.scans_started += 1
                    stats.requests += result.requests
                    stats.urls = sorted(set(stats.urls) | set(result.urls))
                    stats.unique_urls = len(stats.urls)
                    if result.timed_out:
                        stats.scan_timeouts += 1

                    if result.completed:
                        stats.scans_completed += 1
                    elif result.retryable and not retry_pending:
                        stats.scans_retried += 1
                        retry_pending = True
                        restart_for_retry = True
                        state["retry_pending"] = True
                        state["last_status"] = (
                            "timeout_retry_pending"
                            if result.timed_out
                            else "failure_retry_pending"
                        )
                        save_checkpoint()
                        logger.warning(
                            "[%s %d/%d] retrying after fresh ZAP: %s",
                            label,
                            index + 1,
                            len(worker_queue),
                            url,
                        )
                        break
                    else:
                        stats.scan_failures += 1

                    state["last_status"] = (
                        "completed" if result.completed else "failed"
                    )

                    stats.source_counts[source] = stats.source_counts.get(source, 0) + 1
                    index += 1
                    finalized_in_chunk += 1
                    retry_pending = False
                    state["next_index"] = index
                    state["retry_pending"] = False
                    save_checkpoint()

                stats.urls = sorted(set(stats.urls) | set(self._core_urls(zap)))
                stats.unique_urls = len(stats.urls)
                save_checkpoint()

            if restart_for_retry:
                continue
            if index < len(worker_queue):
                logger.info(
                    "[%s] chunk complete: processed=%d next=%d/%d",
                    label,
                    finalized_in_chunk,
                    index + 1,
                    len(worker_queue),
                )

        stats.elapsed_sec = prior_elapsed + (time.time() - phase_start)
        state["next_index"] = index
        state["retry_pending"] = False
        save_checkpoint()
        return stats

    def _run_client_chunks(
        self,
        queue: list[tuple[str, str]],
        auth_material: AuthMaterial | None,
        checkpoint: dict,
        *,
        overall_start: float,
    ) -> PhaseStats:
        phase_start = time.time()
        deadline = (
            math.inf
            if self.hybrid.client_max_duration_sec == 0
            else phase_start + self.hybrid.client_max_duration_sec
        )
        prior_overall = float(checkpoint.get("overall_elapsed_sec", 0.0))

        def save_state(state: dict) -> None:
            checkpoint["overall_elapsed_sec"] = prior_overall + (
                time.time() - phase_start
            )
            self._write_checkpoint(checkpoint)

        stats = self._run_client_worker(
            worker_id=0,
            worker_queue=queue,
            auth_material=auth_material,
            phase_start=phase_start,
            deadline=deadline,
            overall_start=overall_start,
            state=checkpoint,
            save_state=save_state,
        )
        traditional_urls = set(checkpoint.get("traditional", {}).get("urls", []))
        stats.urls = sorted(set(stats.urls) - traditional_urls)
        stats.unique_urls = len(stats.urls)
        return stats

    def _run_client_chunks_parallel(
        self,
        queue: list[tuple[str, str]],
        auth_material: AuthMaterial | None,
        checkpoint: dict,
        *,
        overall_start: float,
    ) -> PhaseStats:
        workers = self.hybrid.client_workers
        shards = round_robin_shards(queue, workers)

        phase_start = time.time()
        deadline = (
            math.inf
            if self.hybrid.client_max_duration_sec == 0
            else phase_start + self.hybrid.client_max_duration_sec
        )
        prior_overall = float(checkpoint.get("overall_elapsed_sec", 0.0))
        checkpoint.setdefault("workers", {})
        write_lock = threading.Lock()

        def save_worker_state(worker_key: str, state: dict) -> None:
            with write_lock:
                checkpoint["workers"][worker_key] = state
                checkpoint["overall_elapsed_sec"] = prior_overall + (
                    time.time() - phase_start
                )
                self._write_checkpoint(checkpoint)

        def run_worker(worker_id: int) -> PhaseStats:
            worker_key = str(worker_id)
            state = dict(checkpoint["workers"].get(worker_key, {}))
            return self._run_client_worker(
                worker_id=worker_id,
                worker_queue=shards[worker_id],
                auth_material=auth_material,
                phase_start=phase_start,
                deadline=deadline,
                overall_start=overall_start,
                state=state,
                save_state=lambda s, key=worker_key: save_worker_state(key, s),
            )

        combined = PhaseStats(name="client_spider")
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(run_worker, i): i for i in range(workers)}
            for future in as_completed(futures):
                worker_id = futures[future]
                try:
                    worker_stats = future.result()
                except Exception:
                    logger.exception("[client w%d] worker failed", worker_id)
                    continue
                combined.requests += worker_stats.requests
                combined.urls = sorted(set(combined.urls) | set(worker_stats.urls))
                combined.scans_started += worker_stats.scans_started
                combined.scan_failures += worker_stats.scan_failures
                combined.scans_completed += worker_stats.scans_completed
                combined.scans_retried += worker_stats.scans_retried
                combined.scan_timeouts += worker_stats.scan_timeouts
                combined.zap_restarts += worker_stats.zap_restarts
                combined.timed_out = combined.timed_out or worker_stats.timed_out
                for source, count in worker_stats.source_counts.items():
                    combined.source_counts[source] = (
                        combined.source_counts.get(source, 0) + count
                    )

        combined.elapsed_sec = time.time() - phase_start
        traditional_urls = set(checkpoint.get("traditional", {}).get("urls", []))
        combined.urls = sorted(set(combined.urls) - traditional_urls)
        combined.unique_urls = len(combined.urls)
        checkpoint["overall_elapsed_sec"] = prior_overall + (time.time() - phase_start)
        self._write_checkpoint(checkpoint)
        return combined

    def _run_client_attempt(
        self,
        zap,
        api: ClientSpiderAPI,
        *,
        url: str,
        source: str,
        index: int,
        total: int,
        attempt: int,
        phase_start: float,
        overall_start: float,
        label: str = "client",
    ) -> _AttemptResult:
        scan_start = time.time()
        start_requests = self._request_count(zap)
        start_urls = set(self._core_urls(zap))
        start_reports = self._report_snapshot()
        next_progress = scan_start + self.hybrid.progress_interval_sec
        scan_id: str | None = None
        logger.info(
            "[%s %d/%d] start chunk_attempt=%d source=%s url=%s",
            label,
            index + 1,
            total,
            attempt,
            source,
            url,
        )
        try:
            scan_id = api.scan(
                url=url,
                browser=self.browser_id,
                max_crawl_depth=self.hybrid.max_crawl_depth,
                page_load_time=self.hybrid.page_load_time_sec,
                number_of_browsers=self.hybrid.number_of_browsers,
                scope_check=self.hybrid.scope_check,
            )
            self._active_api = api
            self._active_scan_id = scan_id
            while True:
                status = api.status(scan_id)
                now = time.time()
                if status >= 100:
                    end_reports = self._report_snapshot()
                    logger.info(
                        "[%s %d/%d] done status=%d elapsed=%.1fs requests=%d reports=%s",
                        label,
                        index + 1,
                        total,
                        status,
                        now - scan_start,
                        max(0, self._request_count(zap) - start_requests),
                        self._delta_value(start_reports, end_reports, "total"),
                    )
                    return self._attempt_result(
                        zap, start_requests, start_urls, completed=True
                    )
                if now - scan_start >= self.hybrid.client_scan_max_duration_sec:
                    api.stop(scan_id)
                    logger.warning(
                        "[%s %d/%d] timeout after %.1fs: %s",
                        label,
                        index + 1,
                        total,
                        now - scan_start,
                        url,
                    )
                    return self._attempt_result(
                        zap,
                        start_requests,
                        start_urls,
                        completed=False,
                        timed_out=True,
                        retryable=True,
                    )
                if now >= next_progress:
                    current_reports = self._report_snapshot()
                    logger.info(
                        "[%s %d/%d] running status=%d scan=%.1fs phase=%.1fs overall=%.1fs requests=%d reports=%s",
                        label,
                        index + 1,
                        total,
                        status,
                        now - scan_start,
                        now - phase_start,
                        now - overall_start,
                        max(0, self._request_count(zap) - start_requests),
                        self._delta_value(start_reports, current_reports, "total"),
                    )
                    next_progress = now + self.hybrid.progress_interval_sec
                time.sleep(1)
        except BaseException as exc:
            if not isinstance(exc, Exception):
                if scan_id is not None:
                    try:
                        api.stop(scan_id)
                    except Exception:
                        pass
                raise
            retryable = getattr(exc, "retryable", True)
            logger.warning(
                "[%s %d/%d] failed attempt=%d retryable=%s url=%s error=%s",
                label,
                index + 1,
                total,
                attempt,
                retryable,
                url,
                exc,
            )
            return self._attempt_result(
                zap,
                start_requests,
                start_urls,
                completed=False,
                retryable=retryable,
            )
        finally:
            self._active_api = None
            self._active_scan_id = None

    def _attempt_result(
        self,
        zap,
        start_requests: int,
        start_urls: set[str],
        *,
        completed: bool,
        timed_out: bool = False,
        retryable: bool = False,
    ) -> _AttemptResult:
        return _AttemptResult(
            completed=completed,
            timed_out=timed_out,
            retryable=retryable,
            requests=max(0, self._request_count(zap) - start_requests),
            urls=tuple(sorted(set(self._core_urls(zap)) - start_urls)),
        )

    def _queue_fingerprint(self, queue: list[tuple[str, str]]) -> str:
        payload = {
            "target": self.checkpoint_scope,
            "base_url": self.config.base_url,
            "seed_urls": list(self.config.seed_urls),
            "queue": queue,
            "browser_id": self.browser_id,
            "hybrid": asdict(self.hybrid),
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()

    def _initial_checkpoint(
        self,
        queue: list[tuple[str, str]],
        traditional: PhaseStats,
        initial: _ReportSnapshot | None,
        client_baseline: _ReportSnapshot | None,
    ) -> dict:
        return {
            "version": 1,
            "completed": False,
            "fingerprint": self._queue_fingerprint(queue),
            "queue": queue,
            "next_index": 0,
            "retry_pending": False,
            "current_index": None,
            "current_url": None,
            "current_source": None,
            "current_attempt": None,
            "last_status": "pending",
            "traditional": asdict(traditional),
            "client": asdict(PhaseStats(name="client_spider")),
            "initial_report": self._snapshot_dict(initial),
            "client_baseline": self._snapshot_dict(client_baseline),
        }

    def _load_checkpoint(self) -> dict:
        if self.checkpoint_path is None:
            raise ValueError("--resume requires a checkpoint path")
        if not self.checkpoint_path.is_file():
            raise FileNotFoundError(f"Hybrid ZAP checkpoint not found: {self.checkpoint_path}")
        return json.loads(self.checkpoint_path.read_text(encoding="utf-8"))

    def _write_checkpoint(self, checkpoint: dict) -> None:
        if self.checkpoint_path is None:
            return
        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.checkpoint_path.with_suffix(
            self.checkpoint_path.suffix + ".tmp"
        )
        temporary.write_text(
            json.dumps(checkpoint, sort_keys=True, indent=2),
            encoding="utf-8",
        )
        temporary.replace(self.checkpoint_path)

    @staticmethod
    def _phase_from_dict(data: dict) -> PhaseStats:
        fields = PhaseStats.__dataclass_fields__
        values = {key: value for key, value in data.items() if key in fields}
        return PhaseStats(**values)

    @staticmethod
    def _snapshot_dict(snapshot: _ReportSnapshot | None) -> dict | None:
        return asdict(snapshot) if snapshot is not None else None

    @staticmethod
    def _snapshot_from_dict(data: dict | None) -> _ReportSnapshot | None:
        return _ReportSnapshot(**data) if data is not None else None

    def _shift_snapshot_for_auth(
        self,
        stored: _ReportSnapshot | None,
        before: _ReportSnapshot | None,
        after: _ReportSnapshot | None,
    ) -> _ReportSnapshot | None:
        if stored is None or before is None or after is None:
            return stored
        return _ReportSnapshot(
            sinks=stored.sinks + self._delta_value(before, after, "sinks"),
            unique=stored.unique + self._delta_value(before, after, "unique"),
            total=stored.total + self._delta_value(before, after, "total"),
        )

    def _configure_passthrough(self, zap, api_key: str) -> None:
        try:
            zap.network.add_pass_through(REPORT_SERVER_AUTHORITY, apikey=api_key)
        except Exception:
            zap.core.exclude_from_proxy("http://localhost:9000.*", apikey=api_key)
        try:
            zap.core.exclude_from_proxy(".*tt-bootstrap\\.js$", apikey=api_key)
        except Exception:
            logger.warning("Could not exclude tt-bootstrap.js from the proxy")

    def _load_preparation_script(self, zap) -> None:
        script = self.hybrid.preparation_script
        if not script:
            return
        path = Path(script).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Preparation script not found: {path}")
        try:
            zap.script.load(
                path.stem,
                "selenium",
                "ECMAScript : Graal.js",
                str(path),
            )
            zap.script.enable(path.stem)
        except Exception as exc:
            raise RuntimeError(f"Failed to load Selenium preparation script: {path}") from exc

    @staticmethod
    def _request_count(zap) -> int:
        try:
            return int(zap.core.number_of_messages() or 0)
        except Exception:
            return 0

    def _core_urls(self, zap) -> list[str]:
        try:
            return list(zap.core.urls(baseurl=self.config.base_url) or [])
        except Exception:
            return []

    @staticmethod
    def _report_snapshot() -> _ReportSnapshot | None:
        try:
            response = requests.get(REPORT_SERVER_URL, timeout=5)
            response.raise_for_status()
            data = response.json()
            classify = data.get("classify", {})
            violation = data.get("violation", {})
            return _ReportSnapshot(
                sinks=int(data.get("unique_sinks", 0)),
                unique=int(classify.get("total", 0)) + int(violation.get("total", 0)),
                total=int(classify.get("total_hits", 0)) + int(violation.get("total_hits", 0)),
            )
        except Exception as exc:
            logger.warning("Report snapshot failed: %s", exc)
            return None

    @staticmethod
    def _delta_value(
        before: _ReportSnapshot | None,
        after: _ReportSnapshot | None,
        field_name: str,
    ) -> int | None:
        if before is None or after is None:
            return None
        return max(0, getattr(after, field_name) - getattr(before, field_name))

    def _set_report_delta(
        self,
        stats: PhaseStats,
        before: _ReportSnapshot | None,
        after: _ReportSnapshot | None,
    ) -> None:
        stats.unique_sinks = self._delta_value(before, after, "sinks")
        stats.unique_reports = self._delta_value(before, after, "unique")
        stats.total_reports = self._delta_value(before, after, "total")
