<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

const RIOT_TIMEOUT_SECONDS = 10;
const RIOT_PUUID_PATTERN = '/^[A-Za-z0-9_-]{40,100}$/D';
const RIOT_MATCH_ID_PATTERN = '/^[A-Z0-9]{2,6}_[0-9]{1,15}$/D';
const RIOT_TAGLINE_PATTERN = '/^[\p{L}\p{N}]{2,5}$/uD';
const RIOT_CLASH_TEAM_PATTERN = '/^[A-Za-z0-9-]{1,64}$/D';
const RIOT_CLASH_TOURNAMENTS_TTL = 600;
/** Routes riot/<action> servies par handle_riot. */
const RIOT_PROXY_ROUTES = [
    'account', 'summoner', 'league', 'masteries', 'match-ids', 'match', 'match-timeline', 'active-game',
    'clash-player', 'clash-team', 'clash-tournaments', 'clash-tournament-by-team',
];

const RIOT_MSG_NOT_FOUND = 'Introuvable chez Riot.';
const RIOT_MSG_AUTH = 'Clé API Riot invalide ou expirée (une clé de développement expire toutes les 24 h).';
const RIOT_MSG_RATE = 'Limite de requêtes Riot atteinte, réessaie dans quelques secondes.';
const RIOT_MSG_DOWN = 'Serveur Riot indisponible.';
const RIOT_MSG_NO_KEY = 'Clé API Riot non configurée.';
const RIOT_MSG_NO_ACTIVE_GAME = 'Aucune partie en cours pour ce joueur.';
const RIOT_MSG_NO_CLASH_TEAM = 'Équipe Clash introuvable.';
const RIOT_MSG_NO_CLASH_TOURNAMENT = 'Aucun tournoi Clash pour cette équipe.';

require_once __DIR__ . '/riot_limits.php';

/**
 * URL de base d'un hôte Riot (« europe », « euw1 »…).
 * Surcharge possible UNIQUEMENT pour les tests : variable d'environnement du processus
 * LOLHELPER_RIOT_BASE (http://127.0.0.1:<port>), et seulement sous le serveur intégré `php -S`
 * ou en ligne de commande (collecteur cron : l'environnement n'y vient pas d'un visiteur).
 * Aucune valeur venant de la requête n'est prise en compte.
 */
function riot_base_url(string $host): string
{
    if (PHP_SAPI === 'cli-server' || PHP_SAPI === 'cli') {
        $override = getenv('LOLHELPER_RIOT_BASE', true);
        if (is_string($override) && preg_match('#^http://127\.0\.0\.1:[0-9]{1,5}$#D', $override) === 1) {
            return $override . '/' . $host;
        }
    }
    return 'https://' . $host . '.api.riotgames.com';
}

function riot_require_platform(): string
{
    $p = query_string('platform');
    if ($p === null || !isset(PLATFORM_REGIONS[$p])) {
        throw new HttpError(400, 'Serveur (platform) invalide.');
    }
    return $p;
}

function riot_require_puuid(): string
{
    $v = query_string('puuid');
    if ($v === null || preg_match(RIOT_PUUID_PATTERN, $v) !== 1) {
        throw new HttpError(400, 'PUUID invalide.');
    }
    return $v;
}

function riot_require_match_id(): string
{
    $v = query_string('id');
    if ($v === null || preg_match(RIOT_MATCH_ID_PATTERN, $v) !== 1) {
        throw new HttpError(400, 'Identifiant de partie invalide.');
    }
    return $v;
}

function riot_game_name(): string
{
    $v = query_string('gameName');
    if ($v !== null) {
        $v = trim($v);
    }
    if (
        $v === null || $v === '' || !mb_check_encoding($v, 'UTF-8')
        || mb_strlen($v, 'UTF-8') > 32 || preg_match('/[\p{C}]/u', $v) !== 0
    ) {
        throw new HttpError(400, 'Nom de jeu (gameName) invalide : 1 à 32 caractères.');
    }
    return $v;
}

