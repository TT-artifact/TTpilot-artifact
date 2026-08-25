#!/usr/bin/env python3
"""
Extract and normalize URLs from crawler logs + reports.db (union).

Usage:
    from get_combined_urls import get_combined_urls
    urls = get_combined_urls(target_dir, base_url, target_url)

    python3 get_combined_urls.py --target-dir <path> --base-url <url> --target-url <url>
    Output is a JSON array on stdout.

Behavior:
    1. Load Visited URLs from crawler logs (basic, zap, browser-use), remapping base_url to target_url
    2. Load reports.db (if exists), remapping base_url to target_url
    3. Union both sources
    4. Filter by host (only URLs with base_url's netloc)
    5. Normalize each URL (remove fragment)
    6. Filter (http/https only, valid netloc)
    7. Deduplicate + sort
    8. Return list[str]
"""

import json
import argparse
import sys
import os
import glob
import re
from pathlib import Path
from urllib.parse import urlparse, urlunparse
from typing import Any

try:
    import yaml
except ImportError:
    yaml = None

sys.path.insert(0, os.path.dirname(__file__))
from get_page_urls import get_page_urls


SPA_APPS = {
    'reveal.js', 'umbraco', 'elementor'
}


def _get_app_name(target_dir: str) -> str:
    """Extract app name from target directory path."""
    path = target_dir.rstrip('/')
    return path.split('/')[-1]


def normalize_url(url: str, include_fragments: bool = False) -> str:
    """Normalize URL: remove fragment (unless include_fragments=True). Normalize trailing slash."""
    parsed = urlparse(url)
    path = parsed.path or '/'


    if path != '/' and path.endswith('/'):
        path = path.rstrip('/')


    fragment = parsed.fragment if include_fragments else ''

    return urlunparse((
        parsed.scheme,
        parsed.netloc,
        path,
        parsed.params,
        parsed.query,
        fragment
    ))


def _get_query_key_signature(url: str, include_fragments: bool = False) -> str:
    """
    Get query parameter key signature for deduplication.
    Two URLs with same path and same query parameter keys are considered duplicates.
    Trailing slash is normalized (removed except for root path).

    If include_fragments=True, fragments are included in the signature.
    """
    from urllib.parse import parse_qs

    parsed = urlparse(url)
    path = parsed.path or '/'


    if path != '/' and path.endswith('/'):
        path = path.rstrip('/')


    fragment = parsed.fragment if include_fragments else ''


    if not parsed.query:
        return urlunparse((parsed.scheme, parsed.netloc, path, parsed.params, '', fragment))


    try:
        params = parse_qs(parsed.query, keep_blank_values=True)
        sorted_keys = sorted(params.keys())

        sig_query = '&'.join([f'{key}=' for key in sorted_keys])
    except Exception:

        sig_query = parsed.query

    return urlunparse((parsed.scheme, parsed.netloc, path, parsed.params, sig_query, fragment))


def is_valid_url(url: str) -> bool:
    """Check if URL is valid for testing."""
    if not url or not isinstance(url, str):
        return False

    url = url.strip()


    if not url.startswith(('http://', 'https://')):
        return False

    try:
        parsed = urlparse(url)
    except Exception:
        return False


    if not parsed.netloc:
        return False


    if parsed.path.endswith('/tt-bootstrap.js'):
        return False

    return True


def _load_log_urls(target_dir: str, include_fragments: bool = False) -> list[str]:
    """Load visited URLs from crawler log files (basic, zap, browser-use).

    Filters out static resources (CSS, JS, images, fonts, etc.) to match
    the behavior of basic and browser-use crawlers.

    Args:
        target_dir: Path to target directory
        include_fragments: If True, keep URL fragments (for SPA apps)
    """
    log_dir = os.path.join(target_dir, 'logs')
    if not os.path.isdir(log_dir):
        return []


    resource_extensions = {
        '.css', '.js', '.json', '.map',
        '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
        '.ttf', '.woff', '.woff2', '.eot', '.otf',
        '.mp3', '.mp4', '.webm', '.wav', '.ogg', '.m4a',
        '.pdf', '.zip', '.tar', '.gz', '.rar',
        '.xml', '.rss', '.atom',
    }

    urls = []
    for pattern in ('basic_*.log', 'zap_*.log', 'browser-use_*.log'):
        matches = sorted(glob.glob(os.path.join(log_dir, pattern)))
        if not matches:
            continue

        log_path = matches[-1]
        content = Path(log_path).read_text(errors='replace')


        m = re.search(r'Visited URLs:\s*\n(.*)', content, re.DOTALL)
        if not m:
            continue

        for line in m.group(1).splitlines():

            if line.startswith('  ') and (line[2:].startswith('http') or line[2:].startswith('about:')):
                url = line.strip()


                if not include_fragments:
                    url = url.split('#')[0]


                url_lower = url.lower()
                if not any(url_lower.endswith(ext) for ext in resource_extensions):
                    urls.append(url if include_fragments else url.split('#')[0])
            elif line and not line.startswith('  '):

                break

    return urls


def _is_same_host(url: str, base_netloc: str) -> bool:
    """Check if URL's netloc matches base_netloc."""
    try:
        return urlparse(url).netloc == base_netloc
    except Exception:
        return False


