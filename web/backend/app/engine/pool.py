"""Champion pool of a player: how well they know each champion and how much they want it."""

from __future__ import annotations

import math

from .catalog import ChampionCatalog
from .models import (
    ManualPoolEntry,
    MasteryEntry,
    PlayerPreferences,
    PoolEntry,
    RecentChampionStat,
)

FULL_MASTERY_POINTS = 500_000  # points at which mastery comfort saturates
DAY_MS = 86_400_000
FRESH_DAYS = 30  # no decay below this
STALE_DAYS = 365  # maximum decay reached here
MAX_DECAY = 0.4

DESIRE_WANTED_CHAMPION = 1.0
DESIRE_WANTED_ARCHETYPE = 0.6
DESIRE_PLAYED = 0.3  # baseline desire for champions the player plays on their own


def mastery_comfort(points: int, level: int) -> float:
    """Log-scaled: 1k ≈ 0.11, 10k ≈ 0.39, 50k ≈ 0.63, 125k ≈ 0.78, 500k = 1."""
    k = max(0, points) / 1000
    base = math.log1p(k) / math.log1p(FULL_MASTERY_POINTS / 1000)
    return min(1.0, base + 0.01 * min(max(level, 0), 10))


def recency_factor(last_play_time: int | None, now_ms: int | None) -> float:
    if not last_play_time or not now_ms:
        return 1.0
    days = max(0.0, (now_ms - last_play_time) / DAY_MS)
    stale = min(1.0, max(0.0, days - FRESH_DAYS) / (STALE_DAYS - FRESH_DAYS))
    return 1.0 - MAX_DECAY * stale


def recent_comfort(games: int, wins: int) -> float:
    if games <= 0:
        return 0.0
    value = 0.3 + 0.4 * min(1.0, games / 8)
    if games >= 3:
        value += 0.4 * (wins / games - 0.5)
    return max(0.0, min(1.0, value))


def compute_pool(
    masteries: list[MasteryEntry],
    recent: list[RecentChampionStat],
    manual: list[ManualPoolEntry],
    preferences: PlayerPreferences,
    catalog: ChampionCatalog,
    now_ms: int | None = None,
) -> list[PoolEntry]:
    """Merge masteries, recent games, manual entries and wishes into a sorted pool.

    `now_ms` defaults to the most recent mastery play time (keeps the result deterministic).
    """
    if now_ms is None:
        times = [m.last_play_time for m in masteries if m.last_play_time]
        now_ms = max(times) if times else None

    avoided = {catalog.resolve(c) or c for c in preferences.avoided_champions}
    wanted_champs = {catalog.resolve(c) or c for c in preferences.wanted_champions}
    wanted_arch = set(preferences.wanted_archetypes)
    entries: dict[str, dict] = {}

    def slot(cid: str) -> dict:
        return entries.setdefault(
            cid,
            {"mastery": 0.0, "recent": 0.0, "manual": None, "sources": [], "points": 0, "level": 0, "games": 0, "wins": 0},
        )

    for m in masteries:
        cid = catalog.resolve(m.champion_id)
        if not cid or cid in avoided:
            continue
        e = slot(cid)
        e["mastery"] = max(e["mastery"], mastery_comfort(m.points, m.level) * recency_factor(m.last_play_time, now_ms))
        e["points"], e["level"] = max(e["points"], m.points), max(e["level"], m.level)
        if "mastery" not in e["sources"]:
            e["sources"].append("mastery")

    for r in recent:
        cid = catalog.resolve(r.champion_id)
        if not cid or cid in avoided or r.games <= 0:
            continue
        e = slot(cid)
        e["games"] += r.games
        e["wins"] += r.wins
        e["recent"] = recent_comfort(e["games"], e["wins"])
        if "recent" not in e["sources"]:
            e["sources"].append("recent")

    for mp in manual:
        cid = catalog.resolve(mp.champion_id)
        if not cid or cid in avoided:
            continue
        e = slot(cid)
        e["manual"] = mp.comfort
        if "manual" not in e["sources"]:
            e["sources"].append("manual")

    for cid in sorted(wanted_champs):
        if cid in avoided or catalog.get(cid) is None:
            continue
        e = slot(cid)
        if "wanted" not in e["sources"]:
            e["sources"].append("wanted")

    if wanted_arch:
        for champ in catalog.all():
            if champ.archetype in wanted_arch and champ.id not in avoided:
                e = slot(champ.id)
                if "wanted" not in e["sources"]:
                    e["sources"].append("wanted")

    pool: list[PoolEntry] = []
    for cid, e in entries.items():
        if e["manual"] is not None:
            comfort = float(e["manual"])
        else:
            # independent evidence combined like probabilities: 1 - (1-a)(1-b)
            comfort = 1 - (1 - e["mastery"]) * (1 - e["recent"])
        champ = catalog.get(cid)
        desire = 0.0
        if comfort > 0:
            played = DESIRE_PLAYED + (0.15 if e["games"] > 0 else 0.0)
            desire = max(desire, played)
        if champ and champ.archetype in wanted_arch:
            desire = max(desire, DESIRE_WANTED_ARCHETYPE + (0.1 if comfort > 0 else 0.0))
        if cid in wanted_champs:
            desire = DESIRE_WANTED_CHAMPION
        pool.append(
            PoolEntry(
                champion_id=cid,
                comfort=round(max(0.0, min(1.0, comfort)), 4),
                desire=round(min(1.0, desire), 4),
                sources=e["sources"],
                mastery_points=e["points"],
                mastery_level=e["level"],
                recent_games=e["games"],
                recent_wins=e["wins"],
            )
        )
    pool.sort(key=lambda p: (-p.comfort, -p.desire, p.champion_id))
    return pool
