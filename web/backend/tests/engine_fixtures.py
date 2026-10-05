"""In-test champion data for the engine tests (independent from the curated JSON files)."""

from __future__ import annotations

from functools import lru_cache

from app.engine import (
    ChampionCatalog,
    PlayerInput,
    PlayerPreferences,
    PoolEntry,
    Role,
    build_catalog,
)
from app.engine.catalog import ARCHETYPE_ROLES, ARCHETYPE_TRAITS, TRAITS

# id, key, name, roles, archetype, damage, region, groups, traits (engage peel poke wc split pick tf early late mob front cc sus obj)
RAW = [
    ("Malphite", 54, "Malphite", "TOP SUPPORT", "vanguard", "AP", "ixtal", "", "31120131213311"),
    ("Garen", 86, "Garen", "TOP", "juggernaut", "AD", "demacia", "", "10022022212131"),
    ("Darius", 122, "Darius", "TOP", "juggernaut", "AD", "noxus", "", "10022023202132"),
    ("Fiora", 114, "Fiora", "TOP", "skirmisher", "AD", "demacia", "", "00013012320022"),
    ("Teemo", 17, "Teemo", "TOP", "specialist", "AP", "bandle_city", "yordle", "00212102110101"),
    ("Poppy", 78, "Poppy", "TOP JUNGLE SUPPORT", "warden", "AD", "demacia", "yordle", "23011122113311"),
    ("LeeSin", 64, "Lee Sin", "JUNGLE", "diver", "AD", "ionia", "", "21011213131212"),
    ("JarvanIV", 59, "Jarvan IV", "JUNGLE", "diver", "AD", "demacia", "", "30010123122302"),
    ("Amumu", 32, "Amumu", "JUNGLE SUPPORT", "vanguard", "AP", "shurima", "undead", "31010131213301"),
    ("Khazix", 121, "Kha'Zix", "JUNGLE", "assassin", "AD", "void", "void_born", "00011312230002"),
    ("Sejuani", 113, "Sejuani", "JUNGLE", "vanguard", "AD", "freljord", "", "31010132113312"),
    ("Hecarim", 120, "Hecarim", "JUNGLE", "diver", "AD", "shadow_isles", "undead", "30021122232212"),
    ("Vi", 254, "Vi", "JUNGLE", "diver", "AD", "piltover", "", "30010312122312"),
    ("Ahri", 103, "Ahri", "MID", "burst_mage", "AP", "ionia", "vastaya", "10220312230211"),
    ("Orianna", 61, "Orianna", "MID", "battlemage", "AP", "piltover", "machine", "12230131310201"),
    ("Zed", 238, "Zed", "MID", "assassin", "AD", "ionia", "", "00122312130001"),
    ("Veigar", 45, "Veigar", "MID", "burst_mage", "AP", "bandle_city", "yordle", "10120221300301"),
    ("Xerath", 101, "Xerath", "MID SUPPORT", "artillery", "AP", "shurima", "ascended", "00330121200201"),
    ("Viktor", 112, "Viktor", "MID", "battlemage", "AP", "zaun", "", "00231031300101"),
    ("Syndra", 134, "Syndra", "MID", "burst_mage", "AP", "ionia", "", "00220222200201"),
    ("Yasuo", 157, "Yasuo", "MID TOP", "skirmisher", "AD", "ionia", "", "10022121330111"),
    ("Jinx", 222, "Jinx", "BOTTOM", "marksman", "AD", "zaun", "", "00131031300103"),
    ("Caitlyn", 51, "Caitlyn", "BOTTOM", "marksman", "AD", "piltover", "", "00321113200102"),
    ("Ezreal", 81, "Ezreal", "BOTTOM", "marksman", "AD", "piltover", "", "00311112230002"),
    ("Tristana", 18, "Tristana", "BOTTOM MID", "marksman", "AD", "bandle_city", "yordle", "00021022320103"),
    ("Kaisa", 145, "Kai'Sa", "BOTTOM", "marksman", "MIXED", "void", "void_born", "00120221320002"),
    ("Lulu", 117, "Lulu", "SUPPORT", "enchanter", "AP", "bandle_city", "yordle", "03100122200220"),
    ("Leona", 89, "Leona", "SUPPORT", "vanguard", "AP", "targon", "", "31000223113300"),
    ("Thresh", 412, "Thresh", "SUPPORT", "catcher", "AP", "shadow_isles", "undead", "23000322211300"),
    ("Janna", 40, "Janna", "SUPPORT", "enchanter", "AP", "zaun", "", "03100011210220"),
    ("Nautilus", 111, "Nautilus", "SUPPORT", "vanguard", "AP", "bilgewater", "", "31010222103301"),
    ("Kayle", 10, "Kayle", "TOP", "skirmisher", "MIXED", "demacia", "celestial", "00122020310012"),
    ("Morgana", 25, "Morgana", "SUPPORT MID", "burst_mage", "AP", "demacia", "celestial", "12120221200301"),
    ("Rumble", 68, "Rumble", "TOP MID", "battlemage", "AP", "bandle_city", "yordle", "10121032211101"),
    ("Kennen", 85, "Kennen", "TOP", "specialist", "AP", "ionia", "yordle", "20211131220300"),
    ("Gnar", 150, "Gnar", "TOP", "specialist", "AD", "freljord", "yordle", "20211032212201"),
]

