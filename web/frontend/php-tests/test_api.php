<?php
// Tests HTTP de l'API PHP (lancés par run.sh).
declare(strict_types=1);

$A = getenv('API_A');   // clé + mot de passe + CORS + data_dir explicite
$B = getenv('API_B');   // pas de config.php (défauts), data dir par défaut
$C = getenv('API_C');   // clé, pas de mot de passe, data_dir inutilisable -> api/data, Riot injoignable
$T = getenv('TEST_TMP');
$FAKE_LOG = getenv('FAKE_LOG');
const PW = 's3cret';
const KEY = 'RGAPI-test-key-123';
const ORIGIN = 'https://friends.example';
const PUUID = 'kX9v2bQx3Lr7nT0pWq8sYz1aB4cD5eF6gH7iJ8kL9mN0oP1qR2sT3uV4wX5yZ6aB7cD8eF9gH0iJ1k';

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

/** @return array{status:int, headers:array<string,string>, body:string, json:mixed} */
function req(string $method, string $url, array $headers = [], ?string $body = null): array
{
    $respHeaders = [];
    $ch = curl_init($url);
    $h = [];
    foreach ($headers as $k => $v) {
        $h[] = "$k: $v";
    }
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
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $out = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $out = $out === false ? '' : $out;
    return ['status' => $status, 'headers' => $respHeaders, 'body' => $out, 'json' => json_decode($out, true)];
}

function api(string $base, string $query): string
{
    return $base . '/api/index.php?' . $query;
}

function auth(array $extra = []): array
{
    return ['X-App-Password' => PW] + $extra;
}

function expect(array $r, int $status, string $label, ?string $detail = null): void
{
    check($r['status'] === $status, "$label: status $status", "got {$r['status']} body=" . substr($r['body'], 0, 300));
    if ($status !== 204) {
        check(str_starts_with($r['headers']['content-type'] ?? '', 'application/json'), "$label: JSON content-type");
    }
    check(($r['headers']['x-content-type-options'] ?? '') === 'nosniff', "$label: nosniff");
    if ($detail !== null) {
        check(($r['json']['detail'] ?? null) === $detail, "$label: detail", 'got ' . $r['body']);
    }
    check(!str_contains($r['body'], KEY), "$label: key never leaked");
}

function fake_log(): array
{
    global $FAKE_LOG;
    return is_file($FAKE_LOG) ? array_values(array_filter(explode("\n", file_get_contents($FAKE_LOG)))) : [];
}

$MSG_401 = 'Mot de passe requis ou incorrect.';

// ---------------------------------------------------------------- meta
$r = req('GET', api($A, 'r=meta'));
expect($r, 200, 'meta A (public, no password)');
check($r['json']['riot_configured'] === true, 'meta A riot_configured');
check($r['json']['password_required'] === true, 'meta A password_required');
check($r['json']['platform'] === 'euw1' && $r['json']['region'] === 'europe', 'meta A platform/region');
check(count($r['json']['platforms']) === 15 && in_array('vn2', $r['json']['platforms'], true), 'meta platforms');
check($r['json']['storage_ok'] === true, 'meta A storage_ok');
check(!array_key_exists('riot_api_key', $r['json']), 'meta has no key field');

$r = req('GET', api($B, 'r=meta'));
expect($r, 200, 'meta B (no config.php)');
check($r['json']['riot_configured'] === false && $r['json']['password_required'] === false, 'meta B flags');
check($r['json']['storage_ok'] === true, 'meta B storage_ok');
check(is_dir("$T/b/lolhelper-data"), 'B default data dir = dirname(api,2)/lolhelper-data');
check((fileperms("$T/b/lolhelper-data") & 0777) === 0700, 'B data dir created 0700');

$r = req('GET', api($C, 'r=meta'));
expect($r, 200, 'meta C');
check($r['json']['platform'] === 'kr' && $r['json']['region'] === 'asia', 'meta C platform kr/asia');
check($r['json']['storage_ok'] === true, 'meta C storage_ok (fallback)');
check(is_dir("$T/c/www/api/data"), 'C fallback api/data created');
check(str_contains((string) @file_get_contents("$T/c/www/api/data/.htaccess"), 'Require all denied'), 'C fallback data/.htaccess');

