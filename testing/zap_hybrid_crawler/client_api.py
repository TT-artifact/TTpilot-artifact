from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import requests

class ClientSpiderUnavailable(RuntimeError):

    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable

@dataclass
class ClientSpiderAPI:
    port: int
    api_key: str
    timeout: float = 10.0

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _call(self, component: str, kind: str, name: str, **params: Any) -> dict:
        url = f"{self.base_url}/JSON/{component}/{kind}/{name}/"
        response = requests.get(
            url,
            params={"apikey": self.api_key, **params},
            timeout=self.timeout,
        )
        try:
            data = response.json()
        except ValueError as exc:
            raise ClientSpiderUnavailable(
                f"Client Spider returned a non-JSON response ({response.status_code})"
            ) from exc
        if response.status_code >= 400 or "code" in data:
            message = data.get("message") or data.get("detail") or str(data)

            retryable = not (400 <= response.status_code < 500)
            raise ClientSpiderUnavailable(
                f"Client Spider API error: {message}", retryable=retryable
            )
        return data

    def validate(self, minimum_version: tuple[int, int, int] = (0, 30, 0)) -> None:
        try:
            data = self._call("autoupdate", "view", "installedAddons")
            addons = data.get("addons") or data.get("installedAddons") or []
            client = next((item for item in addons if item.get("id") == "client"), None)
            if not client:
                raise ClientSpiderUnavailable("Client Side Integration add-on is not installed")
            raw_version = str(client.get("version", "0"))
            parts = tuple(int(part) for part in raw_version.split(".")[:3])
            version = parts + (0,) * (3 - len(parts))
            if version < minimum_version:
                required = ".".join(map(str, minimum_version))
                raise ClientSpiderUnavailable(
                    f"Client Side Integration {raw_version} is too old; require >= {required}"
                )
        except (requests.RequestException, ClientSpiderUnavailable, ValueError) as exc:
            raise ClientSpiderUnavailable(
                "ZAP Client Spider is unavailable or outdated. Install/update the Client "
                "Side Integration add-on (>= 0.30.0) and enable its browser extension."
            ) from exc

    def set_option(
        self, option: str, value: Any, *, parameter: str = "Integer", required: bool = True
    ) -> bool:
        try:
            self._call(
                "clientSpider", "action", f"setOption{option}", **{parameter: value}
            )
            return True
        except (requests.RequestException, ClientSpiderUnavailable):
            if required:
                raise
            return False

    def configure(
        self,
        *,
        max_children: int,
        max_duration_min: int,
        logout_avoidance: bool,
    ) -> None:

        integer_options = {
            "MaxChildren": max_children,
            "MaxDuration": max_duration_min,
        }
        for name, value in integer_options.items():
            self.set_option(name, value)
        self.set_option(
            "LogoutAvoidance", str(logout_avoidance).lower(), parameter="Boolean"
        )

    def scan(
        self,
        *,
        url: str,
        browser: str,
        max_crawl_depth: int,
        page_load_time: int,
        number_of_browsers: int,
        scope_check: str,
    ) -> str:
        data = self._call(
            "clientSpider",
            "action",
            "scan",
            browser=browser,
            url=url,
            subtreeOnly="false",
            maxCrawlDepth=max_crawl_depth,
            pageLoadTime=page_load_time,
            numberOfBrowsers=number_of_browsers,
            scopeCheck=scope_check,
        )
        scan_id = data.get("scanId") or data.get("scan")
        if scan_id is None:
            raise ClientSpiderUnavailable(f"Client Spider returned no scan id: {data}")
        return str(scan_id)

    def status(self, scan_id: str | None = None) -> int:
        params = {"scanId": scan_id} if scan_id is not None else {}
        data = self._call("clientSpider", "view", "status", **params)
        raw = data.get("status", 0)
        return int(raw)

    def stop(self, scan_id: str) -> None:
        self._call("clientSpider", "action", "stop", scanId=scan_id)
