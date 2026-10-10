#!/usr/bin/env bash
# Tests de l'API PHP : bash web/frontend/php-tests/run.sh
# Lance 4 copies de public/ sous `php -S` (configs différentes) + un faux serveur Riot,
# puis le collecteur méta en ligne de commande (cron) contre ce faux serveur.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC="$HERE/../public"
PHP="${PHP:-php}"

echo "== php -l"
while IFS= read -r -d '' f; do
  "$PHP" -l "$f" >/dev/null || { echo "Syntax error in $f"; exit 1; }
done < <(find "$PUBLIC/api" "$HERE" -name '*.php' -print0)

T="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT

free_port() { "$PHP" -r '$s=stream_socket_server("tcp://127.0.0.1:0");$n=stream_socket_get_name($s,false);echo substr($n,strrpos($n,":")+1);'; }

KEY='RGAPI-test-key-123'
PF="$(free_port)"; PA="$(free_port)"; PB="$(free_port)"; PC="$(free_port)"; PM="$(free_port)"
export FAKE_LOG="$T/fake.log"
export FAKE_CTRL="$T/fake_ctrl.json"

copy_site() { mkdir -p "$T/$1"; cp -R "$PUBLIC" "$T/$1/www"; rm -f "$T/$1/www/api/config.php"; rm -rf "$T/$1/www/api/data"; }
copy_site a; copy_site b; copy_site c
mkdir -p "$T/a/data"
# m : appli dans www/lolhelper/ comme sur OVH (data_dir par défaut = <T>/m/lolhelper-data) ;
# m2 : même code, configs variantes pour le collecteur (CLI uniquement).
for s in m m2; do
  mkdir -p "$T/$s/www"; cp -R "$PUBLIC" "$T/$s/www/lolhelper"
  rm -f "$T/$s/www/lolhelper/api/config.php"; rm -rf "$T/$s/www/lolhelper/api/data"
done
cat > "$T/m/www/lolhelper/api/config.php" <<EOF
<?php
return [
    'riot_api_key' => '$KEY',
    'riot_platform' => 'euw1',
    'app_password' => 's3cret',
    'meta_tiers' => ['CHALLENGER', 'GRANDMASTER', 'IRON'],
    'meta_rate' => 0,
    'meta_time_budget' => 60,
    'meta_min_games' => 3,
];
EOF

cat > "$T/a/www/api/config.php" <<EOF
<?php
return [
    'riot_api_key' => '$KEY',
    'riot_platform' => 'euw1',
    'app_password' => 's3cret',
    'cors_origins' => ['https://friends.example'],
    'data_dir' => '$T/a/data',
];
EOF
# b : pas de config.php du tout (valeurs par défaut).
cat > "$T/c/www/api/config.php" <<EOF
<?php
return [
    'riot_api_key' => '$KEY',
    'riot_platform' => 'kr',
    'app_password' => '',
    'data_dir' => '/dev/null/impossible',
];
EOF

start() { # port docroot [env...] [router]
  local port="$1" root="$2"; shift 2
  env "$@" "$PHP" -d display_errors=0 -d log_errors=1 -d error_log="$T/php_errors.log" \
      -S "127.0.0.1:$port" -t "$root" ${ROUTER:-} >>"$T/server.log" 2>&1 &
  PIDS+=($!)
}

FAKE_KEY="$KEY" ROUTER="$HERE/fake_riot.php" start "$PF" "$HERE" FAKE_KEY="$KEY" FAKE_LOG="$FAKE_LOG" FAKE_CTRL="$FAKE_CTRL"
start "$PA" "$T/a/www" LOLHELPER_RIOT_BASE="http://127.0.0.1:$PF"
start "$PB" "$T/b/www" LOLHELPER_RIOT_BASE="http://127.0.0.1:$PF"
start "$PC" "$T/c/www" LOLHELPER_RIOT_BASE="http://127.0.0.1:1"
start "$PM" "$T/m/www" LOLHELPER_RIOT_BASE="http://127.0.0.1:$PF"

for port in "$PF" "$PA" "$PB" "$PC" "$PM"; do
  for _ in $(seq 1 50); do
    if "$PHP" -r 'exit(@fsockopen("127.0.0.1", (int)$argv[1]) ? 0 : 1);' "$port"; then break; fi
    "$PHP" -r 'usleep(100000);'
  done
done

echo "== HTTP tests"
set +e
API_A="http://127.0.0.1:$PA" API_B="http://127.0.0.1:$PB" API_C="http://127.0.0.1:$PC" TEST_TMP="$T" \
  "$PHP" "$HERE/test_api.php"
status=$?

echo "== Meta collector (CLI) + meta-stats tests"
API_M="http://127.0.0.1:$PM" API_A="http://127.0.0.1:$PA" TEST_TMP="$T" PHP_BIN="$PHP" \
  META_SITE="$T/m/www/lolhelper" META_ALT_SITE="$T/m2/www/lolhelper" META_RIOT_BASE="http://127.0.0.1:$PF" \
  "$PHP" "$HERE/test_meta.php"
meta_status=$?
[ "$status" -eq 0 ] && status=$meta_status
set -e
if [ -s "$T/php_errors.log" ]; then
  echo "== PHP error log (expected entries: network errors, Riot 5xx)"
  sed 's/^/   /' "$T/php_errors.log" | tail -n 20
fi
exit $status