expect(req('POST', api($A, 'r=meta')), 405, 'meta POST -> 405');
expect(req('GET', api($A, 'r=nope')), 401, 'unknown route without password -> 401');
expect(req('GET', api($A, 'r=nope'), auth()), 404, 'unknown route -> 404');
expect(req('GET', api($A, '')), 404, 'no route -> 404');
expect(req('GET', api($A, 'r[]=meta')), 404, 'array route -> 404');

// ---------------------------------------------------------------- auth
expect(req('GET', api($A, 'r=store/players')), 401, 'store without password', $MSG_401);
expect(req('GET', api($A, 'r=store/players'), ['X-App-Password' => 'wrong']), 401, 'store wrong password', $MSG_401);
expect(req('GET', api($A, 'r=store/players'), ['X-App-Password' => PW . 'x']), 401, 'store longer password', $MSG_401);
expect(req('GET', api($A, 'r=riot/summoner&platform=euw1&puuid=' . PUUID)), 401, 'riot without password', $MSG_401);
expect(req('GET', api($A, 'r=store/players'), auth()), 200, 'store with password');
expect(req('GET', api($B, 'r=store/players')), 200, 'B no password configured -> open');

// ---------------------------------------------------------------- store CRUD
$r = req('GET', api($A, 'r=store/teams'), auth());
check($r['json'] === [], 'empty collection -> []');
$r = req('PUT', api($A, 'r=store/teams/t-2'), auth(['Content-Type' => 'application/json']), '{"name":"Deux","id":"hack","nested":{},"list":[],"n":1.5,"txt":"Élégant <b>"}');
expect($r, 200, 'PUT t-2');
check($r['json']['id'] === 't-2', 'PUT id forced');
check(str_contains($r['body'], '"nested":{}') && str_contains($r['body'], '"list":[]'), 'empty object/array preserved', $r['body']);
check(str_contains($r['body'], 'Élégant'), 'unicode kept unescaped');
expect(req('PUT', api($A, 'r=store/teams/a-1'), auth(), '{"name":"Un"}'), 200, 'PUT a-1');
expect(req('PUT', api($A, 'r=store/teams/m-3'), auth(), '{"name":"Trois"}'), 200, 'PUT m-3');
$r = req('GET', api($A, 'r=store/teams'), auth());
check(array_column($r['json'], 'id') === ['t-2', 'a-1', 'm-3'], 'insertion order', $r['body']);
$r = req('PUT', api($A, 'r=store/teams/a-1'), auth(), '{"name":"Un bis"}');
check($r['json'] === ['name' => 'Un bis', 'id' => 'a-1'], 'upsert returns stored doc', $r['body']);
$r = req('GET', api($A, 'r=store/teams'), auth());
check(array_column($r['json'], 'id') === ['t-2', 'a-1', 'm-3'] && $r['json'][1]['name'] === 'Un bis', 'upsert keeps position');
$r = req('DELETE', api($A, 'r=store/teams/a-1'), auth());
check($r['status'] === 204 && $r['body'] === '', 'DELETE -> 204 empty');
expect(req('DELETE', api($A, 'r=store/teams/a-1'), auth()), 404, 'DELETE absent -> 404');
$r = req('GET', api($A, 'r=store/teams'), auth());
check(array_column($r['json'], 'id') === ['t-2', 'm-3'], 'after delete');
check(is_file("$T/a/data/teams.json"), 'stored in configured data_dir');
check(glob("$T/a/data/*.tmp-*") === [], 'no temp files left');

