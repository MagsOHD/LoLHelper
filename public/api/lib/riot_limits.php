<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

/*
 * Limites de débit Riot adaptatives, partagées par le proxy (requêtes des joueurs) et le collecteur méta.
 *
 * Riot renvoie à chaque réponse la limite de l'application et l'usage courant de chaque fenêtre :
 *   X-App-Rate-Limit: 20:1,100:120          (requêtes:fenêtre en secondes)
 *   X-App-Rate-Limit-Count: 3:1,41:120
 * (et X-Method-Rate-Limit[-Count] pour la méthode appelée). Les compteurs sont tenus par valeur de
 * routage (euw1, europe…) : un seau par hôte, plus un seau par hôte + famille de méthode.
 *
 * Fichier <dossier de données>/riot_limits.json (hors de www/, écrit sous flock + rename atomique) :
 *   {"v":1,
 *    "app":    {"europe": {"w":[[20,1,3],[100,120,41]], "at":1763070000.123, "calls":[1763070001.5], "until":0}},
 *    "method": {"europe match-v5.match": {...même forme...}}}
 *   w      : [limite, fenêtre (s), compte] relevés dans les derniers en-têtes (absent = rien vu encore)
 *   at     : instant d'envoi de la requête dont la réponse a fourni w
 *   calls  : appels réservés depuis « at » dont la réponse n'a pas (encore) mis w à jour
 *   until  : pause imposée par un 429 Riot d'application/méthode (Retry-After)
 *
 * Estimation prudente de l'usage d'une fenêtre (limite L, durée W) à l'instant t :
 *   usage = (t < at + W ? compte : 0) + nombre de calls c avec c > at et c + W > t
 * (Riot peut avoir remis sa fenêtre à zéro plus tôt ; on suppose le pire : elle vient de commencer.)
 * Un appel passe si, pour chaque fenêtre (application et méthode connues), usage × 100 < part × L,
 * avec part = 95 pour les joueurs et 60 pour le collecteur. Avant tout en-tête : 20/1 s et 100/120 s.
 * Sinon l'attente = temps jusqu'à ce que suffisamment d'appels sortent de la fenêtre.
 */

const RIOT_LIMITS_FILE = 'riot_limits.json';
const RIOT_LIMITS_LOCK = 'riot_limits.lock';
/** Part de chaque fenêtre utilisable, en pourcentage (entiers : décision exacte et reproductible). */
const RIOT_USER_SHARE_PCT = 95;
const RIOT_COLLECTOR_SHARE_PCT = 60;
/** Limites supposées tant que Riot n'a renvoyé aucun en-tête (clé personnelle). */
const RIOT_DEFAULT_APP_LIMITS = [[20, 1], [100, 120]];
const RIOT_LIMITS_MAX_CALLS = 300;
const RIOT_LIMITS_MAX_WINDOWS = 10;
const RIOT_METHOD_BUCKET_TTL = 86400;
const RIOT_RATE_HEADER_PATTERN = '/^[0-9]{1,9}:[0-9]{1,6}(,[0-9]{1,9}:[0-9]{1,6}){0,9}$/D';
/** En-têtes de réponse Riot conservés par riot_http_get (noms en minuscules). */
const RIOT_RATE_HEADERS = [
    'x-app-rate-limit',
    'x-app-rate-limit-count',
    'x-method-rate-limit',
    'x-method-rate-limit-count',
    'x-rate-limit-type',
];

/**
 * « 20:1,100:120 » -> [[20, 1], [100, 120]] ; [] si l'en-tête est absent ou malformé.
 * @return list<array{0:int,1:int}>
 */
function riot_parse_rate_header(?string $value): array
{
    if ($value === null) {
        return [];
    }
    $value = str_replace(' ', '', $value);
    if (preg_match(RIOT_RATE_HEADER_PATTERN, $value) !== 1) {
        return [];
    }
    $out = [];
    foreach (explode(',', $value) as $pair) {
        [$a, $b] = explode(':', $pair);
        $out[] = [(int) $a, (int) $b];
    }
    return $out;
}

/**
 * Hôte Riot (« europe », « euw1 ») et chemin d'une URL construite par riot_base_url.
 * @return array{0:string,1:string}
 */
function riot_url_target(string $url): array
{
    $host = (string) parse_url($url, PHP_URL_HOST);
    $path = (string) parse_url($url, PHP_URL_PATH);
    if (preg_match('/^([a-z0-9]{2,12})\.api\.riotgames\.com$/D', $host, $m) === 1) {
        return [$m[1], $path];
    }
    // Faux serveur des tests : http://127.0.0.1:<port>/<hôte>/<chemin Riot>.
    if (preg_match('#^/([a-z0-9]{2,12})(/.*)$#D', $path, $m) === 1) {
        return [$m[1], $m[2]];
    }
    return ['unknown', $path];
}

