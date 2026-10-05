"""API tests: FastAPI TestClient, temp sqlite DB, engine stubbed, no network."""

from __future__ import annotations

import pytest
import respx
from fastapi.testclient import TestClient

from app.engine.models import GenerationOptions, PlayerInput, Role
from app.main import create_app
from app.riot import RateLimiter, RiotClient
from app.settings import Settings
from tests.fixtures.fakes import EngineStub, OfflineDDragon, load_fixture


def make_settings(tmp_path, **kw) -> Settings:
    base = dict(
        _env_file=None,
        riot_api_key="",
        riot_platform="euw1",
        riot_region="",
        database_path=tmp_path / "app.db",
        cache_dir=tmp_path / "cache",
        frontend_dist=tmp_path / "no-dist",
    )
    base.update(kw)
    return Settings(**base)


@pytest.fixture
def engine(monkeypatch) -> EngineStub:
    return EngineStub().install(monkeypatch)


@pytest.fixture
def client(tmp_path, engine):
    app = create_app(make_settings(tmp_path), ddragon=OfflineDDragon())
    with TestClient(app) as c:
        yield c


def add_player(client, name="Alice", tag="EUW"):
    r = client.post("/api/players", json={"game_name": name, "tag_line": tag})
    assert r.status_code == 201, r.text
    return r.json()


# -- meta ------------------------------------------------------------------------------------
def test_health_and_meta_without_key(client, engine):
    assert client.get("/api/health").json() == {"status": "ok"}
    meta = client.get("/api/meta").json()
    assert meta["riot_configured"] is False
    assert meta["ddragon_version"] == "offline"
    assert meta["platform"] == "euw1" and meta["region"] == "europe"
    assert "kr" in meta["platforms"]
    assert engine.calls["build_catalog"][0] == ([], "offline")


def test_static_lists(client):
    names = [c["name"] for c in client.get("/api/champions").json()]
    assert names == sorted(names, key=str.casefold) and "Wukong" in names
    assert client.get("/api/archetypes").json()[0]["key"] == "mage"
    assert client.get("/api/themes").json()[0]["key"] == "engage"


def test_unknown_api_route_is_french_404(client):
    r = client.get("/api/nope")
    assert r.status_code == 404 and r.json()["detail"] == "Ressource introuvable."


# -- players ---------------------------------------------------------------------------------
def test_create_manual_player_without_key(client):
    p = add_player(client, "Le Fou Élégant", "#EUW")
    assert p["puuid"] is None
    assert (p["game_name"], p["tag_line"], p["platform"]) == ("Le Fou Élégant", "EUW", "euw1")
    assert p["recent"]["roles"] == {"TOP": 0, "JUNGLE": 0, "MID": 0, "BOTTOM": 0, "SUPPORT": 0}
    assert p["pool"] == [] and p["rank"] is None and p["profile_icon_url"] == ""
    assert client.get(f"/api/players/{p['id']}").json()["id"] == p["id"]
    assert len(client.get("/api/players").json()) == 1


def test_duplicate_player_is_409_case_insensitive(client):
    add_player(client, "Alice", "EUW")
    r = client.post("/api/players", json={"game_name": "aLICE", "tag_line": "euw"})
    assert r.status_code == 409 and "existe déjà" in r.json()["detail"]


def test_invalid_platform_and_body(client):
    r = client.post("/api/players", json={"game_name": "A", "tag_line": "B", "platform": "mars1"})
    assert r.status_code == 422 and "Serveur inconnu" in r.json()["detail"]
    r = client.post("/api/players", json={"game_name": ""})
    assert r.status_code == 422 and isinstance(r.json()["detail"], str)


def test_sync_without_key_is_400(client):
    p = add_player(client)
    r = client.post(f"/api/players/{p['id']}/sync")
    assert r.status_code == 400 and "clé API Riot" in r.json()["detail"]
    assert client.post("/api/players/unknown/sync").status_code == 404