function riot_tag_line(): string
{
    $v = query_string('tagLine');
    if ($v !== null) {
        $v = trim($v);
    }
    if ($v === null || !mb_check_encoding($v, 'UTF-8') || preg_match(RIOT_TAGLINE_PATTERN, $v) !== 1) {
        throw new HttpError(400, 'Tag (tagLine) invalide : 2 à 5 lettres ou chiffres, sans « # ».');
    }
    return $v;
}

/** Entier optionnel dans [min, max] ; $default si absent. */
function riot_int_param(string $name, ?int $default, int $min, int $max): ?int
{
    $v = query_string($name);
    if ($v === null || $v === '') {
        if (array_key_exists($name, $_GET) && !is_string($_GET[$name])) {
            throw new HttpError(400, "Paramètre $name invalide.");
        }
        return $default;
    }
    if (preg_match('/^[0-9]{1,6}$/D', $v) !== 1 || (int) $v < $min || (int) $v > $max) {
        throw new HttpError(400, "Paramètre $name invalide ($min à $max).");
    }
    return (int) $v;
}

/**
 * Un seul appel Riot. Renvoie [statut, corps, Retry-After brut|null, en-têtes de limites] ; statut 0 = erreur réseau.
 * En-têtes : ceux de RIOT_RATE_HEADERS présents dans la réponse, noms en minuscules.
 * @return array{0:int,1:string,2:?string,3:array<string,string>}
 */
function riot_http_get(string $apiKey, string $url): array
{
    $retryAfter = null;
    $rateHeaders = [];
    $ch = curl_init($url);
    if ($ch === false) {
        return [0, '', null, []];
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => RIOT_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => RIOT_TIMEOUT_SECONDS,
        CURLOPT_HTTPHEADER => ['X-Riot-Token: ' . $apiKey, 'Accept: application/json'],
        CURLOPT_ENCODING => '',
        CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$retryAfter, &$rateHeaders): int {
            $p = strpos($line, ':');
            if ($p !== false && $p <= 40) {
                $name = strtolower(trim(substr($line, 0, $p)));
                $value = trim(substr($line, $p + 1));
                if ($name === 'retry-after') {
                    $retryAfter = $value;
                } elseif (in_array($name, RIOT_RATE_HEADERS, true) && strlen($value) <= 200) {
                    $rateHeaders[$name] = $value;
                }
            }
            return strlen($line);
        },
    ]);
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    if ($body === false) {
        error_log('lolhelper: erreur réseau Riot : ' . curl_error($ch));
        $status = 0;
        $body = '';
    }
    curl_close($ch);
    return [$status, (string) $body, $retryAfter, $rateHeaders];
}

/**
 * Appel Riot d'un joueur (proxy) : garde des limites à 95 % de chaque fenêtre, puis traduction du statut
 * amont. Renvoie [corps JSON brut, en-têtes X-App-Rate-Limit(-Count) à transmettre] en cas de 200.
 * Au-delà de la part autorisée : 429 local (aucun appel Riot) avec Retry-After = secondes avant que la
 * fenêtre se libère. $notFound : message renvoyé (404) quand Riot répond 404.
 * @return array{0:string,1:array<string,string>}
 */
function riot_fetch(array $config, ?string $dataDir, string $url, string $notFound = RIOT_MSG_NOT_FOUND): array
{
    $key = $config['riot_api_key'];
    if ($key === '') {
        throw new HttpError(400, RIOT_MSG_NO_KEY);
    }
    $sentAt = microtime(true);
    $wait = riot_gate_acquire($dataDir, $url, RIOT_USER_SHARE_PCT, $sentAt);
    if ($wait > 0) {
        $seconds = (string) max(1, min(3600, (int) ceil($wait)));
        throw new HttpError(429, RIOT_MSG_RATE, ['Retry-After' => $seconds] + riot_local_rate_headers($dataDir, $url));
    }
    [$status, $body, $retryAfter, $rateHeaders] = riot_http_get($key, $url);
    riot_limits_record($dataDir, $url, $sentAt, $status, $rateHeaders, $retryAfter);
    $pass = riot_passthrough_headers($rateHeaders);
    if ($status === 200) {
        return [$body, $pass];
    }
    if ($status === 404) {
        throw new HttpError(404, $notFound, $pass);
    }
    if ($status === 401 || $status === 403) {
        throw new HttpError(502, RIOT_MSG_AUTH, $pass);
    }
    if ($status === 429) {
        $seconds = ($retryAfter !== null && preg_match('/^[0-9]{1,5}$/D', $retryAfter) === 1) ? (string) (int) $retryAfter : '2';
        throw new HttpError(429, RIOT_MSG_RATE, ['Retry-After' => $seconds] + $pass);
    }
    if ($status !== 0) {
        error_log('lolhelper: Riot HTTP ' . $status);
    }
    throw new HttpError(502, RIOT_MSG_DOWN, $pass);
}

