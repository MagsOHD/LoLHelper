<?php
// Tests du collecteur méta par niveau (cron CLI + collecte depuis le site) et des routes meta-stats /
// meta-status / meta-collect (lancés par run.sh).
declare(strict_types=1);

$M = getenv('API_M');             // site dans www/lolhelper/ (comme sur OVH), mot de passe, data_dir par défaut
$A = getenv('API_A');             // site des tests HTTP : rien de collecté
$B = getenv('API_B');             // pas de config.php, horloge de test figée hors plage horaire (B_NOW)
$B_NOW = (int) getenv('B_NOW');
$SITE = getenv('META_SITE');      // <T>/m/www/lolhelper
$ALT = getenv('META_ALT_SITE');   // <T>/m2/www/lolhelper : configs variantes (CLI uniquement)
$T = getenv('TEST_TMP');
$PHP = getenv('PHP_BIN') ?: 'php';
$FAKE_LOG = getenv('FAKE_LOG');
$FAKE_CTRL = getenv('FAKE_CTRL');
$RIOT_BASE = getenv('META_RIOT_BASE');
const PW = 's3cret';
const KEY = 'RGAPI-test-key-123';
const ADMIN = 'adm1n-Pa55-word';
const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER_PLUS'];

$DATA = "$T/m/lolhelper-data";
$META = "$DATA/meta";
$P = [];
for ($i = 1; $i <= 5; $i++) {
    $P[$i] = "meta-player-0$i-abcdefghijklmnopqrstuvwxyz0123456789";
}
$mid = static fn (int $n): string => sprintf('EUW1_80000000%02d', $n);

// Horloge injectée dans le collecteur (LOLHELPER_TEST_NOW) : aujourd'hui 10:00 à Paris = dans la plage 04h–15h.
$PARIS = new DateTimeZone('Europe/Paris');
$IN_WINDOW = (new DateTimeImmutable('today 10:00', $PARIS))->getTimestamp();
$TODAY = (new DateTimeImmutable('@' . $IN_WINDOW))->setTimezone($PARIS)->format('Y-m-d');
$CLOSED = (new DateTimeImmutable('today 03:30', $PARIS))->getTimestamp();
$realHour = (int) (new DateTimeImmutable('now', $PARIS))->format('G');
$REAL_OPEN = $realHour >= 4 && $realHour < 15;

$passed = 0;
$failed = 0;

function check(bool $cond, string $label, string $extra = ''): void
{
    global $passed, $failed;
    if ($cond) {
        $passed++;
    } else {
        $failed++;
        fwrite(STDERR, "FAIL: $label" . ($extra !== '' ? "\n      $extra" : '') . "\n");
    }
}

function req(string $url, array $headers = [], string $method = 'GET'): array
{
    $respHeaders = [];
    $h = [];
    foreach ($headers as $k => $v) {
        $h[] = "$k: $v";
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $h,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respHeaders) {
            $p = strpos($line, ':');
            if ($p !== false) {
                $respHeaders[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
            }
            return strlen($line);
        },
    ]);
    $out = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $out = $out === false ? '' : $out;
    return ['status' => $status, 'headers' => $respHeaders, 'body' => $out, 'json' => json_decode($out, true)];
}

function fake_log(): array
{
    global $FAKE_LOG;
    return is_file($FAKE_LOG) ? array_values(array_filter(explode("\n", file_get_contents($FAKE_LOG)))) : [];
}

/** Chemins Riot (sans hôte ni query) demandés depuis le dernier reset. */
function riot_paths(): array
{
    return array_map(static fn (string $u): string => (string) parse_url($u, PHP_URL_PATH), fake_log());
}

function ctrl(array $c): void
{
    global $FAKE_CTRL;
    file_put_contents($FAKE_CTRL, json_encode($c));
}

