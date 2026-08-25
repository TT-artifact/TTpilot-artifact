#!/usr/bin/env python3

from __future__ import annotations
import argparse, datetime, logging, signal, subprocess, sys
from pathlib import Path
import yaml
SCRIPT_DIR = Path(__file__).resolve().parent
RESEARCH_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(RESEARCH_DIR / "testing"))
from basic_crawler import CrawlConfig
from basic_crawler.url_utils import is_same_origin
from zap_hybrid_crawler import HybridZapConfig, HybridZapCrawler

class Tee:
    def __init__(self, *streams): self.streams = streams
    def write(self, data):
        for stream in self.streams: stream.write(data); stream.flush()
    def flush(self):
        for stream in self.streams: stream.flush()

def parse_args():
    p = argparse.ArgumentParser(description="ZAP traditional Spider + Client Spider crawler")
    p.add_argument("yml_file", help="targets/<app>.yml")
    p.add_argument("--max-duration", type=int, help="Per-phase duration in seconds")
    p.add_argument("--zap-port", type=int, default=8090)
    p.add_argument("--api-key"); p.add_argument("--zap-image", default="zap-hybrid-chrome")
    p.add_argument("--browser-id", default="chrome-headless")
    p.add_argument("--resume", action="store_true", help="Resume zap_hybrid_checkpoint.json")
    p.add_argument("--client-workers", type=int, help="Parallel ZAP containers for the client-spider queue")
    p.add_argument("--spider-max-duration", type=int, help="Traditional spider budget in seconds (0 = unlimited)")
    p.add_argument("--traditional-only", action="store_true", help="Run only the traditional spider phase, then stop")
    return p.parse_args()

def ensure_image(image):
    r = subprocess.run(["docker", "images", "-q", image], capture_output=True, text=True, timeout=10)
    if r.stdout.strip(): return
    if image != "zap-hybrid-chrome": raise RuntimeError(f"ZAP image not found: {image}")
    dockerfile = RESEARCH_DIR / "testing/zap_hybrid_crawler/Dockerfile.zap-hybrid-chrome"
    subprocess.run(["docker", "build", "--platform", "linux/amd64", "-t", image, "-f", str(dockerfile), str(RESEARCH_DIR)], check=True, timeout=600)

def load_seeds(target_name, cfg):
    seeds = list(cfg.get("seed_urls", []) or [])
    path = RESEARCH_DIR / "out/targets" / target_name / "seed_urls.txt"
    if path.exists(): seeds.extend(x.strip() for x in path.read_text().splitlines() if x.strip())
    base = cfg.get("base_url", "http://localhost:8080/"); out = []; seen = set()
    for url in seeds:
        if url not in seen and is_same_origin(url, base): seen.add(url); out.append(url)
    return out

def integer(cfg, key, default): return int(cfg.get(key, default))
def metric(value): return "N/A" if value is None else str(value)
def print_phase(p):
    print(f"[{p.name}]")
    print(f"  Unique URLs:       {p.unique_urls}")
    print(f"  Requests:          {p.requests}")
    print(f"  Elapsed:           {p.elapsed_sec:.1f}s")
    print(f"  Unique sinks:      {metric(p.unique_sinks)}")
    print(f"  Unique reports:    {metric(p.unique_reports)}")
    print(f"  Total reports:     {metric(p.total_reports)}")
    print(f"  Scans/failures:    {p.scans_started}/{p.scan_failures}")
    print(f"  Completed/retried: {p.scans_completed}/{p.scans_retried}")
    print(f"  Timeouts/restarts: {p.scan_timeouts}/{p.zap_restarts}")
    print(f"  Timed out:         {p.timed_out}")
    if p.source_counts: print(f"  URL sources:       {p.source_counts}")

def interrupt_on_sigterm(_signum, _frame):
    raise KeyboardInterrupt

