"""Pure composition engine (no I/O except its own JSON data files)."""

from .catalog import ChampionCatalog, build_catalog, list_archetypes
from .generator import generate_compositions as _generate_compositions
from .models import *  # noqa: F401,F403 - re-export shared models
from .plans import build_game_plan as _build_game_plan, build_matchup_plan as _build_matchup_plan
from .pool import compute_pool
from .text import elide_all
from .themes import list_themes

from . import models as _models


def generate_compositions(players, options, catalog):
    return elide_all(_generate_compositions(players, options, catalog))


def build_game_plan(picks, catalog):
    return elide_all(_build_game_plan(picks, catalog))


def build_matchup_plan(ally, enemy, catalog):
    return elide_all(_build_matchup_plan(ally, enemy, catalog))



__all__ = [
    n for n, v in vars(_models).items() if getattr(v, "__module__", None) == _models.__name__
] + [
    "ChampionCatalog",
    "build_catalog",
    "build_game_plan",
    "build_matchup_plan",
    "compute_pool",
    "generate_compositions",
    "list_archetypes",
    "list_themes",
]