expect(req('GET', api($A, 'r=store/users'), auth()), 404, 'invalid collection -> 404');
expect(req('PUT', api($A, 'r=store/users/x'), auth(), '{}'), 404, 'PUT invalid collection -> 404');
expect(req('PUT', api($A, 'r=store/teams/bad_id'), auth(), '{}'), 400, 'invalid id (underscore) -> 400');
expect(req('PUT', api($A, 'r=store/teams/' . str_repeat('a', 65)), auth(), '{}'), 400, 'id too long -> 400');
expect(req('PUT', api($A, 'r=store/teams/' . str_repeat('a', 64)), auth(), '{}'), 200, 'id 64 chars ok');
expect(req('PUT', api($A, 'r=store/teams/x1'), auth(), '[1,2]'), 400, 'array body -> 400');
expect(req('PUT', api($A, 'r=store/teams/x1'), auth(), '[]'), 400, 'empty array body -> 400');
expect(req('PUT', api($A, 'r=store/teams/x1'), auth(), '"str"'), 400, 'string body -> 400');
expect(req('PUT', api($A, 'r=store/teams/x1'), auth(), 'null'), 400, 'null body -> 400');
expect(req('PUT', api($A, 'r=store/teams/x1'), auth(), '{bad json'), 400, 'invalid JSON -> 400');
expect(req('PUT', api($A, 'r=store/teams/x1'), auth(), ''), 400, 'empty body -> 400');
expect(req('PUT', api($A, 'r=store/teams/x1'), auth(), "{\"a\":\"\xC3\x28\"}"), 400, 'invalid UTF-8 -> 400');
$big = '{"x":"' . str_repeat('a', 262144) . '"}';
expect(req('PUT', api($A, 'r=store/teams/x1'), auth(), $big), 413, 'oversized body -> 413');
expect(req('POST', api($A, 'r=store/teams/x1'), auth(), '{}'), 405, 'POST doc -> 405');
expect(req('PUT', api($A, 'r=store/teams'), auth(), '{}'), 405, 'PUT collection -> 405');
expect(req('DELETE', api($A, 'r=store/teams'), auth()), 405, 'DELETE collection -> 405');
check(isset(req('POST', api($A, 'r=store/teams/x1'), auth(), '{}')['headers']['allow']), '405 has Allow header');

// path traversal
foreach (['store/../config', 'store/teams/../../x', 'store/..%2F..%2Fx', 'store/teams/..', 'store/teams/.htaccess', 'store/./teams', 'riot/../store/teams'] as $evil) {
    $r = req('GET', api($A, 'r=' . $evil), auth());
    check(in_array($r['status'], [400, 404, 405], true), "traversal r=$evil rejected", "got {$r['status']}");
}
$r = req('PUT', api($A, 'r=' . rawurlencode('store/teams/../../../evil')), auth(), '{}');
check(in_array($r['status'], [400, 404], true), 'encoded traversal PUT rejected');
check(!file_exists("$T/evil.json") && !file_exists("$T/a/evil.json"), 'no file written outside');

// 500 docs limit (fresh collection "saved" on server B)
for ($i = 0; $i < 500; $i++) {
    $r = req('PUT', api($B, "r=store/saved/s$i"), [], '{"i":' . $i . '}');
    if ($r['status'] !== 200) {
        check(false, "fill saved #$i", $r['body']);
        break;
    }
}
expect(req('PUT', api($B, 'r=store/saved/s500'), [], '{}'), 413, '501st doc -> 413');
expect(req('PUT', api($B, 'r=store/saved/s3'), [], '{"upd":true}'), 200, 'upsert at limit ok');
$r = req('GET', api($B, 'r=store/saved'), []);
check(count($r['json']) === 500 && $r['json'][3] === ['upd' => true, 'id' => 's3'], '500 docs stored');
check(is_file("$T/b/lolhelper-data/saved.json"), 'B stored in default data dir');

// ---------------------------------------------------------------- CORS
$r = req('OPTIONS', api($A, 'r=store/players'), ['Origin' => ORIGIN, 'Access-Control-Request-Method' => 'PUT']);
check($r['status'] === 204, 'preflight 204 (no password needed)', "got {$r['status']}");
check(($r['headers']['access-control-allow-origin'] ?? '') === ORIGIN, 'preflight ACAO');
check(str_contains($r['headers']['access-control-allow-methods'] ?? '', 'DELETE'), 'preflight methods');
check(str_contains($r['headers']['access-control-allow-headers'] ?? '', 'X-App-Password'), 'preflight headers');
$r = req('OPTIONS', api($A, 'r=store/players'), ['Origin' => 'https://evil.example']);
check($r['status'] === 204 && !isset($r['headers']['access-control-allow-origin']), 'preflight other origin: no CORS headers');
$r = req('GET', api($A, 'r=meta'), ['Origin' => ORIGIN]);
check(($r['headers']['access-control-allow-origin'] ?? '') === ORIGIN, 'GET allowed origin echoed');
$r = req('GET', api($A, 'r=meta'), ['Origin' => 'https://evil.example']);
check(!isset($r['headers']['access-control-allow-origin']), 'GET other origin: no ACAO');
$r = req('GET', api($B, 'r=meta'), ['Origin' => ORIGIN]);
check(!isset($r['headers']['access-control-allow-origin']), 'no cors_origins -> no ACAO');

