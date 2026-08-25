from dataclasses import dataclass, field
from typing import Optional

@dataclass(frozen=True)
class CrawlConfig:

    base_url: str
    max_pages: int
    max_duration_sec: int
    headless: bool = True
    auth_enabled: bool = False
    auth_type: Optional[str] = None
    auth_credentials: dict = field(default_factory=dict)
    seed_urls: list = field(default_factory=list)
    enable_js_extraction: bool = True

@dataclass
class CrawlStats:

    pages_visited: int = 0
    actions_performed: int = 0
    elapsed_sec: float = 0.0
    reports_collected: int = 0
    unique_reports_collected: int = 0
    unique_sinks_collected: int = 0

    unique_urls_discovered: int = 0
    queue_peak_size: int = 0
    requests_made: int = 0

    forms_submitted: int = 0
    buttons_clicked: int = 0
    reveal_actions: int = 0
    significant_local_transitions: int = 0

    coverage_time_series: list = field(default_factory=list)

    visited_urls: list = field(default_factory=list)

    def add_time_snapshot(self, elapsed_sec: float) -> None:
        self.coverage_time_series.append(
            (elapsed_sec, self.pages_visited, self.reports_collected)
        )
