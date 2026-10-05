"""API request/response models (domain models come from app.engine.models)."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from ..engine.models import (
    CompositionSuggestion,
    GenerationOptions,
    ManualPoolEntry,
    MasteryEntry,
    Pick,
    PlayerPreferences,
    PoolEntry,
    RecentChampionStat,
    Role,
)


class Rank(BaseModel):
    queue: str
    tier: str
    division: str = ""
    lp: int = 0
    wins: int = 0
    losses: int = 0


def _empty_roles() -> dict[Role, int]:
    return {r: 0 for r in Role}


class RecentSummary(BaseModel):
    games: int = 0
    roles: dict[Role, int] = Field(default_factory=_empty_roles)
    champions: list[RecentChampionStat] = []


class Player(BaseModel):
    id: str
    game_name: str
    tag_line: str
    platform: str
    puuid: Optional[str] = None
    profile_icon_url: str = ""
    summoner_level: Optional[int] = None
    rank: Optional[Rank] = None
    last_synced_at: Optional[str] = None
    preferences: PlayerPreferences = PlayerPreferences()
    masteries: list[MasteryEntry] = []
    recent: RecentSummary = Field(default_factory=RecentSummary)
    manual_pool: list[ManualPoolEntry] = []
    pool: list[PoolEntry] = []


class PlayerCreate(BaseModel):
    game_name: str = Field(min_length=1, max_length=64)
    tag_line: str = Field(min_length=1, max_length=16)
    platform: Optional[str] = None


class PoolUpdate(BaseModel):
    champions: list[ManualPoolEntry]


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    player_ids: list[str] = []


class Team(BaseModel):
    id: str
    name: str
    player_ids: list[str]
    created_at: str


class GenerateRequest(BaseModel):
    player_ids: list[str]
    options: GenerationOptions = GenerationOptions()


class GenerateResponse(BaseModel):
    suggestions: list[CompositionSuggestion]


class GamePlanRequest(BaseModel):
    picks: list[Pick]


class EnemyPick(BaseModel):
    champion_id: str
    role: Optional[Role] = None


class MatchupRequest(BaseModel):
    ally: list[Pick] = []
    enemy: list[EnemyPick]


class SavedCompositionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    team_id: Optional[str] = None
    theme: Optional[str] = None
    picks: list[Pick]
    notes: Optional[str] = None


class SavedComposition(SavedCompositionIn):
    id: str
    created_at: str


class Meta(BaseModel):
    ddragon_version: str
    riot_configured: bool
    platform: str
    region: str
    platforms: list[str]
