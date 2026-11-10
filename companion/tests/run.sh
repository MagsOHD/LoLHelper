#!/usr/bin/env bash
# Tests du compagnon sous Linux avec PowerShell 7 : bash companion/tests/run.sh
#   PWSH=/chemin/vers/pwsh (défaut : pwsh dans le PATH), php, python3, openssl, curl requis.
#   SITE=real : utilise la vraie API PHP (copie de public/) au lieu du faux site fake_site.php.
# 1. tests unitaires (tests/unit.ps1) ;
# 2. intégration : faux client League HTTPS auto-signé (fake_lcu.py, scénario chronométré,
#    redémarrage du client avec nouveau port/jeton) + faux site (`php -S` fake_site.php),
#    assistant de configuration piloté par l'entrée standard, puis vérification des envois.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../lolhelper-draft.ps1"
PWSH="${PWSH:-pwsh}"

echo "== Copies téléchargeables (public/companion/) identiques"
for f in lolhelper-draft.ps1 Lancer-LoLHelper-Draft.bat; do
  cmp -s "$HERE/../$f" "$HERE/../../public/companion/$f" || { echo "public/companion/$f diffère de companion/$f : recopiez-le."; exit 1; }
done
[ "$(head -c3 "$SCRIPT" | od -An -tx1 | tr -d ' ')" = "efbbbf" ] || { echo "lolhelper-draft.ps1 doit être en UTF-8 avec BOM (Windows PowerShell 5.1)."; exit 1; }
if grep -q $'[^\r]$' "$HERE/../Lancer-LoLHelper-Draft.bat"; then echo "Le .bat doit avoir des fins de ligne CRLF."; exit 1; fi

command -v "$PWSH" >/dev/null || { echo "pwsh introuvable (PWSH=...) : tests ignorés."; exit 2; }

echo "== Tests unitaires"
"$PWSH" -NoProfile -File "$HERE/unit.ps1"

W="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$W"
}
trap cleanup EXIT

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }

openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -days 1 \
  -keyout "$W/key.pem" -out "$W/cert.pem" >/dev/null 2>&1

PUUID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["puuid"])' "$HERE/fixtures/current-summoner.json")"
PASSWORD='s3cret-pass'
mkdir -p "$W/site" "$W/config"
SITE_PORT="$(free_port)"
if [ "${SITE:-fake}" = "real" ]; then
  # Vraie API PHP (copie de public/) ; le joueur est créé via store/players.
  cp -R "$HERE/../../public" "$W/www"; rm -f "$W/www/api/config.php"; rm -rf "$W/www/api/data"
  mkdir -p "$W/data"
  printf "<?php\nreturn ['app_password' => '%s', 'data_dir' => '%s', 'riot_api_key' => '', 'riot_platform' => 'euw1'];\n" \
    "$PASSWORD" "$W/data" > "$W/www/api/config.php"
  php -S "127.0.0.1:$SITE_PORT" -t "$W/www" >"$W/php.log" 2>&1 &
else
  FAKE_SITE_DIR="$W/site" FAKE_SITE_PASSWORD="$PASSWORD" FAKE_SITE_PUUIDS="$PUUID" \
    php -S "127.0.0.1:$SITE_PORT" "$HERE/fake_site.php" >"$W/php.log" 2>&1 &
fi
PIDS+=($!)
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$SITE_PORT/api/index.php?r=meta" && break; sleep 0.1; done
if [ "${SITE:-fake}" = "real" ]; then
  curl -sf -X PUT -H "X-App-Password: $PASSWORD" -H 'Content-Type: application/json' \
    --data "{\"id\":\"p1\",\"name\":\"Moi\",\"puuid\":\"$PUUID\"}" \
    "http://127.0.0.1:$SITE_PORT/api/index.php?r=store/players/p1" >/dev/null
fi

LOCKFILE="$W/lockfile"
start_lcu() { # $1 = n° du scénario, $2 = jeton
  python3 "$HERE/fake_lcu.py" --scenario "$HERE/fixtures/scenario-$1.json" --fixtures "$HERE/fixtures" \
    --lockfile "$LOCKFILE" --cert "$W/cert.pem" --key "$W/key.pem" --log "$W/lcu$1.log" --token "$2" &
  LCU_PID=$!
  PIDS+=($LCU_PID)
  for _ in $(seq 50); do [ -s "$LOCKFILE" ] && break; sleep 0.1; done
}

echo "== Intégration (environ 75 s)"
# Adresse saisie avec une barre finale et un fragment (#/team/x) : normalisée par l'assistant.
printf 'http://127.0.0.1:%s/#/team/x\nmauvais\n%s\n' "$SITE_PORT" "$PASSWORD" | \
  "$PWSH" -NoProfile -File "$SCRIPT" -ConfigPath "$W/config/LoLHelper/config.json" \
    -LockfilePath "$LOCKFILE" -MaxRunSeconds 68 >"$W/companion.log" 2>&1 &
COMP_PID=$!
PIDS+=($COMP_PID)

sleep 4
start_lcu 1 "token-one_AAA"
echo "-- contrôle TLS"
"$PWSH" -NoProfile -File "$HERE/tls-check.ps1" -LcuLockfile "$LOCKFILE"
sleep 31
kill "$LCU_PID"; rm -f "$LOCKFILE"   # client fermé
sleep 4
start_lcu 2 "token-two_BBB"           # client relancé : nouveau port, nouveau jeton
wait "$COMP_PID" || { echo "Le compagnon a échoué"; cat "$W/companion.log"; exit 1; }

echo "-- sortie console du compagnon"
cat "$W/companion.log"
echo "-- vérifications"
if [ "${SITE:-fake}" = "real" ]; then
  [ "$(grep -c 'Envoyé au site' "$W/companion.log")" -eq 9 ] || { echo "ECHEC : 9 envois attendus"; exit 1; }
  if sed -n '/Ctrl+C/,$p' "$W/companion.log" | grep -Eqi "refus|HTTP 4|injoignable"; then echo "ECHEC : envoi refusé par l'API"; exit 1; fi
  curl -sf -H "X-App-Password: $PASSWORD" "http://127.0.0.1:$SITE_PORT/api/index.php?r=live-draft&players=p1" | \
    python3 -c 'import json,sys; d=json.load(sys.stdin)["live"]; assert d["phase"]=="none" and d["player_id"]=="p1", d; print("ok   vraie API : 9 envois acceptés, dernier état none pour p1")'
else
  python3 "$HERE/check_results.py" "$W" "$HERE/fixtures" "$PUUID" "$PASSWORD"
fi
