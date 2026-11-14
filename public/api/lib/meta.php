<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

/*
 * Statistiques « méta » par niveau de classement (META_TIERS), collectées par cron/collect-meta.php.
 * Fichiers dans <dossier de données>/meta/ (jamais sous www/ sauf repli api/data protégé) :
 *   state.json                 état du collecteur (v2 : par niveau joueurs de départ, curseur, rotation des
 *                              pages ; niveau suivant du tourniquet, pause 429, patchs conservés, rejets)
 *   summary.json               { v:2, platform, updated_at,
 *                                patches: { "16.19": { games, updated_at } }            (tous niveaux confondus)
 *                                tiers: { "GOLD": { "16.19": { games, updated_at, oldest, newest } } } }
 *   buffer-<NIVEAU>-<patch>.bin  tampon circulaire des X parties les plus récentes (meta_games_per_tier),
 *                              enregistrements binaires de 73 octets triés par date (voir meta_pack_record)
 *   stats-<NIVEAU>-<patch>.json  agrégats recalculés depuis le tampon (format servi par la route meta-stats)
 *   legacy-<patch>.json + seen-<patch>.bin  agrégats d'avant la collecte par niveau (MASTER_PLUS), ajoutés
 *                              aux parties du tampon tant qu'il n'est pas plein, puis supprimés
 *   stats-<patch>.json         ancien format (sans niveau) : lu comme MASTER_PLUS jusqu'à la migration
 *   collect.lock               verrou du collecteur (partagé par le cron et la route meta-collect)
 *   last_run.json              résumé du dernier passage (cron ou site) : stop, requêtes, parties, durée, at, source
 */

const META_PATCH_PATTERN = '/^[0-9]{1,3}\.[0-9]{1,3}$/D';
const META_KEEP_PATCHES = 2;
const META_LOCK_FILE = 'collect.lock';
const META_LAST_RUN_FILE = 'last_run.json';
/** Niveau des données collectées avant la collecte par niveau (fichiers sans niveau). */
const META_LEGACY_TIER = 'MASTER_PLUS';

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

/**
 * Horloge (secondes). Surcharge possible UNIQUEMENT pour les tests : variable d'environnement du processus
 * LOLHELPER_TEST_NOW (instant Unix), lue seulement en ligne de commande ou sous `php -S` ; aucune valeur
 * venant de la requête HTTP n'est prise en compte (même règle que LOLHELPER_RIOT_BASE).
 */
function meta_clock(): int
{
    if (PHP_SAPI === 'cli' || PHP_SAPI === 'cli-server') {
        $v = getenv('LOLHELPER_TEST_NOW', true);
        if (is_string($v) && preg_match('/^[0-9]{9,11}$/D', $v) === 1) {
            return (int) $v;
        }
    }
    return time();
}

/** « 04h–15h » */
function meta_hours_label(array $hours): string
{
    return sprintf('%02dh–%02dh', $hours[0], $hours[1]);
}

/**
 * Plage horaire de la collecte automatique à l'instant $now (heure locale du fuseau de config.php).
 * remaining : secondes avant la fin de la plage si elle est ouverte (null = toujours ouverte, « 00-24 »).
 * @return array{start:int, end:int, open:bool, remaining:?int}
 */
function meta_window(array $config, ?int $now = null): array
{
    $now ??= meta_clock();
    [$start, $end] = $config['meta_hours'];
    $out = ['start' => $start, 'end' => $end, 'open' => true, 'remaining' => null];
    if ($start === 0 && $end === 24) {
        return $out;
    }
    $tz = new DateTimeZone($config['timezone']);
    $local = (new DateTimeImmutable('@' . $now))->setTimezone($tz);
    $hour = (int) $local->format('G');
    $open = $start < $end ? ($hour >= $start && $hour < $end) : ($hour >= $start || $hour < $end);
    $out['open'] = $open;
    if ($open) {
        $close = $local->setTime($end % 24, 0, 0);
        if ($end === 24 || $close->getTimestamp() <= $now) {
            $close = $close->modify('+1 day')->setTime($end % 24, 0, 0);
        }
        $out['remaining'] = max(1, $close->getTimestamp() - $now);
    }
    return $out;
}

