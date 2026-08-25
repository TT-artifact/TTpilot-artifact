#!/usr/bin/env python3
"""Run the resumable, sandboxed grouped Claude agent crawler."""
from __future__ import annotations
import argparse, datetime as dt, json, logging, re, sqlite3, sys, time
from dataclasses import asdict
from pathlib import Path
import yaml
from dotenv import load_dotenv
sys.path.insert(0, str(Path(__file__).parent.parent / "testing"))
from agent_crawler import AgentCrawler, AgentCrawlerConfig


def parse_args():
    p = argparse.ArgumentParser(description="Sandboxed evidence-based agent crawler")
    p.add_argument("yml_file")
    p.add_argument("--model-fast", default="haiku")
    p.add_argument("--model-escalation", default="sonnet")
    p.add_argument("--max-turns", type=int, default=20,
                   help="Claude tool-turn limit for the Haiku stage")
    p.add_argument("--max-progress-turns", type=int, default=32,
                   help="combined Haiku + optional Sonnet tool-turn ceiling")
    p.add_argument("--max-budget-fast", type=float, default=0.75,
                   help="maximum cost for each Haiku stage")
    p.add_argument("--max-budget-escalation", type=float, default=1.50,
                   help="maximum cost for each Sonnet escalation stage")
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--group-size", type=int, default=20)
    p.add_argument("--headless", type=lambda v: v.lower() != "false", default=True)
    p.add_argument("--no-resume", action="store_true")
    p.add_argument("--retry-timeouts", action="store_true",
                   help="retry sinks whose latest attempt timed out")
    p.add_argument("--retry-stalled", action="store_true",
                   help="retry turn-limited sinks that recorded no workflow progress")
    return p.parse_args()


def main() -> int:
    load_dotenv()
    args = parse_args()
    if not (1 <= args.max_turns <= args.max_progress_turns):
        raise ValueError("require 1 <= max-turns <= max-progress-turns")
    if (min(args.workers, args.timeout, args.group_size) < 1
            or min(args.max_budget_fast, args.max_budget_escalation) <= 0):
        raise ValueError("workers, timeout and group-size must be positive")
    cfg = yaml.safe_load(Path(args.yml_file).read_text(encoding="utf-8"))
    name = cfg["target"]["name"]
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", name):
        raise ValueError(f"invalid target name: {name}")
    out = Path("out/targets") / name
    sinks, reports, source = out / "sinks.db", out / "reports.db", out / "src"
    for path in (sinks, reports, source):
        if not path.exists():
            raise FileNotFoundError(path)
    logs = out / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / f"agent_{dt.datetime.now():%Y%m%d_%H%M%S}.log"
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                        handlers=[logging.StreamHandler(), logging.FileHandler(log_path)])
    crawl_cfg, auth = cfg.get("crawl", {}), cfg.get("crawl", {}).get("auth", {})
    fast_turns = args.max_turns
    config = AgentCrawlerConfig(
        base_url=crawl_cfg.get("base_url", "http://localhost:8080/"),
        sinks_db_path=str(sinks.resolve()), reports_db_path=str(reports.resolve()),
        source_root=str(source.resolve()), headless=args.headless,
        auth_enabled=auth.get("enabled", False), auth_type=auth.get("type"),
        auth_credentials=auth.get("credentials", {}), max_workers=args.workers,
        timeout_secs=args.timeout, project_root=str(Path.cwd().resolve()),
        venv_python=sys.executable, resume=not args.no_resume, group_size=args.group_size,
        model_fast=args.model_fast, model_escalation=args.model_escalation,
        max_turns=args.max_turns, max_progress_turns=args.max_progress_turns,
        fast_turns=fast_turns,
        escalation_turns=max(1, args.max_progress_turns - fast_turns),
        fast_budget_usd=args.max_budget_fast,
        escalation_budget_usd=args.max_budget_escalation,
        retry_timeouts=args.retry_timeouts, retry_stalled=args.retry_stalled,
    )
    crawler = AgentCrawler(config)
    started_at = time.time()
    results = crawler.run()
    counts = {}
    for result in results:
        counts[result.reach] = counts.get(result.reach, 0) + 1
    output = {"app": name, "crawl_run_id": crawler.crawl_run_id,
              "timestamp": dt.datetime.now().isoformat(), "cumulative": counts,
              "this_run": crawler.state.summary(crawler.crawl_run_id),
              "results": [asdict(result) for result in results]}
    rendered = json.dumps(output, indent=2, ensure_ascii=False)
    (crawler.run_dir / "results.json").write_text(rendered, encoding="utf-8")
    manifest_config = asdict(config)
    manifest_config["auth_credentials"] = {"configured": bool(config.auth_credentials)}
    (crawler.run_dir / "manifest.json").write_text(json.dumps({
        "crawl_run_id": crawler.crawl_run_id, "config": manifest_config,
        "summary": output["this_run"]}, indent=2, ensure_ascii=False), encoding="utf-8")
    all_urls = {url for result in results for url in result.urls_visited}
    actions = sum(result.actions_taken for result in results)
    with sqlite3.connect(reports) as conn:
        has_events = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_report_events'").fetchone()
        total_reports = conn.execute("SELECT COUNT(*) FROM agent_report_events").fetchone()[0] if has_events else 0
    logging.info("Crawl Results")
    logging.info("Pages visited: %d", len(all_urls))
    logging.info("Actions performed: %d", actions)
    logging.info("Elapsed time: %.1fs", time.time() - started_at)
    logging.info("Unique sinks triggered: %d", counts.get("reachable", 0))
    logging.info("Total reports: %d", total_reports)
    (out / "agent_results.json").write_text(rendered, encoding="utf-8")
    logging.info("agent crawl %s cumulative=%s", crawler.crawl_run_id, counts)
    logging.info("results=%s", crawler.run_dir / "results.json")
    return 2 if any(r.status == "infra_failed" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
