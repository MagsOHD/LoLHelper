"""Players: CRUD, Riot sync, preferences and manual pool."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from ..engine.models import PlayerPreferences
from ..services import engine_bridge
from ..services import players as svc
from ..services.state import AppContext
from ..settings import PLATFORMS
from .deps import get_ctx, not_found, unprocessable, validate_champions
from ..services.schemas import Player, PlayerCreate, PoolUpdate

router = APIRouter(prefix="/players", tags=["players"])


def _get_row(ctx: AppContext, player_id: str) -> dict:
    row = ctx.db.get_player(player_id)
    if row is None:
        raise not_found("Joueur introuvable.")
    return row


def _duplicate(game_name: str, tag_line: str) -> HTTPException:
    return HTTPException(status_code=409, detail=f"Le joueur {game_name}#{tag_line} existe déjà.")


@router.get("", response_model=list[Player])
async def list_players(ctx: AppContext = Depends(get_ctx)) -> list[Player]:
    return [svc.to_player(row, ctx) for row in ctx.db.list_players()]


@router.post("", response_model=Player, status_code=201)
async def create_player(body: PlayerCreate, ctx: AppContext = Depends(get_ctx)) -> Player:
    game_name = body.game_name.strip()
    tag_line = body.tag_line.strip().lstrip("#").strip()
    platform = (body.platform or ctx.settings.riot_platform).strip().lower()
    if not game_name or not tag_line:
        raise unprocessable("Le nom de jeu et le tag sont obligatoires.")
    if platform not in PLATFORMS:
        raise unprocessable(f"Serveur inconnu : {platform}. Valeurs possibles : {', '.join(PLATFORMS)}.")
    if ctx.db.find_player_by_riot_id(game_name, tag_line):
        raise _duplicate(game_name, tag_line)

    fields: dict = {"game_name": game_name, "tag_line": tag_line, "platform": platform}
    if ctx.riot is not None:
        account = await svc.resolve_account(ctx, game_name, tag_line, platform)
        puuid = account["puuid"]
        fields["game_name"] = account.get("gameName") or game_name
        fields["tag_line"] = account.get("tagLine") or tag_line
        if ctx.db.find_player_by_puuid(puuid):
            raise _duplicate(fields["game_name"], fields["tag_line"])
        fields["puuid"] = puuid
        fields.update(await svc.fetch_riot_fields(ctx, puuid, platform))
        # Re-check after the (slow) Riot calls to avoid concurrent duplicates.
        if ctx.db.find_player_by_puuid(puuid) or ctx.db.find_player_by_riot_id(
            fields["game_name"], fields["tag_line"]
        ):
            raise _duplicate(fields["game_name"], fields["tag_line"])
    row = ctx.db.insert_player(fields)
    return svc.to_player(row, ctx)


@router.get("/{player_id}", response_model=Player)
async def get_player(player_id: str, ctx: AppContext = Depends(get_ctx)) -> Player:
    return svc.to_player(_get_row(ctx, player_id), ctx)


@router.delete("/{player_id}", status_code=204)
async def delete_player(player_id: str, ctx: AppContext = Depends(get_ctx)) -> Response:
    if not ctx.db.delete_player(player_id):
        raise not_found("Joueur introuvable.")
    return Response(status_code=204)


@router.post("/{player_id}/sync", response_model=Player)
async def sync_player(player_id: str, ctx: AppContext = Depends(get_ctx)) -> Player:
    row = _get_row(ctx, player_id)
    if ctx.riot is None:
        raise HTTPException(
            status_code=400,
            detail="Aucune clé API Riot configurée : impossible de synchroniser ce joueur.",
        )
    fields: dict = {}
    puuid = row.get("puuid")
    if not puuid:
        # Manual player created before a key was configured: resolve the Riot ID now.
        account = await svc.resolve_account(ctx, row["game_name"], row["tag_line"], row["platform"])
        puuid = account["puuid"]
        other = ctx.db.find_player_by_puuid(puuid)
        if other and other["id"] != player_id:
            raise _duplicate(row["game_name"], row["tag_line"])
        fields.update(
            puuid=puuid,
            game_name=account.get("gameName") or row["game_name"],
            tag_line=account.get("tagLine") or row["tag_line"],
        )
    fields.update(await svc.fetch_riot_fields(ctx, puuid, row["platform"]))
    updated = ctx.db.update_player(player_id, fields)
    if updated is None:  # deleted meanwhile
        raise not_found("Joueur introuvable.")
    return svc.to_player(updated, ctx)


@router.put("/{player_id}/preferences", response_model=Player)
async def update_preferences(
    player_id: str, body: PlayerPreferences, ctx: AppContext = Depends(get_ctx)
) -> Player:
    _get_row(ctx, player_id)
    validate_champions(ctx, [*body.wanted_champions, *body.avoided_champions])
    if body.wanted_archetypes:
        known = {a.key for a in engine_bridge.list_archetypes()}
        unknown = [a for a in body.wanted_archetypes if a not in known]
        if unknown:
            raise unprocessable(f"Type de personnage inconnu : {', '.join(unknown)}.")
    prefs = body.model_copy(
        update={
            "roles": list(dict.fromkeys(body.roles)),
            "wanted_archetypes": list(dict.fromkeys(body.wanted_archetypes)),
            "wanted_champions": list(dict.fromkeys(body.wanted_champions)),
            "avoided_champions": list(dict.fromkeys(body.avoided_champions)),
        }
    )
    row = ctx.db.update_player(player_id, {"preferences": prefs.model_dump(mode="json")})
    return svc.to_player(row, ctx)  # type: ignore[arg-type]


@router.put("/{player_id}/pool", response_model=Player)
async def update_pool(player_id: str, body: PoolUpdate, ctx: AppContext = Depends(get_ctx)) -> Player:
    _get_row(ctx, player_id)
    validate_champions(ctx, [e.champion_id for e in body.champions])
    dedup = {e.champion_id: e for e in body.champions}  # last entry wins
    pool = [e.model_dump(mode="json") for e in dedup.values()]
    row = ctx.db.update_player(player_id, {"manual_pool": pool})
    return svc.to_player(row, ctx)  # type: ignore[arg-type]
