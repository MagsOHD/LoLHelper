"""Theme definitions (data/themes.json) and how a lineup is scored against a theme."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Sequence

from .analysis import viability
from .catalog import DATA_DIR, TRAIT_INDEX, ChampData
from .models import ThemeInfo


@dataclass(frozen=True)
class Requirement:
    trait: str | None = None
    min: int = 0
    archetypes: frozenset[str] = frozenset()
    count: int = 1

    def ok(self, c: ChampData) -> bool:
        if self.archetypes and c.archetype not in self.archetypes:
            return False
        if self.trait and c.t.get(self.trait, 0) < self.min:
            return False
        return True


@dataclass(frozen=True)
class ThemeDef:
    key: str
    label: str
    kind: str
    description: str
    weights: tuple[tuple[int, float], ...] = ()  # (trait index, weight)
    penalties: tuple[tuple[int, float], ...] = ()
    target: float = 1.6  # wanted average per champion for weighted traits
    requires: tuple[Requirement, ...] = ()
    regions: frozenset[str] = frozenset()
    groups: frozenset[str] = frozenset()
    archetypes: frozenset[str] = frozenset()
    damage: frozenset[str] = frozenset()
    champions: frozenset[str] = frozenset()
    min_members: int = 0
    pairs_theme: bool = False
    ignore_damage_mix: bool = False
    member_cache: dict = field(default_factory=dict, compare=False, hash=False)

    @property
    def thematic(self) -> bool:
        return self.kind == "thematic"

    def info(self) -> ThemeInfo:
        return ThemeInfo(key=self.key, label=self.label, kind=self.kind, description=self.description)  # type: ignore[arg-type]

    # ---------------------------------------------------------------- membership
    def is_member(self, c: ChampData) -> bool:
        """Static membership (not used for the pair-based lore theme)."""
        if not self.thematic or self.pairs_theme:
            return False
        hit = self.member_cache.get(c.id)
        if hit is None:
            hit = (
                (c.region in self.regions)
                or bool(self.groups & c.groups)
                or (c.archetype in self.archetypes)
                or (c.damage in self.damage)
                or (c.id in self.champions)
            )
            self.member_cache[c.id] = hit
        return hit

    def members_in(self, champs: Sequence[ChampData]) -> list[ChampData]:
        if self.pairs_theme:
            ids = {c.id for c in champs}
            linked = {a for a, b, _ in lore_pairs() if a in ids and b in ids}
            linked |= {b for a, b, _ in lore_pairs() if a in ids and b in ids}
            return [c for c in champs if c.id in linked]
        return [c for c in champs if self.is_member(c)]

    def required_members(self, n: int) -> int:
        if not self.thematic or n == 0:
            return 0
        if self.pairs_theme:
            return 2 if n < 5 else self.min_members
        return min(n, max(1, math.ceil(self.min_members * n / 5)))

    def affinity(self, c: ChampData) -> float:
        """0..1 how much a single champion contributes to this theme."""
        if self.thematic:
            if self.pairs_theme:
                return 1.0 if c.id in lore_champions() else 0.0
            return 1.0 if self.is_member(c) else 0.0
        if not self.weights:
            return 0.0
        tot = sum(w for _, w in self.weights)
        val = sum(w * c.traits[i] for i, w in self.weights) / (3 * tot)
        if self.requires and any(r.ok(c) for r in self.requires):
            val = min(1.0, val + 0.25)
        return val

    # ---------------------------------------------------------------- scoring
    def trait_score(self, sums: Sequence[float], n: int) -> float:
        if not self.weights or n == 0:
            return 0.0
        tot = 0.0
        acc = 0.0
        goal = self.target * n
        for i, w in self.weights:
            acc += w * min(1.0, sums[i] / goal)
            tot += w
        score = acc / tot
        for i, w in self.penalties:
            score -= w * min(1.0, sums[i] / (3 * n))
        return max(0.0, score)

    def requirement_score(self, champs: Sequence[ChampData]) -> float:
        if not self.requires:
            return 1.0
        n = len(champs)
        parts = []
        for r in self.requires:
            need = max(1, round(r.count * n / 5)) if r.count > 1 else 1
            have = sum(1 for c in champs if r.ok(c))
            parts.append(min(1.0, have / need))
        return sum(parts) / len(parts)

    def fit(self, champs: Sequence[ChampData], sums: Sequence[float] | None = None) -> float:
        """0..1 fit of a (possibly partial) lineup with this theme."""
        n = len(champs)
        if n == 0:
            return 0.0
        if sums is None:
            sums = team_sums(champs)
        if not self.thematic:
            return self.trait_score(sums, n) * (0.4 + 0.6 * self.requirement_score(champs))
        members = len(self.members_in(champs))
        need = self.required_members(n)
        ratio = members / n
        member_score = ratio if members >= need else 0.45 * ratio
        via = viability(champs, sums, ignore_damage=self.ignore_damage_mix)
        return 0.7 * member_score + 0.3 * via

    def satisfied(self, champs: Sequence[ChampData]) -> bool:
        """Hard-ish constraint for thematic themes (always True for playstyles)."""
        if not self.thematic:
            return True
        return len(self.members_in(champs)) >= self.required_members(len(champs))


def team_sums(champs: Sequence[ChampData]) -> list[float]:
    sums = [0.0] * len(TRAIT_INDEX)
    for c in champs:
        for i, v in enumerate(c.traits):
            sums[i] += v
    return sums


# --------------------------------------------------------------------------- loading


def _parse(entry: dict) -> ThemeDef:
    def tw(d: dict | None) -> tuple[tuple[int, float], ...]:
        return tuple((TRAIT_INDEX[k], float(v)) for k, v in (d or {}).items() if k in TRAIT_INDEX)

    members = entry.get("members") or {}
    reqs = tuple(
        Requirement(
            trait=r.get("trait"),
            min=int(r.get("min", 0)),
            archetypes=frozenset(r.get("archetypes") or []),
            count=int(r.get("count", 1)),
        )
        for r in entry.get("requires") or []
    )
    return ThemeDef(
        key=entry["key"],
        label=entry["label"],
        kind=entry.get("kind", "playstyle"),
        description=entry.get("description", ""),
        weights=tw(entry.get("weights")),
        penalties=tw(entry.get("penalties")),
        target=float(entry.get("target", 1.6)),
        requires=reqs,
        regions=frozenset(members.get("regions") or []),
        groups=frozenset(members.get("groups") or []),
        archetypes=frozenset(members.get("archetypes") or []),
        damage=frozenset(members.get("damage") or []),
        champions=frozenset(members.get("champions") or []),
        min_members=int(entry.get("min_members", 0)),
        pairs_theme=bool(entry.get("pairs_theme", False)),
        ignore_damage_mix=bool(entry.get("ignore_damage_mix", False)),
    )


@lru_cache(maxsize=1)
def _raw() -> dict:
    with (DATA_DIR / "themes.json").open(encoding="utf-8") as fh:
        return json.load(fh)


@lru_cache(maxsize=1)
def all_themes() -> tuple[ThemeDef, ...]:
    return tuple(_parse(t) for t in _raw()["themes"])


@lru_cache(maxsize=1)
def lore_pairs() -> tuple[tuple[str, str, str], ...]:
    return tuple((a, b, d) for a, b, d in _raw().get("lore_pairs", []))


@lru_cache(maxsize=1)
def lore_champions() -> frozenset[str]:
    return frozenset(x for a, b, _ in lore_pairs() for x in (a, b))


def get_theme(key: str | None) -> ThemeDef | None:
    if not key:
        return None
    for t in all_themes():
        if t.key == key:
            return t
    return None


def list_themes() -> list[ThemeInfo]:
    return [t.info() for t in all_themes()]


def theme_label(key: str) -> str:
    t = get_theme(key)
    return t.label if t else key


def detect_themes(champs: Sequence[ChampData], limit: int = 3) -> list[tuple[ThemeDef, float]]:
    """Best matching themes of a lineup, best first (thematic ones only when satisfied)."""
    if not champs:
        return []
    sums = team_sums(champs)
    scored: list[tuple[ThemeDef, float]] = []
    for t in all_themes():
        if t.thematic:
            if not t.satisfied(champs) or len(champs) < 3:
                continue
            members = len(t.members_in(champs))
            if members < max(3, t.required_members(len(champs))):
                continue
        scored.append((t, t.fit(champs, sums)))
    scored.sort(key=lambda x: (-x[1], x[0].key))
    play = [s for s in scored if not s[0].thematic]
    them = [s for s in scored if s[0].thematic]
    out = play[:1]
    rest = sorted(play[1:] + them, key=lambda x: (-x[1], x[0].key))
    for t, s in rest:
        if len(out) >= limit:
            break
        if t.thematic or s >= 0.75 * out[0][1]:
            out.append((t, s))
    return out
