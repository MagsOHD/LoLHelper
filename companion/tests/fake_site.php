<?php
// Faux site LoLHelper pour les tests du compagnon (routeur `php -S`).
// Variables d'environnement : FAKE_SITE_DIR (journal puts.jsonl + requests.jsonl),
// FAKE_SITE_PASSWORD, FAKE_SITE_PUUIDS (puuids connus, séparés par des virgules).
// Reproduit le contrat de la route PUT r=live-draft (validation stricte du CompanionPayload).
declare(strict_types=1);

$dir = getenv('FAKE_SITE_DIR') ?: sys_get_temp_dir();
$password = (string) getenv('FAKE_SITE_PASSWORD');
$known = array_filter(explode(',', (string) getenv('FAKE_SITE_PUUIDS')));

function out(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$route = $_GET['r'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
file_put_contents($dir . '/requests.jsonl', json_encode(['method' => $method, 'path' => $path, 'r' => $route]) . "\n", FILE_APPEND);

if ($path !== '/api/index.php') {
    out(404, ['detail' => 'Introuvable.']);
    return true;
}
if ($route === 'meta') {
    out(200, ['riot_configured' => true, 'password_required' => $password !== '', 'storage_ok' => true]);
    return true;
}
// Comme l'API réelle : « b64:<UTF-8> » ou forme brute.
$given = (string) ($_SERVER['HTTP_X_APP_PASSWORD'] ?? '');
if (str_starts_with($given, 'b64:')) {
    $given = (string) base64_decode(substr($given, 4), true);
}
if ($password !== '' && !hash_equals($password, trim($given))) {
    out(401, ['detail' => 'Mot de passe requis ou incorrect.']);
    return true;
}
if ($route !== 'live-draft') {
    out(404, ['detail' => 'Route inconnue.']);
    return true;
}
if ($method === 'GET') {
    out(400, ['detail' => 'Paramètre players manquant.']);
    return true;
}
if ($method !== 'PUT') {
    out(405, ['detail' => 'Méthode non autorisée.']);
    return true;
}

$raw = file_get_contents('php://input');
$p = json_decode((string) $raw, true);
$errors = [];
$isInt = static fn($v, int $min, int $max): bool => is_int($v) && $v >= $min && $v <= $max;
$isList = static fn($v, int $max): bool => is_array($v) && array_is_list($v) && count($v) <= $max;
$keys = static fn(array $a): string => implode(',', array_keys($a));

if (!is_array($p) || array_is_list($p)) {
    $errors[] = 'not an object';
} else {
    if ($keys($p) !== 'version,puuid,phase,queue_id,local_cell,my_team,their_team,bans,actions,timer_remaining_ms,sent_at') {
        $errors[] = 'keys: ' . $keys($p);
    }
    if (($p['version'] ?? null) !== 1) $errors[] = 'version';
    if (!is_string($p['puuid'] ?? null) || preg_match('/^[A-Za-z0-9_-]{1,100}$/D', $p['puuid']) !== 1) $errors[] = 'puuid';
    if (!in_array($p['phase'] ?? null, ['planning', 'ban_pick', 'finalization', 'game_starting', 'none'], true)) $errors[] = 'phase';
    if (!$isInt($p['queue_id'] ?? null, 0, 100000)) $errors[] = 'queue_id';
    if (!$isInt($p['local_cell'] ?? null, -1, 20)) $errors[] = 'local_cell';
    if (!$isInt($p['timer_remaining_ms'] ?? null, 0, 3600000)) $errors[] = 'timer';
    if (!is_string($p['sent_at'] ?? null) || preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/D', $p['sent_at']) !== 1) $errors[] = 'sent_at';
    if (!$isList($p['my_team'] ?? null, 5)) {
        $errors[] = 'my_team';
    } else {
        foreach ($p['my_team'] as $m) {
            if (!is_array($m) || $keys($m) !== 'cell,puuid,champion_key,intent_key,position'
                || !$isInt($m['cell'], 0, 20) || !is_string($m['puuid']) || strlen($m['puuid']) > 100
                || !$isInt($m['champion_key'], 0, 2000) || !$isInt($m['intent_key'], 0, 2000)
                || !in_array($m['position'], ['top', 'jungle', 'middle', 'bottom', 'utility', ''], true)) {
                $errors[] = 'my_team entry ' . json_encode($m);
            }
        }
    }
    if (!$isList($p['their_team'] ?? null, 5)) {
        $errors[] = 'their_team';
    } else {
        foreach ($p['their_team'] as $m) {
            // puuid adverse : "" (classée/normale) ou puuid fourni par le client (Clash, personnalisée).
            if (!is_array($m) || $keys($m) !== 'cell,puuid,champion_key' || !$isInt($m['cell'], 0, 20)
                || !is_string($m['puuid']) || ($m['puuid'] !== '' && preg_match('/^[A-Za-z0-9_-]{40,100}$/D', $m['puuid']) !== 1)
                || !$isInt($m['champion_key'], 0, 2000)) {
                $errors[] = 'their_team entry ' . json_encode($m);
            }
        }
    }
    $bans = $p['bans'] ?? null;
    if (!is_array($bans) || $keys($bans) !== 'mine,theirs' || !$isList($bans['mine'], 5) || !$isList($bans['theirs'], 5)) {
        $errors[] = 'bans';
    } else {
        foreach (array_merge($bans['mine'], $bans['theirs']) as $b) {
            if (!$isInt($b, 0, 2000)) $errors[] = 'ban value';
        }
    }
    if (!$isList($p['actions'] ?? null, 30)) {
        $errors[] = 'actions';
    } else {
        foreach ($p['actions'] as $a) {
            if (!is_array($a) || $keys($a) !== 'type,champion_key,completed,ally,cell,in_progress'
                || !in_array($a['type'], ['ban', 'pick'], true) || !$isInt($a['champion_key'], 0, 2000)
                || !is_bool($a['completed']) || !is_bool($a['ally']) || !$isInt($a['cell'], 0, 20) || !is_bool($a['in_progress'])) {
                $errors[] = 'action ' . json_encode($a);
            }
        }
    }
}

file_put_contents($dir . '/puts.jsonl', json_encode(['body' => $p, 'raw' => $raw, 'errors' => $errors], JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND);
if ($errors) {
    out(400, ['detail' => 'Données invalides : ' . implode('; ', $errors)]);
    return true;
}
if (!in_array($p['puuid'], $known, true)) {
    out(404, ['detail' => "Ce compte Riot n'est pas dans la liste des joueurs du site."]);
    return true;
}
out(200, ['ok' => true, 'player_id' => 'p1']);
return true;
