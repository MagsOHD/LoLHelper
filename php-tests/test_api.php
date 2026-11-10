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

// ---------------------------------------------------------------- drafts collection
$r = req('GET', api($A, 'r=store/drafts'), auth());
expect($r, 200, 'drafts empty');
check($r['json'] === [], 'drafts empty -> []');
expect(req('GET', api($A, 'r=store/drafts')), 401, 'drafts without password', $MSG_401);
$draft = '{"source":"manual","allies":[{"player_id":"p-1","champion":"Ahri","locked":false}],"enemies":[],"bans":{"allies":[],"enemies":[]}}';
$r = req('PUT', api($A, 'r=store/drafts/team-t-2'), auth(), $draft);
expect($r, 200, 'PUT draft');
check($r['json']['id'] === 'team-t-2' && $r['json']['allies'][0]['champion'] === 'Ahri', 'draft stored', $r['body']);
$r = req('PUT', api($A, 'r=store/drafts/team-t-2'), auth(), '{"source":"manual","allies":[],"enemies":[]}');
expect($r, 200, 'PUT draft upsert');
$r = req('GET', api($A, 'r=store/drafts'), auth());
check(count($r['json']) === 1 && $r['json'][0]['allies'] === [], 'draft upserted', $r['body']);
expect(req('PUT', api($A, 'r=store/drafts/bad_id'), auth(), '{}'), 400, 'draft invalid id');
$r = req('DELETE', api($A, 'r=store/drafts/team-t-2'), auth());
check($r['status'] === 204, 'DELETE draft -> 204');
check(req('GET', api($A, 'r=store/drafts'), auth())['json'] === [], 'drafts empty after delete');
check(is_file("$T/a/data/drafts.json"), 'drafts stored in data_dir');

// ---------------------------------------------------------------- live draft (companion)
const PUUID2 = 'Qa1Wb2Ec3Rd4Tf5Yg6Uh7Ij8Ok9Pl0Am1Sn2Do3Fp4Gq5Hr6Js7Kt8Lu9Mv0Nw1Bx2Vy3Cz4Xa5Zb6';
const MSG_LIVE_INVALID = 'Données du compagnon invalides : ';
$liveFile = "$T/a/data/live.json";

function companion(array $over = []): array
{
    return array_replace([
        'version' => 1,
        'puuid' => PUUID,
        'phase' => 'ban_pick',
        'queue_id' => 420,
        'local_cell' => 2,
        'my_team' => [
            ['cell' => 0, 'puuid' => '', 'champion_key' => 0, 'intent_key' => 0, 'position' => 'top'],
            ['cell' => 1, 'puuid' => PUUID2, 'champion_key' => 64, 'intent_key' => 0, 'position' => 'jungle'],
            ['cell' => 2, 'puuid' => PUUID, 'champion_key' => 0, 'intent_key' => 103, 'position' => 'middle'],
            ['cell' => 3, 'puuid' => '', 'champion_key' => 2000, 'intent_key' => 0, 'position' => 'bottom'],
            ['cell' => 4, 'puuid' => '', 'champion_key' => 0, 'intent_key' => 0, 'position' => ''],
        ],
        'their_team' => [
            ['cell' => 5, 'champion_key' => 238],
            ['cell' => 6, 'champion_key' => 0],
        ],
        'bans' => ['mine' => [55, 0], 'theirs' => [238]],
        'actions' => [
            ['type' => 'ban', 'champion_key' => 55, 'completed' => true, 'ally' => true, 'cell' => 0, 'in_progress' => false],
            ['type' => 'pick', 'champion_key' => 103, 'completed' => false, 'ally' => true, 'cell' => 2, 'in_progress' => true],
        ],
        'timer_remaining_ms' => 21000,
        'sent_at' => '2026-11-10T20:00:00Z',
    ], $over);
}

function push(string $base, array $payload, ?array $headers = null): array
{
    return req('PUT', api($base, 'r=live-draft'), $headers ?? auth(['Content-Type' => 'application/json']), json_encode($payload));
}