// ---------------------------------------------------------------- Riot happy paths
@unlink($FAKE_LOG);
$r = req('GET', api($A, 'r=riot/account&platform=euw1&gameName=' . rawurlencode('Le Fou Élégant') . '&tagLine=EUW'), auth());
expect($r, 200, 'riot account');
check(($r['json']['gameName'] ?? '') === 'Le Fou Élégant' && $r['json']['tagLine'] === 'EUW', 'account name round trip', $r['body']);
check(($r['json']['_host'] ?? '') === 'europe', 'account uses region host');
check(in_array('/europe/riot/account/v1/accounts/by-riot-id/Le%20Fou%20%C3%89l%C3%A9gant/EUW', fake_log(), true), 'gameName URL-encoded', implode(' | ', fake_log()));
$r = req('GET', api($A, 'r=riot/account&platform=kr&gameName=' . rawurlencode('Hide on bush') . '&tagLine=KR1'), auth());
check(($r['json']['_host'] ?? '') === 'asia', 'kr -> asia');
$r = req('GET', api($A, 'r=riot/account&platform=br1&gameName=x&tagLine=' . rawurlencode('Ñ12')), auth());
check(($r['json']['_host'] ?? '') === 'americas' && $r['json']['tagLine'] === 'Ñ12', 'br1 -> americas, unicode tag');
$r = req('GET', api($A, 'r=riot/account&platform=vn2&gameName=x&tagLine=VN2'), auth());
check(($r['json']['_host'] ?? '') === 'sea', 'vn2 -> sea');

$r = req('GET', api($A, 'r=riot/summoner&platform=euw1&puuid=' . PUUID), auth());
expect($r, 200, 'riot summoner');
check(($r['json']['summonerLevel'] ?? 0) === 287, 'summoner body passthrough');
check(in_array('/euw1/lol/summoner/v4/summoners/by-puuid/' . PUUID, fake_log(), true), 'summoner uses platform host');
$r = req('GET', api($A, 'r=riot/league&platform=euw1&puuid=' . PUUID), auth());
expect($r, 200, 'riot league');
check(($r['json'][0]['tier'] ?? '') === 'SILVER', 'league body');
$r = req('GET', api($A, 'r=riot/masteries&platform=euw1&puuid=' . PUUID . '&count=30'), auth());
expect($r, 200, 'riot masteries');
check(in_array('/euw1/lol/champion-mastery/v4/champion-masteries/by-puuid/' . PUUID . '/top?count=30', fake_log(), true), 'masteries count');
req('GET', api($A, 'r=riot/masteries&platform=euw1&puuid=' . PUUID), auth());
check(in_array('/euw1/lol/champion-mastery/v4/champion-masteries/by-puuid/' . PUUID . '/top?count=30', fake_log(), true), 'masteries default count');
$r = req('GET', api($A, 'r=riot/match-ids&platform=euw1&puuid=' . PUUID . '&count=20&queue=420'), auth());
expect($r, 200, 'riot match-ids');
check(($r['json'][0] ?? '') === 'EUW1_7000000001', 'match-ids body');
check(in_array('/europe/lol/match/v5/matches/by-puuid/' . PUUID . '/ids?start=0&count=20&queue=420', fake_log(), true), 'match-ids query', implode(' | ', fake_log()));
req('GET', api($A, 'r=riot/match-ids&platform=euw1&puuid=' . PUUID), auth());
check(in_array('/europe/lol/match/v5/matches/by-puuid/' . PUUID . '/ids?start=0&count=20', fake_log(), true), 'match-ids no queue');

