"""Runtime state shared by the routes (stored on `app.state.ctx`)."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from ..db import Database
from ..riot import DataDragonClient, RiotClient
from ..settings import Settings
from . import engine_bridge

logger = logging.getLogger(__name__)


@dataclass
class AppContext:
    settings: Settings
    db: Database
    ddragon: DataDragonClient
    riot: RiotClient | None = None
    catalog: Any = None  # engine ChampionCatalog
    ddragon_version: str = "offline"
    _refresh_lock: asyncio.Lock | None = field(default=None, repr=False)

    async def refresh_catalog(self) -> None:
        """(Re)load Data Dragon champions and rebuild the engine catalog."""
        if self._refresh_lock is None:
            self._refresh_lock = asyncio.Lock()
        async with self._refresh_lock:
            version, champions = await self.ddragon.load_champions()
            catalog = engine_bridge.build_catalog(champions, version)
            self.catalog, self.ddragon_version = catalog, version
            logger.info("Champion catalog ready (Data Dragon %s, %d raw champions)", version, len(champions))
