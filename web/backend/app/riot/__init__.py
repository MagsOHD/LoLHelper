"""Riot Games API and Data Dragon clients."""

from .client import RiotClient
from .ddragon import OFFLINE_VERSION, DataDragonClient, profile_icon_url
from .errors import RiotAuthError, RiotError, RiotNotConfigured, RiotNotFound, RiotRateLimited
from .player_data import fetch_match_summaries, fetch_player_data
from .ratelimit import DEV_KEY_LIMITS, RateLimiter

__all__ = [
    "DEV_KEY_LIMITS",
    "OFFLINE_VERSION",
    "DataDragonClient",
    "RateLimiter",
    "RiotAuthError",
    "RiotClient",
    "RiotError",
    "RiotNotConfigured",
    "RiotNotFound",
    "RiotRateLimited",
    "fetch_match_summaries",
    "fetch_player_data",
    "profile_icon_url",
]
