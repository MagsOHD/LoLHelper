"""Single import point for the composition engine (`app.engine`).

Routes and services always call `engine_bridge.<fn>(...)` (attribute access at call time), so
tests can stub any engine function with `monkeypatch.setattr(engine_bridge, "<fn>", fake)`.
The engine module is imported lazily, so a missing/incomplete engine yields a clear error.
"""

from __future__ import annotations

import importlib
from types import ModuleType
from typing import Any

ENGINE_EXPORTS = (
    "list_archetypes",
    "list_themes",
    "build_catalog",
    "ChampionCatalog",
    "compute_pool",
    "generate_compositions",
    "build_game_plan",
    "build_matchup_plan",
)


class EngineUnavailableError(RuntimeError):
    pass


def load_engine() -> ModuleType:
    try:
        module = importlib.import_module("app.engine")
    except ImportError as exc:
        raise EngineUnavailableError(
            f"Moteur de composition indisponible : impossible d'importer app.engine ({exc})."
        ) from exc
    missing = [name for name in ENGINE_EXPORTS if not hasattr(module, name)]
    if missing:
        raise EngineUnavailableError(
            "Moteur de composition incomplet : app/engine/__init__.py doit exporter "
            + ", ".join(missing)
            + "."
        )
    return module


def list_archetypes() -> list:
    return load_engine().list_archetypes()


def list_themes() -> list:
    return load_engine().list_themes()


def build_catalog(ddragon_champions: list[dict], version: str) -> Any:
    return load_engine().build_catalog(ddragon_champions, version)


def compute_pool(masteries, recent, manual, preferences, catalog) -> list:
    return load_engine().compute_pool(masteries, recent, manual, preferences, catalog)


def generate_compositions(players, options, catalog) -> list:
    return load_engine().generate_compositions(players, options, catalog)


def build_game_plan(picks, catalog) -> Any:
    return load_engine().build_game_plan(picks, catalog)


def build_matchup_plan(ally, enemy, catalog) -> Any:
    return load_engine().build_matchup_plan(ally, enemy, catalog)
