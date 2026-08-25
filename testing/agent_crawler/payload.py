"""Generate unique, non-malicious payloads for sink trigger attempts."""

import hashlib
import secrets


def generate_payload(sink_key: str) -> str:
    """Generate a unique payload for one sink trigger attempt.

    Format: tt-<sink_hash6>-<random4>
      - sink_hash6: first 6 hex chars of sink_key MD5 - links payload back to sink
      - random4:    2-byte random hex - unique per run, prevents cross-run collisions

    Example: tt-a3f9b2-c1d2
    """
    sink_hash = hashlib.md5(sink_key.encode()).hexdigest()[:6]
    random_suffix = secrets.token_hex(2)
    return f"tt-{sink_hash}-{random_suffix}"
