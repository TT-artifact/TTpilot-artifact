#!/usr/bin/env python3

import argparse
import sqlite3
import sys
from pathlib import Path
from typing import Set, List, Tuple
import yaml
import os
import re

def get_research_root() -> Path:

    return Path(__file__).resolve().parent.parent

def parse_yaml(yml_path: str) -> dict:

    with open(yml_path) as f:
        return yaml.safe_load(f)

def file_to_url(abs_path: str, src_dir: str, base_url: str, web_root: str = '') -> str:

    from urllib.parse import quote, urlparse, urlunparse

    rel = os.path.relpath(abs_path, src_dir)

    if web_root:
        prefix = web_root.strip('/') + '/'
        if rel.startswith(prefix):
            rel = rel[len(prefix):]
    else:

        for prefix in ['public/', 'static/', 'dist/', 'www/', 'build/']:
            if rel.startswith(prefix):
                rel = rel[len(prefix):]
                break

    parsed = urlparse(base_url)
    path = parsed.path or '/'

    if '.' in path.split('/')[-1]:
        normalized_path = '/' if path == '/' else path.rsplit('/', 1)[0] + '/'
    else:
        normalized_path = path if path.endswith('/') else path + '/'

    normalized_base = urlunparse((parsed.scheme, parsed.netloc, normalized_path, '', '', ''))

    encoded_rel = quote(rel.replace('\\', '/').lstrip('/'), safe='/')
    url = normalized_base.rstrip('/') + '/' + encoded_rel
    return url

def find_html_for_js(js_abs_path: str, src_dir: str) -> List[str]:

    js_basename = os.path.basename(js_abs_path)
    js_name_no_ext = os.path.splitext(js_basename)[0]
    matching_html = []

    for root, dirs, files in os.walk(src_dir):

        dirs[:] = [d for d in dirs if d not in {'node_modules', '.git', 'vendor', '.next', 'build', 'dist'}]

        for file in files:
            if file.endswith(('.html', '.htm')):
                html_path = os.path.join(root, file)
                try:
                    with open(html_path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()

                        if (js_basename in content or
                            js_name_no_ext in content or
                            f'src="{js_basename}"' in content or
                            f"src='{js_basename}'" in content):
                            matching_html.append(html_path)
                except (IOError, UnicodeDecodeError):
                    pass

    return matching_html

def get_apps_in_db(db_path: str) -> List[str]:

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT DISTINCT app FROM sinks ORDER BY app')
    apps = [row[0] for row in cursor.fetchall()]
    conn.close()
    return apps

def query_sinks(db_path: str, app_name: str) -> List[Tuple[str, str]]:

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute('''
        SELECT DISTINCT file FROM sinks
        WHERE app = ? AND status IN ('RECEIVER_MATCH', 'RECEIVER_UNRESOLVABLE', 'NO_RECEIVER')
        ORDER BY file
    ''', (app_name,))

    files = []
    for (file_path,) in cursor.fetchall():
        file_type = 'html' if file_path.endswith(('.html', '.htm')) else 'js'
        files.append((file_path, file_type))

    conn.close()
    return files

def generate_seed_urls(yml_path: str) -> List[str]:

    cfg = parse_yaml(yml_path)
    target_name = cfg['target']['name']
    base_url = cfg.get('crawl', {}).get('base_url', 'http://localhost:8080/')
    web_root = cfg.get('serve', {}).get('web_root', '')

    research_root = get_research_root()
    src_dir = research_root / 'out' / 'targets' / target_name / 'src'
    db_path = research_root / 'out' / 'targets' / target_name / 'sinks.db'

    if not db_path.exists():
        print(f"Error: sinks.db not found at {db_path}", file=sys.stderr)
        sys.exit(1)

    if not src_dir.exists():
        print(f"Error: source directory not found at {src_dir}", file=sys.stderr)
        sys.exit(1)

    apps = get_apps_in_db(str(db_path))
    if not apps:
        print(f"Error: no sinks found in {db_path}", file=sys.stderr)
        sys.exit(1)
    app_name = apps[0]

    files = query_sinks(str(db_path), app_name)

    urls_set: Set[str] = set()
    urls_ordered: List[str] = []

    for file_path, file_type in files:
        if not os.path.exists(file_path):
            continue

        if file_type == 'html':

            url = file_to_url(file_path, str(src_dir), base_url, web_root)
            if url not in urls_set:
                urls_set.add(url)
                urls_ordered.append(url)
        else:

            html_files = find_html_for_js(file_path, str(src_dir))
            for html_path in html_files:
                url = file_to_url(html_path, str(src_dir), base_url, web_root)
                if url not in urls_set:
                    urls_set.add(url)
                    urls_ordered.append(url)

    return urls_ordered

def main():
    parser = argparse.ArgumentParser(description='Generate seed URLs from sink detection results')
    parser.add_argument('yml_file', help='Target YAML file (e.g., targets/001-urlpages.yml)')
    parser.add_argument('--out', help='Output file path (default: out/targets/{TARGET_NAME}/seed_urls.txt)')

    args = parser.parse_args()

    urls = generate_seed_urls(args.yml_file)

    if args.out:
        out_path = args.out
    else:
        cfg = parse_yaml(args.yml_file)
        target_name = cfg['target']['name']
        research_root = get_research_root()
        out_path = research_root / 'out' / 'targets' / target_name / 'seed_urls.txt'

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with open(out_path, 'w') as f:
        for url in urls:
            f.write(url + '\n')

    print(f"Generated {len(urls)} seed URLs")
    print(f"Saved to: {out_path}")

    if urls:
        print("\nFirst 5 URLs:")
        for url in urls[:5]:
            print(f"  {url}")
        if len(urls) > 5:
            print(f"  ... and {len(urls) - 5} more")

if __name__ == '__main__':
    main()