def _load_target_urls_yaml(target_dir: str, base_url: str, target_url: str) -> list[str]:
    """Load URLs from target_urls.yaml in eval/target_urls.yaml (if exists).

    Returns normalized URLs remapped from base_url to target_url.
    """
    if yaml is None:
        return []


    yaml_paths = [
        os.path.join(target_dir, 'eval', 'target_urls.yaml'),
        os.path.join(target_dir, 'target_urls.yaml'),
    ]

    for yaml_path in yaml_paths:
        if not os.path.isfile(yaml_path):
            continue

        try:
            with open(yaml_path) as f:
                data = yaml.safe_load(f)

            if not data or 'urls' not in data:
                continue

            urls = data.get('urls', [])
            if not urls:
                continue


            normalized_target = _normalize_base_url(target_url)
            target_parsed = urlparse(normalized_target)

            remapped_urls = []
            for url in urls:
                if not isinstance(url, str):
                    continue

                parsed = urlparse(url)
                remapped = urlunparse((
                    target_parsed.scheme,
                    target_parsed.netloc,
                    parsed.path,
                    parsed.params,
                    parsed.query,
                    parsed.fragment
                ))
                remapped_urls.append(remapped)

            return remapped_urls
        except Exception as e:
            print(f"Warning: Failed to load {yaml_path}: {e}", file=sys.stderr)
            continue

    return []


def _load_reports_urls(target_dir: str, base_url: str, target_url: str) -> list[str]:
    """Load and normalize URLs from reports.db if it exists."""
    reports_db = os.path.join(target_dir, 'reports.db')
    if not os.path.isfile(reports_db):
        return []


    return get_page_urls(reports_db, base_url, target_url)


def _normalize_base_url(url: str) -> str:
    """
    Normalize base URL to directory form (ensure trailing slash).
    If URL ends with a file-like path (e.g., /generator.html), use its directory.
    """
    parsed = urlparse(url)
    path = parsed.path or '/'


    if not path or path.endswith('/'):
        normalized_path = path
    else:


        if '.' in path.split('/')[-1]:
            normalized_path = '/' if path == '/' else path.rsplit('/', 1)[0] + '/'
        else:
            normalized_path = path if path.endswith('/') else path + '/'

    return urlunparse((parsed.scheme, parsed.netloc, normalized_path, '', '', ''))


def get_combined_urls(
    target_dir: str,
    base_url: str,
    target_url: str,
) -> list[str]:
    """
    Extract combined URLs from crawler logs + reports.db.

    Args:
        target_dir: Path to target directory (contains logs/ and/or reports.db)
        base_url: Original base URL (e.g., http://localhost:8080/ or http://localhost:8080/generator.html)
        target_url: Target URL for remapping (e.g., http://localhost:8081/)

    Returns:
        Sorted list of normalized unique URLs
    """

    app_name = _get_app_name(target_dir)
    include_fragments = app_name in SPA_APPS


    original_base_path = urlparse(base_url).path or '/'


    normalized_base = _normalize_base_url(base_url)
    normalized_target = _normalize_base_url(target_url)
    base_netloc = urlparse(normalized_base).netloc

    target_parsed = urlparse(normalized_target)


    target_yaml_urls = _load_target_urls_yaml(target_dir, normalized_base, normalized_target)
    if target_yaml_urls:
        seed_urls = target_yaml_urls
        filtered_reports_urls = []
    else:


        log_urls = _load_log_urls(target_dir, include_fragments=include_fragments)


        filtered_log_urls = []
        for url in log_urls:
            if _is_same_host(url, base_netloc):
                parsed = urlparse(url)
                remapped = urlunparse((
                    target_parsed.scheme,
                    target_parsed.netloc,
                    parsed.path,
                    parsed.params,
                    parsed.query,
                    parsed.fragment
                ))
                filtered_log_urls.append(remapped)


        reports_urls = _load_reports_urls(target_dir, normalized_base, normalized_target)


        filtered_reports_urls = [url for url in reports_urls if _is_same_host(url, target_parsed.netloc)]


        seed_urls = filtered_log_urls


    def strip_original_base_path(urls: list[str]) -> list[str]:
        """Remove original_base_path prefix from URL paths if needed."""
        if original_base_path == '/' or original_base_path.endswith('/'):
            return urls

        normalized_urls = []
        for url in urls:
            parsed = urlparse(url)
            if parsed.path.startswith(original_base_path + '/'):

                new_path = parsed.path[len(original_base_path):]
                url = urlunparse((parsed.scheme, parsed.netloc, new_path, parsed.params, parsed.query, parsed.fragment))
            elif parsed.path == original_base_path:

                url = urlunparse((parsed.scheme, parsed.netloc, '/', parsed.params, parsed.query, parsed.fragment))
            normalized_urls.append(url)
        return normalized_urls

    seed_urls = strip_original_base_path(seed_urls)
    filtered_reports_urls = strip_original_base_path(filtered_reports_urls)


    all_urls = seed_urls + filtered_reports_urls


    seen: set[str] = set()
    valid_urls: list[str] = []

    for url in all_urls:
        if is_valid_url(url):
            normalized = normalize_url(url, include_fragments=include_fragments)

            dedup_key = _get_query_key_signature(normalized, include_fragments=include_fragments)
            if dedup_key not in seen:
                seen.add(dedup_key)
                valid_urls.append(normalized)

    return sorted(valid_urls)


def main():
    parser = argparse.ArgumentParser(
        description='Extract combined URLs from crawler logs + reports.db'
    )
    parser.add_argument('--target-dir', required=True, help='Path to target directory')
    parser.add_argument('--base-url', required=True, help='Original base URL (e.g., http://localhost:8080/)')
    parser.add_argument('--target-url', required=True, help='Target URL for remapping (e.g., http://localhost:8081/)')

    args = parser.parse_args()

    try:
        urls = get_combined_urls(args.target_dir, args.base_url, args.target_url)


        json.dump(urls, sys.stdout)
        print()

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
