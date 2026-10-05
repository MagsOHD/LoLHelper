<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
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
 * @return array{riot_api_key:string, riot_platform:string, app_password:string, cors_origins:list<string>, data_dir:?string}
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

    return [
        'riot_api_key' => is_string($key) ? trim($key) : '',
        'riot_platform' => (is_string($platform) && isset(PLATFORM_REGIONS[$platform])) ? $platform : 'euw1',
        'app_password' => is_string($password) ? $password : '',
        'cors_origins' => $cleanOrigins,
        'data_dir' => (is_string($dataDir) && $dataDir !== '') ? rtrim($dataDir, '/\\') : null,
    ];
}
