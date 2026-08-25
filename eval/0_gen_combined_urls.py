#!/usr/bin/env python3
"""
Generate combined_urls.yaml for each app by running get_combined_urls.py.

For each app in out/targets/, runs:
  python3 eval/utils/get_combined_urls.py \
    --target-dir out/targets/{app} \
    --base-url http://localhost:8080 \
    --target-url http://localhost:8080

Output: out/targets/{app}/eval/combined_urls.yaml
  - Supports comments for disabling specific URLs
  - Format: YAML with urls array
  - Example: Comment out URLs with '#' to disable them
"""

import json
import subprocess
import sys
from pathlib import Path
from datetime import datetime

APP_ORDER = [
    "urlpages",
    "beep.js",
    "railroad-diagrams",
    "go2rtc",
    "reveal.js",
    "umbraco",
    "cesiumjs",
    "copyparty",
    "draw.io",
    "microweber",
    "elementor",
    "squidex",
    "cacti"
]

BASE_URL = "http://localhost:8080"
TARGET_URL = "http://localhost:8080"


def main():
    research_dir = Path(__file__).parent.parent
    targets_dir = research_dir / "out" / "targets"
    utils_script = research_dir / "eval" / "utils" / "get_combined_urls.py"

    if not utils_script.exists():
        print(f"Error: {utils_script} not found")
        return

    print(f"\n=== Generating combined_urls.yaml for all apps ===\n")

    for app_name in APP_ORDER:
        app_dir = targets_dir / app_name
        if not app_dir.exists():
            print(f"Warning: {app_dir} not found, skipping")
            continue

        eval_dir = app_dir / "eval"
        eval_dir.mkdir(parents=True, exist_ok=True)
        output_file = eval_dir / "combined_urls.yaml"

        cmd = [
            sys.executable,
            str(utils_script),
            "--target-dir", str(app_dir),
            "--base-url", BASE_URL,
            "--target-url", TARGET_URL,
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                print(f"Error: {app_name}: Command failed")
                print(f"  stderr: {result.stderr.strip()}")
                continue


            urls = json.loads(result.stdout.strip())


            with open(output_file, "w") as f:

                f.write(f"# Combined URLs for {app_name}\n")
                f.write(f"# Generated: {datetime.now().isoformat()}\n")
                f.write(f"# Total URLs: {len(urls)}\n")
                f.write(f"# Note: Comment out URLs with '#' to disable them\n\n")


                f.write("metadata:\n")
                f.write(f"  description: Combined URLs from crawler logs and reports.db\n")
                f.write(f"  count: {len(urls)}\n")
                f.write(f"  generated: {datetime.now().isoformat()}\n\n")


                f.write("urls:\n")
                for url in urls:
                    f.write(f"  - {url}\n")

            print(f"OK: {app_name}: {len(urls)} URLs -> {output_file.relative_to(research_dir)}")

        except subprocess.TimeoutExpired:
            print(f"Error: {app_name}: Timeout")
        except json.JSONDecodeError:
            print(f"Error: {app_name}: Invalid JSON output")
        except Exception as e:
            print(f"Error: {app_name}: {e}")

    print("\nAll apps processed")


if __name__ == "__main__":
    main()
