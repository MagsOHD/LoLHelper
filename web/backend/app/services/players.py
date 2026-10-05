"""Player-related use cases: response building, Riot sync, engine inputs."""

from __future__ import annotations

from typing import Any

from ..db import utc_now_iso
from ..engine.models import (
    ManualPoolEntry,
    MasteryEntry,
    PlayerInput,
    PlayerPreferences,
    RecentChampionStat,
    Role,
)
from ..riot import RiotNotConfigured, fetch_player_data, profile_icon_url
from ..riot.aggregate import empty_recent
from .schemas import Player, RecentSummary
from . import engine_bridge
from .state import AppContext


def _recent(row: dict[str, Any]) -> RecentSummary:
    return RecentSummary.model_validate(row.get("recent") or empty_recent())


def compute_player_pool(row: dict[str, Any], ctx: AppContext) -> list:
    recent = _recent(row)
    return engine_bridge.compute_pool(
        [MasteryEntry.model_validate(m) for m in row.get("masteries") or []],
        list(recent.champions),
        [ManualPoolEntry.model_validate(m) for m in row.get("manual_pool") or []],
        PlayerPreferences.model_validate(row.get("preferences") or {}),
        ctx.catalog,
    )


def to_player(row: dict[str, Any], ctx: AppContext) -> Player:
    return Player(
        id=row["id"],
        game_name=row["game_name"],
        tag_line=row["tag_line"],
        platform=row["platform"],
        puuid=row.get("puuid"),
        profile_icon_url=profile_icon_url(ctx.ddragon_version, row.get("profile_icon_id")),
        summoner_level=row.get("summoner_level"),
        rank=row.get("rank"),
        last_synced_at=row.get("last_synced_at"),
        preferences=PlayerPreferences.model_validate(row.get("preferences") or {}),
        masteries=row.get("masteries") or [],
        recent=_recent(row),
        manual_pool=row.get("manual_pool") or [],
        pool=compute_player_pool(row, ctx),
    )


def to_player_input(row: dict[str, Any], ctx: AppContext) -> PlayerInput:
    recent = _recent(row)
    return PlayerInput(
        player_id=row["id"],
        name=row["game_name"],
        preferences=PlayerPreferences.model_validate(row.get("preferences") or {}),
        role_games={Role(k): int(v) for k, v in recent.roles.items()},
        pool=compute_player_pool(row, ctx),
    )


async def fetch_riot_fields(ctx: AppContext, puuid: str, platform: str) -> dict[str, Any]:
    if ctx.riot is None:
        raise RiotNotConfigured()
    data = await fetch_player_data(
        ctx.riot,
        puuid=puuid,
        platform=platform,
        region=ctx.settings.region_for(platform),
        catalog=ctx.catalog,
        cache=ctx.db,
        match_count=ctx.settings.riot_match_count,
        concurrency=ctx.settings.riot_match_concurrency,
    )
    data["last_synced_at"] = utc_now_iso()
    return data


async def resolve_account(ctx: AppContext, game_name: str, tag_line: str, platform: str) -> dict:
    if ctx.riot is None:
        raise RiotNotConfigured()
    return await ctx.riot.get_account_by_riot_id(game_name, tag_line, ctx.settings.region_for(platform))