/** Modifie live.json sous le verrou de la collection. */
function live_file_edit(string $file, callable $fn): void
{
    $lock = fopen(dirname($file) . '/live.lock', 'c');
    flock($lock, LOCK_EX);
    $docs = json_decode((string) file_get_contents($file), true);
    file_put_contents($file, json_encode($fn($docs), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    flock($lock, LOCK_UN);
    fclose($lock);
}

function iso_ago(int $seconds): string
{
    return gmdate('Y-m-d\TH:i:s', time() - $seconds) . '.000Z';
}

function set_received(string $file, string $docId, string $at): void
{
    live_file_edit($file, function (array $docs) use ($docId, $at): array {
        foreach ($docs as &$d) {
            if ($d['id'] === $docId) {
                $d['received_at'] = $at;
            }
        }
        return $docs;
    });
}

// internal collection never reachable through store/…
foreach (['GET' => 'r=store/live', 'PUT' => 'r=store/live/live-p-1', 'DELETE' => 'r=store/live/live-p-1'] as $m => $q) {
    expect(req($m, api($A, $q), auth(), $m === 'PUT' ? '{}' : null), 404, "store/live $m -> 404", 'Collection inconnue.');
}
expect(req('GET', api($A, 'r=store/live/x'), auth()), 404, 'store/live GET doc -> 404');

expect(push($A, companion(), []), 401, 'live PUT without password', $MSG_401);
expect(push($A, companion(), ['X-App-Password' => 'nope']), 401, 'live PUT wrong password', $MSG_401);
expect(req('GET', api($A, 'r=live-draft&players=p-1')), 401, 'live GET without password', $MSG_401);
expect(req('POST', api($A, 'r=live-draft'), auth(), '{}'), 405, 'live POST -> 405');
expect(req('DELETE', api($A, 'r=live-draft'), auth()), 405, 'live DELETE -> 405');

$MSG_UNKNOWN = "Ce compte Riot n'est pas dans la liste des joueurs du site.";
expect(push($A, companion()), 404, 'live unknown puuid (no players)', $MSG_UNKNOWN);
expect(req('PUT', api($A, 'r=store/players/p-1'), auth(), json_encode(['game_name' => 'Un', 'puuid' => PUUID])), 200, 'player p-1');
expect(req('PUT', api($A, 'r=store/players/p-2'), auth(), json_encode(['game_name' => 'Deux', 'puuid' => PUUID2])), 200, 'player p-2');
expect(req('PUT', api($A, 'r=store/players/p-3'), auth(), json_encode(['game_name' => 'Trois', 'puuid' => null])), 200, 'player p-3');
expect(push($A, companion(['puuid' => strrev(PUUID)])), 404, 'live unknown puuid', $MSG_UNKNOWN);
check(!is_file($liveFile) || !str_contains((string) file_get_contents($liveFile), strrev(PUUID)), 'unknown puuid not stored');

@unlink($FAKE_LOG);
$extra = companion([
    'their_team' => [['cell' => 5, 'champion_key' => 238, 'puuid' => PUUID2, 'summonerName' => 'Ennemi', 'gameName' => 'Spy']],
    'evil' => str_repeat('x', 1000),
]);
$r = push($A, $extra);
expect($r, 200, 'live PUT valid');
check($r['json'] === ['ok' => true, 'player_id' => 'p-1'], 'live PUT response', $r['body']);
check(fake_log() === [], 'live PUT makes no Riot call');
check(is_file($liveFile) && glob("$T/a/data/*.tmp-*") === [], 'live stored in data_dir, no temp files');
$stored = (string) @file_get_contents($liveFile);
check(!str_contains($stored, 'Ennemi') && !str_contains($stored, 'Spy') && !str_contains($stored, 'evil'), 'unknown fields dropped (no enemy identity)', $stored);

$r = req('GET', api($A, 'r=live-draft&players=p-1'), auth());
expect($r, 200, 'live GET');
$live = $r['json']['live'] ?? null;
check(is_array($live) && $live['player_id'] === 'p-1' && $live['phase'] === 'ban_pick' && $live['puuid'] === PUUID, 'live GET doc', $r['body']);
check(is_array($live) && !array_key_exists('id', $live), 'live GET hides internal id');
check(preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/', $live['received_at'] ?? '') === 1
    && abs(strtotime($live['received_at']) - time()) < 30, 'received_at = server time ISO', $live['received_at'] ?? '');
check(($live['their_team'] ?? null) === [['cell' => 5, 'champion_key' => 238]], 'their_team canonical', json_encode($live['their_team'] ?? null));
check(($live['my_team'][3]['champion_key'] ?? null) === 2000 && ($live['my_team'][4]['position'] ?? null) === '', 'my_team kept');
check(($live['bans'] ?? null) === ['mine' => [55, 0], 'theirs' => [238]] && count($live['actions'] ?? []) === 2, 'bans/actions kept');
check(($live['timer_remaining_ms'] ?? null) === 21000 && ($live['sent_at'] ?? null) === '2026-11-10T20:00:00Z' && ($live['queue_id'] ?? null) === 420, 'scalars kept');

// strict validation
$team6 = array_fill(0, 6, ['cell' => 0, 'champion_key' => 0]);
$action = ['type' => 'pick', 'champion_key' => 1, 'completed' => false, 'ally' => true, 'cell' => 0, 'in_progress' => false];
$slot = fn (array $o) => [array_replace(['cell' => 0, 'puuid' => '', 'champion_key' => 0, 'intent_key' => 0, 'position' => 'top'], $o)];
$bad = [
    'version 2' => companion(['version' => 2]),
    'version string' => companion(['version' => '1']),
    'puuid short' => companion(['puuid' => 'abc']),
    'puuid traversal' => companion(['puuid' => '../' . substr(PUUID, 3)]),
    'puuid int' => companion(['puuid' => 12]),
    'phase unknown' => companion(['phase' => 'ChampSelect']),
    'queue_id string' => companion(['queue_id' => '420']),
    'local_cell 10' => companion(['local_cell' => 10]),
    'my_team object' => companion(['my_team' => ['a' => 1]]),
    'my_team 6' => companion(['my_team' => $team6]),
    'my_team item string' => companion(['my_team' => ['x']]),
    'my_team cell missing' => companion(['my_team' => [['champion_key' => 1]]]),
    'champion_key 2001' => companion(['my_team' => $slot(['champion_key' => 2001])]),
    'champion_key -1' => companion(['my_team' => $slot(['champion_key' => -1])]),
    'champion_key float' => companion(['my_team' => $slot(['champion_key' => 103.5])]),
    'champion_key string' => companion(['my_team' => $slot(['champion_key' => '103'])]),
    'intent_key 9999' => companion(['my_team' => $slot(['intent_key' => 9999])]),
    'position mid' => companion(['my_team' => $slot(['position' => 'mid'])]),
    'ally puuid bad' => companion(['my_team' => $slot(['puuid' => 'x/y'])]),
    'their_team 6' => companion(['their_team' => $team6]),
    'their_team key bool' => companion(['their_team' => [['cell' => 5, 'champion_key' => true]]]),
    'bans list' => companion(['bans' => [1, 2]]),
    'bans mine 6' => companion(['bans' => ['mine' => [1, 2, 3, 4, 5, 6], 'theirs' => []]]),
    'bans theirs bad key' => companion(['bans' => ['mine' => [], 'theirs' => [3000]]]),
    'actions 31' => companion(['actions' => array_fill(0, 31, $action)]),
    'action type' => companion(['actions' => [array_replace($action, ['type' => 'swap'])]]),
    'action completed string' => companion(['actions' => [array_replace($action, ['completed' => 'true'])]]),
    'action ally missing' => companion(['actions' => [array_diff_key($action, ['ally' => 1])]]),
    'timer string' => companion(['timer_remaining_ms' => '21000']),
    'timer huge' => companion(['timer_remaining_ms' => 1e12]),
    'sent_at format' => companion(['sent_at' => 'hier soir']),
    'sent_at long' => companion(['sent_at' => '2026-11-10T20:00:00.' . str_repeat('1', 100) . 'Z']),
];
$missing = companion();
unset($missing['phase']);
$bad['phase missing'] = $missing;
foreach ($bad as $label => $p) {
    $r = push($A, $p);
    expect($r, 400, "live invalid: $label");
    check(str_starts_with($r['json']['detail'] ?? '', MSG_LIVE_INVALID), "live invalid: $label detail", $r['body']);
}
expect(req('PUT', api($A, 'r=live-draft'), auth(), '[1]'), 400, 'live array body');
expect(req('PUT', api($A, 'r=live-draft'), auth(), '{oops'), 400, 'live invalid JSON');
expect(req('PUT', api($A, 'r=live-draft'), auth(), '{"version":1,"puuid":"' . PUUID . '","phase":"none","x":"' . str_repeat('a', 262144) . '"}'), 413, 'live oversized body');
$r = req('GET', api($A, 'r=live-draft&players=p-1'), auth());
check(($r['json']['live']['phase'] ?? '') === 'ban_pick', 'invalid pushes did not overwrite');

// players filter / freshness window (15 min, server time)
expect(req('GET', api($A, 'r=live-draft'), auth()), 400, 'live GET no players');
expect(req('GET', api($A, 'r=live-draft&players='), auth()), 400, 'live GET empty players');
expect(req('GET', api($A, 'r=live-draft&players=a,b,c,d,e,f'), auth()), 400, 'live GET 6 players');
expect(req('GET', api($A, 'r=live-draft&players=p-1,bad_id'), auth()), 400, 'live GET bad id');
expect(req('GET', api($A, 'r=live-draft&players=p-1,'), auth()), 400, 'live GET trailing comma');
expect(req('GET', api($A, 'r=live-draft&players[]=p-1'), auth()), 400, 'live GET array param');
$r = req('GET', api($A, 'r=live-draft&players=a,b,c,d,p-1'), auth());
check(($r['json']['live']['player_id'] ?? '') === 'p-1', 'live GET 5 ids ok');
$r = req('GET', api($A, 'r=live-draft&players=p-2,p-3'), auth());
expect($r, 200, 'live GET other players');
check($r['json'] === ['live' => null], 'live GET none for other players', $r['body']);

// minimal payload, phase "none" accepted (defaults filled)
$r = push($A, ['version' => 1, 'puuid' => PUUID2, 'phase' => 'none', 'queue_id' => null, 'bans' => null]);
expect($r, 200, 'live PUT minimal phase none');
check(($r['json']['player_id'] ?? '') === 'p-2', 'minimal -> p-2');
$r = req('GET', api($A, 'r=live-draft&players=p-2'), auth());
$l2 = $r['json']['live'] ?? [];
check(($l2['phase'] ?? '') === 'none' && $l2['my_team'] === [] && $l2['bans'] === ['mine' => [], 'theirs' => []]
    && $l2['queue_id'] === null && $l2['timer_remaining_ms'] === null, 'minimal defaults', $r['body']);
check(str_contains($r['body'], '"bans":{"mine":[],"theirs":[]}') && str_contains($r['body'], '"my_team":[]'), 'empty lists/objects JSON shape', $r['body']);
$r = push($A, companion(['puuid' => PUUID2, 'timer_remaining_ms' => -150.4, 'local_cell' => -1]));
check($r['status'] === 200, 'negative timer / local_cell -1 accepted', $r['body']);
check((req('GET', api($A, 'r=live-draft&players=p-2'), auth())['json']['live']['timer_remaining_ms'] ?? null) === 0, 'negative timer clamped to 0');

set_received($liveFile, 'live-p-1', iso_ago(60));
set_received($liveFile, 'live-p-2', iso_ago(120));
$r = req('GET', api($A, 'r=live-draft&players=p-2,p-1'), auth());
check(($r['json']['live']['player_id'] ?? '') === 'p-1', 'most recent of several', $r['body']);
set_received($liveFile, 'live-p-1', iso_ago(16 * 60));
$r = req('GET', api($A, 'r=live-draft&players=p-1'), auth());
check($r['json'] === ['live' => null], 'stale (16 min) -> null', $r['body']);
$r = req('GET', api($A, 'r=live-draft&players=p-1,p-2'), auth());
check(($r['json']['live']['player_id'] ?? '') === 'p-2', 'stale ignored, fresh one returned');
set_received($liveFile, 'live-p-2', iso_ago(14 * 60));
$r = req('GET', api($A, 'r=live-draft&players=p-1,p-2'), auth());
check(($r['json']['live']['player_id'] ?? '') === 'p-2', '14 min still fresh');
set_received($liveFile, 'live-p-2', gmdate('Y-m-d\TH:i:s', time() + 3600) . '.000Z');
check(req('GET', api($A, 'r=live-draft&players=p-2'), auth())['json'] === ['live' => null], 'future received_at ignored');
expect(push($A, companion()), 200, 'live re-push refreshes');
$r = req('GET', api($A, 'r=live-draft&players=p-1'), auth());
check(($r['json']['live']['phase'] ?? '') === 'ban_pick', 're-push fresh again');
expect(push($A, companion(['phase' => 'none', 'my_team' => [], 'their_team' => [], 'actions' => []])), 200, 'live push phase none');
$r = req('GET', api($A, 'r=live-draft&players=p-1'), auth());
check(($r['json']['live']['phase'] ?? '') === 'none', 'phase none stored and returned');
$docs = json_decode((string) file_get_contents($liveFile), true);
check(array_column($docs, 'id') === ['live-p-1', 'live-p-2'], 'one live doc per player', json_encode(array_column($docs, 'id')));

// no password configured (B): open, default data dir
expect(req('PUT', api($B, 'r=store/players/b-1'), [], json_encode(['puuid' => PUUID])), 200, 'B player');
expect(push($B, companion(), []), 200, 'B live PUT open');
check(is_file("$T/b/lolhelper-data/live.json"), 'B live in default data dir');

// ---------------------------------------------------------------- spectator (riot/active-game)
@unlink($FAKE_LOG);
$r = req('GET', api($A, 'r=riot/active-game&platform=euw1&puuid=' . PUUID), auth());
expect($r, 200, 'active-game 200');
check(($r['json']['gameId'] ?? 0) === 7123456789 && ($r['json']['participants'][0]['puuid'] ?? '') === PUUID, 'active-game body passthrough', $r['body']);
check(($r['json']['_host'] ?? '') === 'euw1', 'active-game uses platform host');
check(in_array('/euw1/lol/spectator/v5/active-games/by-summoner/' . PUUID, fake_log(), true), 'active-game upstream path', implode(' | ', fake_log()));
check(($r['headers']['cache-control'] ?? '') === 'no-store' && !isset($r['headers']['x-cache']), 'active-game not cacheable');
req('GET', api($A, 'r=riot/active-game&platform=euw1&puuid=' . PUUID), auth());
check(count(fake_log()) === 2, 'active-game not cached (2 upstream calls)');
check(!is_dir("$T/a/data/active-games") && glob("$T/a/data/*game*") === [], 'nothing written to disk');
$r = req('GET', api($A, 'r=riot/active-game&platform=kr&puuid=' . PUUID), auth());
check(($r['json']['_host'] ?? '') === 'kr', 'active-game kr host');
$spec = fn (string $prefix) => req('GET', api($A, 'r=riot/active-game&platform=euw1&puuid=' . $prefix . substr(PUUID, strlen($prefix))), auth());
expect($spec('missing'), 404, 'active-game 404', 'Aucune partie en cours pour ce joueur.');
$r = $spec('limited');
expect($r, 429, 'active-game 429', 'Limite de requêtes Riot atteinte, réessaie dans quelques secondes.');
check(($r['headers']['retry-after'] ?? '') === '5', 'active-game Retry-After copied');
expect($spec('badkey'), 502, 'active-game 401 -> 502', $msgAuth);
expect($spec('boom'), 502, 'active-game 500 -> 502', 'Serveur Riot indisponible.');
expect(req('GET', api($A, 'r=riot/active-game&platform=euw1&puuid=' . PUUID)), 401, 'active-game without password', $MSG_401);
expect(req('GET', api($A, 'r=riot/active-game&platform=euw1&puuid=short'), auth()), 400, 'active-game bad puuid', 'PUUID invalide.');
expect(req('GET', api($A, 'r=riot/active-game&platform=europe&puuid=' . PUUID), auth()), 400, 'active-game bad platform');
expect(req('GET', api($B, 'r=riot/active-game&platform=euw1&puuid=' . PUUID)), 400, 'active-game no key', $noKey);
expect(req('GET', api($C, 'r=riot/active-game&platform=euw1&puuid=' . PUUID)), 502, 'active-game network error');
expect(req('PUT', api($A, 'r=riot/active-game&platform=euw1&puuid=' . PUUID), auth(), '{}'), 405, 'active-game PUT -> 405');

// ---------------------------------------------------------------- direct file access
foreach (['lib/http.php', 'lib/storage.php', 'lib/riot.php', 'lib/config.php', 'lib/live.php'] as $f) {
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
