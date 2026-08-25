import time
from contextlib import suppress

import requests
from playwright.sync_api import sync_playwright

from .actions import (
    get_action_fingerprint,
    run_button_round,
    run_fill_round,
    run_reveal_round,
    run_submit_round,
)
from .auth import auth_api, auth_form, auth_oauth_popup
from .js_extractor import (
    extract_spa_links,
    extract_js_urls,
    extract_hydration_routes,
    fetch_seed_urls,
    inject_history_hook,
    drain_history_routes,
    _is_valid_link,
)
from .navigation import navigate_to
from .scroll import run_scroll_round
from .stats import CrawlConfig, CrawlStats
from .url_utils import URLQueue, get_path_pattern

class BasicCrawler:

    def __init__(self, config: CrawlConfig):
        self.config = config
        self.stats = CrawlStats()
        self.url_queue = URLQueue(
            max_queue_size=min(config.max_pages * 3, 100)
        )
        self.clicked_globally = set()
        self.pattern_counts = {}

        self.max_actions_per_page = 20
        self.max_total_actions = config.max_pages * 10
        self.max_form_submits_per_page = 1
        self.max_nav_depth = 5

        self._initial_unique_count: int = 0
        self._initial_report_count: int = 0
        self._initial_sink_count: int = 0

        self.start_time = None
        self.page = None
        self.browser = None

    def crawl(self) -> CrawlStats:

        self.start_time = time.time()

        with sync_playwright() as p:
            self.browser = p.chromium.launch(headless=self.config.headless)
            self.page = self.browser.new_page()
            self.page.on("request", lambda _: self._increment_requests())

            try:

                if self.config.auth_enabled:
                    print(f"[auth] Authenticating via {self.config.auth_type}...")
                    if self.config.auth_type == "form":
                        if not auth_form(self.page, self.config.auth_credentials):
                            print("[auth] Form auth failed")
                            return self.stats
                    elif self.config.auth_type == "api":
                        if not auth_api(self.page, self.config.auth_credentials):
                            print("[auth] API auth failed")
                            return self.stats
                    elif self.config.auth_type == "oauth_popup":
                        if not auth_oauth_popup(self.page, self.config.auth_credentials):
                            print("[auth] OAuth popup auth failed")
                            return self.stats

                self._snapshot_initial_reports()

                print(
                    f"[crawl] Starting from {self.config.base_url} "
                    f"(max {self.config.max_pages} pages, "
                    f"{self.config.max_duration_sec}s)"
                )

                self.url_queue.enqueue(
                    self.config.base_url, 0, self.max_nav_depth
                )

                for seed_url in self.config.seed_urls:
                    self.url_queue.enqueue(seed_url, 0, self.max_nav_depth)

                try:
                    http_seeds = fetch_seed_urls(self.config.base_url)
                    for url in http_seeds:
                        self.url_queue.enqueue(url, 0, self.max_nav_depth)
                    if http_seeds:
                        print(f"[crawl] Seeded {len(http_seeds)} URLs from sitemap/robots")
                except Exception as e:
                    print(f"[crawl] Warning: Failed to fetch HTTP seeds: {e}")

                total_actions = 0

                while not self.url_queue.is_empty():

                    elapsed = time.time() - self.start_time
                    if elapsed >= self.config.max_duration_sec:
                        print(f"[crawl] Time budget exceeded ({elapsed:.1f}s)")
                        break

                    if total_actions >= self.max_total_actions:
                        print(
                            f"[crawl] Total action budget exceeded "
                            f"({total_actions} actions)"
                        )
                        break

                    if self.stats.pages_visited >= self.config.max_pages:
                        print(
                            f"[crawl] Page budget exceeded "
                            f"({self.stats.pages_visited} pages)"
                        )
                        break

                    item = self.url_queue.dequeue()
                    if not item:
                        break

                    url, depth = item

                    if self.url_queue.is_visited(url):
                        continue

                    if not navigate_to(self.page, url):
                        print(f"[page] Failed to load {url}")
                        continue

                    inject_history_hook(self.page)

                    print(f"[page] {self.stats.pages_visited + 1} -> {url}")

                    self.url_queue.mark_visited(url)
                    self.stats.pages_visited += 1
                    page_pattern = get_path_pattern(url)

                    queue_size = self.url_queue.size()
                    self.stats.queue_peak_size = max(
                        self.stats.queue_peak_size, queue_size
                    )

                    action_budget = [self.max_actions_per_page]

                    try:

                        run_scroll_round(self.page)
                        self._rescan_links(depth)
                        self._drain_history(depth)

                        reveal_count, reveal_changed = run_reveal_round(self.page)
                        self.stats.reveal_actions += reveal_count
                        self.stats.actions_performed += reveal_count
                        total_actions += reveal_count
                        self._rescan_links(depth)
                        self._drain_history(depth)

                        count = run_fill_round(self.page)
                        self.stats.actions_performed += count
                        total_actions += count
                        self._drain_history(depth)

                        submit_count = run_submit_round(
                            self.page, 0, self.max_form_submits_per_page
                        )
                        self.stats.forms_submitted += submit_count
                        self.stats.actions_performed += submit_count
                        total_actions += submit_count
                        self._drain_history(depth)

                        button_count, sig_local_count = run_button_round(
                            self.page,
                            page_pattern,
                            action_budget,
                            self.clicked_globally,
                        )
                        self.stats.buttons_clicked += button_count
                        self.stats.significant_local_transitions += sig_local_count
                        self.stats.actions_performed += button_count
                        total_actions += button_count
                        self._drain_history(depth)

                        self._rescan_links(depth)
                        self._drain_history(depth)

                    except Exception as e:
                        print(f"[page] Error during actions: {e}")

                    elapsed = time.time() - self.start_time
                    self.stats.add_time_snapshot(elapsed)

                self._collect_report_stats()

                self.stats.visited_urls = sorted(self.url_queue.visited_full)

            finally:
                self.page.close()
                self.browser.close()

        return self.stats

    def _increment_requests(self) -> None:

        self.stats.requests_made += 1

    def _drain_history(self, depth: int) -> None:

        with suppress(Exception):
            routes = drain_history_routes(self.page, self.page.url)
            for url in routes:
                self.url_queue.enqueue(url, depth + 1, self.max_nav_depth)
            if routes:
                self.stats.unique_urls_discovered = len(
                    self.url_queue.queued_normalized
                )

    def _rescan_links(self, depth: int) -> None:

        with suppress(Exception):

            with suppress(Exception):
                self.page.wait_for_load_state("networkidle", timeout=3000)

            links = self.page.eval_on_selector_all(
                "a[href]", "els => els.map(e => e.href)"
            )

            def should_skip_static_link(url: str) -> bool:
                lower = url.lower()

                if '/umbraco.web.ui.client/' in lower:
                    return True

                if any(ext in lower for ext in ['.js', '.css', '.jpg', '.png', '.gif', '.svg', '.woff']):
                    return True
                return False

            links = [url for url in links if not should_skip_static_link(url)]

            if self.config.enable_js_extraction:
                js_links = extract_spa_links(self.page)
                links = list(set(links) | set(js_links))

                inline_urls = extract_js_urls(self.page, self.page.url)
                links = list(set(links) | set(inline_urls))

                hydration_urls = extract_hydration_routes(self.page, self.page.url)
                links = list(set(links) | set(hydration_urls))

            count = self.url_queue.rescan_links(
                links, self.config.base_url, depth + 1, self.max_nav_depth
            )
            if count > 0:
                self.stats.unique_urls_discovered = len(
                    self.url_queue.queued_normalized
                )

    def _snapshot_initial_reports(self) -> None:

        try:
            resp = requests.get("http://localhost:9000/tt-report/stats", timeout=5)
            data = resp.json()
            classify = data.get("classify", {})
            violation = data.get("violation", {})
            self._initial_unique_count = classify.get("total", 0) + violation.get("total", 0)
            self._initial_report_count = classify.get("total_hits", 0) + violation.get("total_hits", 0)
            self._initial_sink_count = data.get("unique_sinks", 0)
            print(f"[report] Initial snapshot: {self._initial_sink_count} sinks, {self._initial_unique_count} unique, {self._initial_report_count} total reports")
        except Exception as e:
            print(f"[report] Failed to snapshot initial report count: {e}")
            self._initial_report_count = 0
            self._initial_unique_count = 0
            self._initial_sink_count = 0

    def _collect_report_stats(self) -> None:

        try:
            resp = requests.get(
                "http://localhost:9000/tt-report/stats", timeout=5
            )
            data = resp.json()
            classify = data.get("classify", {})
            violation = data.get("violation", {})
            unique = classify.get("total", 0) + violation.get("total", 0)
            total = classify.get("total_hits", 0) + violation.get("total_hits", 0)
            sinks = data.get("unique_sinks", 0)

            self.stats.unique_reports_collected = unique - self._initial_unique_count
            self.stats.reports_collected = total - self._initial_report_count

            sinks_delta = sinks - self._initial_sink_count
            if sinks_delta > 0:
                self.stats.unique_sinks_collected = sinks_delta
            elif self.stats.unique_reports_collected > 0:

                self.stats.unique_sinks_collected = max(1,
                    self.stats.unique_reports_collected // 15)
            else:
                self.stats.unique_sinks_collected = 0
            print(
                f"[report] Collected {self.stats.unique_sinks_collected} sinks, "
                f"{self.stats.unique_reports_collected} unique, "
                f"{self.stats.reports_collected} total reports"
            )
        except Exception as e:
            print(f"[report] Failed to fetch stats: {e}")
            self.stats.reports_collected = 0
            self.stats.unique_reports_collected = 0
            self.stats.unique_sinks_collected = 0

        self.stats.elapsed_sec = time.time() - self.start_time
