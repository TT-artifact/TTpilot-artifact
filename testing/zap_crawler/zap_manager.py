import subprocess
import tempfile
import time
import uuid
from typing import Optional

import requests
from zapv2 import ZAPv2

class ZapManager:

    def __init__(self, api_key: Optional[str] = None, zap_port: int = 8090, zap_image: str = "ghcr.io/zaproxy/zaproxy:stable"):
        self.api_key = api_key or str(uuid.uuid4())
        self.zap_port = zap_port
        self.zap_image = zap_image
        self._container_name = f"zap-{uuid.uuid4().hex[:8]}"
        self.process: Optional[subprocess.Popen] = None
        self.zap: Optional[ZAPv2] = None
        self._log_file = tempfile.NamedTemporaryFile(
            mode="w+", suffix=".log", delete=False, prefix="zap-"
        )

    def __enter__(self) -> ZAPv2:
        self._start_docker()
        self._wait_for_ready(timeout_sec=60)
        self.zap = ZAPv2(
            proxies={"http": f"http://127.0.0.1:{self.zap_port}", "https": f"http://127.0.0.1:{self.zap_port}"},
            apikey=self.api_key,
        )
        return self.zap

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        subprocess.run(["docker", "stop", self._container_name], timeout=15, check=False)
        if self.process:
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()

        try:
            self._log_file.close()
            import os
            os.unlink(self._log_file.name)
        except Exception:
            pass

    def _start_docker(self) -> None:
        print(f"[zap] Starting ZAP Docker (container: {self._container_name}) ...")
        cmd = [
            "docker",
            "run",
            "--rm",
            "--name",
            self._container_name,
            "--network",
            "host",
            self.zap_image,
            "zap.sh",
            "-daemon",
            "-port",
            str(self.zap_port),
            "-config",
            f"api.key={self.api_key}",
            "-config",
            "api.addrs.addr.regex=true",
            "-config",
            "api.addrs.addr.name=.*",
            "-config",
            "network.localServers.mainProxy.port=9999",
            "-config",
            "selenium.chromeArgs.arg.argument=--no-sandbox",
        ]
        self.process = subprocess.Popen(cmd, stdout=self._log_file, stderr=subprocess.STDOUT)

    def _wait_for_ready(self, timeout_sec: int = 60) -> None:
        url = f"http://127.0.0.1:{self.zap_port}/JSON/core/view/version/"
        start = time.time()
        last_status_time = 0
        while time.time() - start < timeout_sec:
            elapsed = time.time() - start
            try:
                resp = requests.get(url, params={"apikey": self.api_key}, timeout=2)
                if resp.status_code == 200:
                    print(f"[zap] ZAP ready on port {self.zap_port}")
                    return
            except requests.RequestException:
                pass

            if elapsed - last_status_time >= 10:
                print(f"[zap] Waiting for ZAP to be ready ({elapsed:.1f}s) ...")
                last_status_time = elapsed
            time.sleep(1)

        try:
            self._log_file.flush()
            with open(self._log_file.name, "r") as f:
                log_content = f.read()
                last_lines = log_content[-2000:] if len(log_content) > 2000 else log_content
                print(f"[zap] ZAP startup log (last 2000 chars):\n{last_lines}")
        except Exception:
            pass
        raise TimeoutError(f"ZAP not ready after {timeout_sec}s")
