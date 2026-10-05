<?php
// Faux serveur Riot pour les tests (routeur `php -S`). URL : /<hôte>/<chemin Riot>.
declare(strict_types=1);

$fixtures = __DIR__ . '/fixtures';
$log = getenv('FAKE_LOG');
$expectedKey = getenv('FAKE_KEY');
$uri = $_SERVER['REQUEST_URI'];
$token = $_SERVER['HTTP_X_RIOT_TOKEN'] ?? '';
if (is_string($log) && $log !== '') {
    file_put_contents($log, $uri . "\n", FILE_APPEND | LOCK_EX);
}

function out(int $status, string $body, array $headers = []): void
{
    http_response_code($status);
    header('Content-Type: application/json;charset=utf-8');
    foreach ($headers as $k => $v) {
        header("$k: $v");
    }
    echo $body;
}

if ($token !== $expectedKey) {
    out(401, '{"status":{"message":"Unauthorized","status_code":401}}');
    return true;
}

$path = parse_url($uri, PHP_URL_PATH);
$segments = explode('/', ltrim($path, '/'));
$host = array_shift($segments);
$rest = '/' . implode('/', $segments);

// Erreurs à la demande, déclenchées par la valeur du dernier segment décodé.
$last = rawurldecode((string) end($segments));
$special = [
    'Missing' => [404, [], '{"status":{"status_code":404}}'],
    'BadKey' => [401, [], '{"status":{"status_code":401}}'],
    'Forbid' => [403, [], '{"status":{"status_code":403}}'],
    'Limited' => [429, ['Retry-After' => '7'], '{"status":{"status_code":429}}'],
    'LimitedNoRA' => [429, [], '{"status":{"status_code":429}}'],
    'Boom' => [503, [], 'oops'],
];

if (preg_match('#^/riot/account/v1/accounts/by-riot-id/([^/]+)/([^/]+)$#', $rest, $m)) {
    $gameName = rawurldecode($m[1]);
    $tagLine = rawurldecode($m[2]);
    if (isset($special[$gameName])) {
        [$s, $h, $b] = $special[$gameName];
        out($s, $b, $h);
        return true;
    }
    $acc = json_decode(file_get_contents("$fixtures/account.json"), true);
    $acc['gameName'] = $gameName;
    $acc['tagLine'] = $tagLine;
    $acc['_host'] = $host;
    out(200, json_encode($acc, JSON_UNESCAPED_UNICODE));
    return true;
}

if (preg_match('#^/lol/(summoner/v4/summoners|league/v4/entries)/by-puuid/([^/]+)$#', $rest, $m)) {
    $puuid = $m[2];
    if (str_starts_with($puuid, 'missing')) {
        out(404, '{}');
        return true;
    }
    if (str_starts_with($puuid, 'boom')) {
        out(500, 'err');
        return true;
    }
    out(200, file_get_contents($fixtures . ($m[1] === 'league/v4/entries' ? '/league_entries.json' : '/summoner.json')));
    return true;
}

if (preg_match('#^/lol/champion-mastery/v4/champion-masteries/by-puuid/([^/]+)/top$#', $rest)) {
    out(200, file_get_contents("$fixtures/masteries.json"));
    return true;
}

if (preg_match('#^/lol/match/v5/matches/by-puuid/([^/]+)/ids$#', $rest)) {
    out(200, file_get_contents("$fixtures/match_ids.json"));
    return true;
}

if (preg_match('#^/lol/match/v5/matches/([A-Z0-9_]+)$#', $rest, $m)) {
    $id = $m[1];
    if ($id === 'EUW1_7000000001') {
        out(200, file_get_contents("$fixtures/match_EUW1_7000000001.json"));
    } elseif ($id === 'EUW1_429') {
        out(429, '{}', ['Retry-After' => '3']);
    } elseif ($id === 'EUW1_401') {
        out(401, '{}');
    } elseif ($id === 'EUW1_500') {
        out(500, '{}');
    } else {
        out(404, '{"status":{"status_code":404}}');
    }
    return true;
}

out(400, '{"status":{"message":"unknown fake route"}}');
return true;