/** Date locale « 2026-11-13 » (fuseau de config.php) : jour du tourniquet des niveaux complets. */
function meta_local_day(array $config, ?int $now = null): string
{
    $now ??= meta_clock();
    return (new DateTimeImmutable('@' . $now))->setTimezone(new DateTimeZone($config['timezone']))->format('Y-m-d');
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

/** Une entrée de résumé {games, updated_at[, oldest, newest]} valide, sinon null. */
function meta_clean_summary_entry(mixed $info, bool $withRange): ?array
{
    if (!is_array($info)) {
        return null;
    }
    $games = $info['games'] ?? null;
    $updated = $info['updated_at'] ?? null;
    if (!is_int($games) || $games < 0 || !is_string($updated)) {
        return null;
    }
    $out = ['games' => $games, 'updated_at' => $updated];
    if ($withRange) {
        foreach (['oldest', 'newest'] as $k) {
            $v = $info[$k] ?? null;
            $out[$k] = is_string($v) ? $v : null;
        }
    }
    return $out;
}

/**
 * patch => entrée, du plus récent au plus ancien (patchs invalides ignorés).
 * @return array<string, array<string,mixed>>
 */
function meta_clean_patch_map(mixed $patches, bool $withRange): array
{
    if (!is_array($patches)) {
        return [];
    }
    $clean = [];
    foreach ($patches as $patch => $info) {
        $patch = (string) $patch;
        $entry = meta_clean_summary_entry($info, $withRange);
        if (preg_match(META_PATCH_PATTERN, $patch) === 1 && $entry !== null) {
            $clean[$patch] = $entry;
        }
    }
    $out = [];
    foreach (meta_sort_patches(array_map('strval', array_keys($clean))) as $p) {
        $out[$p] = $clean[$p];
    }
    return $out;
}

/**
 * Patchs conservés, tous niveaux confondus : patch => [games, updated_at], du plus récent au plus ancien.
 * (Ancien résumé sans niveau : ses patchs sont ceux de MASTER_PLUS.)
 * @return array<string, array{games:int, updated_at:string}>
 */
function meta_read_summary(string $metaDir): array
{
    $summary = meta_read_json($metaDir . '/summary.json');
    return meta_clean_patch_map($summary['patches'] ?? null, false);
}

/**
 * Résumé par niveau : niveau => patch => {games, updated_at, oldest, newest} (niveaux dans l'ordre de META_TIERS).
 * Ancien résumé (sans « tiers ») : tout est rattaché à MASTER_PLUS.
 * @return array<string, array<string, array{games:int, updated_at:string, oldest:?string, newest:?string}>>
 */
function meta_read_tier_summary(string $metaDir): array
{
    $summary = meta_read_json($metaDir . '/summary.json');
    if ($summary === null) {
        return [];
    }
    if (!is_array($summary['tiers'] ?? null)) {
        $legacy = meta_clean_patch_map($summary['patches'] ?? null, true);
        return $legacy ? [META_LEGACY_TIER => $legacy] : [];
    }
    $out = [];
    foreach (META_TIERS as $tier) {
        $patches = meta_clean_patch_map($summary['tiers'][$tier] ?? null, true);
        if ($patches) {
            $out[$tier] = $patches;
        }
    }
    return $out;
}

/**
 * Niveau servi par défaut : MASTER_PLUS s'il a des parties, sinon celui qui en a le plus (à égalité, le plus haut).
 * @param array<string, array<string, array{games:int}>> $tiers
 */
function meta_default_tier(array $tiers): ?string
{
    $best = null;
    $bestGames = 0;
    foreach (META_TIERS as $tier) {
        $games = array_sum(array_map(static fn (array $i): int => $i['games'], $tiers[$tier] ?? []));
        if ($tier === 'MASTER_PLUS' && $games > 0) {
            return $tier;
        }
        if ($games > 0 && $games >= $bestGames) {
            $best = $tier;
            $bestGames = $games;
        }
    }
    return $best;
}

/** Fichier d'agrégats d'un niveau et d'un patch (ancien nom sans niveau pour MASTER_PLUS non migré) ; null si absent. */
function meta_stats_file(string $metaDir, string $tier, string $patch): ?string
{
    $file = $metaDir . "/stats-$tier-$patch.json";
    if (is_file($file)) {
        return $file;
    }
    $old = $metaDir . "/stats-$patch.json";
    return ($tier === META_LEGACY_TIER && is_file($old)) ? $old : null;
}

/**
 * Résumé des patchs sous forme de liste pour le site.
 * @param array<string, array{games:int, updated_at:string}> $patches
 * @return list<array{patch:string, games:int, updated_at:string}>
 */
function meta_patch_list(array $patches): array
{
    $out = [];
    foreach ($patches as $p => $info) {
        $out[] = ['patch' => (string) $p, 'games' => $info['games'], 'updated_at' => $info['updated_at']];
    }
    return $out;
}

/**
 * Patch le plus récent et liste des patchs conservés d'un dossier de données (null = aucun), tous niveaux confondus.
 * @return array{patch:?string, games:int, patches:list<array{patch:string, games:int, updated_at:string}>}
 */
function meta_dir_overview(?string $dataDir): array
{
    $patches = $dataDir !== null ? meta_read_summary(meta_dir($dataDir)) : [];
    $latest = array_key_first($patches);
    return [
        'patch' => $latest !== null ? (string) $latest : null,
        'games' => $latest !== null ? $patches[$latest]['games'] : 0,
        'patches' => meta_patch_list($patches),
    ];
}

/**
 * Avancement par niveau sur le patch courant (le plus récent conservé) : niveaux suivis par config.php et
 * niveaux ayant des données, dans l'ordre de META_TIERS.
 * @return list<array{tier:string, patch:?string, games:int, target:int, oldest:?string, newest:?string}>
 */
function meta_tier_progress(array $config, ?string $metaDir): array
{
    $tiers = $metaDir !== null ? meta_read_tier_summary($metaDir) : [];
    $current = $metaDir !== null ? array_key_first(meta_read_summary($metaDir)) : null;
    $out = [];
    foreach (META_TIERS as $tier) {
        if (!in_array($tier, $config['meta_tiers'], true) && !isset($tiers[$tier])) {
            continue;
        }
        $info = $current !== null ? ($tiers[$tier][(string) $current] ?? null) : null;
        $out[] = [
            'tier' => $tier,
            'patch' => $current !== null ? (string) $current : null,
            'games' => $info['games'] ?? 0,
            'target' => $config['meta_games_per_tier'],
            'oldest' => $info['oldest'] ?? null,
            'newest' => $info['newest'] ?? null,
        ];
    }
    return $out;
}

/**
 * Une collecte tient-elle le verrou ? Sonde par verrou partagé non bloquant, relâché aussitôt
 * (le collecteur réessaie quelques fois si la sonde le gêne).
 */
function meta_lock_held(string $metaDir): bool
{
    $file = $metaDir . '/' . META_LOCK_FILE;
    if (!is_file($file)) {
        return false;
    }
    $h = @fopen($file, 'r');
    if ($h === false) {
        return false;
    }
    $free = flock($h, LOCK_SH | LOCK_NB);
    if ($free) {
        flock($h, LOCK_UN);
    }
    fclose($h);
    return !$free;
}

/** Route GET r=meta-status (mot de passe déjà vérifié). */
function handle_meta_status(array $config, string $apiDir): void
{
    $dataDir = resolve_data_dir($config, $apiDir);
    $metaDir = $dataDir !== null ? meta_dir($dataDir) : null;
    $lastRun = $metaDir !== null ? meta_read_json($metaDir . '/' . META_LAST_RUN_FILE) : null;
    $window = meta_window($config);
    send_json(200, [
        'collecting' => $metaDir !== null && meta_lock_held($metaDir),
        'last_run' => $lastRun,
        'patches' => meta_dir_overview($dataDir)['patches'],
        'admin_enabled' => $config['admin_password'] !== '',
        'meta_enabled' => $config['meta_enabled'],
        'tiers' => meta_tier_progress($config, $metaDir),
        'window' => ['start' => $window['start'], 'end' => $window['end'], 'open' => $window['open']],
    ]);
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
 * Résumé pour la route meta : {patch, tier, games, updated_at} des statistiques servies par défaut
 * (niveau $tier, sinon meta_default_tier), ou null.
 * @return array{patch:string, tier:string, games:int, updated_at:string}|null
 */
function meta_stats_info(?string $dataDir, int $minGames, ?string $tier = null): ?array
{
    if ($dataDir === null) {
        return null;
    }
    $tiers = meta_read_tier_summary(meta_dir($dataDir));
    $tier ??= meta_default_tier($tiers);
    if ($tier === null) {
        return null;
    }
    $patches = $tiers[$tier] ?? [];
    $patch = meta_pick_patch($patches, $minGames);
    if ($patch === null) {
        return null;
    }
    return ['patch' => $patch, 'tier' => $tier, 'games' => $patches[$patch]['games'], 'updated_at' => $patches[$patch]['updated_at']];
}

/**
 * Route GET r=meta-stats[&tier=GOLD][&patch=16.18] (mot de passe déjà vérifié).
 * tier : un niveau de META_TIERS (anciens CHALLENGER/GRANDMASTER/MASTER = MASTER_PLUS), par défaut
 * MASTER_PLUS s'il a des parties, sinon le niveau qui en a le plus.
 * Sans patch : patch servi par meta_pick_patch ; avec : un des patchs conservés du niveau (sinon 404).
 */
function handle_meta_stats(array $config, string $apiDir): void
{
    $headers = ['Cache-Control' => 'private, max-age=300'];
    $requestedTier = null;
    if (array_key_exists('tier', $_GET)) {
        $requestedTier = meta_normalize_tier(query_string('tier'));
        if ($requestedTier === null) {
            throw new HttpError(400, 'Niveau invalide (attendu : ' . implode(', ', META_TIERS) . ').');
        }
    }
    $requested = null;
    if (array_key_exists('patch', $_GET)) {
        $requested = query_string('patch');
        if ($requested === null || preg_match(META_PATCH_PATTERN, $requested) !== 1) {
            throw new HttpError(400, 'Patch invalide (format attendu : 16.19).');
        }
    }
    $dataDir = resolve_data_dir($config, $apiDir);
    $metaDir = $dataDir !== null ? meta_dir($dataDir) : null;
    $tiers = $metaDir !== null ? meta_read_tier_summary($metaDir) : [];
    $tier = $requestedTier ?? meta_default_tier($tiers);
    $unavailable = ['available' => false, 'games' => 0, 'tier' => $tier];
    if ($requested !== null) {
        $patches = $tier !== null ? ($tiers[$tier] ?? []) : [];
        if (!isset($patches[$requested])) {
            throw new HttpError(404, 'Patch non disponible pour ce niveau : seuls les ' . META_KEEP_PATCHES . ' patchs les plus récents sont conservés.');
        }
        $info = ['patch' => $requested] + $patches[$requested];
    } else {
        $info = $tier !== null ? meta_stats_info($dataDir, $config['meta_min_games'], $tier) : null;
    }
    if ($metaDir === null || $tier === null || $info === null) {
        send_json(200, $unavailable, $headers);
        return;
    }
    $file = meta_stats_file($metaDir, $tier, $info['patch']);
    $raw = $file !== null ? @file_get_contents($file) : false;
    $stats = null;
    if (is_string($raw) && $raw !== '') {
        try {
            $stats = json_decode($raw, false, 64, JSON_THROW_ON_ERROR);
        } catch (JsonException $e) {
            $stats = null;
        }
    }
    if (!($stats instanceof stdClass) || !is_int($stats->games ?? null) || $stats->games <= 0) {
        error_log("lolhelper: statistiques méta illisibles pour $tier, patch " . $info['patch']);
        send_json(200, $unavailable, $headers);
        return;
    }
    $map = static fn (mixed $v): stdClass => $v instanceof stdClass ? $v : new stdClass();
    send_json(200, [
        'available' => true,
        'patch' => $info['patch'],
        'tier' => $tier,
        'platform' => is_string($stats->platform ?? null) ? $stats->platform : $config['riot_platform'],
        'games' => $stats->games,
        'updated_at' => is_string($stats->updated_at ?? null) ? $stats->updated_at : $info['updated_at'],
        'champions' => $map($stats->champions ?? null),
        'bans' => $map($stats->bans ?? null),
        'matchups' => $map($stats->matchups ?? null),
    ], $headers);
}
