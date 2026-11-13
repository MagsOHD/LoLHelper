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
queues = [p["body"]["queue_id"] for p in puts]
check("queue_id 420 puis 700 (gameflow session, Clash)", queues == [420] * 7 + [700] * 2, queues)
raw = "".join(p["raw"] for p in puts)
check("aucune identité adverse hors puuid révélé",
      all(s not in raw for s in ("SECRET", "obf-enemy", "99000", "88000", "VisibleEnemy", "CLASH")))

# Classée : le client masque les adversaires -> puuid "" partout.
ranked = [p["body"] for p in puts[:7]]
check("classée : their_team.puuid vide",
      all(e.get("puuid") == "" for b in ranked for e in b["their_team"]),
      [b["their_team"] for b in ranked])
# Clash : le client affiche l'équipe adverse -> puuid du LCU, tel quel, rien d'autre.
with open(fixtures + "/session-revealed-banpick.json", encoding="utf-8") as fh:
    revealed = json.load(fh)
want = [{"cell": m["cellId"], "puuid": m["puuid"], "champion_key": m["championId"]} for m in revealed["theirTeam"]]
rv = puts[7]["body"] if len(puts) > 7 else {}
check("Clash : their_team = cellule + puuid du client + champion", rv.get("their_team") == want, rv.get("their_team"))
check("Clash : puuid adverses seulement dans l'envoi révélé",
      all(m["puuid"] not in p["raw"] for m in revealed["theirTeam"] for i, p in enumerate(puts) if i != 7))

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
