<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

/*
 * Statistiques « méta » haut elo collectées par cron/collect-meta.php.
 * Fichiers dans <dossier de données>/meta/ (jamais sous www/ sauf repli api/data protégé) :
 *   state.json          état du collecteur (joueurs de départ, curseur, pause 429, rejets)
 *   summary.json        { platform, updated_at, patches: { "16.19": { games, updated_at } } }
 *   stats-<patch>.json  agrégats d'un patch (format servi par la route meta-stats)
 *   seen-<patch>.bin    identifiants de parties déjà comptées (entiers 64 bits big-endian triés)
 *   collect.lock        verrou du collecteur
 */

const META_PATCH_PATTERN = '/^[0-9]{1,3}\.[0-9]{1,3}$/D';
const META_KEEP_PATCHES = 2;

/** teamPosition Riot -> rôle de l'appli (les autres valeurs sont ignorées). */
const META_ROLE_MAP = [
    'TOP' => 'TOP',
    'JUNGLE' => 'JUNGLE',
    'MIDDLE' => 'MID',
    'BOTTOM' => 'BOTTOM',
    'UTILITY' => 'SUPPORT',
];

function meta_dir(string $dataDir): string
{
    return $dataDir . DIRECTORY_SEPARATOR . 'meta';
}

/** « 16.19.712.3456 » -> « 16.19 » ; null si la version est inexploitable. */
function meta_patch_from_version(mixed $version): ?string
{
    if (!is_string($version) || preg_match('/^([0-9]{1,3})\.([0-9]{1,3})(\.|$)/', $version, $m) !== 1) {
        return null;
    }
    return ((int) $m[1]) . '.' . ((int) $m[2]);
}

/**
 * Trie des patchs du plus récent au plus ancien.
 * @param list<string> $patches
 * @return list<string>
 */
function meta_sort_patches(array $patches): array
{
    usort($patches, static fn (string $a, string $b): int => version_compare($b, $a));
    return array_values($patches);
}

/** Lit un fichier JSON objet (tableau associatif) ; null si absent ou invalide. */
function meta_read_json(string $file): ?array
{
    if (!is_file($file)) {
        return null;
    }
    $raw = @file_get_contents($file);
    if (!is_string($raw) || $raw === '') {
        return null;
    }
    try {
        $data = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        error_log('lolhelper: fichier méta illisible : ' . basename($file));
        return null;
    }
    return is_array($data) ? $data : null;
}

/**
 * Patchs résumés valides : patch => [games, updated_at], du plus récent au plus ancien.
 * @return array<string, array{games:int, updated_at:string}>
 */
function meta_read_summary(string $metaDir): array
{
    $summary = meta_read_json($metaDir . '/summary.json');
    $patches = $summary['patches'] ?? null;
    if (!is_array($patches)) {
        return [];
    }
    $clean = [];
    foreach ($patches as $patch => $info) {
        $patch = (string) $patch;
        if (preg_match(META_PATCH_PATTERN, $patch) !== 1 || !is_array($info)) {
            continue;
        }
        $games = $info['games'] ?? null;
        $updated = $info['updated_at'] ?? null;
        if (!is_int($games) || $games < 0 || !is_string($updated)) {
            continue;
        }
        $clean[$patch] = ['games' => $games, 'updated_at' => $updated];
    }
    $out = [];
    foreach (meta_sort_patches(array_map('strval', array_keys($clean))) as $p) {
        $out[$p] = $clean[$p];
    }
    return $out;
}

/**
 * Patch servi : le plus récent s'il a au moins $minGames parties, sinon le précédent s'il en a
 * davantage, sinon le plus récent. null si rien n'est collecté.
 * @param array<string, array{games:int, updated_at:string}> $patches trié du plus récent au plus ancien
 */
function meta_pick_patch(array $patches, int $minGames): ?string
{
    $order = [];
    foreach ($patches as $p => $info) {
        if ($info['games'] > 0) {
            $order[] = (string) $p;
        }
    }
    if (!$order) {
        return null;
    }
    $latest = $order[0];
    if ($patches[$latest]['games'] >= $minGames || !isset($order[1])) {
        return $latest;
    }
    $previous = $order[1];
    return $patches[$previous]['games'] > $patches[$latest]['games'] ? $previous : $latest;
}

/**
 * Résumé pour la route meta : {patch, games, updated_at} du patch servi, ou null.
 * @return array{patch:string, games:int, updated_at:string}|null
 */
function meta_stats_info(?string $dataDir, int $minGames): ?array
{
    if ($dataDir === null) {
        return null;
    }
    $patches = meta_read_summary(meta_dir($dataDir));
    $patch = meta_pick_patch($patches, $minGames);
    if ($patch === null) {
        return null;
    }
    return ['patch' => $patch, 'games' => $patches[$patch]['games'], 'updated_at' => $patches[$patch]['updated_at']];
}

/** Route GET r=meta-stats (mot de passe déjà vérifié). */
function handle_meta_stats(array $config, string $apiDir): void
{
    $headers = ['Cache-Control' => 'private, max-age=300'];
    $unavailable = ['available' => false, 'games' => 0];
    $dataDir = resolve_data_dir($config, $apiDir);
    $info = meta_stats_info($dataDir, $config['meta_min_games']);
    if ($dataDir === null || $info === null) {
        send_json(200, $unavailable, $headers);
        return;
    }
    $file = meta_dir($dataDir) . '/stats-' . $info['patch'] . '.json';
    $raw = is_file($file) ? @file_get_contents($file) : false;
    $stats = null;
    if (is_string($raw) && $raw !== '') {
        try {
            $stats = json_decode($raw, false, 64, JSON_THROW_ON_ERROR);
        } catch (JsonException $e) {
            $stats = null;
        }
    }
    if (!($stats instanceof stdClass) || !is_int($stats->games ?? null) || $stats->games <= 0) {
        error_log('lolhelper: statistiques méta illisibles pour le patch ' . $info['patch']);
        send_json(200, $unavailable, $headers);
        return;
    }
    $map = static fn (mixed $v): stdClass => $v instanceof stdClass ? $v : new stdClass();
    send_json(200, [
        'available' => true,
        'patch' => $info['patch'],
        'platform' => is_string($stats->platform ?? null) ? $stats->platform : $config['riot_platform'],
        'games' => $stats->games,
        'updated_at' => is_string($stats->updated_at ?? null) ? $stats->updated_at : $info['updated_at'],
        'champions' => $map($stats->champions ?? null),
        'bans' => $map($stats->bans ?? null),
        'matchups' => $map($stats->matchups ?? null),
    ], $headers);
}
