<?php
// Tests du collecteur méta (cron CLI) et de la route meta-stats (lancés par run.sh).
declare(strict_types=1);

$M = getenv('API_M');             // site dans www/lolhelper/ (comme sur OVH), mot de passe, data_dir par défaut
$A = getenv('API_A');             // site des tests HTTP : rien de collecté
$SITE = getenv('META_SITE');      // <T>/m/www/lolhelper
$ALT = getenv('META_ALT_SITE');   // <T>/m2/www/lolhelper : configs variantes, même dossier de données
$T = getenv('TEST_TMP');
$PHP = getenv('PHP_BIN') ?: 'php';
$FAKE_LOG = getenv('FAKE_LOG');
$FAKE_CTRL = getenv('FAKE_CTRL');
$RIOT_BASE = getenv('META_RIOT_BASE');
const PW = 's3cret';
const KEY = 'RGAPI-test-key-123';

$DATA = "$T/m/lolhelper-data";
$META = "$DATA/meta";
$P = [];
for ($i = 1; $i <= 5; $i++) {
    $P[$i] = "meta-player-0$i-abcdefghijklmnopqrstuvwxyz0123456789";
}
$mid = static fn (int $n): string => sprintf('EUW1_80000000%02d', $n);

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

function req(string $url, array $headers = []): array
{
    $respHeaders = [];
    $h = [];
    foreach ($headers as $k => $v) {
        $h[] = "$k: $v";
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
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

/** Lance le collecteur en CLI ; renvoie [code, stderr+stdout, durée, requêtes Riot]. */
function collect(string $site): array
{
    global $PHP, $FAKE_LOG, $RIOT_BASE;
    @unlink($FAKE_LOG);
    $env = getenv();
    $env['LOLHELPER_RIOT_BASE'] = $RIOT_BASE;
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
    ];
    file_put_contents("$site/api/config.php", '<?php return ' . var_export(array_merge($base, $extra), true) . ';');
}

function stats(string $patch): ?array
{
    global $META;
    $f = "$META/stats-$patch.json";
    return is_file($f) ? json_decode(file_get_contents($f), true) : null;
}

function state(): array
{
    global $META;
    return json_decode((string) @file_get_contents("$META/state.json"), true) ?: [];
}

$auth = ['X-App-Password' => PW];
$riotMatch = static fn (int $n): string => '/europe/lol/match/v5/matches/' . sprintf('EUW1_80000000%02d', $n);
$riotIds = static fn (string $puuid): string => "/europe/lol/match/v5/matches/by-puuid/$puuid/ids";
$CHAL = '/euw1/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5';
$GM = '/euw1/lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5';

// ---------------------------------------------------------------- avant toute collecte
@unlink($FAKE_LOG);
$r = req("$M/lolhelper/api/cron/collect-meta.php");
check($r['status'] === 404 && $r['body'] === '', 'cron script over HTTP -> 404, empty body', "got {$r['status']} " . substr($r['body'], 0, 200));
check(fake_log() === [] && !is_dir($META), 'cron script over HTTP does nothing');

$r = req("$M/lolhelper/api/index.php?r=meta-stats");
check($r['status'] === 401, 'meta-stats requires the password', "got {$r['status']}");
$r = req("$M/lolhelper/api/index.php?r=meta-stats", $auth);
check($r['status'] === 200 && $r['json'] === ['available' => false, 'games' => 0], 'meta-stats unavailable before collection', $r['body']);
check(($r['headers']['cache-control'] ?? '') === 'private, max-age=300', 'meta-stats Cache-Control', $r['headers']['cache-control'] ?? '');
$r = req("$M/lolhelper/api/index.php?r=meta");
check($r['status'] === 200 && array_key_exists('meta_stats', $r['json']) && $r['json']['meta_stats'] === null, 'meta.meta_stats null before collection', $r['body']);
$r = req("$A/api/index.php?r=meta");
check(array_key_exists('meta_stats', $r['json'] ?? []) && $r['json']['meta_stats'] === null, 'meta A meta_stats null');
$r = req("$A/api/index.php?r=meta-stats", $auth);
check($r['status'] === 200 && $r['json'] === ['available' => false, 'games' => 0], 'meta-stats A unavailable');

// ---------------------------------------------------------------- run 1 : arrêt sur 429
ctrl(['match_429' => $mid(5), 'retry_after' => '1']);
[$code, $out, , $paths] = collect($SITE);
check($code === 0, 'run1 exit 0', $out);
check(str_contains($out, '429') && str_contains($out, 'lolhelper meta:'), 'run1 logs the 429 stop', $out);
$expected = [$CHAL, $GM, $riotIds($P[1]), $riotMatch(1), $riotMatch(2), $riotMatch(3), $riotMatch(4), $riotIds($P[2]), $riotMatch(5)];
check($paths === $expected, 'run1 requests (seed refresh, P1 complete, stop right after 429)', implode("\n      ", $paths));
check(is_dir($META), 'data written in ~/lolhelper-data/meta (sibling of www/)', $out);
check(!is_dir("$T/m/www/lolhelper-data") && !is_dir("$T/m/www/lolhelper/api/data") && !is_dir("$T/m/www/lolhelper/lolhelper-data"), 'nothing written under www/');
$st = state();
check(($st['seeds'] ?? null) === [$P[1], $P[2], $P[3], $P[4]], 'seeds: tiers order, LP desc, deduped, invalid dropped', json_encode($st['seeds'] ?? null));
check(($st['cursor'] ?? null) === 1, 'run1 cursor stays on the interrupted player');
check(($st['blocked_until'] ?? 0) >= time(), 'run1 records Retry-After pause');
check(stats('16.19')['games'] === 1 && stats('16.18')['games'] === 1, 'run1 counts (16.19: 1, 16.18: 1)');
check(stats('16.17') === null && !is_file("$META/seen-16.17.bin"), 'only the 2 most recent patches kept on disk');
check(glob("$META/*.tmp-*") === [], 'no temp files left');
check(!str_contains((string) @file_get_contents("$META/state.json"), KEY), 'key never stored');

// ---------------------------------------------------------------- run 2 : pause Retry-After
[$code, $out, , $paths] = collect($SITE);
check($code === 0 && $paths === [] && str_contains($out, 'pause'), 'run2 honours Retry-After (no request)', $out . implode(',', $paths));

// ---------------------------------------------------------------- run 3 : reprise
ctrl([]);
while (time() < (state()['blocked_until'] ?? 0)) {
    usleep(100000);
}
[$code, $out, , $paths] = collect($SITE);
$expected = [
    $riotIds($P[2]), $riotMatch(5), $riotMatch(6), $riotMatch(7),
    $riotIds($P[3]), $riotMatch(8), $riotMatch(12),
    $riotIds($P[4]), $riotMatch(9),
    $riotIds($P[1]), $riotMatch(1),
];
check($code === 0 && $paths === $expected, 'run3 resumes at P2, skips seen matches, no seed refresh', implode("\n      ", $paths) . "\n" . $out);
check(str_contains($out, 'tour complet'), 'run3 stops after one full pass', $out);
check(stats('16.19')['games'] === 2 && stats('16.18')['games'] === 3, 'run3 counts (16.19: 2, 16.18: 3)', json_encode([stats('16.19')['games'], stats('16.18')['games']]));
check((state()['cursor'] ?? null) === 1, 'run3 cursor back to start of pass');
check(filesize("$META/seen-16.19.bin") === 16 && filesize("$META/seen-16.18.bin") === 24, 'seen sets: 8 bytes per counted match');
$before = [file_get_contents("$META/stats-16.19.json"), file_get_contents("$META/stats-16.18.json")];

// ---------------------------------------------------------------- run 4 : rien de neuf
[$code, $out, , $paths] = collect($SITE);
check($code === 0 && $paths === [$riotIds($P[2]), $riotIds($P[3]), $riotIds($P[4]), $riotIds($P[1])], 'run4 only lists ids (everything seen or rejected)', implode("\n      ", $paths));
check([file_get_contents("$META/stats-16.19.json"), file_get_contents("$META/stats-16.18.json")] === $before, 'run4 no double counting (stats unchanged)');

// ---------------------------------------------------------------- route : repli sur le patch précédent
$r = req("$M/lolhelper/api/index.php?r=meta-stats", $auth);
check($r['status'] === 200 && ($r['json']['available'] ?? null) === true && $r['json']['patch'] === '16.18' && $r['json']['games'] === 3,
    'meta-stats falls back to previous patch (16.19 has 2 < meta_min_games 3)', $r['body']);
check(($r['json']['champions']['103']['MID'] ?? null) === [3, 2], '16.18 Ahri MID [3, 2]', $r['body']);
$r = req("$M/lolhelper/api/index.php?r=meta");
check(($r['json']['meta_stats'] ?? null) === ['patch' => '16.18', 'games' => 3, 'updated_at' => $r['json']['meta_stats']['updated_at'] ?? ''], 'meta.meta_stats (16.18)', $r['body']);
check(preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/D', (string) ($r['json']['meta_stats']['updated_at'] ?? '')) === 1, 'meta_stats.updated_at ISO 8601 UTC');

// ---------------------------------------------------------------- run 5 : rafraîchissement des joueurs (> 24 h)
$st = state();
$st['seed_refreshed_at'] = time() - 90000;
file_put_contents("$META/state.json", json_encode($st));
ctrl(['challenger' => 'b']);
[$code, $out, , $paths] = collect($SITE);
check(array_slice($paths, 0, 2) === [$CHAL, $GM], 'run5 refreshes seeds after 24 h', implode("\n      ", $paths));
check((state()['seeds'] ?? null) === [$P[5], $P[1], $P[2], $P[3], $P[4]], 'run5 new seed list', json_encode(state()['seeds'] ?? null));
check(in_array($riotMatch(10), $paths, true) && in_array($riotMatch(11), $paths, true) && !in_array($riotMatch(2), $paths, true), 'run5 collects new player matches only');
check(stats('16.19')['games'] === 4 && stats('16.18')['games'] === 3, 'run5 counts (16.19: 4)');
ctrl([]);

// ---------------------------------------------------------------- route : patch courant + contenu
$r = req("$M/lolhelper/api/index.php?r=meta-stats", $auth);
$j = $r['json'] ?? [];
check($r['status'] === 200 && ($j['patch'] ?? '') === '16.19' && ($j['games'] ?? 0) === 4 && ($j['platform'] ?? '') === 'euw1', 'meta-stats serves 16.19 once >= meta_min_games', $r['body']);
check(array_keys($j) === ['available', 'patch', 'platform', 'games', 'updated_at', 'champions', 'bans', 'matchups'], 'meta-stats payload keys', implode(',', array_keys($j)));
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
$cursorBefore = state()['cursor'];
write_config($ALT, ['meta_rate' => 3, 'meta_time_budget' => 1]);
[$code, $out, $dur, $paths] = collect($ALT);
check($code === 0 && str_contains($out, 'budget'), 'time budget stop logged', $out);
check(count($paths) >= 1 && count($paths) <= 4, 'time budget + pacing bound requests (3/s for 1 s)', (string) count($paths));
check($dur < 4.0, 'time budget respected', sprintf('%.2f s', $dur));
check(stats('16.19')['games'] === 4, 'budget run keeps counts');

// ---------------------------------------------------------------- 401
$cursorBefore = state()['cursor'];
write_config($ALT, ['riot_api_key' => 'RGAPI-wrong']);
[$code, $out, , $paths] = collect($ALT);
check($code === 1 && str_contains($out, '401') && count($paths) === 1, '401 stops the run at once (exit 1)', $out . implode(',', $paths));
check(state()['cursor'] === $cursorBefore && stats('16.19')['games'] === 4, '401 leaves state untouched');

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

// ---------------------------------------------------------------- désactivé / sans clé
write_config($ALT, ['meta_enabled' => false]);
[$code, $out, , $paths] = collect($ALT);
check($code === 0 && $paths === [] && str_contains($out, 'désactivée'), 'meta_enabled=false does nothing', $out);
write_config($ALT, ['riot_api_key' => '']);
[$code, $out, , $paths] = collect($ALT);
check($code === 1 && $paths === [], 'no key -> exit 1, no request', $out);

// ---------------------------------------------------------------- fonctions pures
define('LOLHELPER_API', true);
$api = "$SITE/api";
require "$api/lib/http.php";
require "$api/lib/config.php";
require "$api/lib/storage.php";
require "$api/lib/riot.php";
require "$api/lib/meta.php";
require "$api/lib/meta_collector.php";

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
    $info = ['queueId' => 420, 'gameVersion' => '16.19.1', 'gameDuration' => 1500, 'gameEndTimestamp' => 1, 'participants' => $ps];
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

echo "PHP meta tests: $passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
