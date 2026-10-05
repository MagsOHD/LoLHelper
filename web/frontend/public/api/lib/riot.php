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

const RIOT_MSG_NOT_FOUND = 'Introuvable chez Riot.';
const RIOT_MSG_AUTH = 'Clé API Riot invalide ou expirée (une clé de développement expire toutes les 24 h).';
const RIOT_MSG_RATE = 'Limite de requêtes Riot atteinte, réessaie dans quelques secondes.';
const RIOT_MSG_DOWN = 'Serveur Riot indisponible.';
const RIOT_MSG_NO_KEY = 'Clé API Riot non configurée.';

/**
 * URL de base d'un hôte Riot (« europe », « euw1 »…).
 * Surcharge possible UNIQUEMENT pour les tests : variable d'environnement du processus
 * LOLHELPER_RIOT_BASE (http://127.0.0.1:<port>), et seulement sous le serveur intégré `php -S`.
 * Aucune valeur venant de la requête n'est prise en compte.
 */
function riot_base_url(string $host): string
{
    if (PHP_SAPI === 'cli-server') {
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
 * Un seul appel Riot. Renvoie [statut, corps, Retry-After brut|null] ; statut 0 = erreur réseau.
 * @return array{0:int,1:string,2:?string}
 */
function riot_http_get(string $apiKey, string $url): array
{
    $retryAfter = null;
    $ch = curl_init($url);
    if ($ch === false) {
        return [0, '', null];
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => RIOT_TIMEOUT_SECONDS,
        CURLOPT_CONNECTTIMEOUT => RIOT_TIMEOUT_SECONDS,
        CURLOPT_HTTPHEADER => ['X-Riot-Token: ' . $apiKey, 'Accept: application/json'],
        CURLOPT_ENCODING => '',
        CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$retryAfter): int {
            if (stripos($line, 'retry-after:') === 0) {
                $retryAfter = trim(substr($line, 12));
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
    return [$status, (string) $body, $retryAfter];
}

/**
 * Appelle Riot et traduit le statut amont. Renvoie le corps JSON brut en cas de 200.
 */
function riot_fetch(array $config, string $url): string
{
    $key = $config['riot_api_key'];
    if ($key === '') {
        throw new HttpError(400, RIOT_MSG_NO_KEY);
    }
    [$status, $body, $retryAfter] = riot_http_get($key, $url);
    if ($status === 200) {
        return $body;
    }
    if ($status === 404) {
        throw new HttpError(404, RIOT_MSG_NOT_FOUND);
    }
    if ($status === 401 || $status === 403) {
        throw new HttpError(502, RIOT_MSG_AUTH);
    }
    if ($status === 429) {
        $seconds = ($retryAfter !== null && preg_match('/^[0-9]{1,5}$/D', $retryAfter) === 1) ? (string) (int) $retryAfter : '2';
        throw new HttpError(429, RIOT_MSG_RATE, ['Retry-After' => $seconds]);
    }
    if ($status !== 0) {
        error_log('lolhelper: Riot HTTP ' . $status);
    }
    throw new HttpError(502, RIOT_MSG_DOWN);
}

/** Routes riot/* (GET uniquement, déjà vérifié). */
function handle_riot(string $action, array $config, string $apiDir): void
{
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
        case 'match':
            $platform = riot_require_platform();
            $matchId = riot_require_match_id();
            handle_riot_match($config, $apiDir, $platform, $matchId);
            return;
        default:
            throw new HttpError(404, 'Route inconnue.');
    }
    send_raw_json(200, riot_fetch($config, $url));
}

function handle_riot_match(array $config, string $apiDir, string $platform, string $matchId): void
{
    // $matchId est validé par RIOT_MATCH_ID_PATTERN : aucun « / » ni « . » possible.
    $dataDir = resolve_data_dir($config, $apiDir);
    $cacheDir = $dataDir !== null ? $dataDir . '/matches' : null;
    $cacheFile = $cacheDir !== null ? $cacheDir . '/' . $matchId . '.json' : null;

    if ($cacheFile !== null && is_file($cacheFile)) {
        $cached = @file_get_contents($cacheFile);
        if (is_string($cached) && $cached !== '') {
            send_raw_json(200, $cached, ['X-Cache' => 'HIT']);
            return;
        }
    }

    if ($config['riot_api_key'] === '') {
        throw new HttpError(400, RIOT_MSG_NO_KEY);
    }
    $url = riot_base_url(PLATFORM_REGIONS[$platform]) . '/lol/match/v5/matches/' . rawurlencode($matchId);
    $body = riot_fetch($config, $url);

    if ($cacheDir !== null && $cacheFile !== null) {
        try {
            json_decode($body, false, 512, JSON_THROW_ON_ERROR);
            if (ensure_writable_dir($cacheDir)) {
                write_atomic($cacheFile, $body);
            }
        } catch (Throwable $e) {
            error_log('lolhelper: cache de partie non écrit (' . $matchId . ') : ' . $e->getMessage());
        }
    }
    send_raw_json(200, $body, ['X-Cache' => 'MISS']);
}
