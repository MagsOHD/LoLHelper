"""Data Dragon client: download + disk cache + offline fallback."""

from __future__ import annotations

import asyncio
import json

import httpx
import respx

from app.riot import OFFLINE_VERSION, DataDragonClient, profile_icon_url

VERSIONS = "https://ddragon.leagueoflegends.com/api/versions.json"
CHAMPS = {"type": "champion", "version": "15.19.1", "data": {"Ahri": {"id": "Ahri", "key": "103", "name": "Ahri"}}}


def load(tmp_path, **kw):
    async def go():
        client = DataDragonClient(tmp_path, "fr_FR", **kw)
        try:
            return await client.load_champions()
        finally:
            await client.aclose()

    return asyncio.run(go())


@respx.mock
def test_downloads_then_uses_disk_cache(tmp_path):
    v = respx.get(VERSIONS).respond(json=["15.19.1", "15.18.1"])
    c = respx.get("https://ddragon.leagueoflegends.com/cdn/15.19.1/data/fr_FR/champion.json").respond(json=CHAMPS)
    version, champs = load(tmp_path)
    assert version == "15.19.1" and champs[0]["id"] == "Ahri"
    version, champs = load(tmp_path)
    assert version == "15.19.1" and len(champs) == 1
    assert v.call_count == 1 and c.call_count == 1  # version fresh (<6h) + champion file cached


@respx.mock
def test_unreachable_falls_back_to_cached_file(tmp_path):
    (tmp_path / "champion_15.10.1_fr_FR.json").write_text(json.dumps(CHAMPS), encoding="utf-8")
    respx.get(VERSIONS).mock(side_effect=httpx.ConnectError("blocked"))
    version, champs = load(tmp_path)
    assert version == "15.10.1" and champs[0]["key"] == "103"


@respx.mock
def test_unreachable_without_cache_is_offline(tmp_path):
    respx.get(VERSIONS).respond(403)
    assert load(tmp_path) == (OFFLINE_VERSION, [])


def test_profile_icon_url():
    assert profile_icon_url("15.19.1", 5367) == (
        "https://ddragon.leagueoflegends.com/cdn/15.19.1/img/profileicon/5367.png"
    )
    assert profile_icon_url(OFFLINE_VERSION, 5367) == ""
    assert profile_icon_url("15.19.1", None) == ""
