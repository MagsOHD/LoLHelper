"""Riot API client tests (httpx mocked with respx, realistic payloads in tests/fixtures)."""

from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from app.db import Database
from app.riot import (
    RateLimiter,
    RiotAuthError,
    RiotClient,
    RiotNotFound,
    RiotRateLimited,
    fetch_player_data,
)
from app.riot.aggregate import aggregate_recent, map_masteries, pick_rank, summarize_match
from tests.fixtures.fakes import FakeCatalog, load_fixture

EU = "https://europe.api.riotgames.com"
EUW = "https://euw1.api.riotgames.com"
ACCOUNT = load_fixture("account.json")
PUUID = ACCOUNT["puuid"]
MATCH_IDS = load_fixture("match_ids.json")


class SleepRecorder:
    def __init__(self):
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def make_client(sleep=None, limiter=None) -> RiotClient:
    return RiotClient(
        "RGAPI-test-key",
        limiter=limiter or RateLimiter(limits=()),
        sleep=sleep or SleepRecorder(),
    )


def run(coro):
    return asyncio.run(coro)


def mock_all_player_endpoints(router: respx.Router) -> dict[str, respx.Route]:
    routes = {
        "summoner": router.get(f"{EUW}/lol/summoner/v4/summoners/by-puuid/{PUUID}").respond(
            json=load_fixture("summoner.json")
        ),
        "league": router.get(f"{EUW}/lol/league/v4/entries/by-puuid/{PUUID}").respond(
            json=load_fixture("league_entries.json")
        ),
        "mastery": router.get(
            f"{EUW}/lol/champion-mastery/v4/champion-masteries/by-puuid/{PUUID}/top"
        ).respond(json=load_fixture("masteries.json")),
        "ids": router.get(f"{EU}/lol/match/v5/matches/by-puuid/{PUUID}/ids").respond(json=MATCH_IDS),
    }
    for mid in MATCH_IDS:
        routes[mid] = router.get(f"{EU}/lol/match/v5/matches/{mid}").respond(
            json=load_fixture(f"match_{mid}.json")
        )
    return routes


# -- account ---------------------------------------------------------------------------------
@respx.mock
def test_account_resolution_encodes_riot_id_and_sends_token():
    route = respx.get(url__regex=r"https://europe\.api\.riotgames\.com/riot/account/v1/.*").respond(json=ACCOUNT)

    async def go():
        client = make_client()
        try:
            return await client.get_account_by_riot_id("Le Fou Élégant", "#EUW", "europe")
        finally:
            await client.aclose()

    account = run(go())
    assert account["puuid"] == PUUID
    request = route.calls.last.request
    assert request.headers["X-Riot-Token"] == "RGAPI-test-key"
    assert request.url.raw_path.decode() == (
        "/riot/account/v1/accounts/by-riot-id/Le%20Fou%20%C3%89l%C3%A9gant/EUW"
    )


@respx.mock
def test_account_404_maps_to_not_found_with_french_message():
    respx.get(url__regex=r".*/riot/account/v1/.*").respond(404, json={"status": {"status_code": 404}})
    client = make_client()
    with pytest.raises(RiotNotFound) as exc:
        run(client.get_account_by_riot_id("Inconnu", "0000", "europe"))
    assert "Inconnu#0000" in exc.value.message
    assert exc.value.status_code == 404


@pytest.mark.parametrize("status", [401, 403])
@respx.mock
def test_auth_errors_explain_expired_dev_key(status):
    respx.get(url__regex=r".*/riot/account/v1/.*").respond(status, json={"status": {"message": "Forbidden"}})
    client = make_client()
    with pytest.raises(RiotAuthError) as exc:
        run(client.get_account_by_riot_id("Faker", "KR1", "asia"))
    msg = exc.value.message
    assert "Clé API Riot invalide ou expirée" in msg
    assert "24 h" in msg and "developer.riotgames.com" in msg


# -- rate limiting -----------------------------------------------------------------------------
@respx.mock
def test_429_honours_retry_after_then_succeeds():
    route = respx.get(url__regex=r".*/riot/account/v1/.*").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "3"}),
            httpx.Response(429, headers={"Retry-After": "1"}),
            httpx.Response(200, json=ACCOUNT),
        ]
    )
    sleep = SleepRecorder()
    client = make_client(sleep=sleep)
    account = run(client.get_account_by_riot_id("Faker", "KR1", "europe"))
    assert account["puuid"] == PUUID
    assert route.call_count == 3
    assert sleep.calls == [3.0, 1.0]


