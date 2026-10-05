"""High level: fetch everything we store about a player from the Riot API."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol

from .aggregate import CatalogLike, aggregate_recent, map_masteries, pick_rank, summarize_match
from .client import RiotClient
from .errors import RiotNotFound

logger = logging.getLogger(__name__)


class MatchCache(Protocol):
    def get_cached_matches(self, match_ids: list[str]) -> dict[str, dict[str, Any]]: ...
    def put_cached_match(self, match_id: str, data: dict[str, Any]) -> None: ...


async def fetch_match_summaries(
    client: RiotClient,
    match_ids: list[str],
    region: str,
    cache: MatchCache | None = None,
    concurrency: int = 5,
) -> list[dict]:
    """Return match summaries in `match_ids` order, using the cache for known matches and
    fetching the others concurrently (bounded by a semaphore)."""
    cached = cache.get_cached_matches(match_ids) if cache is not None else {}
    missing = [m for m in match_ids if m not in cached]
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def fetch_one(match_id: str) -> tuple[str, dict | None]:
        async with semaphore:
            try:
                raw = await client.get_match(match_id, region)
            except RiotNotFound:
                logger.info("Match %s not found, skipped", match_id)
                return match_id, None
        summary = summarize_match(raw)
        if cache is not None:
            cache.put_cached_match(match_id, summary)
        return match_id, summary

    fetched = dict(await asyncio.gather(*(fetch_one(m) for m in missing)))
    out = []
    for match_id in match_ids:
        summary = cached.get(match_id) or fetched.get(match_id)
        if summary is not None:
            out.append(summary)
    return out


async def fetch_player_data(
    client: RiotClient,
    *,
    puuid: str,
    platform: str,
    region: str,
    catalog: CatalogLike,
    cache: MatchCache | None = None,
    match_count: int = 20,
    concurrency: int = 5,
) -> dict[str, Any]:
    """Returns {profile_icon_id, summoner_level, rank, masteries, recent}."""
    summoner, entries, masteries_raw, match_ids = await asyncio.gather(
        client.get_summoner_by_puuid(puuid, platform),
        client.get_league_entries(puuid, platform),
        client.get_top_masteries(puuid, platform, count=30),
        client.get_match_ids(puuid, region, count=match_count),
    )
    summaries = await fetch_match_summaries(client, match_ids, region, cache, concurrency)
    return {
        "profile_icon_id": summoner.get("profileIconId"),
        "summoner_level": summoner.get("summonerLevel"),
        "rank": pick_rank(entries),
        "masteries": map_masteries(masteries_raw, catalog),
        "recent": aggregate_recent(summaries, puuid, catalog),
    }
