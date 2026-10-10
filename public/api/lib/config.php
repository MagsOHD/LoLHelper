<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

/** Paliers acceptés par le collecteur méta (ligues « apex » : une seule page par palier). */
const META_ALLOWED_TIERS = ['CHALLENGER', 'GRANDMASTER', 'MASTER'];

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
 * @return array{riot_api_key:string, riot_platform:string, app_password:string, cors_origins:list<string>, data_dir:?string,
 *   meta_enabled:bool, meta_tiers:list<string>, meta_time_budget:int, meta_rate:float, meta_min_games:int}
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
    $tiers = $raw['meta_tiers'] ?? ['CHALLENGER', 'GRANDMASTER'];
    $cleanTiers = [];
    if (is_array($tiers)) {
        foreach ($tiers as $t) {
            if (is_string($t) && in_array(strtoupper($t), META_ALLOWED_TIERS, true) && !in_array(strtoupper($t), $cleanTiers, true)) {
                $cleanTiers[] = strtoupper($t);
            }
        }
    }
    $budget = $raw['meta_time_budget'] ?? 600;
    $rate = $raw['meta_rate'] ?? 0.5;
    $minGames = $raw['meta_min_games'] ?? 300;

    return [
        'riot_api_key' => is_string($key) ? trim($key) : '',
        'riot_platform' => (is_string($platform) && isset(PLATFORM_REGIONS[$platform])) ? $platform : 'euw1',
        'app_password' => is_string($password) ? $password : '',
        'cors_origins' => $cleanOrigins,
        'data_dir' => (is_string($dataDir) && $dataDir !== '') ? rtrim($dataDir, '/\\') : null,
        'meta_enabled' => is_bool($metaEnabled) ? $metaEnabled : true,
        'meta_tiers' => $cleanTiers ?: ['CHALLENGER', 'GRANDMASTER'],
        'meta_time_budget' => (is_int($budget) || is_float($budget)) ? max(1, min(3300, (int) $budget)) : 600,
        'meta_rate' => (is_int($rate) || is_float($rate)) ? max(0.0, min(20.0, (float) $rate)) : 0.5,
        'meta_min_games' => is_int($minGames) ? max(0, $minGames) : 300,
    ];
}
