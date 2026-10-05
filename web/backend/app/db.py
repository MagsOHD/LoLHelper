"""SQLite persistence (stdlib sqlite3).

A single connection shared by the whole app, guarded by a re-entrant lock: queries are tiny,
so serialising them is simpler and safer than juggling per-request connections.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    game_name TEXT NOT NULL,
    tag_line TEXT NOT NULL,
    platform TEXT NOT NULL,
    puuid TEXT,
    profile_icon_id INTEGER,
    summoner_level INTEGER,
    rank_json TEXT,
    masteries_json TEXT NOT NULL DEFAULT '[]',
    recent_json TEXT,
    preferences_json TEXT NOT NULL DEFAULT '{}',
    manual_pool_json TEXT NOT NULL DEFAULT '[]',
    last_synced_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    player_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_compositions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    team_id TEXT,
    theme TEXT,
    picks_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS match_cache (
    match_id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);
"""

# column name -> (decoded key, default when NULL)
_JSON_COLUMNS: dict[str, tuple[str, Any]] = {
    "rank_json": ("rank", None),
    "masteries_json": ("masteries", []),
    "recent_json": ("recent", None),
    "preferences_json": ("preferences", {}),
    "manual_pool_json": ("manual_pool", []),
    "player_ids_json": ("player_ids", []),
    "picks_json": ("picks", []),
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id() -> str:
    return str(uuid.uuid4())


def _decode(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    out: dict[str, Any] = {}
    for key in row.keys():
        value = row[key]
        if key in _JSON_COLUMNS:
            name, default = _JSON_COLUMNS[key]
            out[name] = json.loads(value) if value else (default.copy() if isinstance(default, (list, dict)) else default)
        else:
            out[key] = value
    return out


def _encode(fields: dict[str, Any]) -> dict[str, Any]:
    """Map decoded keys (e.g. "rank") back to their *_json columns."""
    reverse = {name: col for col, (name, _) in _JSON_COLUMNS.items()}
    out: dict[str, Any] = {}
    for key, value in fields.items():
        if key in reverse:
            out[reverse[key]] = None if value is None else json.dumps(value, ensure_ascii=False)
        else:
            out[key] = value
    return out


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            if self.path != ":memory:":
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- low level -----------------------------------------------------------------------
    def _fetchall(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(sql, tuple(params)).fetchall()
        return [_decode(r) for r in rows]  # type: ignore[misc]

    def _fetchone(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(sql, tuple(params)).fetchone()
        return _decode(row)

    def _insert(self, table: str, fields: dict[str, Any]) -> None:
        cols = _encode(fields)
        sql = f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})"
        with self._lock:
            self._conn.execute(sql, tuple(cols.values()))
            self._conn.commit()

    def _update(self, table: str, row_id: str, fields: dict[str, Any]) -> None:
        if not fields:
            return
        cols = _encode(fields)
        sql = f"UPDATE {table} SET {', '.join(f'{c} = ?' for c in cols)} WHERE id = ?"
        with self._lock:
            self._conn.execute(sql, (*cols.values(), row_id))
            self._conn.commit()

    def _delete(self, table: str, row_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
            self._conn.commit()
            return cur.rowcount > 0

    # -- players -------------------------------------------------------------------------
    def list_players(self) -> list[dict[str, Any]]:
        return self._fetchall("SELECT * FROM players ORDER BY created_at, rowid")

    def get_player(self, player_id: str) -> dict[str, Any] | None:
        return self._fetchone("SELECT * FROM players WHERE id = ?", (player_id,))

    def find_player_by_riot_id(self, game_name: str, tag_line: str) -> dict[str, Any] | None:
        gn, tl = game_name.strip().casefold(), tag_line.strip().casefold()
        for p in self.list_players():
            if p["game_name"].casefold() == gn and p["tag_line"].casefold() == tl:
                return p
        return None

    def find_player_by_puuid(self, puuid: str) -> dict[str, Any] | None:
        return self._fetchone("SELECT * FROM players WHERE puuid = ?", (puuid,))

    def insert_player(self, fields: dict[str, Any]) -> dict[str, Any]:
        data = {"id": new_id(), "created_at": utc_now_iso(), **fields}
        self._insert("players", data)
        return self.get_player(data["id"])  # type: ignore[return-value]

    def update_player(self, player_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
        self._update("players", player_id, fields)
        return self.get_player(player_id)

    def delete_player(self, player_id: str) -> bool:
        """Delete a player and remove it from every team (single transaction)."""
        with self._lock:
            cur = self._conn.execute("DELETE FROM players WHERE id = ?", (player_id,))
            if cur.rowcount == 0:
                self._conn.rollback()
                return False
            for row in self._conn.execute("SELECT id, player_ids_json FROM teams").fetchall():
                ids = json.loads(row["player_ids_json"] or "[]")
                if player_id in ids:
                    ids = [i for i in ids if i != player_id]
                    self._conn.execute(
                        "UPDATE teams SET player_ids_json = ? WHERE id = ?", (json.dumps(ids), row["id"])
                    )
            self._conn.commit()
            return True

    # -- teams ---------------------------------------------------------------------------
    def list_teams(self) -> list[dict[str, Any]]:
        return self._fetchall("SELECT * FROM teams ORDER BY created_at, rowid")

    def get_team(self, team_id: str) -> dict[str, Any] | None:
        return self._fetchone("SELECT * FROM teams WHERE id = ?", (team_id,))

    def insert_team(self, name: str, player_ids: list[str]) -> dict[str, Any]:
        data = {"id": new_id(), "name": name, "player_ids": player_ids, "created_at": utc_now_iso()}
        self._insert("teams", data)
        return self.get_team(data["id"])  # type: ignore[return-value]

    def update_team(self, team_id: str, name: str, player_ids: list[str]) -> dict[str, Any] | None:
        self._update("teams", team_id, {"name": name, "player_ids": player_ids})
        return self.get_team(team_id)

    def delete_team(self, team_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM teams WHERE id = ?", (team_id,))
            self._conn.execute("UPDATE saved_compositions SET team_id = NULL WHERE team_id = ?", (team_id,))
            self._conn.commit()
            return cur.rowcount > 0

    # -- saved compositions --------------------------------------------------------------
    def list_saved(self) -> list[dict[str, Any]]:
        return self._fetchall("SELECT * FROM saved_compositions ORDER BY created_at DESC, rowid DESC")

    def get_saved(self, comp_id: str) -> dict[str, Any] | None:
        return self._fetchone("SELECT * FROM saved_compositions WHERE id = ?", (comp_id,))

    def insert_saved(self, fields: dict[str, Any]) -> dict[str, Any]:
        data = {"id": new_id(), "created_at": utc_now_iso(), **fields}
        self._insert("saved_compositions", data)
        return self.get_saved(data["id"])  # type: ignore[return-value]

    def delete_saved(self, comp_id: str) -> bool:
        return self._delete("saved_compositions", comp_id)

    # -- match cache (match details are immutable: cached forever) -----------------------
    def get_cached_matches(self, match_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not match_ids:
            return {}
        placeholders = ", ".join("?" for _ in match_ids)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT match_id, data_json FROM match_cache WHERE match_id IN ({placeholders})",
                tuple(match_ids),
            ).fetchall()
        return {r["match_id"]: json.loads(r["data_json"]) for r in rows}

    def put_cached_match(self, match_id: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO match_cache (match_id, data_json, fetched_at) VALUES (?, ?, ?)",
                (match_id, json.dumps(data, ensure_ascii=False), utc_now_iso()),
            )
            self._conn.commit()
