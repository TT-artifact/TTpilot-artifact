#!/usr/bin/env python3
"""Shared Docker Compose utilities for eval run scripts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None


def expand_volumes_yaml(volumes_json: str, docker_context: str, research_root: str) -> str:
    """Convert volumes JSON array to YAML indented lines with {docker_context} expansion."""
    volumes = json.loads(volumes_json)
    lines = []
    for vol in volumes:
        vol_expanded = vol.replace("{docker_context}", f"{research_root}/{docker_context}")
        lines.append(f"      - {vol_expanded}")
    return "\n".join(lines)


def extract_env_for_unpatched(
    patched_compose_path: str,
    unpatched_port: int,
    patched_port: int,
) -> str:
    """Extract environment from patched compose, adapting it for the unpatched service.

    Replaces mysql hostname and patched port references so the unpatched
    container uses its own MySQL and port.
    """
    if yaml is None:
        raise ImportError("PyYAML is required for extract_env_for_unpatched")

    with open(patched_compose_path) as f:
        compose = yaml.safe_load(f)

    app = compose["services"]["app"]
    env = app.get("environment", {})
    lines: list[str] = []

    if isinstance(env, dict):
        for k, v in env.items():
            v_str = str(v)
            v_str = re.sub(r"\bmysql\b", "mysql-unpatched", v_str)
            v_str = v_str.replace(f":{patched_port}", f":{unpatched_port}")
            v_str = v_str.replace(f"localhost:{patched_port}", f"localhost:{unpatched_port}")
            lines.append(f"      {k}: {v_str}")
    elif isinstance(env, list):
        for item in env:
            item = re.sub(r"(DB_HOST=)\S+", r"\1mysql-unpatched", item)
            item = item.replace(f":{patched_port}", f":{unpatched_port}")
            lines.append(f"      - {item}")

    return "\n".join(lines)


def create_unpatched_compose(
    output_path: str,
    unpatched_dir: str,
    dockerfile_path: str,
    serve_port: int,
    host_port: int = 8081,
    volumes_yaml: str = "",
    needs_mysql: bool = False,
    mysql_host_port: int = 3307,
    network_name: str | None = None,
    env_yaml: str = "",
) -> None:
    """Write docker-compose.unpatched.yml to output_path."""
    env_section = f"    environment:\n{env_yaml}" if env_yaml else "    environment:\n      - NODE_ENV=production"
    volumes_section = f"    volumes:\n{volumes_yaml}" if volumes_yaml else ""
    depends_section = (
        "    depends_on:\n      mysql-unpatched:\n        condition: service_healthy"
        if needs_mysql
        else ""
    )
    network_service_section = f"    networks:\n      - {network_name}" if network_name else ""

    service_parts = [
        "services:",
        "  app-unpatched:",
        "    build:",
        f'      context: "{unpatched_dir}"',
        f'      dockerfile: "{dockerfile_path}"',
        "    ports:",
        f'      - "{host_port}:{serve_port}"',
        env_section,
    ]
    if depends_section:
        service_parts.append(depends_section)
    if network_service_section:
        service_parts.append(network_service_section)
    if volumes_section:
        service_parts.append(volumes_section)

    content = "\n".join(service_parts)

    if needs_mysql:
        mysql_net = f"\n    networks:\n      - {network_name}" if network_name else ""
        content += f"""

  mysql-unpatched:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: app_db
    healthcheck:
      test: [CMD, mysqladmin, ping, -h, localhost]
      interval: 5s
      timeout: 3s
      retries: 10
    ports:
      - "{mysql_host_port}:3306"{mysql_net}"""

    if network_name:
        content += f"""

networks:
  {network_name}:
    driver: bridge"""

    content = re.sub(r"\n{3,}", "\n\n", content).strip() + "\n"
    Path(output_path).write_text(content)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate docker-compose.unpatched.yml")
    parser.add_argument("--output", required=True, help="Output path for docker-compose.unpatched.yml")
    parser.add_argument("--unpatched-dir", required=True)
    parser.add_argument("--dockerfile", required=True)
    parser.add_argument("--serve-port", type=int, required=True)
    parser.add_argument("--host-port", type=int, default=8081)
    parser.add_argument("--volumes-json", default="[]")
    parser.add_argument("--docker-context", default="")
    parser.add_argument("--research-root", default="")
    parser.add_argument("--needs-mysql", action="store_true")
    parser.add_argument("--mysql-host-port", type=int, default=3307)
    parser.add_argument("--network-name", default=None)

    parser.add_argument("--patched-compose", default=None, help="Path to patched docker-compose.yml for env extraction")
    parser.add_argument("--patched-port", type=int, default=8080)
    parser.add_argument("--unpatched-port", type=int, default=8081)

    args = parser.parse_args()

    volumes_yaml = ""
    if args.volumes_json and args.volumes_json != "[]":
        volumes_yaml = expand_volumes_yaml(args.volumes_json, args.docker_context, args.research_root)

    env_yaml = ""
    if args.patched_compose:
        env_yaml = extract_env_for_unpatched(args.patched_compose, args.unpatched_port, args.patched_port)

    create_unpatched_compose(
        output_path=args.output,
        unpatched_dir=args.unpatched_dir,
        dockerfile_path=args.dockerfile,
        serve_port=args.serve_port,
        host_port=args.host_port,
        volumes_yaml=volumes_yaml,
        needs_mysql=args.needs_mysql,
        mysql_host_port=args.mysql_host_port,
        network_name=args.network_name,
        env_yaml=env_yaml,
    )
    print(f"Created: {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
