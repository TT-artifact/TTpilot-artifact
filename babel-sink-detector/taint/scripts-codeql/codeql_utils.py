from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

CODEQL_CLI = os.environ.get("CODEQL_CLI", "tools/codeql/codeql")
BQRS_DECODE_TIMEOUT = 60

def decode_bqrs(bqrs_path: Path) -> str:

    result = subprocess.run(
        [CODEQL_CLI, "bqrs", "decode", str(bqrs_path), "--format=csv"],
        capture_output=True, text=True, timeout=BQRS_DECODE_TIMEOUT, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"codeql bqrs decode failed: {result.stderr.strip()}")
    return result.stdout

def run_codeql_query(
    codeql_db: Path,
    query_path: str,
    output_bqrs: Path,
    timeout: int,
) -> None:

    query_name = Path(query_path).stem
    logger.info("Running %s...", query_name)
    result = subprocess.run(
        [CODEQL_CLI, "query", "run",
         f"--database={codeql_db}",
         f"--output={output_bqrs}",
         query_path],
        capture_output=True, text=True, timeout=timeout, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{query_name} failed: {result.stderr.strip()}")
    logger.info("%s complete: %s", query_name, output_bqrs)

def run_python_script(script_path: str, args: list[str], timeout: int = 300) -> None:

    script_name = Path(script_path).stem
    result = subprocess.run(
        [sys.executable, script_path, *args],
        capture_output=True, text=True, check=False, timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{script_name} failed: {result.stderr.strip()}")
    if result.stdout.strip():
        logger.info("%s: %s", script_name, result.stdout.strip().split("\n")[-1])
