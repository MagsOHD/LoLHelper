"""Shared domain models between the composition engine, the API and the frontend."""

from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


class Role(str, Enum):
    TOP = "TOP"
    JUNGLE = "JUNGLE"
    MID = "MID"
    BOTTOM = "BOTTOM"
    SUPPORT = "SUPPORT"


DamageType = Literal["AD", "AP", "MIXED"]
ThemeKind = Literal["playstyle", "thematic"]


class ChampionTraits(BaseModel):
    """0 (none) to 3 (excellent) ratings used by the engine."""

    engage: int = 0
    peel: int = 0
    poke: int = 0
    waveclear: int = 0
    splitpush: int = 0
    pick: int = 0
    teamfight: int = 0
    early: int = 0
    late: int = 0
    mobility: int = 0
    frontline: int = 0
    cc: int = 0
    sustain: int = 0
    objective: int = 0


class ChampionInfo(BaseModel):
    id: str  # Data Dragon id, e.g. "MonkeyKing"
    key: int  # Data Dragon numeric key, e.g. 62 (used by champion-mastery-v4)
    name: str  # localized display name, e.g. "Wukong"
    title: str = ""
    image_url: str = ""
    tags: list[str] = []  # Data Dragon tags (Fighter, Mage, ...)
    roles: list[Role] = []  # viable positions, most common first
    archetype: str = ""  # key of an Archetype (character type)
    damage_type: DamageType = "AD"
    region: str = ""  # Runeterra faction key, e.g. "noxus", "" if none
    groups: list[str] = []  # extra thematic tags, e.g. "yordle", "void", "undead"
    traits: ChampionTraits = ChampionTraits()


class ArchetypeInfo(BaseModel):
    key: str
    label: str
    description: str


class ThemeInfo(BaseModel):
    key: str
    label: str
    kind: ThemeKind
    description: str


class MasteryEntry(BaseModel):
    champion_id: str
    level: int
    points: int
    last_play_time: Optional[int] = None  # epoch ms


class RecentChampionStat(BaseModel):
    champion_id: str
    games: int
    wins: int
    kills: float = 0
    deaths: float = 0
    assists: float = 0
    role: Optional[Role] = None  # most played position on that champion


class PlayerPreferences(BaseModel):
    roles: list[Role] = []  # ordered, first = favourite
    wanted_archetypes: list[str] = []
    wanted_champions: list[str] = []
    avoided_champions: list[str] = []


class ManualPoolEntry(BaseModel):
    champion_id: str
    comfort: float = Field(ge=0, le=1)


class PoolEntry(BaseModel):
    champion_id: str
    comfort: float = Field(ge=0, le=1)  # how well the player knows it
    desire: float = Field(ge=0, le=1)  # how much the player wants to play it
    sources: list[Literal["mastery", "recent", "manual", "wanted"]] = []


class PlayerInput(BaseModel):
    """Everything the engine needs about one player."""

    player_id: str
    name: str
    preferences: PlayerPreferences = PlayerPreferences()
    role_games: dict[Role, int] = {}  # recent games per position
    pool: list[PoolEntry] = []


class GenerationOptions(BaseModel):
    theme: Optional[str] = None  # None = best themes automatically
    role_assignments: dict[str, Role] = {}  # player_id -> forced role
    locked_picks: dict[str, str] = {}  # player_id -> champion_id
    bans: list[str] = []
    enemy_champions: list[str] = []
    count: int = Field(default=5, ge=1, le=20)
    exploration: float = Field(default=0.2, ge=0, le=1)  # 0 = only known champs, 1 = anything goes


class ScoreBreakdown(BaseModel):
    comfort: float  # 0..100
    desire: float
    theme_fit: float
    balance: float
    counter: Optional[float] = None  # only when enemy_champions given


class Pick(BaseModel):
    role: Role
    champion_id: str
    player_id: Optional[str] = None


class SuggestedPick(Pick):
    comfort: float = 0  # 0..1
    desire: float = 0  # 0..1
    reasons: list[str] = []  # short French sentences


class CompositionSuggestion(BaseModel):
    theme: str
    theme_label: str
    score: float  # 0..100
    breakdown: ScoreBreakdown
    picks: list[SuggestedPick]
    strengths: list[str] = []
    warnings: list[str] = []


class PhasePlan(BaseModel):
    phase: Literal["early", "mid", "late"]
    summary: str
    tips: list[str] = []


class RoleTip(BaseModel):
    role: Role
    champion_id: str
    tips: list[str]


class GamePlan(BaseModel):
    identity: str  # one-line description of what the comp is
    detected_themes: list[str]  # theme keys, best first
    win_conditions: list[str]
    phases: list[PhasePlan]
    power_spikes: list[str]
    key_combos: list[str]
    objectives: list[str]
    role_tips: list[RoleTip]
    avoid: list[str]  # things not to do
    damage_profile: dict[str, float]  # {"AD": .., "AP": .., "MIXED": ..} shares summing to 1


class ThreatInfo(BaseModel):
    champion_id: str
    danger: int = Field(ge=1, le=3)
    why: str
    how_to_handle: str


class LaneMatchup(BaseModel):
    role: Role
    ally_champion_id: str
    enemy_champion_id: str
    advice: str


class MatchupPlan(BaseModel):
    enemy_identity: str
    enemy_themes: list[str]
    enemy_win_conditions: list[str]
    how_to_win: list[str]
    threats: list[ThreatInfo]
    lane_matchups: list[LaneMatchup]
    objectives: list[str]
    suggested_bans: list[str] = []