/** Lance le collecteur en CLI (horloge injectée, dans la plage par défaut) ; renvoie [code, stderr+stdout, durée, requêtes Riot]. */
function collect(string $site, ?int $now = null): array
{
    global $PHP, $FAKE_LOG, $RIOT_BASE, $IN_WINDOW;
    @unlink($FAKE_LOG);
    $env = getenv();
    $env['LOLHELPER_RIOT_BASE'] = $RIOT_BASE;
    $env['LOLHELPER_TEST_NOW'] = (string) ($now ?? $IN_WINDOW);
    unset($env['DOCUMENT_ROOT']);
    $t0 = microtime(true);
    $proc = proc_open(
        [$PHP, '-d', 'log_errors=1', '-d', 'error_log=', '-d', 'display_errors=stderr', "$site/api/cron/collect-meta.php"],
        [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        sys_get_temp_dir(),
        $env
    );
    $out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    return [$code, $out, microtime(true) - $t0, riot_paths()];
}

function write_config(string $site, array $extra): void
{
    global $T;
    $base = [
        'riot_api_key' => KEY,
        'riot_platform' => 'euw1',
        'app_password' => PW,
        'data_dir' => "$T/m/lolhelper-data",
        'meta_rate' => 0,
        'meta_time_budget' => 60,
        'meta_min_games' => 3,
        // Anciennes valeurs (MASTER_PLUS) : le faux serveur Riot ne connaît que ces deux ligues apex.
        'meta_tiers' => ['CHALLENGER', 'GRANDMASTER'],
    ];
    file_put_contents("$site/api/config.php", '<?php return ' . var_export(array_merge($base, $extra), true) . ';');
}

function limits(): array
{
    global $DATA;
    return json_decode((string) @file_get_contents("$DATA/riot_limits.json"), true) ?: [];
}

function stats(string $patch, string $tier = 'MASTER_PLUS', ?string $dir = null): ?array
{
    global $META;
    $f = ($dir ?? $META) . "/stats-$tier-$patch.json";
    return is_file($f) ? json_decode(file_get_contents($f), true) : null;
}

function state(?string $dir = null): array
{
    global $META;
    return json_decode((string) @file_get_contents(($dir ?? $META) . '/state.json'), true) ?: [];
}

function last_run(?string $dir = null): ?array
{
    global $META;
    return json_decode((string) @file_get_contents(($dir ?? $META) . '/last_run.json'), true);
}

/** Numéros de parties d'un tampon binaire (73 octets par partie), dans l'ordre du fichier. */
function buffer_ids(string $file): array
{
    $raw = is_file($file) ? (string) file_get_contents($file) : '';
    return array_map(static fn (string $r): int => unpack('J', $r)[1], $raw === '' ? [] : str_split($raw, 73));
}

/** Niveau d'un appel « ids » du faux serveur (joueurs générés meta-gen-<NIVEAU>, sinon MASTER_PLUS). */
function ids_tiers(array $paths): array
{
    $out = [];
    foreach ($paths as $p) {
        if (preg_match('#/by-puuid/([^/]+)/ids$#', $p, $m) === 1) {
            $out[] = preg_match('/^meta-gen-([A-Z]+)-/', $m[1], $g) === 1 ? $g[1] : 'MASTER_PLUS';
        }
    }
    return $out;
}

/** Parties générées par le faux serveur (même formule) : numéro => instant de création. */
function gen_matches(int $tierIdx, int $base, int $perPage, int $ids): array
{
    $out = [];
    for ($div = 1; $div <= 4; $div++) {
        for ($k = 0; $k < $perPage; $k++) {
            for ($m = 0; $m < $ids; $m++) {
                $out[(int) sprintf('9%d%d%d%02d%02d', $tierIdx, $div, 1, $k, $m)] = $base + $m * 600 + ($div * 10 + $k) * 7;
            }
        }
    }
    return $out;
}

/** Les $x plus récentes (création puis numéro), triées comme le tampon (de la plus ancienne à la plus récente). */
function most_recent(array $created, int $x): array
{
    $ids = array_keys($created);
    usort($ids, static fn (int $a, int $b): int => [$created[$a], $a] <=> [$created[$b], $b]);
    return array_slice($ids, -$x);
}

function ksort_deep(mixed $v): mixed
{
    if (!is_array($v)) {
        return $v;
    }
    ksort($v);
    return array_map('ksort_deep', $v);
}

const SUMMARY_KEYS = ['status', 'stop', 'message', 'requests', 'new_matches', 'patch', 'games', 'patches', 'duration_s'];

/** Résumé d'un passage : clés, types, liste des patchs. */
function summary_shape_ok(mixed $s, bool $withRetry = false): bool
{
    if (!is_array($s)) {
        return false;
    }
    $keys = array_values(array_diff(array_keys($s), ['at', 'source']));
    $expected = $withRetry ? [...SUMMARY_KEYS, 'retry_after'] : SUMMARY_KEYS;
    if ($keys !== $expected || !is_string($s['stop']) || !is_string($s['message']) || !is_int($s['requests'])
        || !is_int($s['new_matches']) || !(is_string($s['patch']) || $s['patch'] === null) || !is_int($s['games'])
        || !is_array($s['patches']) || !(is_int($s['duration_s']) || is_float($s['duration_s']))) {
        return false;
    }
    foreach ($s['patches'] as $p) {
        if (!is_array($p) || array_keys($p) !== ['patch', 'games', 'updated_at']) {
            return false;
        }
    }
    return !$withRetry || (is_int($s['retry_after']) && $s['retry_after'] >= 1);
}

$auth = ['X-App-Password' => PW];
$riotMatch = static fn (int $n): string => '/europe/lol/match/v5/matches/' . sprintf('EUW1_80000000%02d', $n);
$riotIds = static fn (string $puuid): string => "/europe/lol/match/v5/matches/by-puuid/$puuid/ids";
$CHAL = '/euw1/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5';
$GM = '/euw1/lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5';
$MP_EMPTY = ['tier' => 'MASTER_PLUS', 'patch' => null, 'games' => 0, 'target' => 500, 'oldest' => null, 'newest' => null];
const STATS_KEYS = ['available', 'patch', 'tier', 'platform', 'games', 'updated_at', 'champions', 'bans', 'matchups'];
const STATUS_KEYS = ['collecting', 'last_run', 'patches', 'admin_enabled', 'meta_enabled', 'tiers', 'window'];

// ---------------------------------------------------------------- avant toute collecte
@unlink($FAKE_LOG);
$r = req("$M/lolhelper/api/cron/collect-meta.php");
check($r['status'] === 404 && $r['body'] === '', 'cron script over HTTP -> 404, empty body', "got {$r['status']} " . substr($r['body'], 0, 200));
check(fake_log() === [] && !is_dir($META), 'cron script over HTTP does nothing');

$r = req("$M/lolhelper/api/index.php?r=meta-stats");
check($r['status'] === 401, 'meta-stats requires the password', "got {$r['status']}");
$r = req("$M/lolhelper/api/index.php?r=meta-stats", $auth);
check($r['status'] === 200 && $r['json'] === ['available' => false, 'games' => 0, 'tier' => null], 'meta-stats unavailable before collection', $r['body']);
check(($r['headers']['cache-control'] ?? '') === 'private, max-age=300', 'meta-stats Cache-Control', $r['headers']['cache-control'] ?? '');
$r = req("$M/lolhelper/api/index.php?r=meta-stats&tier=GOLD", $auth);
check($r['status'] === 200 && $r['json'] === ['available' => false, 'games' => 0, 'tier' => 'GOLD'], 'meta-stats tier=GOLD unavailable before collection', $r['body']);
$r = req("$M/lolhelper/api/index.php?r=meta");
check($r['status'] === 200 && array_key_exists('meta_stats', $r['json']) && $r['json']['meta_stats'] === null, 'meta.meta_stats null before collection', $r['body']);
$r = req("$A/api/index.php?r=meta");
check(array_key_exists('meta_stats', $r['json'] ?? []) && $r['json']['meta_stats'] === null, 'meta A meta_stats null');
$r = req("$A/api/index.php?r=meta-stats", $auth);
check($r['status'] === 200 && ($r['json']['available'] ?? null) === false && ($r['json']['games'] ?? null) === 0, 'meta-stats A unavailable');
$r = req("$M/lolhelper/api/index.php?r=meta-status");
check($r['status'] === 401, 'meta-status requires the password', "got {$r['status']}");
$r = req("$M/lolhelper/api/index.php?r=meta-status", $auth);
check($r['status'] === 200 && $r['json'] === ['collecting' => false, 'last_run' => null, 'patches' => [], 'admin_enabled' => false, 'meta_enabled' => true,
    'tiers' => [$MP_EMPTY], 'window' => ['start' => 4, 'end' => 15, 'open' => $REAL_OPEN]],
    'meta-status before any collection (old tier names -> MASTER_PLUS only, window from the real clock)', $r['body']);
check(!is_dir($META), 'meta-status creates no meta dir');
$r = req("$A/api/index.php?r=meta-status", $auth);
$j = $r['json'] ?? [];
check($r['status'] === 200 && array_key_exists('last_run', $j) && $j['last_run'] === null && ($j['patches'] ?? null) === [] && ($j['admin_enabled'] ?? null) === false,
    'meta-status A (nothing collected, no admin)', $r['body']);
check(array_column($j['tiers'] ?? [], 'tier') === TIERS && ($j['tiers'][3] ?? null) === ['tier' => 'GOLD', 'patch' => null, 'games' => 0, 'target' => 500, 'oldest' => null, 'newest' => null],
    'meta-status A: default config follows the 8 tiers, target 500', $r['body']);
check(req("$M/lolhelper/api/index.php?r=meta-status", $auth, 'POST')['status'] === 405, 'meta-status POST -> 405');

// Plage horaire : horloge de test seulement par l'environnement du processus, jamais par la requête.
$r = req("$B/api/index.php?r=meta-status");
check($r['status'] === 200 && ($r['json']['window'] ?? null) === ['start' => 4, 'end' => 15, 'open' => false], 'meta-status window closed at 02:00 Paris (test clock of server B)', $r['body']);
foreach ([['LOLHELPER_TEST_NOW' => (string) $CLOSED], ['X-Lolhelper-Test-Now' => (string) $CLOSED], ['Cookie' => "LOLHELPER_TEST_NOW=$CLOSED"]] as $h) {
    $r = req("$M/lolhelper/api/index.php?r=meta-status&LOLHELPER_TEST_NOW=$CLOSED&now=$CLOSED", $auth + $h);
    check(($r['json']['window']['open'] ?? null) === $REAL_OPEN, 'test clock cannot be set over HTTP (' . array_key_first($h) . ')', $r['body']);
}

// ---------------------------------------------------------------- cron hors plage horaire
[$code, $out, $dur, $paths] = collect($SITE, $CLOSED);
check($code === 0 && $paths === [] && str_contains($out, 'hors plage horaire (04h–15h)') && $dur < 3.0, 'cron outside 04h–15h: logs and exits at once', $out);
check(!is_dir($META), 'cron outside the window writes nothing');
write_config($ALT, ['meta_hours' => '22-06']);
[$code, $out, , $paths] = collect($ALT);
check($code === 0 && $paths === [] && str_contains($out, 'hors plage horaire (22h–06h)'), 'custom meta_hours 22-06 closed at 10:00', $out);
check(!is_dir($META), 'nothing written either');

// ---------------------------------------------------------------- run 1 : 429 -> pause Retry-After puis reprise
ctrl(['match_429' => $mid(5), 'retry_after' => '1', 'limited_left' => 1]);
[$code, $out, $dur, $paths] = collect($SITE);
check($code === 0, 'run1 exit 0', $out);
check(str_contains($out, '429') && str_contains($out, 'reprise') && $dur >= 1.0, 'run1 sleeps Retry-After on a 429 and goes on', sprintf('%.2f s ', $dur) . $out);
$expected = [$CHAL, $GM, $riotIds($P[1]), $riotMatch(1), $riotMatch(2), $riotMatch(3), $riotMatch(4),
    $riotIds($P[3]), $riotMatch(8), $riotMatch(12),
    $riotIds($P[2]), $riotMatch(5), $riotMatch(5), $riotMatch(6), $riotMatch(7),
    $riotIds($P[4]), $riotMatch(9)];
check($paths === $expected, 'run1 requests (seed refresh, leagues interleaved, 429 retried once, full round)', implode("\n      ", $paths));
check(is_dir($META), 'data written in ~/lolhelper-data/meta (sibling of www/)', $out);
check(!is_dir("$T/m/www/lolhelper-data") && !is_dir("$T/m/www/lolhelper/api/data") && !is_dir("$T/m/www/lolhelper/lolhelper-data"), 'nothing written under www/');
$st = state();
check(($st['v'] ?? null) === 2 && ($st['tiers']['MASTER_PLUS']['seeds'] ?? null) === [$P[1], $P[3], $P[2], $P[4]],
    'MASTER_PLUS seeds: leagues LP desc, interleaved, deduped, invalid dropped', json_encode($st['tiers'] ?? null));
check(($st['tiers']['MASTER_PLUS']['leagues'] ?? null) === ['CHALLENGER', 'GRANDMASTER'], 'old tier names restrict the apex leagues read');
check(($st['tiers']['MASTER_PLUS']['cursor'] ?? null) === 0 && ($st['blocked_until'] ?? -1) === 0, 'run1 full round: cursor back to start, no pause left');
check(stats('16.19')['games'] === 2 && stats('16.18')['games'] === 3, 'run1 counts (16.19: 2, 16.18: 3)', json_encode([stats('16.19')['games'] ?? null, stats('16.18')['games'] ?? null]));
check(stats('16.19')['tier'] === 'MASTER_PLUS' && stats('16.19')['patch'] === '16.19', 'stats file carries tier and patch');
check(filesize("$META/buffer-MASTER_PLUS-16.19.bin") === 2 * 73 && filesize("$META/buffer-MASTER_PLUS-16.18.bin") === 3 * 73, 'ring buffers: 73 bytes per kept match');
check(buffer_ids("$META/buffer-MASTER_PLUS-16.18.bin") === [8000000003, 8000000008, 8000000009], 'buffer sorted by creation time', json_encode(buffer_ids("$META/buffer-MASTER_PLUS-16.18.bin")));
check(stats('16.17') === null && glob("$META/*16.17*") === [], 'only the 2 most recent patches kept on disk');
check(glob("$META/*.tmp-*") === [], 'no temp files left');
check(!str_contains((string) @file_get_contents("$META/state.json"), KEY), 'key never stored');
$lr = last_run();
check(summary_shape_ok($lr) && $lr['status'] === 'ok' && $lr['stop'] === 'tour complet' && $lr['requests'] === 17 && $lr['source'] === 'cron'
    && $lr['patch'] === '16.19' && $lr['games'] === 2, 'run1 last_run.json written by the CLI', json_encode($lr));
check(preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/D', (string) ($lr['at'] ?? '')) === 1 && abs(strtotime($lr['at']) - time()) < 30, 'last_run.at ISO 8601 UTC');
check(!str_contains((string) @file_get_contents("$META/last_run.json"), KEY), 'key never in last_run.json');
$sum = json_decode((string) file_get_contents("$META/summary.json"), true);
check(($sum['tiers']['MASTER_PLUS']['16.18']['games'] ?? null) === 3 && ($sum['patches']['16.18']['games'] ?? null) === 3
    && preg_match('/^2025-10-09T\d\d:\d\d:\d\dZ$/D', (string) ($sum['tiers']['MASTER_PLUS']['16.18']['newest'] ?? '')) === 1, 'summary.json per tier (games, oldest/newest) and totals', json_encode($sum));
$lim = limits();
check(($lim['app']['europe']['w'] ?? null) === [[20, 1, 1], [100, 120, 1]] && ($lim['app']['euw1']['w'] ?? null) === [[20, 1, 1], [100, 120, 1]],
    'collector records X-App-Rate-Limit(-Count) per host in <data>/riot_limits.json', json_encode($lim));
check(isset($lim['method']['europe match-v5.match']['w'], $lim['method']['europe match-v5.ids']['w'], $lim['method']['euw1 league-v4.challenger']['w']),
    'collector records method limits per family', json_encode(array_keys($lim['method'] ?? [])));
check(($lim['app']['europe']['calls'] ?? null) === [] && filesize("$DATA/riot_limits.json") < 4096, 'limits file stays tiny, reserved calls settled');

// ---------------------------------------------------------------- run 2 / 3 : rien de neuf
ctrl([]);
[$code, $out, , $paths] = collect($SITE);
check($code === 0 && $paths === [$riotIds($P[1]), $riotMatch(1), $riotIds($P[3]), $riotIds($P[2]), $riotIds($P[4])],
    'run2 skips kept matches (16.17 match fetched once more, then rejected)', implode("\n      ", $paths));
check(preg_match('/ 5 requêtes, 0 nouvelles parties, patch 16\.19 \(2 parties\), [0-9.]+ s, arrêt : tour complet/', $out) === 1, 'CLI log line', $out);
$before = [file_get_contents("$META/stats-MASTER_PLUS-16.19.json"), file_get_contents("$META/stats-MASTER_PLUS-16.18.json")];
[$code, $out, , $paths] = collect($SITE);
check($code === 0 && $paths === [$riotIds($P[1]), $riotIds($P[3]), $riotIds($P[2]), $riotIds($P[4])], 'run3 only lists ids (everything kept or rejected)', implode("\n      ", $paths));
check([file_get_contents("$META/stats-MASTER_PLUS-16.19.json"), file_get_contents("$META/stats-MASTER_PLUS-16.18.json")] === $before, 'run3 no double counting (stats unchanged)');

// ---------------------------------------------------------------- route : repli sur le patch précédent
$r = req("$M/lolhelper/api/index.php?r=meta-stats", $auth);
check($r['status'] === 200 && ($r['json']['available'] ?? null) === true && $r['json']['patch'] === '16.18' && $r['json']['games'] === 3 && $r['json']['tier'] === 'MASTER_PLUS',
    'meta-stats falls back to previous patch (16.19 has 2 < meta_min_games 3), default tier MASTER_PLUS', $r['body']);
check(($r['json']['champions']['103']['MID'] ?? null) === [3, 2], '16.18 Ahri MID [3, 2]', $r['body']);
$r = req("$M/lolhelper/api/index.php?r=meta");
check(($r['json']['meta_stats'] ?? null) === ['patch' => '16.18', 'tier' => 'MASTER_PLUS', 'games' => 3, 'updated_at' => $r['json']['meta_stats']['updated_at'] ?? ''], 'meta.meta_stats (16.18, MASTER_PLUS)', $r['body']);
check(preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/D', (string) ($r['json']['meta_stats']['updated_at'] ?? '')) === 1, 'meta_stats.updated_at ISO 8601 UTC');

// ---------------------------------------------------------------- run 5 : rafraîchissement des joueurs (> 24 h)
$st = state();
$st['tiers']['MASTER_PLUS']['refreshed_at'] = time() - 90000;
file_put_contents("$META/state.json", json_encode($st));
ctrl(['challenger' => 'b']);
[$code, $out, , $paths] = collect($SITE);
check(array_slice($paths, 0, 2) === [$CHAL, $GM], 'run5 refreshes seeds after 24 h', implode("\n      ", $paths));
check((state()['tiers']['MASTER_PLUS']['seeds'] ?? null) === [$P[5], $P[3], $P[1], $P[4], $P[2]], 'run5 new seed list', json_encode(state()['tiers']['MASTER_PLUS']['seeds'] ?? null));
check(in_array($riotMatch(10), $paths, true) && in_array($riotMatch(11), $paths, true) && !in_array($riotMatch(2), $paths, true), 'run5 collects new player matches only');
check(stats('16.19')['games'] === 4 && stats('16.18')['games'] === 3, 'run5 counts (16.19: 4)');
ctrl([]);

// ---------------------------------------------------------------- route : patch courant + contenu
$r = req("$M/lolhelper/api/index.php?r=meta-stats", $auth);
$j = $r['json'] ?? [];
check($r['status'] === 200 && ($j['patch'] ?? '') === '16.19' && ($j['games'] ?? 0) === 4 && ($j['platform'] ?? '') === 'euw1', 'meta-stats serves 16.19 once >= meta_min_games', $r['body']);
check(array_keys($j) === STATS_KEYS, 'meta-stats payload keys', implode(',', array_keys($j)));
check(str_contains($r['body'], '"champions":{"') && str_contains($r['body'], '"bans":{"') && str_contains($r['body'], '"matchups":{"'), 'maps are JSON objects');
$c = $j['champions'] ?? [];
check(($c['103']['MID'] ?? null) === [4, 3], 'Ahri MID [4, 3]', json_encode($c['103'] ?? null));
check(($c['134']['MID'] ?? null) === [2, 1], 'Syndra MID [2, 1]');
check(($c['86']['TOP'] ?? null) === [4, 2], 'Garen TOP [4, 2]');
check(($c['412']['SUPPORT'] ?? null) === [3, 2] && ($c['117']['SUPPORT'] ?? null) === [3, 1], 'UTILITY -> SUPPORT, empty/unknown positions skipped', json_encode([$c['412'] ?? null, $c['117'] ?? null]));
check(count($c['412'] ?? []) === 1 && count($c['117'] ?? []) === 1, 'no role bucket for empty/unknown positions');
check(($c['222']['BOTTOM'] ?? null) === [4, 2] && ($c['64']['JUNGLE'] ?? null) === [4, 2], 'BOTTOM/JUNGLE kept');
$b = $j['bans'] ?? [];
check(($b['238'] ?? null) === 2, 'bans deduped within a match (238 banned by both teams in 02)', json_encode($b));
check(($b['157'] ?? null) === 1 && ($b['61'] ?? null) === 1 && ($b['6'] ?? null) === 1, 'bans counted per match');
check(!isset($b['-1']) && !isset($b['99']) && !isset($b['98']), 'no -1, remake and other-queue bans ignored');
$mu = $j['matchups'] ?? [];
check(($mu['MID']['103']['134'] ?? null) === [2, 1] && ($mu['MID']['134']['103'] ?? null) === [2, 1], 'matchup Ahri/Syndra both directions');
check(($mu['MID']['103']['238'] ?? null) === [1, 1] && ($mu['MID']['238']['103'] ?? null) === [1, 0], 'matchup Ahri/Zed both directions');
check(($mu['MID']['61']['103'] ?? null) === [1, 0] && ($mu['MID']['103']['61'] ?? null) === [1, 1], 'matchup Orianna/Ahri (Ahri red side)');
check(($mu['SUPPORT']['412']['117'] ?? null) === [3, 2] && ($mu['SUPPORT']['117']['412'] ?? null) === [3, 1], 'support matchups skip game with unknown position');
check(($mu['TOP']['86']['122'] ?? null) === [4, 2] && ($mu['TOP']['122']['86'] ?? null) === [4, 2], 'top matchups');
check(!isset($mu['UTILITY']) && !isset($mu['MIDDLE']), 'roles renamed in matchups');
$r = req("$M/lolhelper/api/index.php?r=meta");
check(($r['json']['meta_stats']['patch'] ?? '') === '16.19' && ($r['json']['meta_stats']['games'] ?? 0) === 4, 'meta.meta_stats follows (16.19)');
$r = req("$M/lolhelper/api/index.php?r=meta-stats", ['X-App-Password' => 'nope']);
check($r['status'] === 401 && !isset($r['json']['champions']), 'meta-stats wrong password -> 401');
$r = req("$M/lolhelper-data/meta/state.json");
check($r['status'] === 404, 'no meta file served from the site');

// ---------------------------------------------------------------- budget de temps
write_config($ALT, ['meta_rate' => 3, 'meta_time_budget' => 1]);
[$code, $out, $dur, $paths] = collect($ALT);
check($code === 0 && str_contains($out, 'budget'), 'time budget stop logged', $out);
check(count($paths) >= 1 && count($paths) <= 4, 'time budget + pacing bound requests (3/s for 1 s)', (string) count($paths));
check($dur < 4.0, 'time budget respected', sprintf('%.2f s', $dur));
check(stats('16.19')['games'] === 4, 'budget run keeps counts');
// Fin de la plage horaire : le passage ne la dépasse pas (14:59:58 -> 2 s de travail au plus).
write_config($ALT, ['meta_rate' => 1]);
[$code, $out, $dur, $paths] = collect($ALT, (new DateTimeImmutable('today 14:59:58', $PARIS))->getTimestamp());
$lr = last_run();
check($code === 0 && ($lr['stop'] ?? '') === 'budget' && count($paths) >= 1 && count($paths) <= 3 && $dur < 4.0,
    'CLI run capped by the time left before the end hour (2 s at 1 req/s)', sprintf('%.2f s ', $dur) . $out);

// ---------------------------------------------------------------- 401
$cursorBefore = state()['tiers']['MASTER_PLUS']['cursor'];
write_config($ALT, ['riot_api_key' => 'RGAPI-wrong']);
[$code, $out, , $paths] = collect($ALT);
check($code === 1 && str_contains($out, '401') && count($paths) === 1, '401 stops the run at once (exit 1)', $out . implode(',', $paths));
check(state()['tiers']['MASTER_PLUS']['cursor'] === $cursorBefore && stats('16.19')['games'] === 4, '401 leaves state untouched');

// ---------------------------------------------------------------- verrou
write_config($ALT, []);
$lock = fopen("$META/collect.lock", 'c');
flock($lock, LOCK_EX);
[$code, $out, $dur, $paths] = collect($ALT);
check($code === 0 && $paths === [] && str_contains($out, 'déjà en cours'), 'lock prevents overlapping runs', $out);
flock($lock, LOCK_UN);
fclose($lock);
[$code, $out, , $paths] = collect($ALT);
check($code === 0 && count($paths) === 5, 'runs again once the lock is released', $out . implode(',', $paths));

// ---------------------------------------------------------------- rythme : 0,25 req/s par défaut, « auto », garde à 60 %
write_config($ALT, ['meta_rate' => null, 'meta_time_budget' => 5]);
[$code, $out, $dur, $paths] = collect($ALT);
$lr = last_run();
check($code === 0 && count($paths) === 2 && ($lr['stop'] ?? '') === 'budget' && $dur >= 3.9 && $dur < 6.5,
    'meta_rate absent: 0.25 req/s by default (2 calls 4 s apart within a 5 s budget)', sprintf('%.2f s ', $dur) . $out);
write_config($ALT, ['meta_rate' => 'auto']);
[$code, $out, $dur, $paths] = collect($ALT);
check($code === 0 && count($paths) === 5 && str_contains($out, 'tour complet') && $dur < 3.0, 'meta_rate auto: full round, no fixed pacing', sprintf('%.2f s ', $dur) . $out);
// 12 appels dans la fenêtre de 1 s (= 60 % de 20) : le collecteur dort jusqu'à ce qu'elle se libère, puis continue.
ctrl(['app_count' => '12:1,1:120', 'app_count_left' => 1]);
write_config($ALT, ['meta_rate' => 'auto']);
[$code, $out, $dur, $paths] = collect($ALT);
$lr = last_run();
check($code === 0 && count($paths) === 5 && ($lr['stop'] ?? '') === 'tour complet' && ($lr['requests'] ?? 0) === 5,
    'collector at 60 % of the 1 s window sleeps instead of failing, then completes', $out . json_encode($lr));
check($dur >= 0.9 && $dur < 4.0, 'collector slept about one second', sprintf('%.2f s', $dur));
// 60/100 sur 2 min : attente > budget -> arrêt propre « budget » sans nouvel appel ; les joueurs passent encore (< 95 %).
ctrl(['app_count' => '1:1,60:120', 'app_count_left' => 1]);
write_config($ALT, ['meta_rate' => 'auto', 'meta_time_budget' => 5]);
[$code, $out, $dur, $paths] = collect($ALT);
$lr = last_run();
check($code === 0 && count($paths) === 1 && ($lr['stop'] ?? '') === 'budget' && ($lr['requests'] ?? 0) === 1 && $dur < 3.0,
    'collector yields at 60 % of the 120 s window (stops within budget, no extra call)', sprintf('%.2f s ', $dur) . $out . json_encode($lr));
check(str_contains((string) ($lr['message'] ?? ''), 'limite de la clé'), 'stop message names the key limit', (string) ($lr['message'] ?? ''));
$r = req("$M/lolhelper/api/index.php?r=riot-limits", $auth);
$j = $r['json'] ?? [];
check($r['status'] === 200 && ($j['host'] ?? '') === 'europe' && ($j['detected'] ?? null) === true && ($j['app'][1]['count'] ?? null) === 60
    && ($j['app'][1]['limit'] ?? null) === 100 && ($j['collector_share'] ?? null) === 0.6 && ($j['user_share'] ?? null) === 0.95,
    'riot-limits on the collector site shows 60/100', $r['body']);
check(array_key_exists('meta_rate', $j) && $j['meta_rate'] == 0, 'riot-limits reports the numeric meta_rate of config.php', $r['body']);
@unlink($FAKE_LOG);
$r = req("$M/lolhelper/api/index.php?r=riot/account&platform=euw1&gameName=User&tagLine=EUW", $auth);
check($r['status'] === 200 && count(fake_log()) === 1, 'user call still served at 60 % (< 95 %)', $r['body']);
// Site : même garde, même fichier.
ctrl(['app_count' => '1:1,60:120']);
write_config($SITE, ['admin_password' => ADMIN, 'meta_rate' => 'auto']);
@unlink($FAKE_LOG);
$r = req("$M/lolhelper/api/index.php?r=meta-collect", $auth + ['X-Admin-Password' => ADMIN], 'POST');
check($r['status'] === 200 && ($r['json']['stop'] ?? '') === 'budget' && ($r['json']['requests'] ?? 0) === 1 && count(fake_log()) === 1,
    'web collection yields at 60 % too', $r['body']);
ctrl([]);
@unlink("$DATA/riot_limits.json");
write_config($SITE, []);
// meta_rate numérique : plafond en plus de la garde.
write_config($ALT, ['meta_rate' => 2]);
[$code, $out, $dur, $paths] = collect($ALT);
check($code === 0 && count($paths) === 5 && $dur >= 1.9, 'numeric meta_rate caps the collector (5 calls at 2/s >= 2 s)', sprintf('%.2f s ', $dur) . $out);

// ---------------------------------------------------------------- 429 au-delà du budget : arrêt, puis pause respectée
$st = state();
ctrl(['ids_429' => $st['tiers']['MASTER_PLUS']['seeds'][$st['tiers']['MASTER_PLUS']['cursor']], 'retry_after' => '30']);
write_config($ALT, ['meta_time_budget' => 5]);
[$code, $out, $dur, $paths] = collect($ALT);
$lr = last_run();
check($code === 0 && count($paths) === 1 && $dur < 3.0 && ($lr['stop'] ?? '') === 'riot_limit' && ($lr['retry_after'] ?? 0) === 30 && summary_shape_ok($lr, true),
    'CLI 429 whose Retry-After exceeds the budget -> stop riot_limit', sprintf('%.2f s ', $dur) . $out . json_encode($lr));
check((state()['blocked_until'] ?? 0) > time() + 20, '429 pause recorded for the next run');
ctrl([]);
[$code, $out, , $paths] = collect($ALT);
check($code === 0 && $paths === [] && str_contains($out, 'pause') && (last_run()['stop'] ?? '') === 'riot_limit' && (last_run()['requests'] ?? -1) === 0,
    'next run during the pause (longer than its budget): no request', $out . implode(',', $paths));
$st = state();
$st['blocked_until'] = time() + 2;
file_put_contents("$META/state.json", json_encode($st));
write_config($ALT, []);
[$code, $out, $dur, $paths] = collect($ALT);
check($code === 0 && count($paths) === 5 && $dur >= 0.5 && (last_run()['stop'] ?? '') === 'tour complet', 'a pause that fits the budget is waited, then the run goes on', sprintf('%.2f s ', $dur) . $out);

// ---------------------------------------------------------------- désactivé / sans clé
write_config($ALT, ['meta_enabled' => false]);
[$code, $out, , $paths] = collect($ALT);
check($code === 0 && $paths === [] && str_contains($out, 'désactivée'), 'meta_enabled=false does nothing', $out);
write_config($ALT, ['riot_api_key' => '']);
[$code, $out, , $paths] = collect($ALT);
check($code === 1 && $paths === [], 'no key -> exit 1, no request', $out);

// ---------------------------------------------------------------- collecte depuis le site (meta-collect)
$collectUrl = "$M/lolhelper/api/index.php?r=meta-collect";
$statusUrl = "$M/lolhelper/api/index.php?r=meta-status";
$admin = static fn (string $pw): array => $auth + ['X-Admin-Password' => $pw];
$noSecret = static fn (array $r): bool => !str_contains($r['body'], ADMIN) && !str_contains($r['body'], KEY) && !str_contains($r['body'], PW);
$MSG_ADMIN = 'Mot de passe administrateur incorrect.';
$cronRun = last_run();

// Config de run.sh : pas d'admin_password -> collecte manuelle désactivée.
@unlink($FAKE_LOG);
$r = req($collectUrl, $admin(ADMIN), 'POST');
check($r['status'] === 403 && ($r['json']['detail'] ?? '') === 'Collecte manuelle désactivée : définissez admin_password dans config.php.',
    'meta-collect disabled without admin_password -> 403', $r['body']);
$r = req($collectUrl, ['X-Admin-Password' => ADMIN], 'POST');
check($r['status'] === 401 && ($r['json']['detail'] ?? '') === 'Mot de passe requis ou incorrect.', 'meta-collect requires the app password first', $r['body']);
$r = req($statusUrl, $auth);
$j = $r['json'] ?? [];
check($r['status'] === 200 && array_keys($j) === STATUS_KEYS, 'meta-status keys', $r['body']);
check(($j['collecting'] ?? null) === false && ($j['admin_enabled'] ?? null) === false && ($j['last_run'] ?? null) === $cronRun,
    'meta-status: idle, admin disabled, last_run from the cron', $r['body']);
check(array_map(static fn (array $p): array => [$p['patch'], $p['games']], $j['patches'] ?? []) === [['16.19', 4], ['16.18', 3]], 'meta-status patches', $r['body']);
$t = $j['tiers'] ?? [];
check(count($t) === 1 && array_keys($t[0]) === ['tier', 'patch', 'games', 'target', 'oldest', 'newest'] && $t[0]['tier'] === 'MASTER_PLUS'
    && $t[0]['patch'] === '16.19' && $t[0]['games'] === 4 && $t[0]['target'] === 500
    && preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/D', (string) $t[0]['oldest']) === 1 && $t[0]['newest'] >= $t[0]['oldest'],
    'meta-status tiers: progress on the current patch', $r['body']);
check(($j['window'] ?? null) === ['start' => 4, 'end' => 15, 'open' => $REAL_OPEN], 'meta-status window', $r['body']);
check(fake_log() === [] && last_run() === $cronRun, 'disabled trigger makes no Riot call, last_run untouched');

write_config($SITE, ['admin_password' => ADMIN]);
$r = req($statusUrl, $auth);
check(($r['json']['admin_enabled'] ?? null) === true && $noSecret($r), 'meta-status admin_enabled, no secret', $r['body']);
$r = req($collectUrl, $admin(ADMIN));
check($r['status'] === 405 && ($r['headers']['allow'] ?? '') === 'POST', 'meta-collect GET -> 405 Allow: POST', $r['body']);
foreach (['missing' => null, 'wrong' => 'nope', 'longer' => ADMIN . 'x', 'prefix' => substr(ADMIN, 0, 5), 'app password' => PW] as $label => $pw) {
    $r = req($collectUrl, $pw === null ? $auth : $admin($pw), 'POST');
    check($r['status'] === 401 && ($r['json']['detail'] ?? '') === $MSG_ADMIN && $noSecret($r), "meta-collect admin password $label -> 401", $r['body']);
}
check(fake_log() === [] && last_run() === $cronRun, 'rejected triggers make no Riot call');

// Mot de passe accentué, entouré d'espaces dans config.php, envoyé par le site en b64:<UTF-8>.
// Le verrou est tenu : un bon mot de passe répond « busy » sans aucun appel Riot.
$accent = 'Été mdp ñ';
write_config($SITE, ['admin_password' => "  $accent  "]);
$lock = fopen("$META/collect.lock", 'c');
flock($lock, LOCK_EX);
$r = req($collectUrl, $admin('b64:' . base64_encode($accent)), 'POST');
check($r['status'] === 200 && ($r['json']['status'] ?? '') === 'busy', 'accented admin password (b64, config trimmed) accepted', $r['body']);
$r = req($collectUrl, $admin('b64:' . base64_encode(mb_convert_encoding($accent, 'ISO-8859-1', 'UTF-8'))), 'POST');
check($r['status'] === 401, 'Latin-1 bytes of the admin password rejected', $r['body']);
$r = req($collectUrl, $admin('b64:%%%'), 'POST');
check($r['status'] === 401, 'invalid b64 admin password rejected', $r['body']);
flock($lock, LOCK_UN);
fclose($lock);
check(fake_log() === [], 'password encoding checks make no Riot call');
write_config($SITE, ['admin_password' => ADMIN]);

// Bon mot de passe : un passage complet (tout est déjà vu -> 5 listes d'ids). Pas soumis à la plage horaire.
$cursorBefore = state()['tiers']['MASTER_PLUS']['cursor'];
@unlink($FAKE_LOG);
$r = req($collectUrl, $admin(ADMIN), 'POST');
$j = $r['json'] ?? [];
check($r['status'] === 200 && summary_shape_ok($j), 'meta-collect summary shape', $r['body']);
check(($j['status'] ?? '') === 'ok' && ($j['stop'] ?? '') === 'tour complet' && ($j['requests'] ?? -1) === 5 && ($j['new_matches'] ?? -1) === 0,
    'meta-collect full round: 5 requests, 0 new matches', $r['body']);
check(($j['patch'] ?? '') === '16.19' && ($j['games'] ?? 0) === 4 && count($j['patches'] ?? []) === 2 && ($j['duration_s'] ?? 99) < 10, 'meta-collect patch/games/duration', $r['body']);
check(count(riot_paths()) === 5 && state()['tiers']['MASTER_PLUS']['cursor'] === $cursorBefore, 'meta-collect Riot calls + cursor back to start of round', implode(',', riot_paths()));
check($noSecret($r), 'meta-collect response has no secret');
$lr = last_run();
check(is_array($lr) && ($lr['source'] ?? '') === 'web' && array_diff_key($lr, ['at' => 1, 'source' => 1]) === $j, 'last_run.json written by the web run (= response)', json_encode($lr));
check(glob("$META/*.tmp-*") === [], 'no temp files after web run');
$r = req($statusUrl, $auth);
check(($r['json']['last_run'] ?? null) === $lr && ($r['json']['collecting'] ?? null) === false, 'meta-status shows the web run', $r['body']);

// Verrou tenu (cron en cours) -> busy, rien d'autre.
$lock = fopen("$META/collect.lock", 'c');
flock($lock, LOCK_EX);
@unlink($FAKE_LOG);
$r = req($collectUrl, $admin(ADMIN), 'POST');
check($r['status'] === 200 && $r['json'] === ['status' => 'busy'], 'meta-collect while locked -> 200 busy', $r['body']);
check(fake_log() === [] && last_run() === $lr, 'busy: no Riot call, last_run untouched');
$r = req($statusUrl, $auth);
check(($r['json']['collecting'] ?? null) === true, 'meta-status collecting while locked', $r['body']);
flock($lock, LOCK_UN);
fclose($lock);
$r = req($statusUrl, $auth);
check(($r['json']['collecting'] ?? null) === false, 'meta-status idle once released', $r['body']);
$r = req($collectUrl, $admin(ADMIN), 'POST');
check(($r['json']['status'] ?? '') === 'ok', 'meta-collect runs again once released', $r['body']);

// Budget web : meta_web_budget 1 -> borné à 5 s ; 0,5 req/s -> 3 requêtes (t = 0, 2, 4 s). Le budget cron (60 s) ne compte pas.
write_config($SITE, ['admin_password' => ADMIN, 'meta_web_budget' => 1, 'meta_rate' => 0.5]);
@unlink($FAKE_LOG);
$t0 = microtime(true);
$r = req($collectUrl, $admin(ADMIN), 'POST');
$dur = microtime(true) - $t0;
check(($r['json']['stop'] ?? '') === 'budget' && ($r['json']['requests'] ?? 0) === 3 && count(riot_paths()) === 3,
    'web pass bounded by meta_web_budget (clamped to 5 s) at meta_rate', $r['body']);
check($dur > 3.5 && $dur < 8.0, 'web pass duration within budget', sprintf('%.2f s', $dur));
check(($r['json']['duration_s'] ?? 0) >= 3.5 && $r['json']['duration_s'] <= 6.0, 'duration_s reported', $r['body']);

// 429 Riot pendant un passage web : Retry-After 1 s -> pause puis reprise dans le même passage.
write_config($SITE, ['admin_password' => ADMIN]);
$st = state();
$seed = $st['tiers']['MASTER_PLUS']['seeds'][$st['tiers']['MASTER_PLUS']['cursor']];
ctrl(['ids_429' => $seed, 'retry_after' => '1', 'limited_left' => 1]);
@unlink($FAKE_LOG);
$r = req($collectUrl, $admin(ADMIN), 'POST');
$j = $r['json'] ?? [];
check($r['status'] === 200 && summary_shape_ok($j) && $j['stop'] === 'tour complet' && $j['requests'] === 6 && $j['duration_s'] >= 1.0
    && array_slice(riot_paths(), 0, 2) === [$riotIds($seed), $riotIds($seed)], 'meta-collect: 429 -> sleeps Retry-After, retries, completes the round', $r['body']);
// Retry-After au-delà du budget web (5 s) : arrêt riot_limit, pause enregistrée, puis respectée.
write_config($SITE, ['admin_password' => ADMIN, 'meta_web_budget' => 5]);
ctrl(['ids_429' => $seed, 'retry_after' => '30']);
@unlink($FAKE_LOG);
$r = req($collectUrl, $admin(ADMIN), 'POST');
$j = $r['json'] ?? [];
check($r['status'] === 200 && summary_shape_ok($j, true) && $j['status'] === 'ok' && $j['stop'] === 'riot_limit' && $j['retry_after'] === 30 && $j['requests'] === 1,
    'meta-collect Riot 429 beyond the budget -> stop riot_limit + retry_after', $r['body']);
check((state()['blocked_until'] ?? 0) > time() + 20, '429 pause recorded for the cron too');
@unlink($FAKE_LOG);
$r = req($collectUrl, $admin(ADMIN), 'POST');
$j = $r['json'] ?? [];
check(($j['stop'] ?? '') === 'riot_limit' && ($j['requests'] ?? -1) === 0 && ($j['retry_after'] ?? 0) >= 25 && ($j['retry_after'] ?? 0) <= 30 && fake_log() === [],
    'meta-collect during the pause: no request, remaining retry_after', $r['body']);
ctrl([]);
$st = state();
$st['blocked_until'] = 0;
file_put_contents("$META/state.json", json_encode($st));

// Clé refusée / absente, collecte désactivée.
write_config($SITE, ['admin_password' => ADMIN, 'riot_api_key' => 'RGAPI-wrong']);
$cursorBefore = state()['tiers']['MASTER_PLUS']['cursor'];
$r = req($collectUrl, $admin(ADMIN), 'POST');
check($r['status'] === 200 && ($r['json']['stop'] ?? '') === 'riot_key' && ($r['json']['requests'] ?? 0) === 1 && state()['tiers']['MASTER_PLUS']['cursor'] === $cursorBefore,
    'meta-collect rejected Riot key -> stop riot_key, state untouched', $r['body']);
check(!str_contains($r['body'], 'RGAPI-wrong'), 'key not echoed');
write_config($SITE, ['admin_password' => ADMIN, 'riot_api_key' => '']);
@unlink($FAKE_LOG);
$r = req($collectUrl, $admin(ADMIN), 'POST');
check($r['status'] === 400 && ($r['json']['detail'] ?? '') === 'Clé API Riot non configurée.' && fake_log() === [], 'meta-collect without Riot key -> 400', $r['body']);
write_config($SITE, ['admin_password' => ADMIN, 'meta_enabled' => false]);
$before = last_run();
$r = req($collectUrl, $admin(ADMIN), 'POST');
check($r['status'] === 200 && summary_shape_ok($r['json']) && $r['json']['stop'] === 'disabled' && $r['json']['requests'] === 0
    && $r['json']['patch'] === '16.19' && count($r['json']['patches']) === 2 && fake_log() === [] && last_run() === $before,
    'meta-collect with meta_enabled=false -> stop disabled, nothing run', $r['body']);
$r = req($statusUrl, $auth);
check(($r['json']['meta_enabled'] ?? null) === false, 'meta-status meta_enabled false', $r['body']);
write_config($SITE, ['admin_password' => ADMIN]);

// Le cron réécrit last_run.json après des passages web.
write_config($ALT, []);
[$code, $out] = collect($ALT);
$lr = last_run();
check($code === 0 && ($lr['source'] ?? '') === 'cron' && ($lr['stop'] ?? '') === 'tour complet' && summary_shape_ok($lr), 'CLI run after web runs rewrites last_run (source cron)', json_encode($lr) . $out);

// ---------------------------------------------------------------- meta-stats&patch= / &tier=
$ms = "$M/lolhelper/api/index.php?r=meta-stats";
$r = req("$ms&patch=16.18", $auth);
check($r['status'] === 200 && ($r['json']['patch'] ?? '') === '16.18' && ($r['json']['games'] ?? 0) === 3
    && ($r['json']['champions']['103']['MID'] ?? null) === [3, 2], 'meta-stats patch=16.18 (older kept patch)', substr($r['body'], 0, 300));
check(array_keys($r['json'] ?? []) === STATS_KEYS, 'meta-stats patch= payload keys');
check(($r['headers']['cache-control'] ?? '') === 'private, max-age=300', 'meta-stats patch= Cache-Control');
$r = req("$ms&patch=16.19", $auth);
check(($r['json']['patch'] ?? '') === '16.19' && ($r['json']['games'] ?? 0) === 4, 'meta-stats patch=16.19');
$r = req($ms, $auth);
check(($r['json']['patch'] ?? '') === '16.19', 'meta-stats default unchanged');
$r = req("$ms&patch=16.17", $auth);
check($r['status'] === 404 && str_starts_with($r['json']['detail'] ?? '', 'Patch non disponible'), 'meta-stats patch not kept -> 404', $r['body']);
foreach (['abc', '16.18.1', '16', '', '16.18%0A', '..%2F16.18', '1234.1'] as $bad) {
    $r = req("$ms&patch=$bad", $auth);
    check($r['status'] === 400 && ($r['json']['detail'] ?? '') === 'Patch invalide (format attendu : 16.19).', "meta-stats patch=$bad -> 400", $r['body']);
}
$r = req("$M/lolhelper/api/index.php?r=meta-stats&patch[]=16.18", $auth);
check($r['status'] === 400, 'meta-stats patch[] -> 400', $r['body']);
$r = req("$ms&patch=16.18");
check($r['status'] === 401, 'meta-stats patch= requires the password');
$r = req("$A/api/index.php?r=meta-stats&patch=16.18", $auth);
check($r['status'] === 404, 'meta-stats patch= on a site with nothing collected -> 404', $r['body']);
foreach (['MASTER_PLUS', 'master_plus', 'CHALLENGER'] as $tq) {
    $r = req("$ms&tier=$tq&patch=16.18", $auth);
    check($r['status'] === 200 && ($r['json']['tier'] ?? '') === 'MASTER_PLUS' && ($r['json']['games'] ?? 0) === 3, "meta-stats tier=$tq -> MASTER_PLUS", $r['body']);
}
$r = req("$ms&tier=GOLD", $auth);
check($r['status'] === 200 && $r['json'] === ['available' => false, 'games' => 0, 'tier' => 'GOLD'], 'meta-stats tier with nothing collected -> unavailable + tier', $r['body']);
$r = req("$ms&tier=GOLD&patch=16.19", $auth);
check($r['status'] === 404, 'meta-stats tier=GOLD&patch=16.19 -> 404', $r['body']);
foreach (['gold!', 'PLAT', '', '..', 'GOLD_PLUS'] as $bad) {
    $r = req("$ms&tier=$bad", $auth);
    check($r['status'] === 400 && str_starts_with($r['json']['detail'] ?? '', 'Niveau invalide'), "meta-stats tier=$bad -> 400", $r['body']);
}
$r = req("$ms&tier[]=GOLD", $auth);
check($r['status'] === 400, 'meta-stats tier[] -> 400', $r['body']);

// ---------------------------------------------------------------- collecte par niveau (tourniquet, tampons, jour complet)
$TD = "$T/tier-data";
$TM = "$TD/meta";
$IRON_BASE = time() - 40 * 3600;
$GOLD_BASE = time() - 3 * 3600;
$genCtrl = ['gen_ids' => 8, 'entries_per_page' => 2, 'gen_base' => ['IRON' => $IRON_BASE, 'GOLD' => $GOLD_BASE]];
ctrl($genCtrl);
write_config($ALT, ['data_dir' => $TD, 'meta_tiers' => ['gold', 'IRON', 'CHALLENGER'], 'meta_games_per_tier' => 50]);
[$code, $out, $dur, $paths] = collect($ALT);
$raw = fake_log();
$tiersSeq = ids_tiers($paths);
check($code === 0 && str_contains($out, 'tour complet'), 'tier run 1 completes', $out);
$entries = array_values(array_filter($raw, static fn (string $u): bool => str_contains($u, '/league/v4/entries/')));
check(array_slice($raw, 0, 4) === array_map(static fn (string $d): string => "/euw1/lol/league/v4/entries/RANKED_SOLO_5x5/IRON/$d?page=1", ['I', 'II', 'III', 'IV']),
    'IRON seeds from league-v4 entries, one page per division (page 1 first)', implode("\n      ", array_slice($raw, 0, 5)));
check(count($entries) === 8, 'seeds refreshed once per tier (4 divisions x IRON, GOLD)', implode("\n      ", $entries));
check(array_slice($tiersSeq, 0, 6) === ['IRON', 'GOLD', 'MASTER_PLUS', 'IRON', 'GOLD', 'MASTER_PLUS'], 'round-robin across tiers (META_TIERS order)', implode(',', $tiersSeq));
$st = state($TM);
check(($st['tiers']['IRON']['seeds'][0] ?? '') === 'meta-gen-IRON-I-p1-00-abcdefghijklmnopqrstuvwxyz0123'
    && ($st['tiers']['IRON']['seeds'][1] ?? '') === 'meta-gen-IRON-II-p1-00-abcdefghijklmnopqrstuvwxyz0123' && count($st['tiers']['IRON']['seeds']) === 8,
    'tier seeds interleave divisions, entries without puuid dropped', json_encode($st['tiers']['IRON']['seeds'] ?? null));
check(($st['tiers']['IRON']['page_rot'] ?? null) === 1, 'page rotation recorded');
$counts = array_count_values($tiersSeq);
check(($counts['IRON'] ?? 0) === 8 && ($counts['MASTER_PLUS'] ?? 0) === 2, 'every IRON and MASTER_PLUS seed visited once', json_encode($counts));
check(($counts['GOLD'] ?? 0) === 7 && ($st['tiers']['GOLD']['done_day'] ?? null) === $TODAY && ($st['tiers']['IRON']['done_day'] ?? null) === null,
    'GOLD buffer full of matches from the last 24 h -> skipped for the day (IRON full but older: not skipped)', json_encode([$counts, $st['tiers']['GOLD'] ?? null]));
$ironAll = gen_matches(1, $IRON_BASE, 2, 8);
check(buffer_ids("$TM/buffer-IRON-16.19.bin") === most_recent($ironAll, 50), 'IRON ring buffer keeps the 50 most recent of 64 matches, oldest first',
    json_encode(buffer_ids("$TM/buffer-IRON-16.19.bin")));
check(stats('16.19', 'IRON', $TM)['games'] === 50 && stats('16.19', 'GOLD', $TM)['games'] === 50 && stats('16.19', 'IRON', $TM)['tier'] === 'IRON', 'per-tier stats files (50 games each)');
$ironIdsQueries = array_values(array_filter($raw, static fn (string $u): bool => str_contains($u, 'meta-gen-IRON') && str_contains($u, '/ids?')));
parse_str((string) parse_url(end($ironIdsQueries), PHP_URL_QUERY), $q);
check((int) ($q['startTime'] ?? 0) > time() - 3 * 86400 + 3600, 'full buffer: ids asked only after its oldest match (startTime)', end($ironIdsQueries));
// 8e joueur IRON : tampon plein après 7 joueurs (56 parties), sa plus ancienne = m0 de la division IV, joueur 0.
check((int) ($q['startTime'] ?? 0) === $IRON_BASE + 280, 'startTime = creation of the oldest kept match', end($ironIdsQueries));

// Tour 2 : GOLD reste de côté (même jour), IRON n'a rien de neuf.
[$code, $out, , $paths] = collect($ALT);
$tiersSeq = ids_tiers($paths);
check(!in_array('GOLD', $tiersSeq, true) && !array_filter($paths, static fn (string $p): bool => str_contains($p, 'GOLD')), 'tier run 2: GOLD skipped until the next day', implode("\n      ", $paths));
check(count(array_filter($paths, static fn (string $p): bool => preg_match('#/matches/EUW1_9#', $p) === 1)) === 0 && (array_count_values($tiersSeq)['IRON'] ?? 0) === 8,
    'tier run 2: IRON lists ids, every match already kept', implode("\n      ", $paths));
$before = file_get_contents("$TM/stats-IRON-16.19.json");

// Tour 3 : nouvelles parties plus récentes -> elles remplacent les plus anciennes.
ctrl(['gen_ids' => 10] + $genCtrl);
[$code, $out, , $paths] = collect($ALT);
$ironAll = gen_matches(1, $IRON_BASE, 2, 10);
$expectedIron = most_recent($ironAll, 50);
check(buffer_ids("$TM/buffer-IRON-16.19.bin") === $expectedIron && stats('16.19', 'IRON', $TM)['games'] === 50, 'newer matches evict the oldest (buffer stays at 50)',
    json_encode(buffer_ids("$TM/buffer-IRON-16.19.bin")));
check(file_get_contents("$TM/stats-IRON-16.19.json") !== $before, 'IRON aggregates follow the buffer');
check(!array_filter($paths, static fn (string $p): bool => str_contains($p, 'GOLD')), 'GOLD still skipped the same day');

// Lendemain : GOLD est réexaminé (toujours plein de parties des dernières 24 h -> de nouveau de côté, nouveau jour).
$tomorrow = (new DateTimeImmutable('@' . ($IN_WINDOW + 86400)))->setTimezone($PARIS)->format('Y-m-d');
[$code, $out, , $paths] = collect($ALT, $IN_WINDOW + 86400);
check(!array_filter($paths, static fn (string $p): bool => str_contains($p, 'GOLD')) && (state($TM)['tiers']['GOLD']['done_day'] ?? '') === $tomorrow,
    'next day: GOLD re-evaluated (still complete, skipped again)', json_encode(state($TM)['tiers']['GOLD'] ?? null));

// Rafraîchissement des joueurs : page suivante (2), vide -> repli sur la page 1.
$st = state($TM);
$st['tiers']['IRON']['refreshed_at'] = time() - 90000;
file_put_contents("$TM/state.json", json_encode($st));
ctrl(['entries_empty_from_page' => 2, 'gen_ids' => 10] + $genCtrl);
[$code, $out, , $paths] = collect($ALT);
$entries = array_values(array_filter(fake_log(), static fn (string $u): bool => str_contains($u, '/league/v4/entries/')));
check(count($entries) === 8 && str_ends_with($entries[0], 'IRON/I?page=2') && str_ends_with($entries[4], 'IRON/I?page=1'),
    'seed refresh: next page in rotation, empty page -> page 1', implode("\n      ", $entries));
check(count(state($TM)['tiers']['IRON']['seeds'] ?? []) === 8 && (state($TM)['tiers']['IRON']['page_rot'] ?? null) === 1, 'seeds kept from page 1');
ctrl([]);

// Routes sur ces données (site M pointé un instant vers ce dossier).
write_config($SITE, ['data_dir' => $TD, 'meta_tiers' => ['IRON', 'GOLD', 'CHALLENGER'], 'meta_games_per_tier' => 50]);
$r = req($statusUrl, $auth);
$t = $r['json']['tiers'] ?? [];
check(array_column($t, 'tier') === ['IRON', 'GOLD', 'MASTER_PLUS'] && ($t[0]['games'] ?? 0) === 50 && ($t[0]['target'] ?? 0) === 50 && ($t[1]['games'] ?? 0) === 50
    && ($t[0]['patch'] ?? '') === '16.19' && ($t[0]['newest'] ?? '') === gmdate('Y-m-d\TH:i:s\Z', max($ironAll)), 'meta-status per-tier progress', $r['body']);
$r = req("$ms&tier=GOLD", $auth);
check($r['status'] === 200 && ($r['json']['tier'] ?? '') === 'GOLD' && ($r['json']['games'] ?? 0) === 50 && ($r['json']['patch'] ?? '') === '16.19', 'meta-stats tier=GOLD', substr($r['body'], 0, 200));
$r = req($ms, $auth);
check(($r['json']['tier'] ?? '') === 'MASTER_PLUS', 'meta-stats default tier: MASTER_PLUS when it has games', substr($r['body'], 0, 200));
$sum = json_decode((string) file_get_contents("$TM/summary.json"), true);
$sumBackup = json_encode($sum);
unset($sum['tiers']['MASTER_PLUS']);
file_put_contents("$TM/summary.json", json_encode($sum));
$r = req($ms, $auth);
check(($r['json']['tier'] ?? '') === 'GOLD' || ($r['json']['tier'] ?? '') === 'IRON', 'meta-stats default tier without MASTER_PLUS: the tier with most games', substr($r['body'], 0, 200));
file_put_contents("$TM/summary.json", $sumBackup);
$r = req("$M/lolhelper/api/index.php?r=meta");
check(($r['json']['meta_stats']['tier'] ?? '') === 'MASTER_PLUS', 'meta.meta_stats carries the tier', $r['body']);
write_config($SITE, ['admin_password' => ADMIN]);

// ---------------------------------------------------------------- migration des anciens fichiers (sans niveau)
$MD = "$T/mig-data";
$MM = "$MD/meta";
mkdir($MM, 0700, true);
$oldAt = '2026-11-01T00:00:00Z';
file_put_contents("$MM/stats-16.19.json", json_encode(['patch' => '16.19', 'platform' => 'euw1', 'games' => 5, 'updated_at' => $oldAt,
    'champions' => ['103' => ['MID' => [5, 3]]], 'bans' => ['238' => 2], 'matchups' => ['MID' => ['103' => ['134' => [5, 3]]]]]));
file_put_contents("$MM/stats-16.18.json", json_encode(['patch' => '16.18', 'platform' => 'euw1', 'games' => 7, 'updated_at' => $oldAt,
    'champions' => ['86' => ['TOP' => [7, 4]]], 'bans' => new stdClass(), 'matchups' => new stdClass()]));
file_put_contents("$MM/seen-16.19.bin", pack('J', 8000000002));
file_put_contents("$MM/summary.json", json_encode(['platform' => 'euw1', 'updated_at' => $oldAt,
    'patches' => ['16.19' => ['games' => 5, 'updated_at' => $oldAt], '16.18' => ['games' => 7, 'updated_at' => $oldAt]]]));
file_put_contents("$MM/state.json", json_encode(['v' => 1, 'platform' => 'euw1', 'seeds' => [$P[1]], 'seed_tiers' => ['CHALLENGER'],
    'seed_refreshed_at' => time(), 'cursor' => 0, 'blocked_until' => 0, 'patches' => ['16.19', '16.18'], 'rejected' => []]));
write_config($SITE, ['data_dir' => $MD]);
$r = req($ms, $auth);
check(($r['json']['tier'] ?? '') === 'MASTER_PLUS' && ($r['json']['patch'] ?? '') === '16.19' && ($r['json']['games'] ?? 0) === 5
    && ($r['json']['champions']['103']['MID'] ?? null) === [5, 3], 'old files (no tier) served as MASTER_PLUS before migration', $r['body']);
$r = req("$ms&tier=MASTER_PLUS&patch=16.18", $auth);
check(($r['json']['games'] ?? 0) === 7, 'old 16.18 file served as MASTER_PLUS', $r['body']);
$r = req($statusUrl, $auth);
check(($r['json']['tiers'] ?? null) === [['tier' => 'MASTER_PLUS', 'patch' => '16.19', 'games' => 5, 'target' => 500, 'oldest' => null, 'newest' => null]],
    'old summary -> MASTER_PLUS progress', $r['body']);
write_config($ALT, ['data_dir' => $MD, 'meta_tiers' => ['CHALLENGER']]);
[$code, $out, , $paths] = collect($ALT);
check($code === 0 && $paths === [$riotIds($P[1]), $riotMatch(1), $riotMatch(3), $riotMatch(4)],
    'migrated v1 state: seeds kept, no refresh; matches of the old seen set not fetched again', implode("\n      ", $paths) . "\n" . $out);
check(!is_file("$MM/stats-16.19.json") && is_file("$MM/legacy-16.19.json") && is_file("$MM/legacy-16.18.json") && is_file("$MM/seen-16.19.bin"),
    'old stats files renamed legacy-<patch>.json (kept)', implode(',', array_map('basename', glob("$MM/*"))));
$s19 = stats('16.19', 'MASTER_PLUS', $MM);
$s18 = stats('16.18', 'MASTER_PLUS', $MM);
check(($s19['games'] ?? 0) === 5 && ($s19['tier'] ?? '') === 'MASTER_PLUS' && ($s19['champions']['103']['MID'] ?? null) === [5, 3], 'migrated 16.19 stats (MASTER_PLUS)', json_encode($s19));
check(($s18['games'] ?? 0) === 8 && ($s18['champions']['86']['TOP'] ?? null) === [8, 4] && ($s18['champions']['122']['TOP'] ?? null) === [1, 1],
    'old aggregates + new buffer matches (16.18: 7 + 1)', json_encode($s18['champions'] ?? null));
check((state($MM)['v'] ?? 0) === 2 && (state($MM)['tiers']['MASTER_PLUS']['seeds'] ?? null) === [$P[1]], 'state migrated to v2');
$r = req("$ms&patch=16.18", $auth);
check(($r['json']['games'] ?? 0) === 8 && ($r['json']['tier'] ?? '') === 'MASTER_PLUS', 'meta-stats after migration', $r['body']);
$sum = json_decode((string) file_get_contents("$MM/summary.json"), true);
check(($sum['v'] ?? 0) === 2 && ($sum['tiers']['MASTER_PLUS']['16.18']['games'] ?? 0) === 8 && ($sum['patches']['16.19']['games'] ?? 0) === 5, 'summary rewritten (v2)', json_encode($sum));
[$code, $out, , $paths] = collect($ALT);
check($paths === [$riotIds($P[1])] && stats('16.18', 'MASTER_PLUS', $MM)['games'] === 8, 'second run after migration: no double counting', implode(',', $paths));
write_config($SITE, ['admin_password' => ADMIN]);
write_config($ALT, []);

// ---------------------------------------------------------------- fonctions pures
define('LOLHELPER_API', true);
$api = "$SITE/api";
require "$api/lib/http.php";
require "$api/lib/config.php";
require "$api/lib/storage.php";
require "$api/lib/riot.php";
require "$api/lib/meta.php";
require "$api/lib/meta_collector.php";

// Égalité des agrégats : stats-IRON-16.19.json = agrégation indépendante des 50 parties gardées (lues au faux serveur).
ctrl(['gen_ids' => 10, 'entries_per_page' => 2, 'gen_base' => ['IRON' => $IRON_BASE, 'GOLD' => $GOLD_BASE]]);
$indep = meta_empty_stats('16.19', 'euw1', 'IRON');
foreach ($expectedIron as $n) {
    $ch = curl_init("$RIOT_BASE/europe/lol/match/v5/matches/EUW1_$n");
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ['X-Riot-Token: ' . KEY]]);
    meta_aggregate($indep, meta_parse_match(json_decode((string) curl_exec($ch), true)));
    curl_close($ch);
}
ctrl([]);
$fileStats = stats('16.19', 'IRON', $TM);
$strip = static fn (array $s): array => ksort_deep(array_diff_key($s, ['updated_at' => 1]));
check($indep['games'] === 50 && $strip(json_decode(json_encode($indep), true)) === $strip($fileStats ?? []),
    'ring buffer aggregation equals an independent aggregation of the 50 most recent matches');

// Configuration : bornes de meta_web_budget, admin_password.
foreach ([[1, 5], [500, 120], [60, 60], [30.7, 30], ['abc', 45], [null, 45]] as [$in, $want]) {
    write_config($ALT, $in === null ? [] : ['meta_web_budget' => $in]);
    check(load_config("$ALT/api")['meta_web_budget'] === $want, 'meta_web_budget ' . var_export($in, true) . " -> $want");
}
write_config($ALT, ['admin_password' => ['x']]);
check(load_config("$ALT/api")['admin_password'] === '', 'admin_password non-string -> disabled');
write_config($ALT, []);
check(load_config("$ALT/api")['admin_password'] === '' && load_config("$SITE/api")['admin_password'] === ADMIN, 'admin_password default empty / read');

// meta_rate : absent = 0,25 ; « auto » = null (garde seule) ; nombre borné à [0, 20] ; invalide = 0,25.
foreach ([['absent', 0.25], ['auto', null], ['AUTO', null], [0.6, 0.6], [0, 0.0], [3, 3.0], [50, 20.0], [-1, 0.0], ['abc', 0.25], ['0.6', 0.25], [true, 0.25]] as [$in, $want]) {
    write_config($ALT, $in === 'absent' ? ['meta_rate' => null] : ['meta_rate' => $in]);
    check(load_config("$ALT/api")['meta_rate'] === $want, 'meta_rate ' . var_export($in, true) . ' -> ' . var_export($want, true));
}
// meta_tiers : valeurs de META_TIERS (ordre canonique) ; anciens noms -> MASTER_PLUS, ligues apex restreintes.
$tierCases = [
    ['absent', TIERS, ['CHALLENGER', 'GRANDMASTER', 'MASTER']],
    [['CHALLENGER', 'GRANDMASTER'], ['MASTER_PLUS'], ['CHALLENGER', 'GRANDMASTER']],
    [['gold', 'Iron', 'MASTER'], ['IRON', 'GOLD', 'MASTER_PLUS'], ['MASTER']],
    [['MASTER_PLUS', 'CHALLENGER'], ['MASTER_PLUS'], ['CHALLENGER', 'GRANDMASTER', 'MASTER']],
    [['DIAMOND', 'DIAMOND', 'x', 3], ['DIAMOND'], ['CHALLENGER', 'GRANDMASTER', 'MASTER']],
    [['bogus'], TIERS, ['CHALLENGER', 'GRANDMASTER', 'MASTER']],
    ['GOLD', TIERS, ['CHALLENGER', 'GRANDMASTER', 'MASTER']],
];
foreach ($tierCases as [$in, $want, $apex]) {
    write_config($ALT, ['meta_tiers' => $in === 'absent' ? null : $in]);
    $cfg = load_config("$ALT/api");
    check($cfg['meta_tiers'] === $want && $cfg['meta_apex'] === $apex, 'meta_tiers ' . json_encode($in), json_encode([$cfg['meta_tiers'], $cfg['meta_apex']]));
}
foreach ([[null, 500], [10, 50], [9999, 5000], [120.5, 120], ['abc', 500], [800, 800]] as [$in, $want]) {
    write_config($ALT, ['meta_games_per_tier' => $in]);
    check(load_config("$ALT/api")['meta_games_per_tier'] === $want, 'meta_games_per_tier ' . var_export($in, true) . " -> $want");
}
write_config($ALT, ['meta_time_budget' => null]);
check(load_config("$ALT/api")['meta_time_budget'] === 3300, 'meta_time_budget default 3300');
foreach ([[null, [4, 15]], ['22-06', [22, 6]], ['00-24', [0, 24]], ['4h-15h', [4, 15]], [' 6 - 12 ', [6, 12]], ['15-15', [4, 15]], ['25-3', [4, 15]],
    ['3-25', [4, 15]], ['abc', [4, 15]], [415, [4, 15]]] as [$in, $want]) {
    write_config($ALT, ['meta_hours' => $in]);
    check(load_config("$ALT/api")['meta_hours'] === $want, 'meta_hours ' . var_export($in, true));
}
$prevLog = ini_set('error_log', "$T/tz-errors.log");
foreach ([[null, 'Europe/Paris'], ['UTC', 'UTC'], ['America/New_York', 'America/New_York'], ['Mars/Olympus', 'Europe/Paris'], [5, 'Europe/Paris']] as [$in, $want]) {
    write_config($ALT, ['timezone' => $in]);
    check(load_config("$ALT/api")['timezone'] === $want, 'timezone ' . var_export($in, true));
}
ini_set('error_log', (string) $prevLog);
write_config($ALT, []);

// Plage horaire (heure locale, fin exclue, passage de minuit, changement d'heure).
$at = static fn (string $local, string $tz = 'Europe/Paris'): int => (new DateTimeImmutable($local, new DateTimeZone($tz)))->getTimestamp();
$w = static fn (array $hours, int $now, string $tz = 'Europe/Paris'): array => meta_window(['meta_hours' => $hours, 'timezone' => $tz], $now);
check($w([4, 15], $at('2026-11-14 03:59:59'))['open'] === false, 'window: 03:59:59 closed');
check($w([4, 15], $at('2026-11-14 04:00:00')) === ['start' => 4, 'end' => 15, 'open' => true, 'remaining' => 11 * 3600], 'window: 04:00 open, 11 h left');
check($w([4, 15], $at('2026-11-14 14:59:59'))['remaining'] === 1, 'window: 14:59:59 -> 1 s left');
check($w([4, 15], $at('2026-11-14 15:00:00'))['open'] === false && $w([4, 15], $at('2026-11-14 15:00:00'))['remaining'] === null, 'window: 15:00 closed (end exclusive)');
check($w([4, 15], $at('2026-11-14 03:30', 'UTC'))['open'] === true, 'window: local time of the timezone (03:30 UTC = 04:30 Paris)');
check($w([4, 15], $at('2026-11-14 03:30', 'UTC'), 'UTC')['open'] === false, 'window: timezone UTC');
check($w([22, 6], $at('2026-11-14 23:00'))['remaining'] === 7 * 3600 && $w([22, 6], $at('2026-11-14 05:00'))['remaining'] === 3600
    && $w([22, 6], $at('2026-11-14 12:00'))['open'] === false, 'window across midnight (22-06)');
check($w([0, 24], $at('2026-11-14 12:00')) === ['start' => 0, 'end' => 24, 'open' => true, 'remaining' => null], 'window 00-24: always open, no cap');
check($w([18, 24], $at('2026-11-14 23:30'))['remaining'] === 1800, 'window ending at midnight');
check($w([0, 4], $at('2026-03-29 01:00'))['remaining'] === 2 * 3600, 'window across the spring DST change (01:00 -> 04:00 = 2 h)');
check(meta_hours_label([4, 15]) === '04h–15h' && meta_hours_label([22, 6]) === '22h–06h', 'window label');
check(meta_local_day(['timezone' => 'Europe/Paris'], $at('2026-11-14 23:30')) === '2026-11-14' && meta_local_day(['timezone' => 'UTC'], $at('2026-11-14 23:30')) === '2026-11-14'
    && meta_local_day(['timezone' => 'Europe/Paris'], $at('2026-11-14 23:30', 'UTC')) === '2026-11-15', 'local day in the configured timezone');
putenv('LOLHELPER_TEST_NOW=1234567890');
check(meta_clock() === 1234567890, 'test clock from the process environment (CLI)');
putenv('LOLHELPER_TEST_NOW=abc');
check(abs(meta_clock() - time()) <= 1, 'invalid test clock ignored');
putenv('LOLHELPER_TEST_NOW');
check(abs(meta_clock() - time()) <= 1, 'real clock by default');

// Pause après un 429.
check(meta_retry_after_seconds(null) === 5 && meta_retry_after_seconds('7') === 7 && meta_retry_after_seconds('0') === 1
    && meta_retry_after_seconds('3600') === 60 && meta_retry_after_seconds('soon') === 5, 'Retry-After: default 5 s, clamped to 1..60 s');

// Niveaux.
check(meta_normalize_tier('gold') === 'GOLD' && meta_normalize_tier('CHALLENGER') === 'MASTER_PLUS' && meta_normalize_tier('master') === 'MASTER_PLUS'
    && meta_normalize_tier('MASTER+') === 'MASTER_PLUS' && meta_normalize_tier('PLAT') === null && meta_normalize_tier(null) === null, 'tier normalization');
$tg = static fn (array $g): array => array_map(static fn (array $p): array => array_map(static fn (int $n): array => ['games' => $n], $p), $g);
check(meta_default_tier([]) === null && meta_default_tier($tg(['GOLD' => ['16.19' => 10], 'MASTER_PLUS' => ['16.19' => 1]])) === 'MASTER_PLUS'
    && meta_default_tier($tg(['GOLD' => ['16.19' => 10], 'IRON' => ['16.19' => 30]])) === 'IRON'
    && meta_default_tier($tg(['GOLD' => ['16.19' => 10], 'IRON' => ['16.19' => 10]])) === 'GOLD'
    && meta_default_tier($tg(['MASTER_PLUS' => ['16.19' => 0], 'SILVER' => ['16.19' => 2]])) === 'SILVER', 'default tier: MASTER_PLUS if it has games, else most games');
check(meta_interleave([['a', 'b', 'c'], ['d', 'a'], []], 10) === ['a', 'd', 'b', 'c'] && meta_interleave([['a', 'b'], ['c', 'd']], 3) === ['a', 'c', 'b']
    && meta_interleave([], 5) === [], 'interleave: round-robin, deduped, capped');

// Limites Riot : en-têtes, hôtes, familles.
check(riot_parse_rate_header('20:1,100:120') === [[20, 1], [100, 120]] && riot_parse_rate_header('3:1, 41:120') === [[3, 1], [41, 120]], 'rate header parsing');
check(riot_parse_rate_header(null) === [] && riot_parse_rate_header('') === [] && riot_parse_rate_header('20:1;100:120') === []
    && riot_parse_rate_header('a:b') === [] && riot_parse_rate_header("20:1\r\nX: y") === [], 'malformed rate headers ignored');
check(riot_url_target('https://europe.api.riotgames.com/lol/match/v5/matches/EUW1_1') === ['europe', '/lol/match/v5/matches/EUW1_1'], 'host of a real Riot URL');
check(riot_url_target('http://127.0.0.1:8080/euw1/lol/clash/v1/tournaments') === ['euw1', '/lol/clash/v1/tournaments'], 'host of a test URL');
check(riot_method_family('/lol/match/v5/matches/EUW1_1') === 'match-v5.match' && riot_method_family('/lol/match/v5/matches/EUW1_1/timeline') === 'match-v5.timeline'
    && riot_method_family('/lol/match/v5/matches/by-puuid/x/ids') === 'match-v5.ids' && riot_method_family('/lol/clash/v1/tournaments') === 'clash-v1.tournaments'
    && riot_method_family('/lol/clash/v1/tournaments/by-team/abc') === 'clash-v1.tournament-by-team' && riot_method_family('/lol/status/v4/platform-data') === 'lol.status.v4.platform-data',
    'method families');

// Garde : formules (usage × 100 < part × limite pour chaque fenêtre).
$now = 1800000000.0;
$b = static fn (array $w, float $at, array $calls = [], float $until = 0.0): array => ['w' => $w, 'at' => $at, 'calls' => $calls, 'until' => $until];
check(riot_gate_wait($b([[20, 1, 0], [100, 120, 94]], $now), $now, RIOT_USER_SHARE_PCT, true) === 0.0, 'user: 94/100 passes');
check(abs(riot_gate_wait($b([[20, 1, 0], [100, 120, 95]], $now - 10), $now, RIOT_USER_SHARE_PCT, true) - 110.0) < 1e-6, 'user: 95/100 waits until the window frees (110 s)');
check(riot_gate_wait($b([[20, 1, 0], [100, 120, 59]], $now), $now, RIOT_COLLECTOR_SHARE_PCT, true) === 0.0, 'collector: 59/100 passes');
check(riot_gate_wait($b([[20, 1, 0], [100, 120, 60]], $now), $now, RIOT_COLLECTOR_SHARE_PCT, true) > 119.0, 'collector: 60/100 waits');
check(riot_gate_wait($b([[20, 1, 12], [100, 120, 1]], $now - 0.25), $now, RIOT_COLLECTOR_SHARE_PCT, true) === 0.75
    && riot_gate_wait($b([[20, 1, 12], [100, 120, 1]], $now - 0.25), $now, RIOT_USER_SHARE_PCT, true) === 0.0, 'collector yields at 12/20 in 1 s, users do not');
check(riot_gate_wait($b([[20, 1, 0], [100, 120, 99]], $now - 121), $now, RIOT_COLLECTOR_SHARE_PCT, true) === 0.0, 'counts older than their window ignored');
$inflight = $b([[20, 1, 0], [100, 120, 93]], $now - 10, [$now - 20, $now - 5, $now - 2]);
check(abs(riot_gate_wait($inflight, $now, RIOT_USER_SHARE_PCT, true) - 110.0) < 1e-6, 'calls sent since the last header are added (93 + 2 in flight = 95)');
check(riot_gate_wait($b([[20, 1, 0], [100, 120, 1]], $now - 1, [], $now + 4.5), $now, RIOT_USER_SHARE_PCT, true) === 4.5, 'Riot 429 pause honoured');
check(riot_gate_wait(null, $now, RIOT_USER_SHARE_PCT, false) === 0.0, 'unknown method limits never block');
$calls = array_map(static fn (int $i): float => $now - 0.5 + $i * 0.01, range(0, 11));
$def = ['at' => 0.0, 'calls' => $calls, 'until' => 0.0];
check(abs(riot_gate_wait($def, $now, RIOT_COLLECTOR_SHARE_PCT, true) - 0.5) < 1e-6 && riot_gate_wait($def, $now, RIOT_USER_SHARE_PCT, true) === 0.0,
    'before any header: 20/1 s assumed (collector 12, users 19)');
$def['calls'] = array_map(static fn (int $i): float => $now - 100 + $i * 0.5, range(0, 94));
check(abs(riot_gate_wait($def, $now, RIOT_USER_SHARE_PCT, true) - 20.0) < 1e-6, 'before any header: 100/120 s assumed (95 calls -> wait for the oldest)');

// Garde + enregistrement sur fichier (instants explicites : déterministe).
$ld = "$T/limits-test";
@mkdir($ld, 0700);
$u = 'http://127.0.0.1:1/europe/lol/match/v5/matches/EUW1_1';
$okUser = 0;
for ($i = 0; $i < 25; $i++) {
    if (riot_gate_acquire($ld, $u, RIOT_USER_SHARE_PCT, $now + $i * 0.001) === 0.0) {
        $okUser++;
    }
}
check($okUser === 19, 'file gate: 19 user calls in the same second before any header', (string) $okUser);
check(riot_gate_acquire($ld, $u, RIOT_COLLECTOR_SHARE_PCT, $now + 0.03) > 0.9, 'file gate: collector refused meanwhile');
check(riot_gate_acquire($ld, $u, RIOT_USER_SHARE_PCT, $now + 1.5) === 0.0, 'file gate: next second free again');
riot_limits_record($ld, $u, $now + 1.5, 200, ['x-app-rate-limit' => '500:10,30000:600', 'x-app-rate-limit-count' => '450:10,100:600'], null);
$st = json_decode((string) file_get_contents("$ld/riot_limits.json"), true);
check(($st['app']['europe']['w'] ?? null) === [[500, 10, 450], [30000, 600, 100]] && ($st['app']['europe']['at'] ?? 0) === $now + 1.5, 'production key limits learned from headers', json_encode($st['app']['europe'] ?? null));
check(riot_gate_acquire($ld, $u, RIOT_USER_SHARE_PCT, $now + 2) === 0.0 && riot_gate_acquire($ld, $u, RIOT_COLLECTOR_SHARE_PCT, $now + 2) > 9.0, 'learned limits used: users < 95 % of 500, collector >= 60 %');
riot_limits_record($ld, $u, $now + 1.0, 200, ['x-app-rate-limit' => '20:1,100:120', 'x-app-rate-limit-count' => '1:1,1:120'], null);
check((json_decode((string) file_get_contents("$ld/riot_limits.json"), true)['app']['europe']['w'][0][0] ?? 0) === 500, 'older response never overwrites newer counts');
$snap = riot_limits_snapshot($ld, $now + 2);
check($snap['host'] === 'europe' && $snap['detected'] && $snap['app'][0]['limit'] === 500 && $snap['app'][0]['count'] === 451 && $snap['app'][1]['count'] === 101,
    'snapshot: learned limits + estimated usage', json_encode($snap));
check(filesize("$ld/riot_limits.json") < 4096 && glob("$ld/*.tmp-*") === [], 'limits file tiny, no temp files');
file_put_contents("$ld/riot_limits.json", '{oops');
$prevLog = ini_set('error_log', "$ld/errors.log");
check(riot_gate_acquire($ld, $u, RIOT_USER_SHARE_PCT, $now + 5) === 0.0 && is_array(json_decode((string) file_get_contents("$ld/riot_limits.json"), true)), 'corrupt limits file reset');
check(str_contains((string) @file_get_contents("$ld/errors.log"), 'riot_limits.json illisible'), 'corrupt limits file logged');
ini_set('error_log', (string) $prevLog);
check(riot_gate_acquire(null, $u, RIOT_COLLECTOR_SHARE_PCT) === 0.0, 'no storage: gate open');

$pk = static fn (array $g): array => array_map(static fn (int $n): array => ['games' => $n, 'updated_at' => 'x'], $g);
check(meta_pick_patch([], 300) === null, 'pick: nothing');
check(meta_pick_patch($pk(['16.19' => 400, '16.18' => 900]), 300) === '16.19', 'pick: latest >= min');
check(meta_pick_patch($pk(['16.19' => 100, '16.18' => 900]), 300) === '16.18', 'pick: previous when latest < min');
check(meta_pick_patch($pk(['16.19' => 100, '16.18' => 50]), 300) === '16.19', 'pick: latest when previous smaller');
check(meta_pick_patch($pk(['16.19' => 100]), 300) === '16.19', 'pick: only latest');
check(meta_patch_from_version('16.19.712.3456') === '16.19' && meta_patch_from_version('16.9') === '16.9'
    && meta_patch_from_version('abc') === null && meta_patch_from_version(16.19) === null, 'patch from gameVersion');
check(meta_sort_patches(['16.9', '16.10', '15.24']) === ['16.10', '16.9', '15.24'], 'patches sorted numerically');

$match = static function (array $over = []): array {
    $ps = [];
    for ($i = 0; $i < 10; $i++) {
        $ps[] = ['championId' => $i + 1, 'teamId' => $i < 5 ? 100 : 200, 'win' => $i < 5,
            'teamPosition' => ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'][$i % 5]];
    }
    $info = ['queueId' => 420, 'gameVersion' => '16.19.1', 'gameCreation' => 1763000000000, 'gameDuration' => 1500, 'gameEndTimestamp' => 1, 'participants' => $ps];
    return ['info' => array_replace($info, $over)];
};
check(isset(meta_parse_match($match())['patch']), 'parse: valid match');
check(meta_parse_match(null) === ['skip' => 'invalid'] && meta_parse_match(['info' => 'x']) === ['skip' => 'invalid'], 'parse: garbage');
$noEnd = $match(['gameDuration' => 1500000]);
unset($noEnd['info']['gameEndTimestamp']);
check(isset(meta_parse_match($noEnd)['patch']), 'parse: legacy duration in ms');
$noEnd['info']['gameDuration'] = 200000;
check((meta_parse_match($noEnd)['skip'] ?? '') === 'remake', 'parse: legacy remake in ms');
$m = $match();
$m['info']['participants'][3]['gameEndedInEarlySurrender'] = true;
check((meta_parse_match($m)['skip'] ?? '') === 'remake', 'parse: early surrender = remake');
$m = $match();
$m['info']['participants'][7]['win'] = true;
check((meta_parse_match($m)['skip'] ?? '') === 'invalid', 'parse: inconsistent team result');
$m = $match();
array_pop($m['info']['participants']);
check((meta_parse_match($m)['skip'] ?? '') === 'invalid', 'parse: 9 participants');
$m = $match();
$m['info']['participants'][2]['championId'] = '3';
check((meta_parse_match($m)['skip'] ?? '') === 'invalid', 'parse: string championId');
$m = $match();
$m['info']['participants'][2]['teamPosition'] = null;
$parsed = meta_parse_match($m);
check(!isset($parsed['skip']) && $parsed['players'][2][1] === null && $parsed['players'][1][1] === 'JUNGLE','parse: null position kept as no role');
$m = $match();
$m['info']['participants'][0]['teamPosition'] = 'MIDDLE'; // deux MID côté bleu
$s = meta_empty_stats('16.19', 'euw1');
meta_aggregate($s, meta_parse_match($m));
check(!isset($s['matchups']['MID']) && isset($s['matchups']['TOP']) === false && isset($s['matchups']['JUNGLE']), 'aggregate: ambiguous lane skipped for matchups');
check(meta_encode_stats(meta_empty_stats('16.19', 'euw1')) !== '' && str_contains(meta_encode_stats(meta_empty_stats('16.19', 'euw1')), '"bans":{}'), 'empty maps encode as objects');

// MetaSeenSet : 100 000 identifiants, compact et exact.
$file = "$T/seen-test.bin";
$set = new MetaSeenSet();
mt_srand(42);
$ids = [];
for ($i = 0; $i < 100000; $i++) {
    $ids[] = mt_rand(1, PHP_INT_MAX >> 8) * 7 + 7000000000;
}
$memBefore = memory_get_usage();
foreach (array_chunk($ids, 2000) as $chunk) {
    foreach ($chunk as $id) {
        $set->add($id);
    }
    $set->save($file);
}
$loaded = MetaSeenSet::load($file);
$memSet = memory_get_usage() - $memBefore;
$unique = count(array_unique($ids));
check(filesize($file) === $unique * 8 && $loaded->count() === $unique, 'seen set: 8 bytes per id on disk', (string) filesize($file));
$allIn = true;
foreach (array_slice($ids, 0, 5000) as $id) {
    $allIn = $allIn && $loaded->has($id);
}
check($allIn && !$loaded->has(1) && !$loaded->has(PHP_INT_MAX), 'seen set lookups');
$raw = file_get_contents($file);
$sorted = true;
for ($i = 8; $i < strlen($raw); $i += 8) {
    $sorted = $sorted && strcmp(substr($raw, $i - 8, 8), substr($raw, $i, 8)) < 0;
}
check($sorted, 'seen set stored sorted and unique');
check($memSet < 4 * 1024 * 1024, 'seen sets stay compact in memory', (string) $memSet);
check(meta_match_number('EUW1_7000000001') === 7000000001 && meta_match_number('../x') === null && meta_match_number(5) === null, 'match number parsing');

// Enregistrement compact : aller-retour exact.
$m = $match(['gameCreation' => 1763000123456]);
$m['info']['participants'][4]['teamPosition'] = '';
$m['info']['teams'] = [['teamId' => 100, 'bans' => [['championId' => 238], ['championId' => -1]]], ['teamId' => 200, 'bans' => [['championId' => 157], ['championId' => 238]]]];
$parsed = meta_parse_match($m);
$rec = meta_pack_record(8000000042, $parsed);
$back = meta_unpack_record($rec);
check(strlen($rec) === META_RECORD_SIZE && $back['n'] === 8000000042 && $back['created'] === 1763000123 && $back['players'] === $parsed['players'] && $back['bans'] === [238, 157],
    'compact record round trip (73 bytes: id, creation, 10 players, bans)', json_encode($back));
$noCreation = $match();
unset($noCreation['info']['gameCreation']);
check((meta_parse_match($noCreation)['skip'] ?? '') === 'invalid', 'parse: gameCreation required');
$m = $match();
$m['info']['participants'][2]['championId'] = 70000;
check((meta_parse_match($m)['skip'] ?? '') === 'invalid', 'parse: champion key beyond 16 bits rejected');

// Tampon circulaire : capacité, éviction de la plus ancienne, ordre, doublons, relecture.
$mk = static function (int $n, int $t) use ($match): string {
    $p = meta_parse_match($match(['gameCreation' => $t * 1000]));
    return meta_pack_record($n, $p);
};
$ring = new MetaRingBuffer(3);
$ok = [$ring->offer($mk(1, 100)), $ring->offer($mk(3, 300)), $ring->offer($mk(2, 200))];
check($ok === [true, true, true] && $ring->isFull() && $ring->oldestTime() === 100 && $ring->newestTime() === 300, 'ring: fills up to capacity, sorted by time');
check($ring->offer($mk(4, 50)) === false && $ring->count() === 3, 'ring full: older match refused');
check($ring->offer($mk(3, 300)) === false, 'ring: duplicate refused');
check($ring->offer($mk(5, 250)) === true && $ring->oldestTime() === 200 && !$ring->has(1) && $ring->has(5), 'ring full: newer match replaces the oldest');
check(array_map(static fn (string $r): int => unpack('J', $r)[1], iterator_to_array($ring->records(), false)) === [2, 5, 3], 'ring: records oldest first');
$rf = "$T/ring-test.bin";
$ring->save($rf);
check(filesize($rf) === 3 * META_RECORD_SIZE && !$ring->isDirty(), 'ring saved (73 bytes per match)');
$re = MetaRingBuffer::load($rf, 3);
check($re->count() === 3 && $re->has(5) && !$re->isDirty() && $re->oldestTime() === 200, 'ring reloaded unchanged');
$small = MetaRingBuffer::load($rf, 2);
check($small->count() === 2 && !$small->has(2) && $small->isDirty(), 'lower capacity: oldest dropped on load');
file_put_contents($rf, 'garbage');
$prevLog = ini_set('error_log', "$T/ring-errors.log");
check(MetaRingBuffer::load($rf, 3)->count() === 0 && MetaRingBuffer::load($rf, 3)->isDirty(), 'corrupt buffer file reset');
ini_set('error_log', (string) $prevLog);

// Égalité : tampon de 50 nourri dans le désordre = agrégation des 50 plus récentes parmi 300.
mt_srand(7);
$pool = [];
for ($i = 1; $i <= 300; $i++) {
    $ps = [];
    for ($k = 0; $k < 10; $k++) {
        $ps[] = ['championId' => mt_rand(1, 40), 'teamId' => $k < 5 ? 100 : 200, 'win' => ($k < 5) === ($i % 3 !== 0),
            'teamPosition' => ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', ''][mt_rand(0, 5)]];
    }
    $mm = $match(['participants' => $ps, 'gameCreation' => (1763000000 + mt_rand(0, 200000)) * 1000,
        'teams' => [['teamId' => 100, 'bans' => [['championId' => mt_rand(1, 40)]]]]]);
    $pool[$i] = meta_parse_match($mm);
}
$ring = new MetaRingBuffer(50);
$order = array_keys($pool);
shuffle($order);
foreach ($order as $i) {
    $ring->offer(meta_pack_record($i, $pool[$i]));
}
$created = array_map(static fn (array $p): int => $p['created'], $pool);
$top = most_recent($created, 50);
$expect = meta_empty_stats('16.19', 'euw1', 'GOLD');
foreach ($top as $i) {
    meta_aggregate($expect, $pool[$i]);
}
$got = meta_stats_from_records($ring->records(), '16.19', 'euw1', 'GOLD');
check($ring->count() === 50 && array_map(static fn (string $r): int => unpack('J', $r)[1], iterator_to_array($ring->records(), false)) === $top,
    'ring buffer keeps exactly the 50 most recent of 300 (shuffled input)');
check(ksort_deep(array_diff_key($got, ['updated_at' => 1])) === ksort_deep(array_diff_key($expect, ['updated_at' => 1])), 'aggregation from the buffer equals aggregation of the kept matches');
$merged = meta_merge_stats($got, $expect);
check($merged['games'] === 100 && ($merged['bans'] ?? []) !== [] && array_sum($merged['bans']) === 2 * array_sum($got['bans']), 'merge of two aggregates sums every cell');

// Mémoire : un tampon plein de 5000 parties reste compact.
$memBefore = memory_get_usage();
$big = new MetaRingBuffer(5000);
$recTpl = meta_pack_record(1, $pool[1]);
for ($i = 1; $i <= 5000; $i++) {
    $big->offer(pack('JN', 9000000000 + $i, 1763000000 + $i) . substr($recTpl, 12));
}
$big->has(1);
$memBig = memory_get_usage() - $memBefore;
check($big->count() === 5000 && $memBig < 2 * 1024 * 1024, 'full 5000-match buffer < 2 MB in memory', (string) $memBig);

echo "PHP meta tests: $passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
