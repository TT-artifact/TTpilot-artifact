from __future__ import annotations

import subprocess
from typing import Any

from zap_crawler.zap_manager import ZapManager

class HybridZapManager(ZapManager):
    def __init__(
        self,
        *args: Any,
        client_options: dict[str, Any] | None = None,
        max_heap_mb: int = 4096,
        memory_limit_mb: int = 8192,
        pids_limit: int = 2048,
        internal_proxy_port: int = 9999,
        **kwargs: Any,
    ):
        super().__init__(*args, **kwargs)
        self.client_options = client_options or {}
        self.max_heap_mb = max_heap_mb
        self.memory_limit_mb = memory_limit_mb
        self.pids_limit = pids_limit
        self.internal_proxy_port = internal_proxy_port

    def _start_docker(self) -> None:
        print(f"[zap] Starting hybrid ZAP Docker (container: {self._container_name}) ...")
        cmd = [
            "docker", "run", "--rm", "--name", self._container_name,
            "--network", "host",
            "--memory", f"{self.memory_limit_mb}m",
            "--pids-limit", str(self.pids_limit),
            self.zap_image, "zap.sh", f"-Xmx{self.max_heap_mb}m",
            "-daemon", "-port", str(self.zap_port),
            "-config", f"api.key={self.api_key}",
            "-config", "api.addrs.addr.regex=true",
            "-config", "api.addrs.addr.name=.*",
            "-config", f"network.localServers.mainProxy.port={self.internal_proxy_port}",
            "-config", "selenium.chromeArgs.arg.argument=--no-sandbox",
        ]
        for key, value in self.client_options.items():
            if isinstance(value, bool):
                value = str(value).lower()
            cmd.extend(["-config", f"client.spider.{key}={value}"])
        self.process = subprocess.Popen(
            cmd, stdout=self._log_file, stderr=subprocess.STDOUT
        )
