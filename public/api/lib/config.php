<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

/** Niveaux de classement suivis par le collecteur méta, du plus bas au plus haut (MASTER_PLUS = Master et au-dessus). */
const META_TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER_PLUS'];
/** Ligues « apex » (une seule page par ligue) regroupées dans MASTER_PLUS ; anciens noms acceptés dans meta_tiers. */
const META_APEX_LEAGUES = ['CHALLENGER', 'GRANDMASTER', 'MASTER'];
const META_DEFAULT_GAMES_PER_TIER = 500;
/** Plage horaire de la collecte automatique (cron) : [début inclus, fin exclue], heures locales. */
const META_DEFAULT_HOURS = [4, 15];
const META_DEFAULT_TIMEZONE = 'Europe/Paris';
const META_DEFAULT_RATE = 0.25;

/** « gold », « GOLD » -> GOLD ; anciens CHALLENGER/GRANDMASTER/MASTER (et MASTER+) -> MASTER_PLUS ; null si inconnu. */
function meta_normalize_tier(mixed $tier): ?string
{
    if (!is_string($tier)) {
        return null;
    }
    $t = strtoupper(trim($tier));
    if ($t === 'MASTER+' || in_array($t, META_APEX_LEAGUES, true)) {
        return 'MASTER_PLUS';
    }
    return in_array($t, META_TIERS, true) ? $t : null;
}

/**
 * meta_hours « 04-15 » (début inclus, fin exclue, 0 à 24 h ; « 22-06 » passe minuit ; « 00-24 » = toujours).
 * @return array{0:int,1:int}|null
 */
function meta_parse_hours(mixed $value): ?array
{
    if (!is_string($value) || preg_match('/^\s*([0-9]{1,2})\s*h?\s*-\s*([0-9]{1,2})\s*h?\s*$/iD', $value, $m) !== 1) {
        return null;
    }
    $start = (int) $m[1];
    $end = (int) $m[2];
    if ($start > 23 || $end < 1 || $end > 24 || $start === $end) {
        return null;
    }
    return [$start, $end];
}

const PLATFORM_REGIONS = [
    'euw1' => 'europe',
    'eun1' => 'europe',
    'tr1' => 'europe',
    'ru' => 'europe',
    'me1' => 'europe',
    'na1' => 'americas',
    'br1' => 'americas',
    'la1' => 'americas',
    'la2' => 'americas',
    'kr' => 'asia',
    'jp1' => 'asia',
    'oc1' => 'sea',
    'sg2' => 'sea',
    'tw2' => 'sea',
    'vn2' => 'sea',
];

/**
 * Charge api/config.php (facultatif) et normalise les types.
 * @return array{riot_api_key:string, riot_platform:string, app_password:string, admin_password:string, cors_origins:list<string>,
 *   data_dir:?string, meta_enabled:bool, meta_tiers:list<string>, meta_apex:list<string>, meta_games_per_tier:int,
 *   meta_time_budget:int, meta_web_budget:int, meta_rate:?float, meta_min_games:int, meta_hours:array{0:int,1:int}, timezone:string}
 */
