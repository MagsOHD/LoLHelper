#!/usr/bin/env python3
"""Vérifie les journaux produits par run.sh (faux LCU + faux site)."""
import json
import sys

work, fixtures, puuid, password = sys.argv[1:5]
real_site = len(sys.argv) > 5 and sys.argv[5] == "real"
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


def load(name):
    with open(fixtures + "/" + name, encoding="utf-8") as fh:
        return json.load(fh)


SESSIONS = ["session-planning.json", "session-banpick.json", "session-finalization.json",
            "session-game-starting.json", "session-revealed-banpick.json"]
LOCAL_ID = {"game_name": "Moi", "tag_line": "EUW"}
# Identifiants et pseudos des autres joueurs présents dans les fixtures (jamais dans le diagnostic).
others = set()
local_sid = load("current-summoner.json")["summonerId"]
for name in SESSIONS:
    for team in ("myTeam", "theirTeam"):
        for m in load(name)[team]:
            if m["puuid"] == puuid:
                continue
            for k in ("puuid", "gameName", "obfuscatedPuuid"):
                if m.get(k):
                    others.add(m[k])
            if m.get("summonerId"):
                others.add(str(m["summonerId"]))

log_text = open(work + "/companion.log", encoding="utf-8", errors="replace").read()
check("console : compte Moi#EUW", "Connecté au client League : compte Moi#EUW" in log_text)
check("console : identifiant Riot absent signalé (avec -Diagnostic)",
      "ne fournit pas votre identifiant Riot" in log_text and "-Diagnostic" in log_text)
diag_path = work + "/tmp/lolhelper-diagnostic.json"
check("diagnostic : chemin affiché", diag_path in log_text)
try:
    with open(diag_path, encoding="utf-8") as fh:
        diag_text = fh.read()
    diag = json.loads(diag_text)
except (OSError, ValueError) as e:
    diag_text, diag = "", {}
    check("diagnostic : fichier JSON écrit", False, e)
if diag:
    cs = (diag.get("current_summoner") or {}).get("body") or {}
    check("diagnostic : compte local conservé", cs.get("gameName") == "Moi" and cs.get("tagLine") == "EUW"
          and cs.get("puuid") == puuid, cs)
    sess = (diag.get("champ_select_session") or {}).get("body") or {}
    check("diagnostic : dernière sélection (Clash) présente", sess.get("gameId") == load("session-revealed-banpick.json")["gameId"]
          and len(sess.get("theirTeam", [])) == 5, list(sess.keys()))
    me = next((m for m in sess.get("myTeam", []) if m.get("cellId") == sess.get("localPlayerCellId")), {})
    check("diagnostic : joueur local de la sélection conservé", me.get("gameName") == "Moi" and me.get("puuid") == puuid, me)
    leaked = sorted(x for x in others if x in diag_text)
    check("diagnostic : identités des autres joueurs masquées", not leaked, leaked)
    check("diagnostic : masquage visible", '"<masqué>"' in diag_text)
    masked = [m for m in sess.get("myTeam", []) + sess.get("theirTeam", []) if m.get("cellId") != sess.get("localPlayerCellId")]
    check("diagnostic : champs vides laissés vides, autres masqués",
          all(m.get("gameName") in ("", "<masqué>") and m.get("puuid") in ("", "<masqué>") and m.get("summonerId") in (0, "<masqué>")
              for m in masked) and any(m.get("puuid") == "<masqué>" for m in masked), masked)
    check("diagnostic : interprétation", diag.get("interpretation", {}).get("local_riot_id") == "Moi#EUW"
          and diag["interpretation"].get("local_puuid_accepted") is True, diag.get("interpretation"))
    check("diagnostic : aucun jeton du client", "token-one_AAA" not in diag_text and "token-two_BBB" not in diag_text
          and "cmlvd" not in diag_text)

if real_site:
    if failures:
        print("%d échec(s)" % len(failures))
        sys.exit(1)
    print("Intégration (diagnostic, console) : tout est bon.")
    sys.exit(0)

puts = jsonl(work + "/site/puts.jsonl")
site_reqs = jsonl(work + "/site/requests.jsonl")
lcu = jsonl(work + "/lcu1.log") + jsonl(work + "/lcu2.log")

phases = [p["body"]["phase"] for p in puts]
expected = ["planning", "ban_pick", "finalization", "game_starting", "none",
            "ban_pick", "none", "ban_pick", "none"]
check("séquence des envois", phases == expected, phases)
check("payloads valides (contrat)", all(not p["errors"] for p in puts), [p["errors"] for p in puts if p["errors"]])
check("puuid local (UUID du client, tel quel)", all(p["body"]["puuid"] == puuid for p in puts))
check("riot_id local", all(p["body"]["riot_id"] == LOCAL_ID for p in puts))
check("version 2", all(p["body"]["version"] == 2 for p in puts))
queues = [p["body"]["queue_id"] for p in puts]
check("queue_id 420 puis 700 (gameflow session, Clash)", queues == [420] * 7 + [700] * 2, queues)
raw = "".join(p["raw"] for p in puts)
check("aucun pseudo masqué par le client, aucun summonerId ni identifiant masqué",
      all(s not in raw for s in ("SECRET", "obf-enemy", "99000", "88000", "104857601", "obfuscated", "summonerId")))
# Alliés : riot_id seulement pour les noms affichés par le client (soi-même, partenaire de duo).
for p in puts:
    for m in p["body"]["my_team"]:
        want = {2: LOCAL_ID, 3: {"game_name": "Ami Élégant", "tag_line": "EUW"}}.get(m["cell"])
        if m.get("riot_id") != want:
            check("my_team : riot_id seulement si visible", False, m)
            break
check("my_team : riot_id du partenaire (accents UTF-8)", any("Ami Élégant" in json.dumps(p["body"], ensure_ascii=False) for p in puts[:4]))

# Classée : le client masque les adversaires -> puuid "" partout.
ranked = [p["body"] for p in puts[:7]]
check("classée : their_team.puuid vide",
      all(e.get("puuid") == "" for b in ranked for e in b["their_team"]),
      [b["their_team"] for b in ranked])
check("classée : aucun riot_id adverse", all("riot_id" not in e for b in ranked for e in b["their_team"]))
# Clash : le client affiche l'équipe adverse -> puuid du LCU tel quel + nom#tag affiché, rien d'autre.
revealed = load("session-revealed-banpick.json")
want = [{"cell": m["cellId"], "puuid": m["puuid"], "riot_id": {"game_name": m["gameName"], "tag_line": m["tagLine"]},
         "champion_key": m["championId"]} for m in revealed["theirTeam"]]
rv = puts[7]["body"] if len(puts) > 7 else {}
check("Clash : their_team = cellule + puuid + riot_id affichés par le client + champion", rv.get("their_team") == want, rv.get("their_team"))
check("Clash : identités adverses seulement dans l'envoi révélé",
      all(m[k] not in p["raw"] for m in revealed["theirTeam"] for k in ("puuid", "gameName")
          for i, p in enumerate(puts) if i != 7))

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
