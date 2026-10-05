"""Team-level analysis shared by the generator and the plans: balance, counters, notes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .catalog import TRAIT_INDEX, ChampData

I = TRAIT_INDEX
DIVE_ARCHES = {"assassin", "diver", "skirmisher"}
DPS_ARCHES = {"marksman", "juggernaut", "battlemage", "skirmisher"}
SQUISHY_CARRY_ARCHES = {"marksman", "artillery", "burst_mage", "battlemage"}


def _sums(champs: Sequence[ChampData]) -> list[float]:
    sums = [0.0] * len(I)
    for c in champs:
        for i, v in enumerate(c.traits):
            sums[i] += v
    return sums


def ap_share(champs: Sequence[ChampData]) -> float:
    if not champs:
        return 0.5
    ap = sum(1.0 if c.damage == "AP" else 0.5 if c.damage == "MIXED" else 0.0 for c in champs)
    return ap / len(champs)


def damage_mix_score(champs: Sequence[ChampData]) -> float:
    share = ap_share(champs)
    if 0.25 <= share <= 0.75:
        return 1.0
    dist = 0.25 - share if share < 0.25 else share - 0.75
    return max(0.2, 1.0 - dist * 3.2)


def viability(champs: Sequence[ChampData], sums: Sequence[float] | None = None, ignore_damage: bool = False) -> float:
    """0..1 'can this lineup actually play the game' score (a.k.a. balance)."""
    n = len(champs)
    if n == 0:
        return 0.0
    if sums is None:
        sums = _sums(champs)
    f = n / 5
    max_front = max(c.traits[I["frontline"]] for c in champs)
    front = min(1.0, sums[I["frontline"]] / (4 * f)) * (1.0 if max_front >= 2 else 0.6)
    engage_peel = min(1.0, max(sums[I["engage"]] / (4 * f), sums[I["peel"]] / (4 * f)))
    cc = min(1.0, sums[I["cc"]] / (6 * f))
    wc = min(1.0, sums[I["waveclear"]] / (6 * f))
    parts = [(0.25, front), (0.2, engage_peel), (0.1, cc), (0.15, wc)]
    if not ignore_damage and n >= 3:
        parts.append((0.3, damage_mix_score(champs)))
    tot = sum(w for w, _ in parts)
    return sum(w * v for w, v in parts) / tot


balance = viability


# --------------------------------------------------------------------------- counters


@dataclass
class CounterLine:
    key: str  # dive, poke, engage, split, pick, frontline, early, late
    threat: float  # 0..1 how much the enemy relies on it
    answer: float  # 0..1 how well we answer it


def counter_details(ours: Sequence[ChampData], enemy: Sequence[ChampData]) -> list[CounterLine]:
    if not ours or not enemy:
        return []
    o = _sums(ours)
    e = _sums(enemy)
    no, ne = len(ours), len(enemy)

    def avg(s: Sequence[float], t: str, n: int) -> float:
        return s[I[t]] / n

    dive_threat = sum((c.traits[I["mobility"]] + c.traits[I["pick"]]) / 6 for c in enemy if c.archetype in DIVE_ARCHES)
    lines = [
        CounterLine(
            "dive",
            min(1.0, dive_threat / 2),
            min(1.0, (o[I["peel"]] + 0.5 * o[I["cc"]] + 0.5 * o[I["frontline"]]) / (no * 1.8)),
        ),
        CounterLine(
            "poke",
            min(1.0, avg(e, "poke", ne) / 1.6),
            min(1.0, (o[I["engage"]] + 0.5 * o[I["sustain"]] + 0.3 * o[I["mobility"]]) / (no * 1.4)),
        ),
        CounterLine(
            "engage",
            min(1.0, avg(e, "engage", ne) / 1.6),
            min(1.0, (o[I["peel"]] + 0.5 * o[I["cc"]] + 0.3 * o[I["poke"]]) / (no * 1.6)),
        ),
        CounterLine(
            "split",
            min(1.0, max(c.traits[I["splitpush"]] for c in enemy) / 3) * 0.8,
            min(1.0, 0.6 * o[I["waveclear"]] / (no * 1.8) + 0.4 * max(c.traits[I["splitpush"]] for c in ours) / 3),
        ),
        CounterLine(
            "pick",
            min(1.0, avg(e, "pick", ne) / 1.6),
            min(1.0, (o[I["peel"]] + 0.6 * o[I["frontline"]] + 0.3 * o[I["mobility"]]) / (no * 1.6)),
        ),
        CounterLine(
            "frontline",
            min(1.0, avg(e, "frontline", ne) / 1.6),
            min(1.0, sum(1 for c in ours if c.archetype in DPS_ARCHES or c.traits[I["late"]] >= 3) / 2),
        ),
        CounterLine(
            "early",
            max(0.0, min(1.0, (avg(e, "early", ne) - 1.2) / 1.3)),
            max(0.0, min(1.0, 0.5 + (avg(o, "early", no) - avg(e, "early", ne)) / 1.5 + 0.2 * avg(o, "peel", no) / 3)),
        ),
        CounterLine(
            "late",
            max(0.0, min(1.0, (avg(e, "late", ne) - 1.2) / 1.3)),
            max(0.0, min(1.0, 0.5 + (avg(o, "early", no) - avg(e, "early", ne)) / 1.5 + (avg(o, "late", no) - avg(e, "late", ne)) / 2)),
        ),
    ]
    return lines


def counter_score(ours: Sequence[ChampData], enemy: Sequence[ChampData]) -> float:
    lines = counter_details(ours, enemy)
    if not lines:
        return 0.5
    tot = sum(l.threat + 0.05 for l in lines)
    return sum((l.threat + 0.05) * l.answer for l in lines) / tot


# --------------------------------------------------------------------------- notes


def _names(champs: Sequence[ChampData]) -> str:
    names = [c.name for c in champs]
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " et " + names[-1]


def top_by(champs: Sequence[ChampData], trait: str, minimum: int = 2, limit: int = 2) -> list[ChampData]:
    idx = I[trait]
    good = [c for c in champs if c.traits[idx] >= minimum]
    good.sort(key=lambda c: (-c.traits[idx], c.name))
    return good[:limit]


def team_notes(champs: Sequence[ChampData], ignore_damage: bool = False) -> tuple[list[str], list[str]]:
    """French strengths and warnings for a lineup."""
    strengths: list[str] = []
    warnings: list[str] = []
    n = len(champs)
    if n == 0:
        return strengths, warnings
    f = n / 5
    s = _sums(champs)

    front = top_by(champs, "frontline")
    if not front:
        warnings.append("Pas de frontline : personne pour encaisser les dégâts en combat")
    elif s[I["frontline"]] >= 5 * f:
        strengths.append(f"Frontline solide ({_names(front)})")

    eng = top_by(champs, "engage", 3)
    if eng:
        strengths.append(f"Engage fiable avec {_names(eng)}")
    elif n >= 3 and s[I["engage"]] < 3 * f:
        warnings.append("Peu d'engage : difficile de forcer un combat")

    peel = top_by(champs, "peel", 3)
    if peel and any(c.traits[I["late"]] >= 3 for c in champs):
        carry = max(champs, key=lambda c: (c.traits[I["late"]], c.name))
        strengths.append(f"{_names(peel)} peut protéger {carry.name}")

    if n >= 3:
        share = ap_share(champs)
        if share <= 0.05:
            warnings.append("Dégâts 100% AD : l'armure adverse suffira" if not ignore_damage else "Full AD assumé : l'adversaire va empiler l'armure")
        elif share >= 0.95:
            warnings.append("Dégâts 100% AP : la résistance magique adverse suffira" if not ignore_damage else "Full AP assumé : l'adversaire va empiler la résistance magique")
        elif share < 0.25:
            warnings.append("Dégâts très majoritairement AD")
        elif share > 0.75:
            warnings.append("Dégâts très majoritairement AP")
        else:
            strengths.append("Bon mélange de dégâts AD/AP")

    if s[I["waveclear"]] < 5 * f and n >= 3:
        warnings.append("Waveclear faible : difficile de défendre les tours")
    elif s[I["waveclear"]] >= 9 * f:
        strengths.append("Excellent waveclear pour tenir et assiéger")

    if s[I["cc"]] < 4 * f and n >= 3:
        warnings.append("Peu de contrôles (CC) pour verrouiller une cible")
    elif s[I["cc"]] >= 9 * f:
        strengths.append("Beaucoup de contrôles pour verrouiller les cibles")

    poke = top_by(champs, "poke", 3)
    if len(poke) >= 2:
        strengths.append(f"Poke à longue portée ({_names(poke)})")
    split = top_by(champs, "splitpush", 3, 1)
    if split:
        strengths.append(f"{split[0].name} peut tenir une lane seul en split push")

    early = s[I["early"]] / n
    late = s[I["late"]] / n
    if n >= 3:
        if early >= 2.2 and late < 1.8:
            warnings.append("Compo très early : il faut prendre l'avance et finir vite")
        elif late >= 2.4 and early < 1.4:
            warnings.append("Début de partie fragile : jouer safe jusqu'aux objets")
        elif late >= 2.4:
            strengths.append("Très forte en fin de partie")
        elif early >= 2.2:
            strengths.append("Fort début de partie")
    return strengths, warnings
