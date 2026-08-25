import logging
import math
import time
from typing import Optional

import requests
from zapv2 import ZAPv2

from basic_crawler import CrawlConfig, CrawlStats
from .auth import setup_auth
from .zap_manager import ZapManager

logger = logging.getLogger(__name__)

REPORT_SERVER_URL = "http://localhost:9000/tt-report/stats"
REPORT_SERVER_AUTHORITY = "localhost:9000"

class ZapCrawler:

    def __init__(
        self, config: CrawlConfig, zap_port: int = 8090, api_key: Optional[str] = None, zap_image: str = "ghcr.io/zaproxy/zaproxy:stable", browser_id: str = "chrome-headless"
    ):
        self.config = config
        self.zap_port = zap_port
        self.api_key = api_key
        self.zap_image = zap_image
        self.browser_id = browser_id
        self.stats = CrawlStats()
        self._initial_report_count: int = 0
        self._initial_unique_count: int = 0
        self._initial_sink_count: int = 0

    def crawl(self) -> CrawlStats:

        start_time = time.time()

        with ZapManager(api_key=self.api_key, zap_port=self.zap_port, zap_image=self.zap_image) as zap:

            if self.config.auth_enabled:
                print(f"[auth] Authenticating via {self.config.auth_type} ...")
                setup_auth(zap, self.config)

            self._configure_report_passthrough(zap)

            self._configure_url_exclusions(zap)

            self._snapshot_initial_reports()

            urls_to_scan = [self.config.base_url]
            if self.config.seed_urls:
                urls_to_scan.extend(self.config.seed_urls)
            urls_to_scan = list(dict.fromkeys(urls_to_scan))

            n_urls = len(urls_to_scan)
            for i, url in enumerate(urls_to_scan):
                elapsed = time.time() - start_time
                remaining_sec = max(0, self.config.max_duration_sec - elapsed)
                if remaining_sec < 5:
                    print(f"[zap] Time budget exhausted, skipping {url}")
                    break

                urls_left = n_urls - i
                per_url_sec = remaining_sec / urls_left
                per_url_deadline = time.time() + per_url_sec
                remaining_min = max(1, math.ceil(remaining_sec / 60))
                print(
                    f"[zap] AJAX Spider scanning: {url} "
                    f"(max {remaining_min}m, remaining {remaining_sec:.0f}s, per_url {per_url_sec:.0f}s)"
                )
                zap.ajaxSpider.set_option_max_duration(remaining_min)
                zap.ajaxSpider.set_option_browser_id(self.browser_id)
                try:
                    zap.ajaxSpider.scan(url=url)
                except Exception as e:
                    logger.warning("ajaxSpider.scan failed for %s: %s", url, e)
                    continue

                self._run_scan_loop(zap, start_time, per_url_deadline)

            self._collect_results(zap, time.time() - start_time)

        return self.stats

    def _run_scan_loop(self, zap: ZAPv2, start_time: float, per_url_deadline: float = 0) -> None:

        poll_interval = 2
        last_snapshot_time = 0
        scan_start = time.time()

        while True:
            elapsed = time.time() - start_time
            scan_elapsed = time.time() - scan_start

            if elapsed > self.config.max_duration_sec:
                print(f"[zap] Time budget exceeded ({elapsed:.1f}s), stopping ...")
                zap.ajaxSpider.stop()
                break

            if per_url_deadline and time.time() > per_url_deadline:
                print(f"[zap] {elapsed:6.1f}s | per-URL time limit reached, moving to next URL ...")
                break

            status = zap.ajaxSpider.status
            if status == "stopped" and scan_elapsed > 5:
                print(f"[zap] {elapsed:6.1f}s | stopped")
                break

            if elapsed - last_snapshot_time >= 10:
                try:
                    urls = zap.core.urls(baseurl=self.config.base_url) or []
                    num_urls = len(urls)
                    num_requests = int(zap.core.number_of_messages(baseurl=self.config.base_url) or 0)
                    self.stats.coverage_time_series.append((elapsed, num_urls, num_requests))
                    print(f"[zap] {elapsed:6.1f}s | {status} | urls: {num_urls} | requests: {num_requests}")
                    for url in urls[-3:]:
                        print(f"[zap]    {url}")
                    last_snapshot_time = elapsed
                except Exception as e:
                    logger.warning("Snapshot error (non-fatal): %s", e)

            time.sleep(poll_interval)

    def _collect_results(self, zap: ZAPv2, elapsed_sec: float) -> None:

        self.stats.elapsed_sec = elapsed_sec

        try:
            urls = zap.core.urls(baseurl=self.config.base_url) or []
            self.stats.pages_visited = len(urls)
            self.stats.unique_urls_discovered = len(set(urls))
            self.stats.visited_urls = sorted(urls)
        except Exception as e:
            logger.warning("Result collection error (non-fatal): %s", e)
            self.stats.pages_visited = 0
            self.stats.unique_urls_discovered = 0

        try:
            n = zap.core.number_of_messages(baseurl=self.config.base_url)
            self.stats.requests_made = int(n or 0)
        except Exception as e:
            logger.warning("Request count error (non-fatal): %s", e)

        self._collect_report_stats()

    def _configure_report_passthrough(self, zap: ZAPv2) -> None:

        try:
            zap.network.add_pass_through(REPORT_SERVER_AUTHORITY, apikey=self.api_key)
            print(f"[zap] Passthrough configured for {REPORT_SERVER_AUTHORITY}")
        except Exception:
            try:
                zap.core.exclude_from_proxy("http://localhost:9000.*", apikey=self.api_key)
                print(f"[zap] Proxy exclusion configured for {REPORT_SERVER_AUTHORITY}")
            except Exception as e:
                logger.warning("Failed to configure report passthrough (non-fatal): %s", e)

    def _configure_url_exclusions(self, zap: ZAPv2) -> None:

        exclusions = [
            ".*tt-bootstrap\\.js$",
        ]
        for pattern in exclusions:
            try:
                zap.core.exclude_from_proxy(pattern, apikey=self.api_key)
                print(f"[zap] Excluded from crawl: {pattern}")
            except Exception as e:
                logger.warning("Failed to exclude URL pattern %s (non-fatal): %s", pattern, e)

    def _snapshot_initial_reports(self) -> None:

        try:
            resp = requests.get(REPORT_SERVER_URL, timeout=5)
            resp.raise_for_status()
            data = resp.json()
            classify = data.get("classify", {})
            violation = data.get("violation", {})
            self._initial_unique_count = classify.get("total", 0) + violation.get("total", 0)
            self._initial_report_count = classify.get("total_hits", 0) + violation.get("total_hits", 0)
            self._initial_sink_count = data.get("unique_sinks", 0)
            print(f"[report] Initial snapshot: {self._initial_sink_count} sinks, {self._initial_unique_count} unique, {self._initial_report_count} total reports")
        except Exception as e:
            logger.warning("Failed to snapshot initial report count: %s", e)
            self._initial_report_count = 0
            self._initial_unique_count = 0
            self._initial_sink_count = 0

    def _collect_report_stats(self) -> None:

        try:
            resp = requests.get(REPORT_SERVER_URL, timeout=5)
            resp.raise_for_status()
            data = resp.json()
            classify = data.get("classify", {})
            violation = data.get("violation", {})
            total = classify.get("total_hits", 0) + violation.get("total_hits", 0)
            unique = classify.get("total", 0) + violation.get("total", 0)
            sinks = data.get("unique_sinks", 0)
            self.stats.reports_collected = total - self._initial_report_count
            self.stats.unique_reports_collected = unique - self._initial_unique_count
            self.stats.unique_sinks_collected = sinks - self._initial_sink_count
            print(
                f"[report] Collected {self.stats.unique_sinks_collected} sinks, "
                f"{self.stats.unique_reports_collected} unique, "
                f"{self.stats.reports_collected} total reports"
            )
        except Exception as e:
            print(f"[report] Failed to fetch stats: {e}")
            logger.warning("Report stats error (non-fatal): %s", e)
            self.stats.reports_collected = 0
            self.stats.unique_reports_collected = 0
            self.stats.unique_sinks_collected = 0
