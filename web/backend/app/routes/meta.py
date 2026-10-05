"""Health, meta and static game data (champions, archetypes, themes)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..engine.models import ArchetypeInfo, ChampionInfo, ThemeInfo
from ..services import engine_bridge
from ..services.state import AppContext
from ..settings import PLATFORMS
from .deps import get_ctx
from ..services.schemas import Meta

router = APIRouter(tags=["meta"])


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


def _meta(ctx: AppContext) -> Meta:
    return Meta(
        ddragon_version=ctx.ddragon_version,
        riot_configured=ctx.settings.riot_configured,
        platform=ctx.settings.riot_platform,
        region=ctx.settings.effective_region,
        platforms=PLATFORMS,
        password_required=bool(ctx.settings.app_password),
    )


@router.get("/meta", response_model=Meta)
async def meta(ctx: AppContext = Depends(get_ctx)) -> Meta:
    return _meta(ctx)


@router.post("/meta/refresh-catalog", response_model=Meta)
async def refresh_catalog(ctx: AppContext = Depends(get_ctx)) -> Meta:
    """Re-download Data Dragon (if reachable) and rebuild the champion catalog."""
    await ctx.refresh_catalog()
    return _meta(ctx)


@router.get("/champions", response_model=list[ChampionInfo])
async def champions(ctx: AppContext = Depends(get_ctx)) -> list:
    return sorted(ctx.catalog.all(), key=lambda c: c.name.casefold())


@router.get("/archetypes", response_model=list[ArchetypeInfo])
async def archetypes() -> list:
    return engine_bridge.list_archetypes()


@router.get("/themes", response_model=list[ThemeInfo])
async def themes() -> list:
    return engine_bridge.list_themes()
