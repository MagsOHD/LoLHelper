import time

import pytest

from app.engine import GenerationOptions, PlayerInput, PoolEntry, Role, generate_compositions
from app.engine.themes import get_theme

from .engine_fixtures import big_catalog, five_players, player, small_catalog


def _ids(s):
    return [p.champion_id for p in s.picks]


def _check_valid(suggestions, players, cat, options):
    for s in suggestions:
        roles = [p.role for p in s.picks]
        champs = _ids(s)
        assert len(s.picks) == len(players)
        assert len(set(roles)) == len(roles)
        assert len(set(champs)) == len(champs)
        assert {p.player_id for p in s.picks} == {p.player_id for p in players}
        for p in s.picks:
            assert p.champion_id not in options.bans
            assert p.champion_id not in options.enemy_champions
            info = cat.get(p.champion_id)
            if p.player_id not in options.locked_picks:
                assert p.role in info.roles, (p.champion_id, p.role)
            assert p.reasons
        assert 0 <= s.score <= 100


def test_auto_mode_diverse_themes_and_sorted():
    cat = big_catalog()
    players = five_players()
    opts = GenerationOptions(count=5)
    res = generate_compositions(players, opts, cat)
    assert len(res) == 5
    _check_valid(res, players, cat, opts)
    assert [r.score for r in res] == sorted((r.score for r in res), reverse=True)
    assert len({r.theme for r in res}) == 5
    assert len({tuple(sorted(_ids(r))) for r in res}) == 5
    # players get their favourite roles when nothing prevents it
    best = res[0]
    roles = {p.player_id: p.role for p in best.picks}
    assert roles == {"alice": Role.TOP, "bob": Role.JUNGLE, "carl": Role.MID, "dana": Role.BOTTOM, "eve": Role.SUPPORT}


def test_constraints_bans_locks_forced_roles_avoided():
    cat = big_catalog()
    players = five_players()
    players[2].preferences.avoided_champions = ["Orianna"]
    opts = GenerationOptions(
        theme="engage",
        bans=["Malphite", "Leona"],
        enemy_champions=["Jinx"],
        locked_picks={"bob": "Amumu"},
        role_assignments={"alice": Role.SUPPORT, "eve": Role.TOP},
        count=4,
    )
    res = generate_compositions(players, opts, cat)
    assert len(res) == 4
    _check_valid(res, players, cat, opts)
    for s in res:
        by = {p.player_id: p for p in s.picks}
        assert by["bob"].champion_id == "Amumu"
        assert "Choix verrouillé" in by["bob"].reasons
        assert by["alice"].role == Role.SUPPORT and by["eve"].role == Role.TOP
        assert "Orianna" not in _ids(s)
        assert s.breakdown.counter is not None


def test_thematic_theme_respected_when_feasible():
    cat = big_catalog()
    res = generate_compositions(five_players(), GenerationOptions(theme="yordles", count=3), cat)
    theme = get_theme("yordles")
    assert res
    for s in res:
        assert s.theme == "yordles"
        champs = [cat.data(c) for c in _ids(s)]
        assert theme.satisfied(champs)
        assert sum(1 for c in champs if "yordle" in c.groups) >= 3
    assert any("Thème respecté" in x for x in res[0].strengths)


def test_full_ap_theme():
    cat = big_catalog()
    res = generate_compositions(five_players(), GenerationOptions(theme="full_ap", count=2), cat)
    for s in res:
        assert all(cat.get(c).damage_type in ("AP", "MIXED") for c in _ids(s))


def test_determinism():
    cat = big_catalog()
    opts = GenerationOptions(count=6, exploration=0.5)
    a = generate_compositions(five_players(), opts, cat)
    b = generate_compositions(five_players(), opts, cat)
    assert [x.model_dump() for x in a] == [x.model_dump() for x in b]


def test_count_and_fewer_players():
    cat = big_catalog()
    players = five_players()[:2]
    res = generate_compositions(players, GenerationOptions(theme="dive", count=7), cat)
    assert len(res) == 7
    _check_valid(res, players, cat, GenerationOptions())
    assert generate_compositions([], GenerationOptions(), cat) == []


def test_empty_pools_still_produce_valid_lineups():
    cat = small_catalog()
    players = [PlayerInput(player_id=f"p{i}", name=f"P{i}") for i in range(5)]
    opts = GenerationOptions(count=3, exploration=0)
    res = generate_compositions(players, opts, cat)
    assert len(res) == 3
    _check_valid(res, players, cat, opts)


def test_wanted_archetype_and_exploration():
    cat = small_catalog()
    p = player("solo", [Role.MID], {"Orianna": 0.9}, wanted_archetypes=["assassin"])
    p.pool.append(PoolEntry(champion_id="Zed", comfort=0.0, desire=0.6, sources=["wanted"]))
    res = generate_compositions([p], GenerationOptions(theme="pick", count=3, exploration=0.6), cat)
    ids = [_ids(s)[0] for s in res]
    assert "Zed" in ids
    zed = next(s for s in res if _ids(s)[0] == "Zed").picks[0]
    assert any("Correspond à ton envie : " in r for r in zed.reasons)


def test_runtime_under_one_second():
    cat = big_catalog()
    all_ids = sorted(c.id for c in cat.all())
    players = []
    for i, role in enumerate([Role.TOP, Role.JUNGLE, Role.MID, Role.BOTTOM, Role.SUPPORT]):
        pool = {cid: round(0.95 - 0.02 * k, 2) for k, cid in enumerate(all_ids[i * 25: i * 25 + 40])}
        players.append(player(f"p{i}", [role], pool))
    for theme in (None, "engage", "yordles"):
        t0 = time.perf_counter()
        res = generate_compositions(players, GenerationOptions(theme=theme, count=5, exploration=0.3), cat)
        elapsed = time.perf_counter() - t0
        assert res
        assert elapsed < 1.0, (theme, elapsed)


def test_too_many_players():
    with pytest.raises(ValueError):
        generate_compositions(five_players() + five_players()[:1], GenerationOptions(), small_catalog())
