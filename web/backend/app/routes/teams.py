"""Teams CRUD."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from ..services.state import AppContext
from .deps import get_ctx, not_found, unprocessable
from ..services.schemas import Team, TeamIn

router = APIRouter(prefix="/teams", tags=["teams"])

MAX_TEAM_SIZE = 5


def _validate(ctx: AppContext, body: TeamIn) -> tuple[str, list[str]]:
    name = body.name.strip()
    if not name:
        raise unprocessable("Le nom de l'équipe est obligatoire.")
    player_ids = list(dict.fromkeys(body.player_ids))
    if len(player_ids) > MAX_TEAM_SIZE:
        raise unprocessable(f"Une équipe ne peut pas compter plus de {MAX_TEAM_SIZE} joueurs.")
    for pid in player_ids:
        if ctx.db.get_player(pid) is None:
            raise not_found(f"Joueur introuvable : {pid}.")
    return name, player_ids


@router.get("", response_model=list[Team])
async def list_teams(ctx: AppContext = Depends(get_ctx)) -> list:
    return ctx.db.list_teams()


@router.post("", response_model=Team, status_code=201)
async def create_team(body: TeamIn, ctx: AppContext = Depends(get_ctx)) -> dict:
    name, player_ids = _validate(ctx, body)
    return ctx.db.insert_team(name, player_ids)


@router.get("/{team_id}", response_model=Team)
async def get_team(team_id: str, ctx: AppContext = Depends(get_ctx)) -> dict:
    team = ctx.db.get_team(team_id)
    if team is None:
        raise not_found("Équipe introuvable.")
    return team


@router.put("/{team_id}", response_model=Team)
async def update_team(team_id: str, body: TeamIn, ctx: AppContext = Depends(get_ctx)) -> dict:
    if ctx.db.get_team(team_id) is None:
        raise not_found("Équipe introuvable.")
    name, player_ids = _validate(ctx, body)
    return ctx.db.update_team(team_id, name, player_ids)  # type: ignore[return-value]


@router.delete("/{team_id}", status_code=204)
async def delete_team(team_id: str, ctx: AppContext = Depends(get_ctx)) -> Response:
    if not ctx.db.delete_team(team_id):
        raise not_found("Équipe introuvable.")
    return Response(status_code=204)