REGIONS = ["noxus", "demacia", "ionia", "freljord", "zaun", "piltover", "shurima", "targon", "ixtal", ""]


def _meta_entry(row: tuple) -> dict:
    cid, key, name, roles, arch, dmg, region, groups, traits = row
    return {
        "name": name,
        "key": key,
        "roles": roles.split(),
        "archetype": arch,
        "damage_type": dmg,
        "region": region,
        "groups": groups.split() if groups else [],
        "traits": {t: int(traits[i]) for i, t in enumerate(TRAITS)},
        "power_spikes": [f"niveau 6 ({name})"],
        "playstyle": f"Style de jeu de {name}.",
        "counter_tips": f"Conseil contre {name}. Second conseil.",
    }


def base_meta() -> dict[str, dict]:
    return {row[0]: _meta_entry(row) for row in RAW}


def synthetic_meta(count: int = 130) -> dict[str, dict]:
    """Deterministic filler champions so the catalog has a realistic size (~170)."""
    archetypes = sorted(ARCHETYPE_TRAITS)
    out = {}
    for i in range(count):
        arch = archetypes[i % len(archetypes)]
        traits = dict(ARCHETYPE_TRAITS[arch])
        t = TRAITS[i % len(TRAITS)]
        traits[t] = min(3, traits.get(t, 0) + 1)
        roles = [r.value for r in ARCHETYPE_ROLES[arch]]
        out[f"Synth{i:03d}"] = {
            "name": f"Synth {i:03d}",
            "key": 2000 + i,
            "roles": roles,
            "archetype": arch,
            "damage_type": ["AD", "AP", "MIXED"][i % 3],
            "region": REGIONS[i % len(REGIONS)],
            "groups": [],
            "traits": traits,
        }
    return out


@lru_cache(maxsize=None)
def small_catalog() -> ChampionCatalog:
    return build_catalog([], "", meta=base_meta())


@lru_cache(maxsize=None)
def big_catalog() -> ChampionCatalog:
    meta = base_meta()
    meta.update(synthetic_meta())
    return build_catalog([], "", meta=meta)


def player(pid: str, roles: list[Role], pool: dict[str, float], **prefs) -> PlayerInput:
    return PlayerInput(
        player_id=pid,
        name=pid.capitalize(),
        preferences=PlayerPreferences(roles=roles, **prefs),
        pool=[
            PoolEntry(champion_id=c, comfort=v, desire=0.3, sources=["mastery"], mastery_points=int(v * 200_000), mastery_level=7)
            for c, v in pool.items()
        ],
    )


def five_players() -> list[PlayerInput]:
    return [
        player("alice", [Role.TOP, Role.JUNGLE], {"Malphite": 0.9, "Garen": 0.7, "Darius": 0.6, "Teemo": 0.5, "Gnar": 0.4}),
        player("bob", [Role.JUNGLE], {"LeeSin": 0.9, "Amumu": 0.7, "JarvanIV": 0.6, "Sejuani": 0.5, "Vi": 0.4}),
        player("carl", [Role.MID], {"Ahri": 0.9, "Orianna": 0.8, "Zed": 0.6, "Veigar": 0.5, "Xerath": 0.4},
               wanted_archetypes=["assassin"]),
        player("dana", [Role.BOTTOM], {"Jinx": 0.9, "Caitlyn": 0.8, "Ezreal": 0.6, "Tristana": 0.5}),
        player("eve", [Role.SUPPORT], {"Leona": 0.9, "Thresh": 0.8, "Lulu": 0.6, "Janna": 0.5, "Nautilus": 0.4}),
    ]
