"""Test doubles shared by the API / Riot tests (engine stubs, fake catalog, fixture loader)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.engine.models import (
    ArchetypeInfo,
    ChampionInfo,
    CompositionSuggestion,
    GamePlan,
    MatchupPlan,
    PoolEntry,
    Role,
    ScoreBreakdown,
    SuggestedPick,
    ThemeInfo,
)

FIXTURES = Path(__file__).resolve().parent


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


_CHAMPS = [
    ("Ahri", 103, "Ahri", [Role.MID]),
    ("Thresh", 412, "Thresh", [Role.SUPPORT]),
    ("MonkeyKing", 62, "Wukong", [Role.JUNGLE, Role.TOP]),
    ("Fiddlesticks", 9, "Fiddlesticks", [Role.JUNGLE]),
    ("Lux", 99, "Lux", [Role.SUPPORT, Role.MID]),
    ("Garen", 86, "Garen", [Role.TOP]),
    ("Jinx", 222, "Jinx", [Role.BOTTOM]),
    ("Leona", 89, "Leona", [Role.SUPPORT]),
    ("Darius", 122, "Darius", [Role.TOP]),
    ("LeeSin", 64, "Lee Sin", [Role.JUNGLE]),
]


class FakeCatalog:
    def __init__(self, version: str = "test"):
        self.version = version
        self._by_id = {
            cid: ChampionInfo(id=cid, key=key, name=name, roles=roles) for cid, key, name, roles in _CHAMPS
        }
        self._by_key = {c.key: c for c in self._by_id.values()}

    def get(self, champion_id: str):
        return self._by_id.get(champion_id)

    def by_key(self, key: int):
        return self._by_key.get(key)

    def all(self):
        return list(self._by_id.values())


class EngineStub:
    """Records calls; install with `install(monkeypatch)`."""

    def __init__(self):
        self.calls: dict[str, list[tuple]] = {}

    def _record(self, name: str, *args):
        self.calls.setdefault(name, []).append(args)

    def build_catalog(self, champions, version):
        self._record("build_catalog", champions, version)
        return FakeCatalog(version)

    def list_archetypes(self):
        return [
            ArchetypeInfo(key="mage", label="Mage", description="Dégâts magiques"),
            ArchetypeInfo(key="tank", label="Tank", description="Encaisse"),
        ]

    def list_themes(self):
        return [ThemeInfo(key="engage", label="Engage", kind="playstyle", description="Fonce")]

    def compute_pool(self, masteries, recent, manual, preferences, catalog):
        self._record("compute_pool", masteries, recent, manual, preferences, catalog)
        out = {m.champion_id: PoolEntry(champion_id=m.champion_id, comfort=m.comfort, desire=0.5, sources=["manual"]) for m in manual}
        for m in masteries:
            out.setdefault(m.champion_id, PoolEntry(champion_id=m.champion_id, comfort=0.8, desire=0.5, sources=["mastery"]))
        return sorted(out.values(), key=lambda p: -p.comfort)

    def generate_compositions(self, players, options, catalog):
        self._record("generate_compositions", players, options, catalog)
        roles = list(Role)
        picks = [
            SuggestedPick(role=roles[i], champion_id=(p.pool[0].champion_id if p.pool else "Garen"), player_id=p.player_id)
            for i, p in enumerate(players)
        ]
        return [
            CompositionSuggestion(
                theme="engage",
                theme_label="Engage",
                score=80,
                breakdown=ScoreBreakdown(comfort=80, desire=70, theme_fit=90, balance=60),
                picks=picks,
            )
        ]

    def build_game_plan(self, picks, catalog):
        self._record("build_game_plan", picks, catalog)
        return GamePlan(
            identity="Compo test", detected_themes=["engage"], win_conditions=[], phases=[], power_spikes=[],
            key_combos=[], objectives=[], role_tips=[], avoid=[], damage_profile={"AD": 0.5, "AP": 0.5, "MIXED": 0.0},
        )

    def build_matchup_plan(self, ally, enemy, catalog):
        self._record("build_matchup_plan", ally, enemy, catalog)
        return MatchupPlan(
            enemy_identity="Adversaire test", enemy_themes=[], enemy_win_conditions=[], how_to_win=[],
            threats=[], lane_matchups=[], objectives=[],
        )

    def install(self, monkeypatch) -> "EngineStub":
        from app.services import engine_bridge

        for name in (
            "build_catalog", "list_archetypes", "list_themes", "compute_pool",
            "generate_compositions", "build_game_plan", "build_matchup_plan",
        ):
            monkeypatch.setattr(engine_bridge, name, getattr(self, name))
        return self


class OfflineDDragon:
    """Data Dragon double: never touches the network."""

    def __init__(self, version: str = "offline", champions: list[dict] | None = None):
        self.version, self.champions = version, champions or []

    async def load_champions(self):
        return self.version, list(self.champions)

    async def aclose(self):
        pass
