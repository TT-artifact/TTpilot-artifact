import re
from collections import Counter, deque
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

IGNORE_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign",
    "ref", "session", "_", "t", "timestamp",
}
ROUTING_FRAGMENT_PREFIXES = {"/", "!"}
MAX_PATTERN_VISITS = 3

def normalize_url(url: str) -> str:

    p = urlparse(url)
    params = {
        k: v
        for k, v in parse_qs(p.query).items()
        if k not in IGNORE_PARAMS
    }
    query = urlencode(sorted(params.items()), doseq=True)

    fragment = (
        p.fragment if p.fragment[:1] in ROUTING_FRAGMENT_PREFIXES else ""
    )
    return urlunparse((p.scheme, p.netloc, p.path, "", query, fragment))

def get_path_pattern(url: str) -> str:

    path = urlparse(url).path
    return re.sub(r"/\d+", "/{id}", path)

def is_same_origin(url: str, base_url: str) -> bool:

    base_parsed = urlparse(base_url)
    url_parsed = urlparse(url)
    return (
        url_parsed.scheme == base_parsed.scheme
        and url_parsed.netloc == base_parsed.netloc
    )

class URLQueue:

    def __init__(self, max_queue_size: int = 100):
        self.queue: deque = deque()
        self.queued_normalized: set = set()
        self.visited_full: set = set()
        self.pattern_counts: Counter = Counter()
        self.max_queue_size = max_queue_size

    def enqueue(self, url: str, depth: int, max_depth: int = 5) -> bool:

        if depth > max_depth:
            return False
        if len(self.queued_normalized) >= self.max_queue_size:
            return False

        norm = normalize_url(url)
        if norm in self.queued_normalized or self._should_skip(url):
            return False

        self.queue.append((url, depth))
        self.queued_normalized.add(norm)
        return True

    def dequeue(self) -> Optional[tuple]:

        if self.queue:
            return self.queue.popleft()
        return None

    def mark_visited(self, url: str) -> None:

        norm = normalize_url(url)
        self.visited_full.add(norm)
        pattern = get_path_pattern(url)
        self.pattern_counts[pattern] += 1

    def is_visited(self, url: str) -> bool:

        norm = normalize_url(url)
        return norm in self.visited_full

    def is_empty(self) -> bool:

        return len(self.queue) == 0

    def size(self) -> int:

        return len(self.queue)

    def _should_skip(self, url: str) -> bool:

        pattern = get_path_pattern(url)
        return self.pattern_counts[pattern] >= MAX_PATTERN_VISITS

    def rescan_links(
        self,
        links: list,
        base_url: str,
        depth: int,
        max_depth: int = 5,
    ) -> int:

        count = 0
        for link in links:
            if is_same_origin(link, base_url):
                if self.enqueue(link, depth, max_depth):
                    count += 1
        return count
