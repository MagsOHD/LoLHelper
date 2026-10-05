"""FastAPI application: `uvicorn app.main:app` (run from web/backend)."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .db import Database
from .riot import DataDragonClient, RiotClient, RiotError
from .routes import api_router
from .services.engine_bridge import EngineUnavailableError
from .services.state import AppContext
from .settings import Settings

logger = logging.getLogger("app")

_DEFAULT_HTTP_MESSAGES = {
    404: "Ressource introuvable.",
    405: "Méthode non autorisée.",
}


def _format_validation_errors(exc: RequestValidationError) -> str:
    parts = []
    for err in exc.errors()[:5]:
        loc = ".".join(str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path"))
        parts.append(f"{loc or 'requête'} : {err.get('msg', 'valeur invalide')}")
    return "Requête invalide — " + " ; ".join(parts)


def _install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(RiotError)
    async def _riot_error(_: Request, exc: RiotError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})

    @app.exception_handler(EngineUnavailableError)
    async def _engine_error(_: Request, exc: EngineUnavailableError) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"detail": _format_validation_errors(exc), "errors": jsonable_errors(exc)},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail
        if isinstance(detail, str) and detail in ("Not Found", "Method Not Allowed"):
            detail = _DEFAULT_HTTP_MESSAGES.get(exc.status_code, detail)
        return JSONResponse(status_code=exc.status_code, content={"detail": detail}, headers=exc.headers)


def jsonable_errors(exc: RequestValidationError) -> list[dict]:
    from fastapi.encoders import jsonable_encoder

    return jsonable_encoder(exc.errors(), custom_encoder={Exception: str})


def _mount_frontend(app: FastAPI, dist: Path) -> None:
    index = dist / "index.html"
    if not index.is_file():
        logger.info("Frontend build not found at %s (API only)", dist)
        return
    root = dist.resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        if full_path == "api" or full_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": _DEFAULT_HTTP_MESSAGES[404]})
        if full_path:
            candidate = (root / full_path).resolve()
            if candidate.is_file() and candidate.is_relative_to(root):
                return FileResponse(candidate)
        return FileResponse(index)


def create_app(
    settings: Settings | None = None,
    *,
    ddragon: DataDragonClient | None = None,
    riot_client: RiotClient | None = None,
) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = Database(settings.database_path)
        dd = ddragon or DataDragonClient(settings.cache_dir, settings.ddragon_locale)
        riot = riot_client
        if riot is None and settings.riot_configured:
            riot = RiotClient(settings.riot_api_key)
        ctx = AppContext(settings=settings, db=db, ddragon=dd, riot=riot)
        app.state.ctx = ctx
        try:
            await ctx.refresh_catalog()
        except EngineUnavailableError as exc:
            logger.error("%s", exc)
            raise
        if not settings.riot_configured:
            logger.warning("RIOT_API_KEY absente : mode manuel (pas de synchronisation Riot).")
        try:
            yield
        finally:
            if ddragon is None:
                await dd.aclose()
            if riot is not None and riot_client is None:
                await riot.aclose()
            db.close()

    app = FastAPI(title="LoL Team Builder", version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    _install_error_handlers(app)
    app.include_router(api_router)
    _mount_frontend(app, settings.frontend_dist)
    return app


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
app = create_app()
