"""REST API routes (mounted under /api)."""

from fastapi import APIRouter

from . import compositions, meta, players, teams

api_router = APIRouter(prefix="/api")
api_router.include_router(meta.router)
api_router.include_router(players.router)
api_router.include_router(teams.router)
api_router.include_router(compositions.router)

__all__ = ["api_router"]
