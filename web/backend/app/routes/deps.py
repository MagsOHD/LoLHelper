"""Shared route dependencies and validation helpers."""

from __future__ import annotations

from typing import Iterable

from fastapi import HTTPException, Request

from ..services.state import AppContext


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx


def not_found(message: str) -> HTTPException:
    return HTTPException(status_code=404, detail=message)


def unprocessable(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


def validate_champions(ctx: AppContext, champion_ids: Iterable[str]) -> None:
    unknown = [c for c in dict.fromkeys(champion_ids) if ctx.catalog.get(c) is None]
    if unknown:
        label = "Champion inconnu" if len(unknown) == 1 else "Champions inconnus"
        raise unprocessable(f"{label} : {', '.join(unknown)}.")