def main():
    signal.signal(signal.SIGTERM, interrupt_on_sigterm)
    args = parse_args(); yml = Path(args.yml_file)
    root = yaml.safe_load(yml.read_text()); target = root["target"]["name"]
    crawl = root.get("crawl", {}); options = crawl.get("zap_hybrid", {}) or {}
    duration = args.max_duration or int(crawl.get("max_duration_sec", 600))
    seeds = load_seeds(target, crawl)
    log_dir = RESEARCH_DIR / "out/targets" / target / "logs"; log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"zap_hybrid_{datetime.datetime.now():%Y%m%d_%H%M%S}.log"
    log_file = log_path.open("w", encoding="utf-8"); stdout = sys.stdout; sys.stdout = Tee(stdout, log_file)
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)
    try:
        ensure_image(args.zap_image)
        config = CrawlConfig(base_url=crawl.get("base_url", "http://localhost:8080/"), max_pages=int(crawl.get("max_pages", 50)), max_duration_sec=duration, headless=True, auth_enabled=bool(crawl.get("auth", {}).get("enabled", False)), auth_type=crawl.get("auth", {}).get("type"), auth_credentials=crawl.get("auth", {}).get("credentials", {}) or {}, seed_urls=seeds)
        spider_max_duration = args.spider_max_duration if args.spider_max_duration is not None else integer(options, "spider_max_duration_sec", duration)
        hybrid = HybridZapConfig(spider_max_duration_sec=spider_max_duration, client_max_duration_sec=integer(options, "client_max_duration_sec", 0), max_crawl_depth=integer(options, "max_crawl_depth", 0), max_children=integer(options, "max_children", 0), spider_max_depth=integer(options, "spider_max_depth", 5), spider_max_children=integer(options, "spider_max_children", 10), number_of_browsers=integer(options, "number_of_browsers", 1), initial_load_time_sec=integer(options, "initial_load_time_sec", 0), page_load_time_sec=integer(options, "page_load_time_sec", 0), action_wait_time_sec=integer(options, "action_wait_time_sec", 0), shutdown_time_sec=integer(options, "shutdown_time_sec", 10), scope_check=str(options.get("scope_check", "STRICT")).upper(), logout_avoidance=bool(options.get("logout_avoidance", True)), explicit_seed_grace_sec=integer(options, "explicit_seed_grace_sec", 5), preparation_script=options.get("preparation_script"), client_scan_max_duration_sec=integer(options, "client_scan_max_duration_sec", 600), client_restart_every_scans=integer(options, "client_restart_every_scans", 25), progress_interval_sec=integer(options, "progress_interval_sec", 30), zap_max_heap_mb=integer(options, "zap_max_heap_mb", 4096), zap_memory_limit_mb=integer(options, "zap_memory_limit_mb", 8192), zap_pids_limit=integer(options, "zap_pids_limit", 2048), client_workers=args.client_workers or integer(options, "client_workers", 1))
        print("="*60); print(f"Hybrid ZAP Crawler: {target}"); print("="*60)
        client_limit = "unlimited" if hybrid.client_max_duration_sec == 0 else f"{hybrid.client_max_duration_sec}s"
        spider_limit = "unlimited" if hybrid.spider_max_duration_sec == 0 else f"{hybrid.spider_max_duration_sec}s"
        print(f"Base URL: {config.base_url}\nExplicit seeds: {len(seeds)}\nPhase limits: {spider_limit} / {client_limit}\nClient workers: {hybrid.client_workers}")
        if args.traditional_only: print("Mode: traditional-spider-only")
        checkpoint_path = RESEARCH_DIR / "out/targets" / target / "zap_hybrid_checkpoint.json"
        result = HybridZapCrawler(config, hybrid, zap_port=args.zap_port, api_key=args.api_key, zap_image=args.zap_image, browser_id=args.browser_id, checkpoint_path=checkpoint_path, resume=args.resume, checkpoint_scope=target).crawl(traditional_only=args.traditional_only)
        print("\n"+"="*60); print("Hybrid Crawl Results"); print("="*60)
        print_phase(result.traditional_spider); print_phase(result.client_spider)
        c = result.combined; print("[combined]")
        print(f"  Unique URLs:       {c.unique_urls_discovered}\n  Requests:          {c.requests_made}\n  Elapsed:           {c.elapsed_sec:.1f}s")
        print(f"  Unique sinks:      {metric(c.unique_sinks_collected)}\n  Unique reports:    {metric(c.unique_reports_collected)}\n  Total reports:     {metric(c.reports_collected)}")
        print(f"  URL sources:       {result.source_counts}")

        if c.visited_urls:
            print("\nVisited URLs:")
            for url in c.visited_urls:
                print(f"  {url}")
    finally:
        sys.stdout = stdout; log_file.close(); print(f"\n[log] Saved to {log_path}")
if __name__ == "__main__": main()
