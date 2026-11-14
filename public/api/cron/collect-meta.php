<?php
/**
 * LoLHelper — collecteur des statistiques méta par niveau de classement (Fer à Master+, classé solo).
 *
 * À lancer UNIQUEMENT en ligne de commande, par une tâche planifiée OVH (toutes les heures) :
 *   Commande à exécuter : www/lolhelper/api/cron/collect-meta.php   (chemin depuis la racine FTP)
 *   Langage : PHP 8.1 ou plus récent.
 * Ne travaille que dans la plage horaire meta_hours (par défaut 04h–15h, heure de Paris) : en dehors, le
 * script s'arrête aussitôt. Chaque passage travaille au plus meta_time_budget secondes, sans dépasser la fin
 * de la plage, puis s'arrête ; le suivant reprend où il s'était arrêté. Rythme : meta_rate requêtes/s au plus
 * (0,25 par défaut) et jamais plus de 60 % de chaque fenêtre de la limite de la clé Riot (lue dans les
 * réponses, partagée avec le site). Réglages : config.php (voir config.example.php).
 * Données écrites dans <dossier de données>/meta/ (par défaut ~/lolhelper-data/meta, hors de www/).
 */
declare(strict_types=1);

// Jamais via le web (api/.htaccess refuse déjà tout sauf index.php).
if (PHP_SAPI !== 'cli') {
    if (!isset($_SERVER['REQUEST_METHOD'])) {
        error_log('lolhelper meta: ce script doit être lancé avec PHP en ligne de commande (CLI), SAPI actuel : ' . PHP_SAPI);
    }
    if (!headers_sent()) {
        http_response_code(404);
    }
    exit;
}

define('LOLHELPER_API', true);

ini_set('display_errors', 'stderr');
ini_set('serialize_precision', '-1');
error_reporting(E_ALL);

$apiDir = dirname(__DIR__);
require $apiDir . '/lib/http.php';
require $apiDir . '/lib/config.php';
require $apiDir . '/lib/storage.php';
require $apiDir . '/lib/riot.php';
require $apiDir . '/lib/meta.php';
require $apiDir . '/lib/meta_collector.php';

$start = microtime(true);

$main = static function (string $apiDir, float $start): int {
    $config = load_config($apiDir);
    if (!$config['meta_enabled']) {
        error_log('lolhelper meta: collecte désactivée (meta_enabled = false)');
        return 0;
    }
    // Plage horaire de la collecte automatique (le bouton du site n'y est pas soumis).
    $window = meta_window($config);
    if (!$window['open']) {
        error_log('lolhelper meta: hors plage horaire (' . meta_hours_label($config['meta_hours']) . '), rien à faire');
        return 0;
    }
    if ($window['remaining'] !== null) {
        $config['meta_time_budget'] = max(1, min($config['meta_time_budget'], $window['remaining']));
    }
    if ($config['riot_api_key'] === '') {
        error_log('lolhelper meta: clé API Riot non configurée (config.php)');
        return 1;
    }
    @set_time_limit($config['meta_time_budget'] + 120);

    // Même dossier de données que l'API web : DOCUMENT_ROOT est vide en CLI, on le reconstitue.
    if (($_SERVER['DOCUMENT_ROOT'] ?? '') === '') {
        $_SERVER['DOCUMENT_ROOT'] = meta_cli_document_root($apiDir);
    }
    $dataDir = resolve_data_dir($config, $apiDir);
    if ($dataDir === null) {
        error_log('lolhelper meta: aucun dossier de données inscriptible');
        return 1;
    }
    return (new MetaCollector($config, meta_dir($dataDir), $start))->run();
};

try {
    exit($main($apiDir, $start));
} catch (Throwable $e) {
    error_log('lolhelper meta: erreur inattendue : ' . get_class($e) . ': ' . $e->getMessage()
        . ' @ ' . $e->getFile() . ':' . $e->getLine());
    exit(1);
}
