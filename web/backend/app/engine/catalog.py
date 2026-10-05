"""Champion catalog: Data Dragon champions merged with curated meta data."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from .models import ArchetypeInfo, ChampionInfo, ChampionTraits, Role

DATA_DIR = Path(__file__).parent / "data"
DDRAGON_IMG = "https://ddragon.leagueoflegends.com/cdn/{version}/img/champion/{file}"

TRAITS: tuple[str, ...] = tuple(ChampionTraits.model_fields)
TRAIT_INDEX: dict[str, int] = {t: i for i, t in enumerate(TRAITS)}

ROLE_LABELS: dict[Role, str] = {
    Role.TOP: "Top",
    Role.JUNGLE: "Jungle",
    Role.MID: "Mid",
    Role.BOTTOM: "ADC",
    Role.SUPPORT: "Support",
}

DEFAULT_ARCHETYPES: list[dict[str, str]] = [
    {"key": "vanguard", "label": "Tank engageur", "description": "Tank qui lance les combats."},
    {"key": "warden", "label": "Tank protecteur", "description": "Tank qui protège ses carries."},
    {"key": "juggernaut", "label": "Juggernaut", "description": "Combattant lent et très résistant."},
    {"key": "diver", "label": "Plongeur", "description": "Combattant mobile qui plonge sur les carries."},
    {"key": "skirmisher", "label": "Duelliste", "description": "Combattant fort en duel et en split."},
    {"key": "assassin", "label": "Assassin", "description": "Élimine une cible fragile en un instant."},
    {"key": "burst_mage", "label": "Mage burst", "description": "Mage aux gros dégâts instantanés."},
    {"key": "battlemage", "label": "Mage de combat", "description": "Mage qui inflige des dégâts continus au cœur du combat."},
    {"key": "artillery", "label": "Mage artilleur", "description": "Mage à très longue portée qui poke."},
    {"key": "marksman", "label": "Tireur", "description": "Carry à distance aux dégâts continus."},
    {"key": "enchanter", "label": "Enchanteur", "description": "Soutien qui soigne, bouclie et buffe."},
    {"key": "catcher", "label": "Attrapeur", "description": "Soutien qui attrape une cible isolée."},
    {"key": "specialist", "label": "Spécialiste", "description": "Champion au style unique."},
]

# Fallback trait templates per archetype (used for champions missing from curated meta).
ARCHETYPE_TRAITS: dict[str, dict[str, int]] = {
    "vanguard": dict(engage=3, peel=1, waveclear=1, pick=1, teamfight=3, early=1, late=2, mobility=1, frontline=3, cc=3, sustain=1, objective=1),
    "warden": dict(engage=1, peel=3, teamfight=2, early=1, late=2, mobility=1, frontline=3, cc=2, sustain=1),
    "juggernaut": dict(engage=1, waveclear=2, splitpush=2, teamfight=2, early=2, late=2, frontline=2, cc=1, sustain=3, objective=2),
    "diver": dict(engage=2, waveclear=1, splitpush=1, pick=2, teamfight=1, early=2, late=1, mobility=2, frontline=2, cc=2, sustain=1, objective=2),
    "skirmisher": dict(waveclear=2, splitpush=3, pick=1, teamfight=1, early=1, late=3, mobility=2, sustain=2, objective=2),
    "assassin": dict(waveclear=1, splitpush=1, pick=3, teamfight=1, early=2, late=1, mobility=3, objective=1),
    "burst_mage": dict(poke=1, waveclear=2, pick=2, teamfight=2, early=2, late=2, cc=2),
    "battlemage": dict(waveclear=3, teamfight=3, early=1, late=2, frontline=1, cc=1, sustain=1),
    "artillery": dict(poke=3, waveclear=3, pick=1, teamfight=2, early=1, late=2, cc=1),
    "marksman": dict(poke=1, waveclear=2, splitpush=1, teamfight=2, early=1, late=3, objective=3),
    "enchanter": dict(peel=3, poke=1, teamfight=2, early=1, late=2, cc=1, sustain=2),
    "catcher": dict(engage=2, peel=2, pick=3, teamfight=1, early=2, late=1, cc=3),
    "specialist": dict(poke=1, waveclear=2, splitpush=2, teamfight=2, early=1, late=2, cc=1),
}

ARCHETYPE_ROLES: dict[str, list[Role]] = {
    "vanguard": [Role.TOP, Role.SUPPORT, Role.JUNGLE],
    "warden": [Role.SUPPORT, Role.TOP],
    "juggernaut": [Role.TOP],
    "diver": [Role.JUNGLE, Role.TOP],
    "skirmisher": [Role.TOP, Role.JUNGLE],
    "assassin": [Role.MID, Role.JUNGLE],
    "burst_mage": [Role.MID, Role.SUPPORT],
    "battlemage": [Role.MID, Role.TOP],
    "artillery": [Role.MID, Role.SUPPORT],
    "marksman": [Role.BOTTOM],
    "enchanter": [Role.SUPPORT],
    "catcher": [Role.SUPPORT],
    "specialist": [Role.TOP, Role.MID],
}

DAMAGE_ARCHETYPES = {"marksman", "assassin", "burst_mage", "battlemage", "artillery", "skirmisher"}


@dataclass(slots=True)
class ChampData:
    """Light, fast internal view of a champion used by the engine hot loops."""

    id: str
    name: str
    roles: tuple[Role, ...]
    archetype: str
    damage: str
    region: str
    groups: frozenset[str]
    traits: tuple[int, ...]
    t: dict[str, int] = field(default_factory=dict)

    def __getitem__(self, trait: str) -> int:
        return self.t.get(trait, 0)


# --------------------------------------------------------------------------- loading


def _read_json(name: str) -> Any:
    path = DATA_DIR / name
    if not path.exists():
        return None
    try:
        with path.open(encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


@lru_cache(maxsize=1)
def load_meta_file() -> dict[str, dict]:
    data = _read_json("champions_meta.json")
    return data if isinstance(data, dict) else {}


@lru_cache(maxsize=1)
def _archetypes() -> tuple[ArchetypeInfo, ...]:
    data = _read_json("archetypes.json")
    items = data if isinstance(data, list) and data else DEFAULT_ARCHETYPES
    out = []
    for it in items:
        try:
            out.append(ArchetypeInfo(**it))
        except Exception:  # noqa: BLE001 - tolerate a malformed entry
            continue
    return tuple(out)


def list_archetypes() -> list[ArchetypeInfo]:
    return list(_archetypes())


def archetype_label(key: str) -> str:
    for a in _archetypes():
        if a.key == key:
            return a.label
    for a in DEFAULT_ARCHETYPES:
        if a["key"] == key:
            return a["label"]
    return key.replace("_", " ").capitalize() if key else "Polyvalent"


# --------------------------------------------------------------------------- fallback


def _fallback_archetype(tags: list[str], info: dict) -> str:
    tags = tags or []
    main = tags[0] if tags else ""
    has = set(tags)
    defense = int(info.get("defense", 5) or 0)
    if main == "Marksman":
        return "marksman"
    if main == "Tank":
        return "warden" if "Support" in has else "vanguard"
    if main == "Support":
        if "Tank" in has:
            return "warden"
        if "Mage" in has:
            return "enchanter"
        return "catcher" if "Fighter" in has else "enchanter"
    if main == "Assassin":
        return "skirmisher" if "Fighter" in has else "assassin"
    if main == "Fighter":
        if "Tank" in has:
            return "juggernaut"
        if "Assassin" in has:
            return "skirmisher"
        return "juggernaut" if defense >= 6 else "diver"
    if main == "Mage":
        if "Support" in has:
            return "enchanter"
        if "Assassin" in has:
            return "burst_mage"
        if "Tank" in has or "Fighter" in has:
            return "battlemage"
        return "battlemage" if defense >= 4 else "burst_mage"
    return "specialist"


def _fallback_damage(info: dict, archetype: str) -> str:
    atk = int(info.get("attack", 0) or 0)
    mag = int(info.get("magic", 0) or 0)
    if abs(atk - mag) <= 1 and min(atk, mag) >= 5:
        return "MIXED"
    if mag > atk:
        return "AP"
    if atk > mag:
        return "AD"
    return "AP" if archetype in {"burst_mage", "battlemage", "artillery", "enchanter"} else "AD"


def _fallback_traits(archetype: str, info: dict) -> dict[str, int]:
    traits = dict(ARCHETYPE_TRAITS.get(archetype, ARCHETYPE_TRAITS["specialist"]))
    defense = int(info.get("defense", 0) or 0)
    if defense >= 8:
        traits["frontline"] = min(3, traits.get("frontline", 0) + 1)
    return traits


def fallback_meta(tags: list[str], info: dict) -> dict:
    arch = _fallback_archetype(tags, info)
    return {
        "roles": [r.value for r in ARCHETYPE_ROLES.get(arch, [Role.MID])],
        "archetype": arch,
        "damage_type": _fallback_damage(info, arch),
        "region": "",
        "groups": [],
        "traits": _fallback_traits(arch, info),
        "power_spikes": [],
        "playstyle": "",
        "counter_tips": "",
    }


# --------------------------------------------------------------------------- catalog


def _clamp_trait(v: Any) -> int:
    try:
        return max(0, min(3, int(v)))
    except (TypeError, ValueError):
        return 0


def _roles(values: Iterable[Any]) -> list[Role]:
    out: list[Role] = []
    for v in values or []:
        try:
            r = Role(str(v).upper())
        except ValueError:
            continue
        if r not in out:
            out.append(r)
    return out


class ChampionCatalog:
    """Immutable set of champions with lookup helpers."""

    def __init__(self, champions: list[ChampionInfo], extras: dict[str, dict] | None = None):
        self._champs: dict[str, ChampionInfo] = {}
        self._extras: dict[str, dict] = {}
        self._data: dict[str, ChampData] = {}
        for c in sorted(champions, key=lambda c: c.name.lower()):
            self._champs[c.id] = c
            self._extras[c.id] = dict((extras or {}).get(c.id, {}))
            td = c.traits.model_dump()
            self._data[c.id] = ChampData(
                id=c.id,
                name=c.name,
                roles=tuple(c.roles),
                archetype=c.archetype,
                damage=c.damage_type,
                region=c.region,
                groups=frozenset(c.groups),
                traits=tuple(td[t] for t in TRAITS),
                t=td,
            )
        self._by_key = {c.key: c for c in self._champs.values()}
        self._lower = {k.lower(): k for k in self._champs}
        for c in self._champs.values():
            self._lower.setdefault(c.name.lower(), c.id)

    def __len__(self) -> int:
        return len(self._champs)

    def __contains__(self, champion_id: object) -> bool:
        return isinstance(champion_id, str) and self.resolve(champion_id) is not None

    def resolve(self, champion_id: str) -> str | None:
        """Return the canonical id for an id/name given with any casing."""
        if champion_id in self._champs:
            return champion_id
        return self._lower.get(str(champion_id).lower())

    def get(self, champion_id: str) -> ChampionInfo | None:
        cid = self.resolve(champion_id)
        return self._champs.get(cid) if cid else None

    def by_key(self, key: int) -> ChampionInfo | None:
        try:
            return self._by_key.get(int(key))
        except (TypeError, ValueError):
            return None

    def all(self) -> list[ChampionInfo]:
        return list(self._champs.values())

    def meta(self, champion_id: str) -> dict:
        """Extra curated fields: power_spikes (list[str]), playstyle (str), counter_tips (str)."""
        cid = self.resolve(champion_id)
        extra = self._extras.get(cid, {}) if cid else {}
        return {
            "power_spikes": list(extra.get("power_spikes") or []),
            "playstyle": str(extra.get("playstyle") or ""),
            "counter_tips": str(extra.get("counter_tips") or ""),
        }

    def data(self, champion_id: str) -> ChampData | None:
        cid = self.resolve(champion_id)
        return self._data.get(cid) if cid else None

    def all_data(self) -> list[ChampData]:
        return list(self._data.values())

    def name(self, champion_id: str) -> str:
        c = self.get(champion_id)
        return c.name if c else champion_id


def _make_info(cid: str, meta: dict, dd: dict | None, version: str) -> ChampionInfo | None:
    traits_raw = meta.get("traits") or {}
    traits = ChampionTraits(**{t: _clamp_trait(traits_raw.get(t, 0)) for t in TRAITS})
    roles = _roles(meta.get("roles") or [])
    archetype = str(meta.get("archetype") or "")
    if not roles:
        roles = list(ARCHETYPE_ROLES.get(archetype, [Role.MID]))
    damage = str(meta.get("damage_type") or "AD").upper()
    if damage not in ("AD", "AP", "MIXED"):
        damage = "AD"
    if dd is not None:
        try:
            key = int(dd.get("key"))
        except (TypeError, ValueError):
            key = int(meta.get("key") or 0)
        name = str(dd.get("name") or meta.get("name") or cid)
        title = str(dd.get("title") or "")
        tags = list(dd.get("tags") or [])
        img = (dd.get("image") or {}).get("full")
        image_url = DDRAGON_IMG.format(version=version, file=img) if img and version else ""
    else:
        try:
            key = int(meta.get("key") or 0)
        except (TypeError, ValueError):
            key = 0
        name = str(meta.get("name") or cid)
        title = str(meta.get("title") or "")
        tags = list(meta.get("tags") or [])
        image_url = ""
    return ChampionInfo(
        id=cid,
        key=key,
        name=name,
        title=title,
        image_url=image_url,
        tags=tags,
        roles=roles,
        archetype=archetype,
        damage_type=damage,  # type: ignore[arg-type]
        region=str(meta.get("region") or ""),
        groups=[str(g) for g in meta.get("groups") or []],
        traits=traits,
    )


def build_catalog(
    ddragon_champions: list[dict], version: str, meta: dict[str, dict] | None = None
) -> ChampionCatalog:
    """Merge Data Dragon champions (champion.json "data" values) with curated meta.

    With an empty Data Dragon list, the catalog contains the curated champions only.
    Champions unknown to the curated meta get a fallback derived from tags/info.
    """
    curated = load_meta_file() if meta is None else meta
    infos: list[ChampionInfo] = []
    extras: dict[str, dict] = {}
    if ddragon_champions:
        for dd in ddragon_champions:
            cid = dd.get("id")
            if not cid:
                continue
            m = curated.get(cid)
            if m is None:
                m = fallback_meta(list(dd.get("tags") or []), dict(dd.get("info") or {}))
            else:
                m = dict(m)
                if not m.get("archetype"):
                    fb = fallback_meta(list(dd.get("tags") or []), dict(dd.get("info") or {}))
                    m["archetype"] = fb["archetype"]
            info = _make_info(cid, m, dd, version)
            if info:
                infos.append(info)
                extras[cid] = m
    else:
        for cid, m in curated.items():
            info = _make_info(cid, m, None, version)
            if info:
                infos.append(info)
                extras[cid] = m
    return ChampionCatalog(infos, extras)


def placeholder_data(champion_id: str) -> ChampData:
    """Neutral data for an unknown champion id (keeps plans working)."""
    t = {k: 1 for k in TRAITS}
    return ChampData(
        id=champion_id, name=champion_id, roles=(), archetype="specialist", damage="MIXED",
        region="", groups=frozenset(), traits=tuple(t[k] for k in TRAITS), t=t,
    )