/** Famille de méthode Riot d'un chemin (clé des limites par méthode). */
function riot_method_family(string $path): string
{
    $table = [
        '#^/riot/account/v1/accounts/by-riot-id/#' => 'account-v1.by-riot-id',
        '#^/lol/summoner/v4/summoners/by-puuid/#' => 'summoner-v4.by-puuid',
        '#^/lol/league/v4/entries/by-puuid/#' => 'league-v4.entries-by-puuid',
        '#^/lol/league/v4/challengerleagues/#' => 'league-v4.challenger',
        '#^/lol/league/v4/grandmasterleagues/#' => 'league-v4.grandmaster',
        '#^/lol/league/v4/masterleagues/#' => 'league-v4.master',
        '#^/lol/champion-mastery/v4/champion-masteries/by-puuid/[^/]+/top$#D' => 'champion-mastery-v4.top',
        '#^/lol/match/v5/matches/by-puuid/[^/]+/ids$#D' => 'match-v5.ids',
        '#^/lol/match/v5/matches/[^/]+/timeline$#D' => 'match-v5.timeline',
        '#^/lol/match/v5/matches/[^/]+$#D' => 'match-v5.match',
        '#^/lol/spectator/v5/active-games/by-summoner/#' => 'spectator-v5.active-game',
        '#^/lol/clash/v1/players/by-puuid/#' => 'clash-v1.players',
        '#^/lol/clash/v1/teams/#' => 'clash-v1.team',
        '#^/lol/clash/v1/tournaments/by-team/#' => 'clash-v1.tournament-by-team',
        '#^/lol/clash/v1/tournaments$#D' => 'clash-v1.tournaments',
        '#^/lol/clash/v1/tournaments/[^/]+$#D' => 'clash-v1.tournament',
    ];
    foreach ($table as $re => $family) {
        if (preg_match($re, $path) === 1) {
            return $family;
        }
    }
    $segments = array_slice(explode('/', trim($path, '/')), 0, 4);
    $fallback = preg_replace('/[^a-z0-9.-]+/', '-', strtolower(implode('.', $segments)));
    return substr((string) $fallback, 0, 64) ?: 'other';
}

/** Seau vide (aucun en-tête vu). */
function riot_empty_bucket(): array
{
    return ['at' => 0.0, 'calls' => [], 'until' => 0.0];
}

/** Valide un seau relu du fichier ; null si inexploitable. */
function riot_clean_bucket(mixed $b): ?array
{
    if (!is_array($b)) {
        return null;
    }
    $out = riot_empty_bucket();
    $num = static fn (mixed $v): bool => (is_int($v) || is_float($v)) && $v >= 0 && $v < 1e11;
    if ($num($b['at'] ?? null)) {
        $out['at'] = (float) $b['at'];
    }
    if ($num($b['until'] ?? null)) {
        $out['until'] = (float) $b['until'];
    }
    if (is_array($b['w'] ?? null)) {
        $w = [];
        foreach (array_slice($b['w'], 0, RIOT_LIMITS_MAX_WINDOWS) as $win) {
            if (is_array($win) && count($win) === 3 && is_int($win[0] ?? null) && is_int($win[1] ?? null) && is_int($win[2] ?? null)
                && $win[0] >= 1 && $win[1] >= 1 && $win[1] <= 86400 && $win[2] >= 0) {
                $w[] = [$win[0], $win[1], $win[2]];
            }
        }
        if ($w !== []) {
            $out['w'] = $w;
        }
    }
    if (is_array($b['calls'] ?? null)) {
        foreach (array_slice($b['calls'], -RIOT_LIMITS_MAX_CALLS) as $c) {
            if ($num($c)) {
                $out['calls'][] = (float) $c;
            }
        }
    }
    return $out;
}

/**
 * Fenêtres d'un seau : [limite, durée, compte relevé]. Application sans en-tête : limites par défaut.
 * @return list<array{0:int,1:int,2:int}>
 */
function riot_bucket_limits(?array $bucket, bool $app): array
{
    if (isset($bucket['w'])) {
        return $bucket['w'];
    }
    if (!$app) {
        return [];
    }
    return array_map(static fn (array $l): array => [$l[0], $l[1], 0], RIOT_DEFAULT_APP_LIMITS);
}

/**
 * Usage estimé de chaque fenêtre à l'instant $now (voir l'en-tête du fichier).
 * @return list<array{limit:int, window:int, usage:int, drops:list<array{0:float,1:int}>}>
 */