/** Identifiant d'équipe Clash (paramètre teamId). */
function riot_require_clash_team_id(): string
{
    $v = query_string('teamId');
    if ($v === null || preg_match(RIOT_CLASH_TEAM_PATTERN, $v) !== 1) {
        throw new HttpError(400, 'Identifiant d\'équipe Clash (teamId) invalide : 1 à 64 caractères A-Z, a-z, 0-9 ou -.');
    }
    return $v;
}

/** Routes riot/* (GET uniquement, déjà vérifié). */
function handle_riot(string $action, array $config, string $apiDir): void
{
    $notFound = RIOT_MSG_NOT_FOUND;
    switch ($action) {
        case 'account':
            $platform = riot_require_platform();
            $gameName = riot_game_name();
            $tagLine = riot_tag_line();
            if ($config['riot_api_key'] === '') {
                throw new HttpError(400, RIOT_MSG_NO_KEY);
            }
            $url = riot_base_url(PLATFORM_REGIONS[$platform]) . '/riot/account/v1/accounts/by-riot-id/'
                . rawurlencode($gameName) . '/' . rawurlencode($tagLine);
            break;
        case 'summoner':
            $platform = riot_require_platform();
            $puuid = riot_require_puuid();
            $url = riot_base_url($platform) . '/lol/summoner/v4/summoners/by-puuid/' . rawurlencode($puuid);
            break;
        case 'league':
            $platform = riot_require_platform();
            $puuid = riot_require_puuid();
            $url = riot_base_url($platform) . '/lol/league/v4/entries/by-puuid/' . rawurlencode($puuid);
            break;
        case 'masteries':
            $platform = riot_require_platform();
            $puuid = riot_require_puuid();
            $count = riot_int_param('count', 30, 1, 100);
            $url = riot_base_url($platform) . '/lol/champion-mastery/v4/champion-masteries/by-puuid/'
                . rawurlencode($puuid) . '/top?count=' . $count;
            break;
        case 'match-ids':
            $platform = riot_require_platform();
            $puuid = riot_require_puuid();
            $count = riot_int_param('count', 20, 1, 100);
            $queue = riot_int_param('queue', null, 0, 99999);
            $url = riot_base_url(PLATFORM_REGIONS[$platform]) . '/lol/match/v5/matches/by-puuid/'
                . rawurlencode($puuid) . '/ids?start=0&count=' . $count
                . ($queue !== null ? '&queue=' . $queue : '');
            break;
        case 'active-game':
            // Spectator-v5 : hôte de la plateforme ; ne répond qu'une fois la partie lancée. Jamais mis en cache.
            $platform = riot_require_platform();
            $puuid = riot_require_puuid();
            $url = riot_base_url($platform) . '/lol/spectator/v5/active-games/by-summoner/' . rawurlencode($puuid);
            $notFound = RIOT_MSG_NO_ACTIVE_GAME;
            break;
        case 'match':
        case 'match-timeline':
            // Parties et chronologies terminées : immuables, gardées sur disque sans limite de durée.
            $platform = riot_require_platform();
            $matchId = riot_require_match_id();
            $url = riot_base_url(PLATFORM_REGIONS[$platform]) . '/lol/match/v5/matches/' . rawurlencode($matchId)
                . ($action === 'match-timeline' ? '/timeline' : '');
            // $matchId est validé par RIOT_MATCH_ID_PATTERN : aucun « / » ni « . » possible.
            $folder = $action === 'match-timeline' ? 'timelines' : 'matches';
            handle_riot_cached($config, $apiDir, $url, $folder, $matchId, null, RIOT_MSG_NOT_FOUND);
            return;
        case 'clash-player':
            // Clash-v1 : hôte de la plateforme. Liste (vide si le joueur n'est inscrit dans aucune équipe).
            $platform = riot_require_platform();
            $puuid = riot_require_puuid();
            $url = riot_base_url($platform) . '/lol/clash/v1/players/by-puuid/' . rawurlencode($puuid);
            break;
        case 'clash-team':
            $platform = riot_require_platform();
            $teamId = riot_require_clash_team_id();
            $url = riot_base_url($platform) . '/lol/clash/v1/teams/' . rawurlencode($teamId);
            $notFound = RIOT_MSG_NO_CLASH_TEAM;
            break;
        case 'clash-tournament-by-team':
            $platform = riot_require_platform();
            $teamId = riot_require_clash_team_id();
            $url = riot_base_url($platform) . '/lol/clash/v1/tournaments/by-team/' . rawurlencode($teamId);
            $notFound = RIOT_MSG_NO_CLASH_TOURNAMENT;
            break;
        case 'clash-tournaments':
            // Tournois à venir : identiques pour tous, gardés 10 min par plateforme.
            $platform = riot_require_platform();
            $url = riot_base_url($platform) . '/lol/clash/v1/tournaments';
            handle_riot_cached($config, $apiDir, $url, 'clash', 'tournaments-' . $platform, RIOT_CLASH_TOURNAMENTS_TTL, RIOT_MSG_NOT_FOUND);
            return;
        default:
            throw new HttpError(404, 'Route inconnue.');
    }
    [$body, $pass] = riot_fetch($config, resolve_data_dir($config, $apiDir), $url, $notFound);
    send_raw_json(200, $body, $pass);
}

