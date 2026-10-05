"""Async client for the Riot Games API (account-v1, summoner-v4, league-v4,
champion-mastery-v4, match-v5)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable
from urllib.parse import quote

import httpx

from .errors import RiotAuthError, RiotError, RiotNotFound, RiotRateLimited
from .ratelimit import RateLimiter

logger = logging.getLogger(__name__)

RIOT_HOST = "https://{route}.api.riotgames.com"
RETRYABLE_SERVER_ERRORS = {500, 502, 503, 504}


def _retry_after_seconds(response: httpx.Response, default: float = 1.0) -> float:
    value = response.headers.get("Retry-After")
    if value is None:
        return default
    try:
        return max(0.0, float(value))
    except ValueError:
        return default


class RiotClient:
    def __init__(
        self,
        api_key: str,
        *,
        http: httpx.AsyncClient | None = None,
        limiter: RateLimiter | None = None,
        max_retries: int = 3,
        timeout: float = 10.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self.api_key = api_key
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(timeout=timeout)
        self.limiter = limiter if limiter is not None else RateLimiter()
        self.max_retries = max_retries
        self._sleep = sleep

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    # -- transport -----------------------------------------------------------------------
    async def _get(self, url: str, params: dict[str, Any] | None = None) -> Any:
        attempt = 0
        while True:
            await self.limiter.acquire()
            try:
                response = await self._http.get(
                    url, params=params, headers={"X-Riot-Token": self.api_key}
                )
            except httpx.HTTPError as exc:
                logger.warning("Riot API network error on %s: %s", url, exc)
                raise RiotError("Impossible de joindre l'API Riot. Vérifiez votre connexion.") from exc

            status = response.status_code
            if status == 200:
                return response.json()
            if status in (401, 403):
                raise RiotAuthError()
            if status == 404:
                raise RiotNotFound("Ressource introuvable sur l'API Riot.")
            if status == 429 or status in RETRYABLE_SERVER_ERRORS:
                if attempt >= self.max_retries:
                    if status == 429:
                        raise RiotRateLimited()
                    raise RiotError(f"L'API Riot ne répond pas correctement (HTTP {status}).")
                attempt += 1
                delay = _retry_after_seconds(response, default=1.0 * attempt)
                logger.info("Riot API HTTP %s on %s, retry %s in %.1fs", status, url, attempt, delay)
                await self._sleep(delay)
                continue
            raise RiotError(f"Erreur inattendue de l'API Riot (HTTP {status}).")

    # -- endpoints -----------------------------------------------------------------------
    async def get_account_by_riot_id(self, game_name: str, tag_line: str, region: str) -> dict:
        url = (
            f"{RIOT_HOST.format(route=region)}/riot/account/v1/accounts/by-riot-id/"
            f"{quote(game_name.strip(), safe='')}/{quote(tag_line.strip().lstrip('#'), safe='')}"
        )
        try:
            return await self._get(url)
        except RiotNotFound as exc:
            raise RiotNotFound(
                f"Riot ID introuvable : {game_name}#{tag_line}. Vérifiez l'orthographe et le tag."
            ) from exc

    async def get_summoner_by_puuid(self, puuid: str, platform: str) -> dict:
        url = f"{RIOT_HOST.format(route=platform)}/lol/summoner/v4/summoners/by-puuid/{quote(puuid, safe='')}"
        try:
            return await self._get(url)
        except RiotNotFound as exc:
            raise RiotNotFound(
                f"Aucun compte League of Legends trouvé sur le serveur {platform} pour ce joueur."
            ) from exc

    async def get_league_entries(self, puuid: str, platform: str) -> list[dict]:
        url = f"{RIOT_HOST.format(route=platform)}/lol/league/v4/entries/by-puuid/{quote(puuid, safe='')}"
        try:
            return await self._get(url) or []
        except RiotNotFound:
            return []

    async def get_top_masteries(self, puuid: str, platform: str, count: int = 30) -> list[dict]:
        url = (
            f"{RIOT_HOST.format(route=platform)}/lol/champion-mastery/v4/champion-masteries/"
            f"by-puuid/{quote(puuid, safe='')}/top"
        )
        try:
            return await self._get(url, params={"count": count}) or []
        except RiotNotFound:
            return []

    async def get_match_ids(self, puuid: str, region: str, count: int = 20, start: int = 0) -> list[str]:
        url = f"{RIOT_HOST.format(route=region)}/lol/match/v5/matches/by-puuid/{quote(puuid, safe='')}/ids"
        try:
            return await self._get(url, params={"start": start, "count": count}) or []
        except RiotNotFound:
            return []

    async def get_match(self, match_id: str, region: str) -> dict:
        url = f"{RIOT_HOST.format(route=region)}/lol/match/v5/matches/{quote(match_id, safe='')}"
        return await self._get(url)