function riot_bucket_usage(?array $bucket, float $now, bool $app): array
{
    $at = (float) ($bucket['at'] ?? 0.0);
    $calls = $bucket['calls'] ?? [];
    $out = [];
    foreach (riot_bucket_limits($bucket, $app) as [$limit, $window, $count]) {
        $usage = 0;
        $drops = [];
        if ($count > 0 && $at + $window > $now) {
            $usage += $count;
            $drops[] = [$at + $window, $count];
        }
        foreach ($calls as $t) {
            if ($t > $at && $t + $window > $now) {
                $usage++;
                $drops[] = [$t + $window, 1];
            }
        }
        $out[] = ['limit' => $limit, 'window' => $window, 'usage' => $usage, 'drops' => $drops];
    }
    return $out;
}

/**
 * Secondes à attendre avant qu'un appel puisse partir sur ce seau avec la part $sharePct (0 = tout de suite).
 * Déterministe : ne dépend que du seau et de $now.
 */
function riot_gate_wait(?array $bucket, float $now, int $sharePct, bool $app): float
{
    $wait = 0.0;
    $until = (float) ($bucket['until'] ?? 0.0);
    if ($until > $now) {
        $wait = $until - $now;
    }
    foreach (riot_bucket_usage($bucket, $now, $app) as $w) {
        $cap = $sharePct * $w['limit'];
        if ($w['usage'] * 100 < $cap) {
            continue;
        }
        $drops = $w['drops'];
        usort($drops, static fn (array $a, array $b): int => $a[0] <=> $b[0]);
        $remaining = $w['usage'];
        $free = $now + $w['window'];
        foreach ($drops as [$time, $n]) {
            $remaining -= $n;
            if ($remaining * 100 < $cap) {
                $free = $time;
                break;
            }
        }
        $wait = max($wait, $free - $now);
    }
    return $wait;
}

/** Retire les appels déjà couverts par les en-têtes ou sortis de toutes les fenêtres. */
function riot_prune_bucket(array $bucket, float $now, bool $app): array
{
    $maxWindow = 0;
    foreach (riot_bucket_limits($bucket, $app) as [, $window]) {
        $maxWindow = max($maxWindow, $window);
    }
    $at = $bucket['at'];
    $calls = array_values(array_filter(
        $bucket['calls'],
        static fn (float $t): bool => $t > $at && $t + $maxWindow > $now
    ));
    $bucket['calls'] = array_slice($calls, -RIOT_LIMITS_MAX_CALLS);
    return $bucket;
}

/** Lit l'état (sans verrou : le fichier est remplacé par rename atomique). */
function riot_limits_read(string $dataDir): array
{
    $state = ['v' => 1, 'app' => [], 'method' => []];
    $file = $dataDir . '/' . RIOT_LIMITS_FILE;
    $raw = is_file($file) ? @file_get_contents($file) : false;
    if (!is_string($raw) || $raw === '') {
        return $state;
    }
    $data = json_decode($raw, true, 16);
    if (!is_array($data)) {
        error_log('lolhelper: riot_limits.json illisible, limites réinitialisées');
        return $state;
    }
    foreach (['app', 'method'] as $kind) {
        foreach (is_array($data[$kind] ?? null) ? $data[$kind] : [] as $key => $b) {
            $key = (string) $key;
            $clean = riot_clean_bucket($b);
            if ($clean !== null && preg_match('/^[a-z0-9]{2,12}( [a-z0-9.-]{1,64})?$/D', $key) === 1) {
                $state[$kind][$key] = $clean;
            }
        }
    }
    return $state;
}

/**
 * Lecture-modification-écriture sous verrou exclusif. $fn reçoit l'état et renvoie [état|null, résultat] ;
 * état null = rien à écrire. Sans stockage ou en cas d'échec : $fn sur un état vide, sans écriture.
 */
