from app.engine import (
    ManualPoolEntry,
    MasteryEntry,
    PlayerPreferences,
    RecentChampionStat,
    Role,
    build_catalog,
    compute_pool,
    list_archetypes,
    list_themes,
)

from .engine_fixtures import base_meta, small_catalog

DDRAGON = [
    {
        "id": "Malphite", "key": "54", "name": "Malphite", "title": "le fragment du Monolithe",
        "tags": ["Tank", "Fighter"], "info": {"attack": 5, "defense": 9, "magic": 7, "difficulty": 2},
        "image": {"full": "Malphite.png"},
    },
    {
        "id": "Newchamp", "key": "999", "name": "Nouveau", "title": "le nouveau",
        "tags": ["Marksman"], "info": {"attack": 8, "defense": 3, "magic": 2, "difficulty": 6},
        "image": {"full": "Newchamp.png"},
    },
    {
        "id": "Newmage", "key": "998", "name": "Mage Neuf", "title": "",
        "tags": ["Mage", "Support"], "info": {"attack": 2, "defense": 3, "magic": 9, "difficulty": 5},
        "image": {"full": "Newmage.png"},
    },
]


def test_catalog_merges_ddragon_and_meta():
    cat = build_catalog(DDRAGON, "14.1.1", meta=base_meta())
    assert len(cat) == 3
    malph = cat.get("Malphite")
    assert malph.key == 54 and malph.title == "le fragment du Monolithe"
    assert malph.image_url == "https://ddragon.leagueoflegends.com/cdn/14.1.1/img/champion/Malphite.png"
    assert malph.archetype == "vanguard" and malph.region == "ixtal"
    assert malph.traits.engage == 3
    assert cat.by_key(54).id == "Malphite"
    assert cat.meta("Malphite")["playstyle"].startswith("Style de jeu")


def test_catalog_fallback_for_unknown_champions():
    cat = build_catalog(DDRAGON, "14.1.1", meta=base_meta())
    new = cat.get("Newchamp")
    assert new.archetype == "marksman"
    assert new.roles == [Role.BOTTOM]
    assert new.damage_type == "AD"
    assert new.traits.late == 3
    mage = cat.get("Newmage")
    assert mage.archetype == "enchanter" and mage.damage_type == "AP"
    assert cat.meta("Newchamp") == {"power_spikes": [], "playstyle": "", "counter_tips": ""}


def test_catalog_offline_uses_curated_only():
    cat = small_catalog()
    assert len(cat) == len(base_meta())
    assert cat.get("LeeSin").name == "Lee Sin"
    assert cat.get("leesin").id == "LeeSin"  # case-insensitive lookup
    assert cat.get("LeeSin").image_url == ""
    assert cat.get("Nope") is None
    names = [c.name for c in cat.all()]
    assert names == sorted(names, key=str.lower)


def test_archetypes_and_themes_listed():
    keys = {a.key for a in list_archetypes()}
    assert {"vanguard", "marksman", "enchanter"} <= keys
    themes = {t.key: t for t in list_themes()}
    for k in ("engage", "pick", "poke_siege", "protect_carry", "split_push", "dive", "early_snowball",
              "scaling", "skirmish", "yordles", "void", "shadow_isles", "noxus", "demacia", "freljord",
              "ionia", "piltover_zaun", "shurima", "full_ap", "full_ad", "lore"):
        assert k in themes
    assert themes["engage"].kind == "playstyle" and themes["yordles"].kind == "thematic"


def test_pool_comfort_from_masteries_and_recent():
    cat = small_catalog()
    now = 1_700_000_000_000
    pool = compute_pool(
        masteries=[
            MasteryEntry(champion_id="Ahri", level=7, points=150_000, last_play_time=now),
            MasteryEntry(champion_id="Zed", level=7, points=150_000, last_play_time=now - 400 * 86_400_000),
            MasteryEntry(champion_id="Lulu", level=2, points=3_000, last_play_time=now),
        ],
        recent=[RecentChampionStat(champion_id="Lulu", games=8, wins=6)],
        manual=[],
        preferences=PlayerPreferences(),
        catalog=cat,
    )
    by = {p.champion_id: p for p in pool}
    assert by["Ahri"].comfort > by["Zed"].comfort  # recency decay
    assert by["Ahri"].mastery_points == 150_000
    assert by["Lulu"].comfort > 0.6  # recent games boost a low mastery
    assert set(by["Lulu"].sources) == {"mastery", "recent"}
    assert [p.comfort for p in pool] == sorted((p.comfort for p in pool), reverse=True)
    assert all(0 <= p.comfort <= 1 and 0 <= p.desire <= 1 for p in pool)


def test_pool_preferences_manual_and_avoided():
    cat = small_catalog()
    pool = compute_pool(
        masteries=[
            MasteryEntry(champion_id="Ahri", level=7, points=150_000),
            MasteryEntry(champion_id="Yasuo", level=7, points=300_000),
        ],
        recent=[],
        manual=[ManualPoolEntry(champion_id="Ahri", comfort=0.2), ManualPoolEntry(champion_id="Veigar", comfort=0.8)],
        preferences=PlayerPreferences(
            wanted_champions=["Lulu"], wanted_archetypes=["assassin"], avoided_champions=["Yasuo"]
        ),
        catalog=cat,
    )
    by = {p.champion_id: p for p in pool}
    assert "Yasuo" not in by
    assert by["Ahri"].comfort == 0.2  # manual overrides
    assert by["Veigar"].comfort == 0.8 and by["Veigar"].sources == ["manual"]
    assert by["Lulu"].desire == 1.0 and by["Lulu"].comfort == 0 and "wanted" in by["Lulu"].sources
    assert by["Zed"].desire >= 0.6 and by["Khazix"].comfort == 0  # archetype wish
    assert pool[0].champion_id == "Veigar"
