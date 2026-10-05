"""Data Dragon client with an on-disk cache and an offline fallback."""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DDRAGON_BASE = "https://ddragon.leagueoflegends.com"
VERSIONS_URL = f"{DDRAGON_BASE}/api/versions.json"
OFFLINE_VERSION = "offline"
VERSION_TTL_SECONDS = 6 * 3600


def profile_icon_url(version: str, icon_id: int | None) -> str:
    if icon_id is None or not version or version == OFFLINE_VERSION:
        return ""
    return f"{DDRAGON_BASE}/cdn/{version}/img/profileicon/{icon_id}.png"


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(p) for p in re.findall(r"\d+", version))


class DataDragonClient:
    def __init__(
        self,
        cache_dir: str | Path,
        locale: str = "fr_FR",
        *,
        http: httpx.AsyncClient | None = None,
        timeout: float = 5.0,
        version_ttl: float = VERSION_TTL_SECONDS,
    ):
        self.cache_dir = Path(cache_dir)
        self.locale = locale
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(timeout=timeout)
        self.version_ttl = version_ttl

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    # -- cache helpers -------------------------------------------------------------------
    @property
    def _version_file(self) -> Path:
        return self.cache_dir / "ddragon_version.json"

    def _champion_file(self, version: str) -> Path:
        return self.cache_dir / f"champion_{version}_{self.locale}.json"

    def _read_json(self, path: Path) -> Any | None:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _write_json(self, path: Path, data: Any) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except OSError as exc:
            logger.warning("Cannot write Data Dragon cache %s: %s", path, exc)

    def _latest_cached_champions(self) -> tuple[str, list[dict]] | None:
        files = list(self.cache_dir.glob(f"champion_*_{self.locale}.json"))
        candidates = []
        for f in files:
            version = f.name[len("champion_") : -len(f"_{self.locale}.json")]
            candidates.append((version, f))
        for version, f in sorted(candidates, key=lambda c: _version_key(c[0]), reverse=True):
            data = self._read_json(f)
            if isinstance(data, dict) and data.get("data"):
                return version, list(data["data"].values())
        return None

    # -- network -------------------------------------------------------------------------
    async def _fetch_json(self, url: str) -> Any:
        response = await self._http.get(url)
        response.raise_for_status()
        return response.json()

    async def latest_version(self) -> str | None:
        cached = self._read_json(self._version_file)
        if isinstance(cached, dict) and cached.get("version"):
            if time.time() - float(cached.get("fetched_at", 0)) < self.version_ttl:
                return cached["version"]
        try:
            versions = await self._fetch_json(VERSIONS_URL)
            version = versions[0]
            self._write_json(self._version_file, {"version": version, "fetched_at": time.time()})
            return version
        except (httpx.HTTPError, ValueError, IndexError, KeyError, TypeError) as exc:
            logger.warning("Data Dragon unreachable (versions): %s", exc)
            if isinstance(cached, dict) and cached.get("version"):
                return cached["version"]
            return None

    async def load_champions(self) -> tuple[str, list[dict]]:
        """Return (version, champion.json "data" values). Never raises: falls back to the disk
        cache, then to (`"offline"`, []) so the engine uses its curated data."""
        version = await self.latest_version()
        if version:
            path = self._champion_file(version)
            data = self._read_json(path)
            if isinstance(data, dict) and data.get("data"):
                return version, list(data["data"].values())
            url = f"{DDRAGON_BASE}/cdn/{version}/data/{self.locale}/champion.json"
            try:
                data = await self._fetch_json(url)
                if isinstance(data, dict) and data.get("data"):
                    self._write_json(path, data)
                    return version, list(data["data"].values())
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("Data Dragon unreachable (champion.json): %s", exc)
        fallback = self._latest_cached_champions()
        if fallback:
            logger.info("Using cached Data Dragon champions %s", fallback[0])
            return fallback
        logger.warning("No Data Dragon data available: running offline with curated data only")
        return OFFLINE_VERSION, []
