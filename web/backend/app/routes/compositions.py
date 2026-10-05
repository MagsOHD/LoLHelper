"""Composition generation, game plans, matchup plans and saved compositions."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from starlette.concurrency import run_in_threadpool

from ..engine.models import GamePlan, MatchupPlan, Pick, Role
from ..services import engine_bridge
from ..services import players as player_svc
from ..services.state import AppContext
from .deps import get_ctx, not_found, unprocessable, validate_champions
from ..services.schemas import (
    EnemyPick,
    GamePlanRequest,
    GenerateRequest,
    GenerateResponse,
    MatchupRequest,
    SavedComposition,
    SavedCompositionIn,
)

router = APIRouter(prefix="/compositions", tags=["compositions"])

ROLE_ORDER = list(Role)


def _validate_picks(ctx: AppContext, picks: list[Pick], *, label: str = "La composition") -> None:
    if len(picks) > 5:
        raise unprocessable(f"{label} ne peut pas contenir plus de 5 champions.")
    roles = [p.role for p in picks]
    if len(set(roles)) != len(roles):
        raise unprocessable(f"{label} contient plusieurs champions sur le même rôle.")
    champs = [p.champion_id for p in picks]
    if len(set(champs)) != len(champs):
        raise unprocessable(f"{label} contient plusieurs fois le même champion.")
    validate_champions(ctx, champs)


def assign_enemy_roles(enemy: list[EnemyPick], catalog) -> list[Pick]:
    """Fill missing enemy roles: first catalog role not already taken, else any free role."""
    taken: set[Role] = {e.role for e in enemy if e.role is not None}
    out: list[Pick] = []
    for e in enemy:
        role = e.role
        if role is None:
            champ = catalog.get(e.champion_id)
            candidates = [r for r in (champ.roles if champ else []) if r not in taken]
            candidates += [r for r in ROLE_ORDER if r not in taken and r not in candidates]
            role = candidates[0]
            taken.add(role)
        out.append(Pick(role=role, champion_id=e.champion_id))
    return out


@router.post("/generate", response_model=GenerateResponse)
async def generate(body: GenerateRequest, ctx: AppContext = Depends(get_ctx)) -> GenerateResponse:
    ids = body.player_ids
    if not 1 <= len(ids) <= 5:
        raise unprocessable("Sélectionnez entre 1 et 5 joueurs.")
    if len(set(ids)) != len(ids):
        raise unprocessable("Un joueur est sélectionné plusieurs fois.")
    rows = []
    for pid in ids:
        row = ctx.db.get_player(pid)
        if row is None:
            raise not_found(f"Joueur introuvable : {pid}.")
        rows.append(row)

    opts = body.options
    for mapping, what in ((opts.role_assignments, "un rôle"), (opts.locked_picks, "un champion")):
        stray = [pid for pid in mapping if pid not in ids]
        if stray:
            raise unprocessable(f"Impossible d'imposer {what} à un joueur non sélectionné : {', '.join(stray)}.")
    forced_roles = list(opts.role_assignments.values())
    if len(set(forced_roles)) != len(forced_roles):
        raise unprocessable("Deux joueurs ne peuvent pas être forcés sur le même rôle.")
    locked = list(opts.locked_picks.values())
    if len(set(locked)) != len(locked):
        raise unprocessable("Le même champion est imposé à plusieurs joueurs.")
    validate_champions(ctx, [*locked, *opts.bans, *opts.enemy_champions])
    if opts.theme is not None:
        known = {t.key for t in engine_bridge.list_themes()}
        if opts.theme not in known:
            raise unprocessable(f"Thème inconnu : {opts.theme}.")

    players = [player_svc.to_player_input(row, ctx) for row in rows]
    suggestions = await run_in_threadpool(engine_bridge.generate_compositions, players, opts, ctx.catalog)
    return GenerateResponse(suggestions=suggestions)


@router.post("/game-plan", response_model=GamePlan)
async def game_plan(body: GamePlanRequest, ctx: AppContext = Depends(get_ctx)):
    if not body.picks:
        raise unprocessable("Ajoutez au moins un champion pour obtenir un plan de jeu.")
    _validate_picks(ctx, body.picks)
    return engine_bridge.build_game_plan(body.picks, ctx.catalog)


@router.post("/matchup", response_model=MatchupPlan)
async def matchup(body: MatchupRequest, ctx: AppContext = Depends(get_ctx)):
    if not body.enemy:
        raise unprocessable("Ajoutez au moins un champion adverse.")
    if len(body.enemy) > 5:
        raise unprocessable("L'équipe adverse ne peut pas contenir plus de 5 champions.")
    validate_champions(ctx, [e.champion_id for e in body.enemy])
    explicit = [e.role for e in body.enemy if e.role is not None]
    if len(set(explicit)) != len(explicit):
        raise unprocessable("L'équipe adverse contient plusieurs champions sur le même rôle.")
    _validate_picks(ctx, body.ally, label="Votre composition")
    enemy = assign_enemy_roles(body.enemy, ctx.catalog)
    _validate_picks(ctx, enemy, label="L'équipe adverse")
    return engine_bridge.build_matchup_plan(body.ally, enemy, ctx.catalog)


@router.get("/saved", response_model=list[SavedComposition])
async def list_saved(ctx: AppContext = Depends(get_ctx)) -> list:
    return ctx.db.list_saved()


@router.post("/saved", response_model=SavedComposition, status_code=201)
async def create_saved(body: SavedCompositionIn, ctx: AppContext = Depends(get_ctx)) -> dict:
    name = body.name.strip()
    if not name:
        raise unprocessable("Le nom de la composition est obligatoire.")
    if not body.picks:
        raise unprocessable("Une composition sauvegardée doit contenir au moins un champion.")
    _validate_picks(ctx, body.picks)
    if body.team_id is not None and ctx.db.get_team(body.team_id) is None:
        raise not_found("Équipe introuvable.")
    return ctx.db.insert_saved(
        {
            "name": name,
            "team_id": body.team_id,
            "theme": body.theme,
            "picks": [p.model_dump(mode="json") for p in body.picks],
            "notes": body.notes,
        }
    )


@router.delete("/saved/{comp_id}", status_code=204)
async def delete_saved(comp_id: str, ctx: AppContext = Depends(get_ctx)) -> Response:
    if not ctx.db.delete_saved(comp_id):
        raise not_found("Composition introuvable.")
    return Response(status_code=204)