/**
 * Réponse Riot mise en cache sur disque (<données>/<dossier>/<nom>.json), seulement pour un 200 dont le
 * corps est du JSON objet ou liste. $ttl null = sans expiration. X-Cache : HIT ou MISS.
 * $name ne contient que [A-Za-z0-9_-] (validé par l'appelant).
 */
function handle_riot_cached(array $config, string $apiDir, string $url, string $folder, string $name, ?int $ttl, string $notFound): void
{
    $dataDir = resolve_data_dir($config, $apiDir);
    $cacheDir = $dataDir !== null ? $dataDir . '/' . $folder : null;
    $cacheFile = $cacheDir !== null ? $cacheDir . '/' . $name . '.json' : null;

    if ($cacheFile !== null && is_file($cacheFile)) {
        $fresh = $ttl === null || (int) @filemtime($cacheFile) > time() - $ttl;
        $cached = $fresh ? @file_get_contents($cacheFile) : false;
        if (is_string($cached) && $cached !== '') {
            send_raw_json(200, $cached, ['X-Cache' => 'HIT']);
            return;
        }
    }

    if ($config['riot_api_key'] === '') {
        throw new HttpError(400, RIOT_MSG_NO_KEY);
    }
    [$body, $pass] = riot_fetch($config, $dataDir, $url, $notFound);

    if ($cacheDir !== null && $cacheFile !== null) {
        try {
            if (!is_array(json_decode($body, true, 512, JSON_THROW_ON_ERROR))) {
                throw new RuntimeException('réponse JSON inattendue');
            }
            if (ensure_writable_dir($cacheDir)) {
                write_atomic($cacheFile, $body);
            }
        } catch (Throwable $e) {
            error_log('lolhelper: cache Riot non écrit (' . $folder . '/' . $name . ') : ' . $e->getMessage());
        }
    }
    send_raw_json(200, $body, ['X-Cache' => 'MISS'] + $pass);
}