function riot_limits_update(?string $dataDir, callable $fn): mixed
{
    if ($dataDir === null) {
        return $fn(['v' => 1, 'app' => [], 'method' => []])[1];
    }
    $lock = @fopen($dataDir . '/' . RIOT_LIMITS_LOCK, 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        error_log('lolhelper: verrou des limites Riot impossible');
        if ($lock !== false) {
            fclose($lock);
        }
        return $fn(['v' => 1, 'app' => [], 'method' => []])[1];
    }
    try {
        [$state, $result] = $fn(riot_limits_read($dataDir));
        if ($state !== null) {
            try {
                write_atomic($dataDir . '/' . RIOT_LIMITS_FILE, json_encode_safe(riot_limits_encode($state)));
            } catch (Throwable $e) {
                error_log('lolhelper: riot_limits.json non écrit : ' . $e->getMessage());
            }
        }
        return $result;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** Forme JSON compacte (objets vides gardés en objets, millisecondes). */
function riot_limits_encode(array $state): array
{
    $now = microtime(true);
    foreach (['app', 'method'] as $kind) {
        foreach ($state[$kind] as $key => $b) {
            // Seaux de méthode oubliés au bout d'un jour sans nouvelles.
            if ($kind === 'method' && $b['calls'] === [] && $b['until'] <= $now && $b['at'] + RIOT_METHOD_BUCKET_TTL < $now) {
                unset($state[$kind][$key]);
                continue;
            }
            $b['at'] = round($b['at'], 3);
            $b['until'] = round($b['until'], 3);
            $b['calls'] = array_map(static fn (float $c): float => round($c, 3), $b['calls']);
            $state[$kind][$key] = $b;
        }
        if ($state[$kind] === []) {
            $state[$kind] = new stdClass();
        }
    }
    return ['v' => 1, 'app' => $state['app'], 'method' => $state['method']];
}

/**
 * Garde avant un appel Riot : si toutes les fenêtres (application + méthode) laissent passer l'appel
 * avec la part $sharePct, l'appel est réservé (compté dans « calls ») et la fonction renvoie 0.
 * Sinon rien n'est réservé et elle renvoie le nombre de secondes à attendre.
 */
function riot_gate_acquire(?string $dataDir, string $url, int $sharePct, ?float $now = null): float
{
    [$host, $path] = riot_url_target($url);
    $methodKey = $host . ' ' . riot_method_family($path);
    return riot_limits_update($dataDir, static function (array $state) use ($host, $methodKey, $sharePct, $now): array {
        $now ??= microtime(true);
        $app = $state['app'][$host] ?? riot_empty_bucket();
        $method = $state['method'][$methodKey] ?? riot_empty_bucket();
        $wait = max(riot_gate_wait($app, $now, $sharePct, true), riot_gate_wait($method, $now, $sharePct, false));
        if ($wait > 0) {
            return [null, $wait];
        }
        // Arrondi à la milliseconde comme dans le fichier : l'appel réservé et le « at » de sa réponse coïncident.
        $app['calls'][] = round($now, 3);
        $method['calls'][] = round($now, 3);
        $state['app'][$host] = riot_prune_bucket($app, $now, true);
        $state['method'][$methodKey] = riot_prune_bucket($method, $now, false);
        return [$state, 0.0];
    });
}

/** Met à jour un seau avec un couple d'en-têtes limite/compte (si la réponse n'est pas plus ancienne). */
function riot_bucket_apply(array $bucket, ?string $limitHeader, ?string $countHeader, float $sentAt): array
{
    $limits = riot_parse_rate_header($limitHeader);
    if ($limits === [] || round($sentAt, 3) < $bucket['at']) {
        return $bucket;
    }
    $counts = [];
    foreach (riot_parse_rate_header($countHeader) as [$count, $window]) {
        $counts[$window] = $count;
    }
    $w = [];
    foreach (array_slice($limits, 0, RIOT_LIMITS_MAX_WINDOWS) as [$limit, $window]) {
        if ($limit >= 1 && $window >= 1 && $window <= 86400) {
            $w[] = [$limit, $window, $counts[$window] ?? 0];
        }
    }
    if ($w === []) {
        return $bucket;
    }
    usort($w, static fn (array $a, array $b): int => $a[1] <=> $b[1]);
    $bucket['w'] = $w;
    $bucket['at'] = round($sentAt, 3);
    return $bucket;
}

/**
 * Après un appel Riot : enregistre les en-têtes de limites (application et méthode) et, sur un 429
 * d'application ou de méthode, la pause Retry-After.
 * @param array<string,string> $headers en-têtes Riot (noms en minuscules)
 */
function riot_limits_record(?string $dataDir, string $url, float $sentAt, int $status, array $headers, ?string $retryAfter): void
{
    if ($dataDir === null || $status === 0) {
        return; // erreur réseau : l'appel réservé reste compté jusqu'à la fin de ses fenêtres
    }
    [$host, $path] = riot_url_target($url);
    $methodKey = $host . ' ' . riot_method_family($path);
    riot_limits_update($dataDir, static function (array $state) use ($host, $methodKey, $sentAt, $status, $headers, $retryAfter): array {
        $now = microtime(true);
        $app = $state['app'][$host] ?? riot_empty_bucket();
        $method = $state['method'][$methodKey] ?? riot_empty_bucket();
        $app = riot_bucket_apply($app, $headers['x-app-rate-limit'] ?? null, $headers['x-app-rate-limit-count'] ?? null, $sentAt);
        $method = riot_bucket_apply($method, $headers['x-method-rate-limit'] ?? null, $headers['x-method-rate-limit-count'] ?? null, $sentAt);
        if ($status === 429 && $retryAfter !== null && preg_match('/^[0-9]{1,5}$/D', $retryAfter) === 1) {
            $until = $now + min(3600, max(1, (int) $retryAfter));
            $type = strtolower($headers['x-rate-limit-type'] ?? '');
            if ($type === 'application') {
                $app['until'] = max($app['until'], $until);
            } elseif ($type === 'method') {
                $method['until'] = max($method['until'], $until);
            }
            // « service » ou absent : surcharge côté Riot, pas une limite de la clé.
        }
        $state['app'][$host] = riot_prune_bucket($app, $now, true);
        $state['method'][$methodKey] = riot_prune_bucket($method, $now, false);
        return [$state, null];
    });
}

/**
 * En-têtes X-App-Rate-Limit / -Count à renvoyer au navigateur : ceux de Riot s'ils sont valides.
 * @param array<string,string> $headers
 * @return array<string,string>
 */
function riot_passthrough_headers(array $headers): array
{
    $out = [];
    foreach (['x-app-rate-limit' => 'X-App-Rate-Limit', 'x-app-rate-limit-count' => 'X-App-Rate-Limit-Count'] as $k => $name) {
        $v = str_replace(' ', '', $headers[$k] ?? '');
        if ($v !== '' && preg_match(RIOT_RATE_HEADER_PATTERN, $v) === 1) {
            $out[$name] = $v;
        }
    }
    return $out;
}

/**
 * Les mêmes en-têtes reconstitués depuis l'état local (refus local : aucun appel Riot).
 * @return array<string,string>
 */
function riot_local_rate_headers(?string $dataDir, string $url): array
{
    [$host] = riot_url_target($url);
    $bucket = $dataDir !== null ? (riot_limits_read($dataDir)['app'][$host] ?? null) : null;
    $usage = riot_bucket_usage($bucket, microtime(true), true);
    return [
        'X-App-Rate-Limit' => implode(',', array_map(static fn (array $w): string => $w['limit'] . ':' . $w['window'], $usage)),
        'X-App-Rate-Limit-Count' => implode(',', array_map(static fn (array $w): string => $w['usage'] . ':' . $w['window'], $usage)),
    ];
}

/**
 * Vue d'affichage : fenêtres d'application de l'hôte le plus chargé (en-têtes vus en priorité).
 * @return array{app:list<array{limit:int, window:int, count:int, at:?string}>, host:?string, detected:bool}
 */
function riot_limits_snapshot(?string $dataDir, ?float $now = null): array
{
    $now ??= microtime(true);
    $state = $dataDir !== null ? riot_limits_read($dataDir) : ['app' => []];
    $best = null;
    $bestKey = null;
    foreach ($state['app'] as $host => $bucket) {
        $ratio = 0.0;
        foreach (riot_bucket_usage($bucket, $now, true) as $w) {
            $ratio = max($ratio, $w['usage'] / $w['limit']);
        }
        $key = [isset($bucket['w']) ? 1 : 0, $ratio, $bucket['at']];
        if ($bestKey === null || $key > $bestKey) {
            $bestKey = $key;
            $best = (string) $host;
        }
    }
    $bucket = $best !== null ? $state['app'][$best] : null;
    $detected = isset($bucket['w']);
    $at = $detected ? gmdate('Y-m-d\TH:i:s\Z', (int) $bucket['at']) : null;
    $app = [];
    foreach (riot_bucket_usage($bucket, $now, true) as $w) {
        $app[] = ['limit' => $w['limit'], 'window' => $w['window'], 'count' => $w['usage'], 'at' => $at];
    }
    return ['app' => $app, 'host' => $best, 'detected' => $detected];
}

/** Route GET r=riot-limits (mot de passe déjà vérifié). */
function handle_riot_limits(array $config, string $apiDir): void
{
    $snap = riot_limits_snapshot(resolve_data_dir($config, $apiDir));
    send_json(200, [
        'app' => $snap['app'],
        'collector_share' => RIOT_COLLECTOR_SHARE_PCT / 100,
        'user_share' => RIOT_USER_SHARE_PCT / 100,
        'host' => $snap['host'],
        'detected' => $snap['detected'],
        'meta_rate' => $config['meta_rate'],
    ]);
}