def test_update_preferences_and_pool(client, engine):
    p = add_player(client)
    prefs = {"roles": ["MID", "SUPPORT"], "wanted_archetypes": ["mage"], "wanted_champions": ["Ahri"], "avoided_champions": ["Garen"]}
    r = client.put(f"/api/players/{p['id']}/preferences", json=prefs)
    assert r.status_code == 200 and r.json()["preferences"] == prefs

    r = client.put(f"/api/players/{p['id']}/preferences", json={"wanted_champions": ["Zzz"]})
    assert r.status_code == 422 and "Champion inconnu" in r.json()["detail"]
    r = client.put(f"/api/players/{p['id']}/preferences", json={"wanted_archetypes": ["ninja"]})
    assert r.status_code == 422

    r = client.put(f"/api/players/{p['id']}/pool", json={"champions": [{"champion_id": "Ahri", "comfort": 0.9}, {"champion_id": "Lux", "comfort": 0.4}]})
    body = r.json()
    assert r.status_code == 200
    assert [e["champion_id"] for e in body["manual_pool"]] == ["Ahri", "Lux"]
    assert [e["champion_id"] for e in body["pool"]] == ["Ahri", "Lux"]  # computed through compute_pool
    masteries, recent, manual, preferences, _ = engine.calls["compute_pool"][-1]
    assert [m.champion_id for m in manual] == ["Ahri", "Lux"]
    assert preferences.roles == [Role.MID, Role.SUPPORT]

    r = client.put(f"/api/players/{p['id']}/pool", json={"champions": [{"champion_id": "Nope", "comfort": 0.5}]})
    assert r.status_code == 422 and "Nope" in r.json()["detail"]
    r = client.put(f"/api/players/{p['id']}/pool", json={"champions": [{"champion_id": "Ahri", "comfort": 3}]})
    assert r.status_code == 422
    assert client.put("/api/players/missing/pool", json={"champions": []}).status_code == 404


# -- teams -----------------------------------------------------------------------------------
def test_teams_crud_and_limit(client):
    ids = [add_player(client, f"P{i}")["id"] for i in range(6)]
    r = client.post("/api/teams", json={"name": "Les potes", "player_ids": ids[:5]})
    assert r.status_code == 201
    team = r.json()
    assert team["player_ids"] == ids[:5] and team["created_at"]

    r = client.post("/api/teams", json={"name": "Trop", "player_ids": ids})
    assert r.status_code == 422 and "5 joueurs" in r.json()["detail"]
    assert client.post("/api/teams", json={"name": "X", "player_ids": ["ghost"]}).status_code == 404

    r = client.put(f"/api/teams/{team['id']}", json={"name": "Renommée", "player_ids": ids[:2]})
    assert r.json()["name"] == "Renommée" and r.json()["player_ids"] == ids[:2]
    assert client.get(f"/api/teams/{team['id']}").json()["name"] == "Renommée"
    assert len(client.get("/api/teams").json()) == 1
    assert client.delete(f"/api/teams/{team['id']}").status_code == 204
    assert client.get(f"/api/teams/{team['id']}").status_code == 404
    assert client.delete(f"/api/teams/{team['id']}").status_code == 404


def test_delete_player_removes_it_from_teams(client):
    a, b = add_player(client, "A")["id"], add_player(client, "B")["id"]
    team = client.post("/api/teams", json={"name": "T", "player_ids": [a, b]}).json()
    assert client.delete(f"/api/players/{a}").status_code == 204
    assert client.get(f"/api/players/{a}").status_code == 404
    assert client.get(f"/api/teams/{team['id']}").json()["player_ids"] == [b]


