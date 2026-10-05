"""Shared password and CORS settings used when the app is deployed online."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings
from tests.fixtures.fakes import OfflineDDragon
from tests.test_api_routes import engine, make_settings  # noqa: F401 - pytest fixture

ORIGIN = "https://compo.example.fr"


def _client(tmp_path, **kw) -> TestClient:
    return TestClient(create_app(make_settings(tmp_path, **kw), ddragon=OfflineDDragon()))


def test_password_protects_api_but_not_health_and_meta(tmp_path, engine):  # noqa: F811
    with _client(tmp_path, app_password="secret") as c:
        assert c.get("/api/health").status_code == 200
        meta = c.get("/api/meta").json()
        assert meta["password_required"] is True

        r = c.get("/api/players")
        assert r.status_code == 401
        assert r.json()["detail"] == "Mot de passe requis ou incorrect."
        assert c.get("/api/players", headers={"X-App-Password": "wrong"}).status_code == 401
        assert c.get("/api/players", headers={"X-App-Password": "secret"}).status_code == 200


def test_no_password_by_default(tmp_path, engine):  # noqa: F811
    with _client(tmp_path) as c:
        assert c.get("/api/meta").json()["password_required"] is False
        assert c.get("/api/players").status_code == 200


def test_cross_origin_preflight_and_401_carry_cors_headers(tmp_path, engine):  # noqa: F811
    with _client(tmp_path, app_password="secret", cors_origins=ORIGIN) as c:
        pre = c.options(
            "/api/players",
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "x-app-password",
            },
        )
        assert pre.status_code == 200
        assert pre.headers["access-control-allow-origin"] == ORIGIN

        denied = c.get("/api/players", headers={"Origin": ORIGIN})
        assert denied.status_code == 401
        assert denied.headers["access-control-allow-origin"] == ORIGIN


def test_cors_origins_accept_comma_separated_env(monkeypatch, tmp_path):
    monkeypatch.setenv("CORS_ORIGINS", "https://a.fr/, https://b.fr")
    settings = Settings(_env_file=None, database_path=tmp_path / "db")
    assert settings.cors_origins == ["https://a.fr", "https://b.fr"]
