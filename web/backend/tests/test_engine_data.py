"""Validation of the curated engine data files (champion meta + archetypes)."""

import json
from collections import Counter
from pathlib import Path

import pytest

from app.engine.models import ChampionTraits, Role

DATA_DIR = Path(__file__).resolve().parents[1] / "app" / "engine" / "data"

TRAIT_KEYS = {
    "engage", "peel", "poke", "waveclear", "splitpush", "pick", "teamfight",
    "early", "late", "mobility", "frontline", "cc", "sustain", "objective",
}
REQUIRED_FIELDS = {
    "name", "key", "roles", "archetype", "damage_type", "region", "groups",
    "traits", "power_spikes", "playstyle", "counter_tips",
}
REGIONS = {
    "bandle_city", "bilgewater", "demacia", "freljord", "ionia", "ixtal", "noxus",
    "piltover", "zaun", "shadow_isles", "shurima", "targon", "void", "runeterra", "",
}
GROUPS = {
    "yordle", "vastaya", "darkin", "ascended", "undead", "void_born", "dragon",
    "celestial", "spirit", "machine", "beast", "pirate", "sibling",
}
ARCHETYPE_KEYS = {
    "vanguard", "warden", "juggernaut", "diver", "skirmisher", "assassin", "burst_mage",
    "battlemage", "artillery", "marksman", "enchanter", "catcher", "specialist",
}
SMALL_REGIONS = {"targon", "ixtal", "bandle_city"}


def _no_dup_hook(pairs):
    keys = [k for k, _ in pairs]
    dups = [k for k, n in Counter(keys).items() if n > 1]
    assert not dups, f"duplicate keys: {dups}"
    return dict(pairs)


@pytest.fixture(scope="module")
def archetypes():
    with open(DATA_DIR / "archetypes.json", encoding="utf-8") as f:
        return json.load(f, object_pairs_hook=_no_dup_hook)


@pytest.fixture(scope="module")
def champions():
    with open(DATA_DIR / "champions_meta.json", encoding="utf-8") as f:
        return json.load(f, object_pairs_hook=_no_dup_hook)


def test_archetypes(archetypes):
    assert isinstance(archetypes, list)
    assert {a["key"] for a in archetypes} == ARCHETYPE_KEYS
    assert len(archetypes) == len(ARCHETYPE_KEYS)
    for a in archetypes:
        assert set(a) == {"key", "label", "description"}
        assert a["label"].strip() and a["description"].strip()


def test_champion_count(champions):
    assert isinstance(champions, dict)
    assert len(champions) >= 160


def test_well_known_ids_present(champions):
    for cid in ("MonkeyKing", "Chogath", "Leblanc", "Velkoz", "KogMaw", "DrMundo",
                "JarvanIV", "AurelionSol", "TahmKench", "XinZhao", "Belveth", "KSante",
                "RekSai", "Kaisa", "Khazix", "Fiddlesticks", "Nunu", "Renata",
                "MasterYi", "MissFortune", "TwistedFate", "LeeSin", "Kalista",
                "Hwei", "Smolder", "Aurora", "Ambessa", "Mel"):
        assert cid in champions, cid


def test_champion_fields(champions, archetypes):
    arch_keys = {a["key"] for a in archetypes}
    valid_roles = {r.value for r in Role}
    numeric_keys = []
    for cid, c in champions.items():
        assert set(c) == REQUIRED_FIELDS, cid
        assert isinstance(c["name"], str) and c["name"].strip(), cid
        assert isinstance(c["key"], int) and c["key"] > 0, cid
        numeric_keys.append(c["key"])
        assert c["roles"] and len(set(c["roles"])) == len(c["roles"]), cid
        assert set(c["roles"]) <= valid_roles, cid
        assert c["archetype"] in arch_keys, cid
        assert c["damage_type"] in {"AD", "AP", "MIXED"}, cid
        assert c["region"] in REGIONS, cid
        assert set(c["groups"]) <= GROUPS, cid
        assert len(set(c["groups"])) == len(c["groups"]), cid
        assert set(c["traits"]) == TRAIT_KEYS, cid
        for k, v in c["traits"].items():
            assert type(v) is int and 0 <= v <= 3, (cid, k, v)
        ChampionTraits(**c["traits"])
        assert 1 <= len(c["power_spikes"]) <= 3, cid
        assert all(isinstance(s, str) and s.strip() for s in c["power_spikes"]), cid
        assert c["playstyle"].strip() and c["counter_tips"].strip(), cid
    dup_numeric = [k for k, n in Counter(numeric_keys).items() if n > 1]
    assert not dup_numeric, f"duplicate numeric keys: {dup_numeric}"


def test_role_coverage(champions):
    counts = Counter(r for c in champions.values() for r in c["roles"])
    for role in Role:
        assert counts[role.value] >= 20, (role.value, counts[role.value])


def test_archetype_coverage(champions):
    counts = Counter(c["archetype"] for c in champions.values())
    for key in ARCHETYPE_KEYS:
        assert counts[key] >= 3, (key, counts[key])


def test_region_coverage(champions):
    counts = Counter(c["region"] for c in champions.values())
    for region in REGIONS - {""}:
        minimum = 3 if region in SMALL_REGIONS else 5
        assert counts[region] >= minimum, (region, counts[region])


def test_thematic_groups(champions):
    counts = Counter(g for c in champions.values() for g in c["groups"])
    assert counts["yordle"] >= 10
    assert counts["void_born"] >= 5
    assert counts["sibling"] >= 8