# -- compositions ----------------------------------------------------------------------------
def test_generate_calls_engine_with_player_inputs(client, engine):
    a = add_player(client, "A")
    b = add_player(client, "B")
    client.put(f"/api/players/{a['id']}/pool", json={"champions": [{"champion_id": "Ahri", "comfort": 1}]})
    client.put(f"/api/players/{a['id']}/preferences", json={"roles": ["MID"]})
    body = {
        "player_ids": [a["id"], b["id"]],
        "options": {"theme": "engage", "role_assignments": {a["id"]: "MID"}, "bans": ["Garen"], "count": 3},
    }
    r = client.post("/api/compositions/generate", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["suggestions"][0]["picks"][0]["champion_id"] == "Ahri"

    players, options, catalog = engine.calls["generate_compositions"][-1]
    assert all(isinstance(p, PlayerInput) for p in players)
    assert [p.player_id for p in players] == [a["id"], b["id"]]
    assert players[0].name == "A"
    assert players[0].preferences.roles == [Role.MID]
    assert [e.champion_id for e in players[0].pool] == ["Ahri"]
    assert players[0].role_games == {r: 0 for r in Role}
    assert isinstance(options, GenerationOptions)
    assert options.theme == "engage" and options.count == 3 and options.bans == ["Garen"]
    assert options.role_assignments == {a["id"]: Role.MID}
    assert catalog.get("Ahri") is not None


def test_generate_validation(client):
    a = add_player(client, "A")["id"]
    gen = lambda body: client.post("/api/compositions/generate", json=body)  # noqa: E731
    assert gen({"player_ids": []}).status_code == 422
    r = gen({"player_ids": [a, "ghost"]})
    assert r.status_code == 404 and "introuvable" in r.json()["detail"]
    ids = [add_player(client, f"P{i}")["id"] for i in range(5)]
    assert gen({"player_ids": [a, *ids]}).status_code == 422
    r = gen({"player_ids": [a], "options": {"bans": ["Zzz"]}})
    assert r.status_code == 422 and "Champion inconnu : Zzz." == r.json()["detail"]
    assert gen({"player_ids": [a], "options": {"theme": "nope"}}).status_code == 422
    assert gen({"player_ids": [a], "options": {"locked_picks": {"other": "Ahri"}}}).status_code == 422


def test_game_plan(client, engine):
    picks = [{"role": "MID", "champion_id": "Ahri"}, {"role": "SUPPORT", "champion_id": "Thresh"}]
    r = client.post("/api/compositions/game-plan", json={"picks": picks})
    assert r.status_code == 200 and r.json()["identity"] == "Compo test"
    r = client.post("/api/compositions/game-plan", json={"picks": [{"role": "MID", "champion_id": "Nope"}]})
    assert r.status_code == 422


def test_matchup_fills_enemy_roles(client, engine):
    body = {
        "ally": [{"role": "MID", "champion_id": "Ahri"}],
        "enemy": [
            {"champion_id": "Lux"},  # roles SUPPORT, MID -> SUPPORT taken by Leona -> MID
            {"champion_id": "Leona", "role": "SUPPORT"},
            {"champion_id": "Thresh"},  # SUPPORT taken -> first free role: TOP
            {"champion_id": "Jinx"},  # BOTTOM
        ],
    }
    r = client.post("/api/compositions/matchup", json=body)
    assert r.status_code == 200, r.text
    ally, enemy, _ = engine.calls["build_matchup_plan"][-1]
    assert [(p.champion_id, p.role) for p in ally] == [("Ahri", Role.MID)]
    assert [(p.champion_id, p.role) for p in enemy] == [
        ("Lux", Role.MID),
        ("Leona", Role.SUPPORT),
        ("Thresh", Role.TOP),
        ("Jinx", Role.BOTTOM),
    ]
    r = client.post("/api/compositions/matchup", json={"ally": [], "enemy": [{"champion_id": "Zed"}]})
    assert r.status_code == 422 and "Zed" in r.json()["detail"]


def test_saved_compositions_crud(client):
    a = add_player(client, "A")["id"]
    team = client.post("/api/teams", json={"name": "T", "player_ids": [a]}).json()
    body = {"name": "Ma compo", "team_id": team["id"], "theme": "engage",
            "picks": [{"role": "MID", "champion_id": "Ahri", "player_id": a}], "notes": "Fun"}
    r = client.post("/api/compositions/saved", json=body)
    assert r.status_code == 201
    saved = r.json()
    assert saved["id"] and saved["created_at"] and saved["picks"][0]["champion_id"] == "Ahri"
    assert {k: saved[k] for k in body} == body
    assert [s["id"] for s in client.get("/api/compositions/saved").json()] == [saved["id"]]
    bad = dict(body, picks=[{"role": "MID", "champion_id": "Unknown"}])
    assert client.post("/api/compositions/saved", json=bad).status_code == 422
    assert client.post("/api/compositions/saved", json=dict(body, team_id="ghost")).status_code == 404
    assert client.delete(f"/api/compositions/saved/{saved['id']}").status_code == 204
    assert client.get("/api/compositions/saved").json() == []
    assert client.delete(f"/api/compositions/saved/{saved['id']}").status_code == 404


# -- frontend --------------------------------------------------------------------------------
def test_spa_fallback(tmp_path, engine):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>SPA</html>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    app = create_app(make_settings(tmp_path, frontend_dist=dist), ddragon=OfflineDDragon())
    with TestClient(app) as c:
        assert c.get("/").text == "<html>SPA</html>"
        assert c.get("/players/123").text == "<html>SPA</html>"
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert c.get("/api/health").json() == {"status": "ok"}
        r = c.get("/api/unknown")
        assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")


def test_no_dist_means_no_spa(client):
    assert client.get("/").status_code == 404


# -- with a Riot key (Riot API mocked) -------------------------------------------------------
@respx.mock
def test_create_and_sync_player_with_riot_key(tmp_path, engine):
    eu, euw = "https://europe.api.riotgames.com", "https://euw1.api.riotgames.com"
    account = load_fixture("account.json")
    puuid = account["puuid"]
    respx.get(url__regex=r".*/riot/account/v1/accounts/by-riot-id/Ghost/.*").respond(404)
    respx.get(url__regex=r".*/riot/account/v1/accounts/by-riot-id/.*").respond(json=account)
    respx.get(f"{euw}/lol/summoner/v4/summoners/by-puuid/{puuid}").respond(json=load_fixture("summoner.json"))
    respx.get(f"{euw}/lol/league/v4/entries/by-puuid/{puuid}").respond(json=load_fixture("league_entries.json"))
    respx.get(f"{euw}/lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}/top").respond(
        json=load_fixture("masteries.json")
    )
    ids = load_fixture("match_ids.json")
    respx.get(f"{eu}/lol/match/v5/matches/by-puuid/{puuid}/ids").respond(json=ids)
    for mid in ids:
        respx.get(f"{eu}/lol/match/v5/matches/{mid}").respond(json=load_fixture(f"match_{mid}.json"))

    riot = RiotClient("RGAPI-x", limiter=RateLimiter(limits=()))
    settings = make_settings(tmp_path, riot_api_key="RGAPI-x")
    app = create_app(settings, ddragon=OfflineDDragon(version="15.19.1"), riot_client=riot)
    with TestClient(app) as c:
        assert c.get("/api/meta").json()["riot_configured"] is True
        r = c.post("/api/players", json={"game_name": "le fou élégant", "tag_line": "euw"})
        assert r.status_code == 201, r.text
        p = r.json()
        assert p["game_name"] == "Le Fou Élégant" and p["puuid"] == puuid
        assert p["summoner_level"] == 287
        assert p["profile_icon_url"].endswith("/cdn/15.19.1/img/profileicon/5367.png")
        assert p["rank"]["tier"] == "GOLD" and p["last_synced_at"].endswith("Z")
        assert p["recent"]["games"] == 5 and p["recent"]["roles"]["MID"] == 2
        assert p["masteries"][0]["champion_id"] == "Ahri"
        r = c.post("/api/players", json={"game_name": "Le Fou Élégant", "tag_line": "EUW"})
        assert r.status_code == 409
        r = c.post(f"/api/players/{p['id']}/sync")
        assert r.status_code == 200 and r.json()["recent"]["games"] == 5

        r = c.post("/api/players", json={"game_name": "Ghost", "tag_line": "0000"})
        assert r.status_code == 404 and "introuvable" in r.json()["detail"]
