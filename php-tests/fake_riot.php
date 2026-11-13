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

// FAKE_CTRL (fichier JSON écrit par les tests), lu à chaque requête :
//   {"challenger":"b", "match_429":"<id>", "ids_429":"<puuid>", "retry_after":"1",
//    "app_limit":"20:1,100:120", "app_count":"3:1,41:120", "app_count_left":1, "app_count_host":"europe",
//    "tournaments_status":503}
$ctrlFile = getenv('FAKE_CTRL');
$ctrl = (is_string($ctrlFile) && is_file($ctrlFile)) ? (json_decode((string) file_get_contents($ctrlFile), true) ?: []) : [];

/**
 * En-têtes de limites Riot émis sur toutes les réponses. Compte par défaut 1:1,1:120 ; « app_count »
 * le remplace (pour l'hôte « app_count_host » s'il est donné), « app_count_left » réponses durant si présent.
 */
function rate_headers(string $host): array
{
    global $ctrl, $ctrlFile;
    $count = '1:1,1:120';
    $forHost = !isset($ctrl['app_count_host']) || $ctrl['app_count_host'] === $host;
    if (isset($ctrl['app_count']) && $forHost) {
        if (!isset($ctrl['app_count_left'])) {
            $count = $ctrl['app_count'];
        } elseif ($ctrl['app_count_left'] > 0) {
            $count = $ctrl['app_count'];
            $ctrl['app_count_left']--;
            file_put_contents($ctrlFile, json_encode($ctrl), LOCK_EX);
        }
    }
    return [
        'X-App-Rate-Limit' => $ctrl['app_limit'] ?? '20:1,100:120',
        'X-App-Rate-Limit-Count' => $count,
        'X-Method-Rate-Limit' => '2000:10',
        'X-Method-Rate-Limit-Count' => '1:10',
    ];
}

function out(int $status, string $body, array $headers = []): void
{
    global $host;
    http_response_code($status);
    header('Content-Type: application/json;charset=utf-8');
    foreach (rate_headers((string) $host) + $headers as $k => $v) {
        header("$k: $v");
    }
    echo $body;
}

$path = parse_url($uri, PHP_URL_PATH);
$segments = explode('/', ltrim($path, '/'));
$host = array_shift($segments);
$rest = '/' . implode('/', $segments);

if ($token !== $expectedKey) {
    out(401, '{"status":{"message":"Unauthorized","status_code":401}}');
    return true;
}