function load_config(string $apiDir): array
{
    $raw = [];
    $file = $apiDir . '/config.php';
    if (is_file($file)) {
        $loaded = (static function (string $f) {
            return require $f;
        })($file);
        if (is_array($loaded)) {
            $raw = $loaded;
        } else {
            error_log('lolhelper: config.php ne renvoie pas un tableau, valeurs par défaut utilisées');
        }
    }

    $key = $raw['riot_api_key'] ?? '';
    $platform = $raw['riot_platform'] ?? 'euw1';
    $password = $raw['app_password'] ?? '';
    $adminPassword = $raw['admin_password'] ?? '';
    $origins = $raw['cors_origins'] ?? [];
    $dataDir = $raw['data_dir'] ?? null;

    $cleanOrigins = [];
    if (is_array($origins)) {
        foreach ($origins as $o) {
            if (is_string($o) && $o !== '') {
                $cleanOrigins[] = rtrim($o, '/');
            }
        }
    }

    // Collecteur méta (cron) : valeurs bornées, défauts si absentes ou invalides.
    $metaEnabled = $raw['meta_enabled'] ?? true;
    // meta_tiers : niveaux de META_TIERS. Les anciens noms CHALLENGER/GRANDMASTER/MASTER deviennent MASTER_PLUS et
    // restreignent les ligues apex lues pour ce niveau (sauf si MASTER_PLUS est aussi listé : les trois).
    $tiers = $raw['meta_tiers'] ?? META_TIERS;
    $picked = [];
    $apexListed = [];
    $plusListed = false;
    if (is_array($tiers)) {
        foreach ($tiers as $t) {
            $norm = meta_normalize_tier($t);
            if ($norm === null) {
                continue;
            }
            $picked[$norm] = true;
            $upper = strtoupper(trim((string) $t));
            if (in_array($upper, META_APEX_LEAGUES, true)) {
                $apexListed[$upper] = true;
            } elseif ($norm === 'MASTER_PLUS') {
                $plusListed = true;
            }
        }
    }
    $cleanTiers = array_values(array_filter(META_TIERS, static fn (string $t): bool => isset($picked[$t])));
    $apex = ($plusListed || $apexListed === [])
        ? META_APEX_LEAGUES
        : array_values(array_filter(META_APEX_LEAGUES, static fn (string $l): bool => isset($apexListed[$l])));
    $perTier = $raw['meta_games_per_tier'] ?? META_DEFAULT_GAMES_PER_TIER;
    $budget = $raw['meta_time_budget'] ?? 3300;
    $webBudget = $raw['meta_web_budget'] ?? 45;
    // meta_rate : absent = 0,25 requête/s au plus ; un nombre plafonne le collecteur à ce rythme (0 = pas de
    // plafond) ; « auto » = pas de rythme fixe (seule la garde des limites Riot décide, 60 % de chaque fenêtre).
    $rate = $raw['meta_rate'] ?? META_DEFAULT_RATE;
    if (is_string($rate) && strtolower(trim($rate)) === 'auto') {
        $cleanRate = null;
    } elseif (is_int($rate) || is_float($rate)) {
        $cleanRate = max(0.0, min(20.0, (float) $rate));
    } else {
        $cleanRate = META_DEFAULT_RATE;
    }
    $minGames = $raw['meta_min_games'] ?? 300;
    $hours = meta_parse_hours($raw['meta_hours'] ?? null) ?? META_DEFAULT_HOURS;
    $tz = $raw['timezone'] ?? META_DEFAULT_TIMEZONE;
    $cleanTz = META_DEFAULT_TIMEZONE;
    if (is_string($tz) && trim($tz) !== '') {
        try {
            $cleanTz = (new DateTimeZone(trim($tz)))->getName();
        } catch (Exception $e) {
            error_log('lolhelper: fuseau horaire inconnu dans config.php, ' . META_DEFAULT_TIMEZONE . ' utilisé');
        }
    }

    return [
        'riot_api_key' => is_string($key) ? trim($key) : '',
        'riot_platform' => (is_string($platform) && isset(PLATFORM_REGIONS[$platform])) ? $platform : 'euw1',
        'app_password' => is_string($password) ? trim($password) : '',
        'admin_password' => is_string($adminPassword) ? trim($adminPassword) : '',
        'cors_origins' => $cleanOrigins,
        'data_dir' => (is_string($dataDir) && $dataDir !== '') ? rtrim($dataDir, '/\\') : null,
        'meta_enabled' => is_bool($metaEnabled) ? $metaEnabled : true,
        'meta_tiers' => $cleanTiers ?: META_TIERS,
        'meta_apex' => $cleanTiers ? $apex : META_APEX_LEAGUES,
        'meta_games_per_tier' => (is_int($perTier) || is_float($perTier)) ? max(50, min(5000, (int) $perTier)) : META_DEFAULT_GAMES_PER_TIER,
        'meta_time_budget' => (is_int($budget) || is_float($budget)) ? max(1, min(3300, (int) $budget)) : 3300,
        'meta_web_budget' => (is_int($webBudget) || is_float($webBudget)) ? max(5, min(120, (int) $webBudget)) : 45,
        'meta_rate' => $cleanRate,
        'meta_min_games' => is_int($minGames) ? max(0, $minGames) : 300,
        'meta_hours' => $hours,
        'timezone' => $cleanTz,
    ];
}
