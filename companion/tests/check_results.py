#!/usr/bin/env python3
"""Vérifie les journaux produits par run.sh (faux LCU + faux site)."""
import json
import sys

work, fixtures, puuid, password = sys.argv[1:5]
failures = []


def check(name, ok, info=""):
    print(("ok   " if ok else "ECHEC ") + name + ("" if ok else "  " + str(info)))
    if not ok:
        failures.append(name)


def jsonl(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]
    except FileNotFoundError:
        return []


puts = jsonl(work + "/site/puts.jsonl")
site_reqs = jsonl(work + "/site/requests.jsonl")
lcu = jsonl(work + "/lcu1.log") + jsonl(work + "/lcu2.log")

phases = [p["body"]["phase"] for p in puts]
expected = ["planning", "ban_pick", "finalization", "game_starting", "none",
            "ban_pick", "none", "ban_pick", "none"]
check("séquence des envois", phases == expected, phases)
check("payloads valides (contrat)", all(not p["errors"] for p in puts), [p["errors"] for p in puts if p["errors"]])
check("puuid local", all(p["body"]["puuid"] == puuid for p in puts))
check("queue_id 420 (gameflow session)", all(p["body"]["queue_id"] == 420 for p in puts))
raw = "".join(p["raw"] for p in puts)
check("aucune identité adverse", "SECRET" not in raw and "obf-enemy" not in raw and "99000" not in raw)

with open(fixtures + "/expected-banpick.json", encoding="utf-8") as fh:
    exp = json.load(fh)
bp = next((p["body"] for p in puts if p["body"]["phase"] == "ban_pick"), None)
if bp:
    for k in ("timer_remaining_ms", "sent_at"):
        bp = dict(bp); bp.pop(k); exp.pop(k)
check("ban_pick = expected-banpick.json", bp == exp, json.dumps(bp))
first = next((p["body"] for p in puts if p["body"]["phase"] == "planning"), {})
check("chrono transmis", isinstance(first.get("timer_remaining_ms"), int) and first.get("timer_remaining_ms", 0) > 0)

check("LCU : uniquement des GET", all(r["method"] == "GET" for r in lcu), {r["method"] for r in lcu})
check("LCU : authentification correcte", all(r["auth_ok"] for r in lcu))
allowed = {"/lol-summoner/v1/current-summoner", "/lol-gameflow/v1/gameflow-phase",
           "/lol-champ-select/v1/session", "/lol-gameflow/v1/session"}
check("LCU : endpoints attendus", {r["path"] for r in lcu} <= allowed, {r["path"] for r in lcu} - allowed)
check("LCU : appels sur les deux clients", bool(jsonl(work + "/lcu1.log")) and bool(jsonl(work + "/lcu2.log")))

kinds = {(r["method"], r["r"]) for r in site_reqs}
check("site : requêtes attendues", kinds <= {("GET", "meta"), ("GET", "live-draft"), ("PUT", "live-draft")}, kinds)

with open(work + "/config/LoLHelper/config.json", encoding="utf-8") as fh:
    cfg_text = fh.read()
cfg = json.loads(cfg_text)
check("config : adresse du site", cfg["site_url"].startswith("http://127.0.0.1:"), cfg["site_url"])
check("config : mot de passe non stocké en clair", password not in cfg_text and cfg["password_protected"] != "")

if failures:
    print("%d échec(s)" % len(failures))
    sys.exit(1)
print("Intégration : tout est bon.")