// Erreurs à la demande, déclenchées par la valeur du dernier segment décodé.
$last = rawurldecode((string) end($segments));
$special = [
    'Missing' => [404, [], '{"status":{"status_code":404}}'],
    'BadKey' => [401, [], '{"status":{"status_code":401}}'],
    'Forbid' => [403, [], '{"status":{"status_code":403}}'],
    'Limited' => [429, ['Retry-After' => '7'], '{"status":{"status_code":429}}'],
    'LimitedNoRA' => [429, [], '{"status":{"status_code":429}}'],
    'LimitedApp' => [429, ['Retry-After' => '5', 'X-Rate-Limit-Type' => 'application'], '{"status":{"status_code":429}}'],
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

// Spectator-v5 : préfixe du puuid -> erreur (missing 404, limited 429, badkey 401, boom 500).
if (preg_match('#^/lol/spectator/v5/active-games/by-summoner/([^/]+)$#', $rest, $m)) {
    $puuid = rawurldecode($m[1]);
    $errors = [
        'missing' => [404, [], '{"status":{"message":"Data not found","status_code":404}}'],
        'limited' => [429, ['Retry-After' => '5'], '{"status":{"status_code":429}}'],
        'badkey' => [401, [], '{"status":{"status_code":401}}'],
        'boom' => [500, [], 'err'],
    ];
    foreach ($errors as $prefix => [$s, $h, $b]) {
        if (str_starts_with($puuid, $prefix)) {
            out($s, $b, $h);
            return true;
        }
    }
    $game = json_decode(file_get_contents("$fixtures/active_game.json"), true);
    $game['_host'] = $host;
    $game['participants'][0]['puuid'] = $puuid;
    out(200, json_encode($game, JSON_UNESCAPED_UNICODE));
    return true;
}

// ---- Clash-v1 (hôte de la plateforme).
if (preg_match('#^/lol/clash/v1/players/by-puuid/([^/]+)$#', $rest, $m)) {
    $puuid = rawurldecode($m[1]);
    $errors = [
        'missing' => [404, [], '{"status":{"status_code":404}}'],
        'limited' => [429, ['Retry-After' => '5'], '{"status":{"status_code":429}}'],
        'badkey' => [403, [], '{"status":{"status_code":403}}'],
        'boom' => [500, [], 'err'],
    ];
    foreach ($errors as $prefix => [$s, $h, $b]) {
        if (str_starts_with($puuid, $prefix)) {
            out($s, $b, $h);
            return true;
        }
    }
    if (str_starts_with($puuid, 'nobody')) {
        out(200, '[]');
        return true;
    }
    $players = json_decode(file_get_contents("$fixtures/clash_player.json"), true);
    $players[0]['puuid'] = $puuid;
    $players[0]['_host'] = $host;
    out(200, json_encode($players, JSON_UNESCAPED_UNICODE));
    return true;
}

if (preg_match('#^/lol/clash/v1/(teams|tournaments/by-team)/([^/]+)$#', $rest, $m)) {
    $teamId = rawurldecode($m[2]);
    if (isset($special[$teamId])) {
        [$s, $h, $b] = $special[$teamId];
        out($s, $b, $h);
        return true;
    }
    if ($m[1] === 'teams') {
        $doc = json_decode(file_get_contents("$fixtures/clash_team.json"), true);
        $doc['id'] = $teamId;
    } else {
        $doc = json_decode(file_get_contents("$fixtures/clash_tournaments.json"), true)[0];
        $doc['_team'] = $teamId;
    }
    $doc['_host'] = $host;
    out(200, json_encode($doc, JSON_UNESCAPED_UNICODE));
    return true;
}

if ($rest === '/lol/clash/v1/tournaments') {
    $st = $ctrl['tournaments_status'] ?? 200;
    if ($st !== 200) {
        out((int) $st, '{"status":{"status_code":' . (int) $st . '}}', $st === 429 ? ['Retry-After' => '4'] : []);
        return true;
    }
    $list = json_decode(file_get_contents("$fixtures/clash_tournaments.json"), true);
    $list[0]['_host'] = $host;
    out(200, json_encode($list, JSON_UNESCAPED_UNICODE));
    return true;
}

// ---- Match-v5 timeline (hôte de la région).
if (preg_match('#^/lol/match/v5/matches/([A-Z0-9_]+)/timeline$#', $rest, $m)) {
    $id = $m[1];
    if ($id === 'EUW1_7000000001') {
        out(200, file_get_contents("$fixtures/timeline_EUW1_7000000001.json"));
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

// ---- Collecteur méta : ligues apex + parties classées décrites dans fixtures/meta_matches.json.

if (preg_match('#^/lol/league/v4/(challenger|grandmaster|master)leagues/by-queue/RANKED_SOLO_5x5$#', $rest, $m)) {
    $file = "$fixtures/meta_league_{$m[1]}" . ($m[1] === 'challenger' && ($ctrl['challenger'] ?? '') === 'b' ? '_b' : '') . '.json';
    is_file($file) ? out(200, file_get_contents($file)) : out(404, '{}');
    return true;
}

$meta = json_decode(file_get_contents("$fixtures/meta_matches.json"), true);

if (preg_match('#^/lol/match/v5/matches/by-puuid/(meta-player-[^/]+)/ids$#', $rest, $m)) {
    parse_str((string) parse_url($uri, PHP_URL_QUERY), $q);
    $windowStart = time() - 3 * 86400;
    $okQuery = ($q['queue'] ?? '') === '420' && ($q['type'] ?? '') === 'ranked' && ($q['count'] ?? '') === '20'
        && ctype_digit($q['startTime'] ?? 'x') && abs((int) $q['startTime'] - $windowStart) < 120;
    if (!$okQuery) {
        out(400, '{"status":{"message":"bad ids query"}}');
        return true;
    }
    if (($ctrl['ids_429'] ?? '') === $m[1]) {
        out(429, '{}', ['Retry-After' => (string) ($ctrl['retry_after'] ?? '1')]);
        return true;
    }
    out(200, json_encode($meta['players'][$m[1]] ?? []));
    return true;
}

if (preg_match('#^/lol/match/v5/matches/(EUW1_80[0-9]+)$#', $rest, $m)) {
    $id = $m[1];
    if (($ctrl['match_429'] ?? '') === $id) {
        out(429, '{}', ['Retry-After' => (string) ($ctrl['retry_after'] ?? '1')]);
        return true;
    }
    $spec = $meta['matches'][$id] ?? null;
    if ($spec === null) {
        out(404, '{"status":{"status_code":404}}');
        return true;
    }
    if (isset($spec['raw'])) {
        out(200, json_encode($spec['raw']));
        return true;
    }
    $participants = [];
    $puuids = [];
    foreach ([100 => $spec['blue'], 200 => $spec['red']] as $team => $list) {
        foreach ($list as $i => [$champ, $pos]) {
            $puuid = "fake-$id-$team-$i";
            $puuids[] = $puuid;
            $participants[] = [
                'puuid' => $puuid, 'championId' => $champ, 'championName' => "C$champ",
                'teamPosition' => $pos, 'individualPosition' => $pos, 'teamId' => $team,
                'win' => $spec['win'] === $team, 'kills' => 1, 'deaths' => 1, 'assists' => 1,
                'gameEndedInEarlySurrender' => $spec['dur'] < 300,
            ];
        }
    }
    $teams = [];
    foreach ([100, 200] as $team) {
        $bans = [];
        foreach ($spec['bans'][(string) $team] ?? [] as $i => $c) {
            $bans[] = ['championId' => $c, 'pickTurn' => $i + 1];
        }
        $teams[] = ['teamId' => $team, 'win' => $spec['win'] === $team, 'bans' => $bans];
    }
    out(200, json_encode([
        'metadata' => ['dataVersion' => '2', 'matchId' => $id, 'participants' => $puuids],
        'info' => [
            'gameCreation' => 1760000000000, 'gameDuration' => $spec['dur'], 'gameEndTimestamp' => 1760000000000 + $spec['dur'] * 1000,
            'gameVersion' => $spec['v'], 'queueId' => $spec['q'], 'mapId' => 11, 'platformId' => 'EUW1',
            'participants' => $participants, 'teams' => $teams,
        ],
    ]));
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
