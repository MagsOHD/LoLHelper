"""Smoke tests on the real curated data files (skipped when they are not present)."""

import time

import pytest

from app.engine import (
    GenerationOptions,
    MasteryEntry,
    Pick,
    PlayerInput,
    PlayerPreferences,
    Role,
    build_catalog,
    build_game_plan,
    build_matchup_plan,
    compute_pool,
    generate_compositions,
    list_themes,
)
from app.engine.catalog import DATA_DIR

pytestmark = pytest.mark.skipif(
    not (DATA_DIR / "champions_meta.json").exists(), reason="curated champion data not available"
)

ROLES = [Role.TOP, Role.JUNGLE, Role.MID, Role.BOTTOM, Role.SUPPORT]


@pytest.fixture(scope="module")
def catalog():
    cat = build_catalog([], "")
    assert len(cat) > 100
    return cat


@pytest.fixture(scope="module")
def players(catalog):
    out = []
    for i, role in enumerate(ROLES):
        champs = [c for c in catalog.all() if role in c.roles]
        masteries = [
            MasteryEntry(champion_id=c.id, level=7, points=200_000 - 4_000 * k)
            for k, c in enumerate(champs[i * 3: i * 3 + 40])
        ]
        prefs = PlayerPreferences(roles=[role, ROLES[(i + 1) % 5]], wanted_archetypes=["assassin"] if i == 2 else [])
        pool = compute_pool(masteries, [], [], prefs, catalog)
        out.append(PlayerInput(player_id=f"p{i}", name=f"P{i}", preferences=prefs, pool=pool))
    return out


def test_every_theme_generates_on_real_data(catalog, players):
    for theme in [None] + [t.key for t in list_themes()]:
        t0 = time.perf_counter()
        res = generate_compositions(players, GenerationOptions(theme=theme, count=3, exploration=0.3), catalog)
        assert time.perf_counter() - t0 < 1.5, theme
        assert res, theme
        for s in res:
            assert len({p.champion_id for p in s.picks}) == 5
            assert len({p.role for p in s.picks}) == 5


def test_plans_on_real_data(catalog, players):
    res = generate_compositions(players, GenerationOptions(count=2), catalog)
    ally = [Pick(role=p.role, champion_id=p.champion_id) for p in res[0].picks]
    enemy = [Pick(role=p.role, champion_id=p.champion_id) for p in res[1].picks]
    gp = build_game_plan(ally, catalog)
    assert gp.identity and gp.win_conditions and gp.role_tips
    mp = build_matchup_plan(ally, enemy, catalog)
    assert mp.threats and mp.lane_matchups and mp.suggested_bans