@respx.mock
def test_429_gives_up_after_three_retries():
    route = respx.get(url__regex=r".*/riot/account/v1/.*").respond(429, headers={"Retry-After": "2"})
    sleep = SleepRecorder()
    client = make_client(sleep=sleep)
    with pytest.raises(RiotRateLimited):
        run(client.get_account_by_riot_id("Faker", "KR1", "europe"))
    assert route.call_count == 4  # 1 try + 3 retries
    assert sleep.calls == [2.0, 2.0, 2.0]


def test_rate_limiter_waits_when_window_full():
    now = [0.0]
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    limiter = RateLimiter(limits=((2, 1.0), (3, 10.0)), clock=lambda: now[0], sleep=fake_sleep)

    async def go():
        for _ in range(4):
            await limiter.acquire()

    run(go())
    # 2 immediate, 3rd waits 1s (short window), 4th waits until the 10s window frees up.
    assert sleeps[0] == pytest.approx(1.0)
    assert now[0] == pytest.approx(10.0)


# -- aggregation -----------------------------------------------------------------------------
def test_mastery_mapping_uses_numeric_key_and_skips_unknown():
    masteries = map_masteries(load_fixture("masteries.json"), FakeCatalog())
    assert [m["champion_id"] for m in masteries] == ["Ahri", "Thresh", "MonkeyKing"]
    assert masteries[0] == {
        "champion_id": "Ahri",
        "level": 12,
        "points": 154321,
        "last_play_time": 1759600000000,
    }


def test_pick_rank_prefers_solo_queue():
    rank = pick_rank(load_fixture("league_entries.json"))
    assert rank == {"queue": "RANKED_SOLO_5x5", "tier": "GOLD", "division": "II", "lp": 54, "wins": 30, "losses": 25}
    flex_only = [e for e in load_fixture("league_entries.json") if e["queueType"] == "RANKED_FLEX_SR"]
    assert pick_rank(flex_only)["queue"] == "RANKED_FLEX_SR"
    assert pick_rank([]) is None


def test_match_aggregation_positions_wins_kda_and_queue_filter():
    summaries = [summarize_match(load_fixture(f"match_{m}.json")) for m in MATCH_IDS]
    recent = aggregate_recent(summaries, PUUID, FakeCatalog())
    # The ARAM game (queue 450) is excluded.
    assert recent["games"] == 5
    assert recent["roles"] == {"TOP": 0, "JUNGLE": 2, "MID": 2, "BOTTOM": 0, "SUPPORT": 1}
    by_id = {c["champion_id"]: c for c in recent["champions"]}
    assert "Lux" not in by_id
    assert recent["champions"][0]["champion_id"] == "Ahri"
    ahri = by_id["Ahri"]
    assert (ahri["games"], ahri["wins"], ahri["role"]) == (2, 1, "MID")
    assert (ahri["kills"], ahri["deaths"], ahri["assists"]) == (5.5, 3.5, 5.0)
    assert by_id["Thresh"]["role"] == "SUPPORT"
    assert by_id["MonkeyKing"]["wins"] == 1
    # championName "FiddleSticks" does not match the Data Dragon id: resolved via championId 9.
    assert by_id["Fiddlesticks"]["games"] == 1 and by_id["Fiddlesticks"]["wins"] == 0


@respx.mock
def test_fetch_player_data_end_to_end_and_match_cache(tmp_path):
    routes = mock_all_player_endpoints(respx.mock)
    db = Database(tmp_path / "t.db")

    async def go():
        client = make_client()
        try:
            return await fetch_player_data(
                client, puuid=PUUID, platform="euw1", region="europe", catalog=FakeCatalog(), cache=db
            )
        finally:
            await client.aclose()

    data = run(go())
    assert data["profile_icon_id"] == 5367 and data["summoner_level"] == 287
    assert data["rank"]["tier"] == "GOLD"
    assert [m["champion_id"] for m in data["masteries"]][:1] == ["Ahri"]
    assert data["recent"]["games"] == 5
    assert routes["mastery"].calls.last.request.url.params["count"] == "30"
    assert routes["ids"].calls.last.request.url.params["count"] == "20"
    for mid in MATCH_IDS:
        assert routes[mid].call_count == 1

    # Second sync: match details come from the sqlite cache.
    data2 = run(go())
    assert data2["recent"] == data["recent"]
    for mid in MATCH_IDS:
        assert routes[mid].call_count == 1
    db.close()


@respx.mock
def test_summoner_404_is_not_found():
    respx.get(url__regex=r".*/lol/summoner/v4/.*").respond(404)
    client = make_client()
    with pytest.raises(RiotNotFound):
        run(client.get_summoner_by_puuid(PUUID, "euw1"))
