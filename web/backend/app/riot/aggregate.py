"""Pure helpers turning raw Riot payloads into the app's stored player data."""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Iterable, Protocol

# Summoner's Rift queues kept for "recent" stats: ranked solo, ranked flex, normal draft, quickplay.
SUMMONERS_RIFT_QUEUES: frozenset[int] = frozenset({420, 440, 400, 490})
RANK_QUEUES = ("RANKED_SOLO_5x5", "RANKED_FLEX_SR")
ROLES = ("TOP", "JUNGLE", "MID", "BOTTOM", "SUPPORT")
POSITION_TO_ROLE = {
    "TOP": "TOP",
    "JUNGLE": "JUNGLE",
    "MIDDLE": "MID",
    "MID": "MID",
    "BOTTOM": "BOTTOM",
    "UTILITY": "SUPPORT",
    "SUPPORT": "SUPPORT",
}


class CatalogLike(Protocol):
    def get(self, champion_id: str) -> Any: ...
    def by_key(self, key: int) -> Any: ...


def map_position(team_position: str | None) -> str | None:
    return POSITION_TO_ROLE.get((team_position or "").upper())


def pick_rank(entries: Iterable[dict]) -> dict | None:
    by_queue = {e.get("queueType"): e for e in entries or []}
    for queue in RANK_QUEUES:
        entry = by_queue.get(queue)
        if entry:
            return {
                "queue": queue,
                "tier": entry.get("tier", ""),
                "division": entry.get("rank", ""),
                "lp": int(entry.get("leaguePoints", 0)),
                "wins": int(entry.get("wins", 0)),
                "losses": int(entry.get("losses", 0)),
            }
    return None


def map_masteries(raw: Iterable[dict], catalog: CatalogLike, limit: int = 30) -> list[dict]:
    """champion-mastery-v4 entries -> MasteryEntry dicts (numeric championId -> Data Dragon id)."""
    out: list[dict] = []
    for entry in raw or []:
        champ = catalog.by_key(int(entry.get("championId", -1)))
        if champ is None:
            continue
        out.append(
            {
                "champion_id": champ.id,
                "level": int(entry.get("championLevel", 0)),
                "points": int(entry.get("championPoints", 0)),
                "last_play_time": entry.get("lastPlayTime"),
            }
        )
    out.sort(key=lambda m: m["points"], reverse=True)
    return out[:limit]


def summarize_match(raw: dict) -> dict:
    """Compact, puuid-independent summary of a match-v5 payload (what we cache)."""
    info = raw.get("info", {}) or {}
    participants = []
    for p in info.get("participants", []) or []:
        participants.append(
            {
                "puuid": p.get("puuid"),
                "championName": p.get("championName"),
                "championId": p.get("championId"),
                "teamPosition": p.get("teamPosition") or p.get("individualPosition") or "",
                "win": bool(p.get("win")),
                "kills": int(p.get("kills", 0)),
                "deaths": int(p.get("deaths", 0)),
                "assists": int(p.get("assists", 0)),
            }
        )
    return {
        "match_id": (raw.get("metadata") or {}).get("matchId"),
        "queue_id": info.get("queueId"),
        "game_creation": info.get("gameCreation"),
        "participants": participants,
    }


def resolve_champion_id(participant: dict, catalog: CatalogLike) -> str | None:
    name = participant.get("championName") or ""
    if name:
        champ = catalog.get(name)
        if champ is not None:
            return champ.id
    champ_key = participant.get("championId")
    if champ_key is not None:
        champ = catalog.by_key(int(champ_key))
        if champ is not None:
            return champ.id
    return name or None


def empty_recent() -> dict:
    return {"games": 0, "roles": {r: 0 for r in ROLES}, "champions": []}


def aggregate_recent(summaries: Iterable[dict], puuid: str, catalog: CatalogLike) -> dict:
    """Aggregate match summaries into the Player `recent` block."""
    roles: Counter[str] = Counter({r: 0 for r in ROLES})
    games = 0
    per_champ: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"games": 0, "wins": 0, "kills": 0, "deaths": 0, "assists": 0, "roles": Counter()}
    )
    for summary in summaries:
        if summary.get("queue_id") not in SUMMONERS_RIFT_QUEUES:
            continue
        me = next((p for p in summary.get("participants", []) if p.get("puuid") == puuid), None)
        if me is None:
            continue
        champion_id = resolve_champion_id(me, catalog)
        if not champion_id:
            continue
        games += 1
        role = map_position(me.get("teamPosition"))
        if role:
            roles[role] += 1
        stat = per_champ[champion_id]
        stat["games"] += 1
        stat["wins"] += 1 if me.get("win") else 0
        stat["kills"] += me.get("kills", 0)
        stat["deaths"] += me.get("deaths", 0)
        stat["assists"] += me.get("assists", 0)
        if role:
            stat["roles"][role] += 1

    champions = []
    for champion_id, s in per_champ.items():
        n = s["games"]
        champions.append(
            {
                "champion_id": champion_id,
                "games": n,
                "wins": s["wins"],
                "kills": round(s["kills"] / n, 2),
                "deaths": round(s["deaths"] / n, 2),
                "assists": round(s["assists"] / n, 2),
                "role": s["roles"].most_common(1)[0][0] if s["roles"] else None,
            }
        )
    champions.sort(key=lambda c: (-c["games"], -c["wins"], c["champion_id"]))
    return {"games": games, "roles": {r: roles[r] for r in ROLES}, "champions": champions}
