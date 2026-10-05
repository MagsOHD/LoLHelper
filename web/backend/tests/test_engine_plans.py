from app.engine import Pick, Role, build_game_plan, build_matchup_plan

from .engine_fixtures import small_catalog

ALLY = [
    Pick(role=Role.TOP, champion_id="Malphite"),
    Pick(role=Role.JUNGLE, champion_id="JarvanIV"),
    Pick(role=Role.MID, champion_id="Orianna"),
    Pick(role=Role.BOTTOM, champion_id="Jinx"),
    Pick(role=Role.SUPPORT, champion_id="Leona"),
]
ENEMY = [
    Pick(role=Role.TOP, champion_id="Fiora"),
    Pick(role=Role.JUNGLE, champion_id="Khazix"),
    Pick(role=Role.MID, champion_id="Xerath"),
    Pick(role=Role.BOTTOM, champion_id="Ezreal"),
    Pick(role=Role.SUPPORT, champion_id="Lulu"),
]


def test_game_plan_engage_comp():
    plan = build_game_plan(ALLY, small_catalog())
    assert plan.detected_themes[0] == "engage"
    assert "Engage" in plan.identity
    assert plan.win_conditions and plan.objectives and plan.avoid
    assert [p.phase for p in plan.phases] == ["early", "mid", "late"]
    assert all(p.summary for p in plan.phases)
    assert len(plan.power_spikes) == 5
    assert any("Orianna" in c and "Malphite" in c for c in plan.key_combos)
    assert len(plan.role_tips) == 5 and all(t.tips for t in plan.role_tips)
    assert abs(sum(plan.damage_profile.values()) - 1) < 1e-6
    assert plan.damage_profile["AP"] > 0 and plan.damage_profile["AD"] > 0


def test_game_plan_thematic_and_yasuo_combo():
    picks = [
        Pick(role=Role.TOP, champion_id="Gnar"),
        Pick(role=Role.JUNGLE, champion_id="Poppy"),
        Pick(role=Role.MID, champion_id="Veigar"),
        Pick(role=Role.BOTTOM, champion_id="Tristana"),
        Pick(role=Role.SUPPORT, champion_id="Lulu"),
    ]
    plan = build_game_plan(picks, small_catalog())
    assert "yordles" in plan.detected_themes
    combo = build_game_plan(
        [Pick(role=Role.TOP, champion_id="Malphite"), Pick(role=Role.MID, champion_id="Yasuo")], small_catalog()
    )
    assert any("Yasuo" in c and "Malphite" in c for c in combo.key_combos)


def test_game_plan_empty_and_unknown():
    assert build_game_plan([], small_catalog()).identity
    plan = build_game_plan([Pick(role=Role.MID, champion_id="Unknown")], small_catalog())
    assert plan.role_tips[0].champion_id == "Unknown"


def test_matchup_plan():
    plan = build_matchup_plan(ALLY, ENEMY, small_catalog())
    assert plan.enemy_identity.startswith("Compo adverse")
    assert plan.enemy_themes and plan.enemy_win_conditions and plan.how_to_win
    assert 2 <= len(plan.threats) <= 4
    assert plan.threats[0].danger >= 2
    assert all(t.why and t.how_to_handle for t in plan.threats)
    enemy_ids = {p.champion_id for p in ENEMY}
    assert all(t.champion_id in enemy_ids for t in plan.threats)
    assert len(plan.lane_matchups) == 5 and all(m.advice for m in plan.lane_matchups)
    assert plan.objectives
    assert plan.suggested_bans
    taken = enemy_ids | {p.champion_id for p in ALLY}
    assert not set(plan.suggested_bans) & taken


def test_matchup_plan_without_enemy_gives_bans():
    plan = build_matchup_plan(ALLY, [], small_catalog())
    assert plan.suggested_bans and not plan.threats