// match + cache
@unlink($FAKE_LOG);
$r = req('GET', api($A, 'r=riot/match&platform=euw1&id=EUW1_7000000001'), auth());
expect($r, 200, 'riot match (miss)');
check(($r['json']['metadata']['matchId'] ?? '') === 'EUW1_7000000001', 'match body');
check(count(fake_log()) === 1, 'one upstream call');
check(is_file("$T/a/data/matches/EUW1_7000000001.json"), 'match cached on disk');
$r2 = req('GET', api($A, 'r=riot/match&platform=euw1&id=EUW1_7000000001'), auth());
expect($r2, 200, 'riot match (hit)');
check($r2['body'] === $r['body'] && ($r2['headers']['x-cache'] ?? '') === 'HIT', 'cache served identical');
check(count(fake_log()) === 1, 'no upstream call on cache hit');
expect(req('GET', api($A, 'r=riot/match&platform=euw1&id=EUW1_404'), auth()), 404, 'match 404', 'Introuvable chez Riot.');
expect(req('GET', api($A, 'r=riot/match&platform=euw1&id=EUW1_404'), auth()), 404, 'match 404 again (not cached)');
check(count(fake_log()) === 3, '404 not cached', implode(' | ', fake_log()));
$r = req('GET', api($A, 'r=riot/match&platform=euw1&id=EUW1_429'), auth());
expect($r, 429, 'match 429');
check(($r['headers']['retry-after'] ?? '') === '3', 'match 429 Retry-After copied');
check(!is_file("$T/a/data/matches/EUW1_429.json") && !is_file("$T/a/data/matches/EUW1_404.json"), 'errors never cached');

// ---------------------------------------------------------------- upstream errors
$acc = fn (string $gn) => req('GET', api($A, 'r=riot/account&platform=euw1&tagLine=EUW&gameName=' . rawurlencode($gn)), auth());
expect($acc('Missing'), 404, 'upstream 404', 'Introuvable chez Riot.');
$msgAuth = 'Clé API Riot invalide ou expirée (une clé de développement expire toutes les 24 h).';
expect($acc('BadKey'), 502, 'upstream 401', $msgAuth);
expect($acc('Forbid'), 502, 'upstream 403', $msgAuth);
$r = $acc('Limited');
expect($r, 429, 'upstream 429', 'Limite de requêtes Riot atteinte, réessaie dans quelques secondes.');
check(($r['headers']['retry-after'] ?? '') === '7', 'Retry-After copied (7)');
$r = $acc('LimitedNoRA');
check($r['status'] === 429 && ($r['headers']['retry-after'] ?? '') === '2', 'Retry-After default 2');
expect($acc('Boom'), 502, 'upstream 503', 'Serveur Riot indisponible.');
expect(req('GET', api($A, 'r=riot/summoner&platform=euw1&puuid=boom' . substr(PUUID, 4)), auth()), 502, 'upstream 500', 'Serveur Riot indisponible.');
expect(req('GET', api($C, 'r=riot/summoner&platform=euw1&puuid=' . PUUID)), 502, 'network error', 'Serveur Riot indisponible.');
expect(req('GET', api($C, 'r=riot/match&platform=euw1&id=EUW1_7000000001')), 502, 'network error match');

// ---------------------------------------------------------------- validation
$v = fn (string $q) => req('GET', api($A, $q), auth());
expect($v('r=riot/summoner&platform=xx1&puuid=' . PUUID), 400, 'bad platform');
expect($v('r=riot/summoner&puuid=' . PUUID), 400, 'missing platform');
expect($v('r=riot/summoner&platform[]=euw1&puuid=' . PUUID), 400, 'array platform');
expect($v('r=riot/summoner&platform=euw1&puuid=short'), 400, 'short puuid');
expect($v('r=riot/summoner&platform=euw1&puuid=' . rawurlencode('../../' . PUUID)), 400, 'traversal puuid');
expect($v('r=riot/league&platform=euw1&puuid=' . str_repeat('a', 101)), 400, 'long puuid');
expect($v('r=riot/match&platform=euw1&id=euw1_123'), 400, 'lowercase match id');
expect($v('r=riot/match&platform=euw1&id=' . rawurlencode('../config')), 400, 'traversal match id');
expect($v('r=riot/match&platform=euw1&id=EUW1_1234567890123456'), 400, 'match id too long');
expect($v('r=riot/match&platform=euw1'), 400, 'missing match id');
expect($v('r=riot/account&platform=euw1&gameName=x&tagLine=' . rawurlencode('#EUW')), 400, 'tagLine with #');
expect($v('r=riot/account&platform=euw1&gameName=x&tagLine=E'), 400, 'tagLine too short');
expect($v('r=riot/account&platform=euw1&gameName=x&tagLine=EUWEST'), 400, 'tagLine too long');
expect($v('r=riot/account&platform=euw1&gameName=x&tagLine=' . rawurlencode('EU/W')), 400, 'tagLine slash');
expect($v('r=riot/account&platform=euw1&gameName=&tagLine=EUW'), 400, 'empty gameName');
expect($v('r=riot/account&platform=euw1&gameName=' . rawurlencode(str_repeat('é', 33)) . '&tagLine=EUW'), 400, 'gameName 33 chars');
expect($v('r=riot/account&platform=euw1&gameName=' . rawurlencode(str_repeat('é', 32)) . '&tagLine=EUW'), 200, 'gameName 32 accented chars ok');
expect($v('r=riot/account&platform=euw1&gameName=a%0Ab&tagLine=EUW'), 400, 'gameName control char');
expect($v('r=riot/account&platform=euw1&gameName=%C3%28&tagLine=EUW'), 400, 'gameName invalid UTF-8');
expect($v('r=riot/masteries&platform=euw1&puuid=' . PUUID . '&count=0'), 400, 'masteries count 0');
expect($v('r=riot/masteries&platform=euw1&puuid=' . PUUID . '&count=101'), 400, 'masteries count 101');
expect($v('r=riot/match-ids&platform=euw1&puuid=' . PUUID . '&count=abc'), 400, 'match-ids count abc');
expect($v('r=riot/match-ids&platform=euw1&puuid=' . PUUID . '&queue=-1'), 400, 'match-ids negative queue');
expect($v('r=riot/match-ids&platform=euw1&puuid=' . PUUID . '&queue=4%2020'), 400, 'match-ids queue injection');
expect($v('r=riot/unknown&platform=euw1'), 404, 'unknown riot route');
expect(req('PUT', api($A, 'r=riot/summoner&platform=euw1&puuid=' . PUUID), auth(), '{}'), 405, 'riot PUT -> 405');

// ---------------------------------------------------------------- no key
$noKey = 'Clé API Riot non configurée.';
expect(req('GET', api($B, 'r=riot/summoner&platform=euw1&puuid=' . PUUID)), 400, 'no key summoner', $noKey);
expect(req('GET', api($B, 'r=riot/account&platform=euw1&gameName=x&tagLine=EUW')), 400, 'no key account', $noKey);
expect(req('GET', api($B, 'r=riot/match&platform=euw1&id=EUW1_7000000001')), 400, 'no key match', $noKey);

// ---------------------------------------------------------------- direct file access
foreach (['lib/http.php', 'lib/storage.php', 'lib/riot.php', 'lib/config.php'] as $f) {
    $r = req('GET', "$A/api/$f");
    check($r['status'] === 403 && !str_contains($r['body'], '<?php') && $r['body'] === '', "direct /api/$f -> 403, no source", "got {$r['status']} " . substr($r['body'], 0, 80));
}
$r = req('GET', "$A/api/config.php");
check(!str_contains($r['body'], KEY) && !str_contains($r['body'], PW) && !str_contains($r['body'], '<?php'), 'config.php source/secret not exposed');
$r = req('GET', "$A/api/config.example.php");
check(!str_contains($r['body'], '<?php'), 'config.example.php source not exposed');
$r = req('GET', "$A/lolhelper-data/teams.json");
check($r['status'] === 404, 'default data dir is outside the web root', "got {$r['status']}");
$r = req('GET', "$A/../data/teams.json");
check(!str_contains($r['body'], 'Deux'), 'no data via ../');

echo "PHP API tests: $passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
