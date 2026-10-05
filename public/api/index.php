<?php
/**
 * LoLHelper — API PHP (point d'entrée unique) : /api/index.php?r=<route>
 * Voir config.example.php pour la configuration.
 */
declare(strict_types=1);

define('LOLHELPER_API', true);

ini_set('display_errors', '0');
ini_set('serialize_precision', '-1');
error_reporting(E_ALL);

$apiDir = __DIR__;
require $apiDir . '/lib/http.php';
require $apiDir . '/lib/config.php';
require $apiDir . '/lib/storage.php';
require $apiDir . '/lib/riot.php';

send_common_headers();

/** @param list<string> $allowed */
function require_method(array $allowed): void
{
    if (!in_array(request_method(), $allowed, true)) {
        throw new HttpError(405, 'Méthode non autorisée.', ['Allow' => implode(', ', $allowed)]);
    }
}

function handle_request(string $apiDir): void
{
    $config = load_config($apiDir);
    apply_cors($config['cors_origins']);

    $method = request_method();
    if ($method === 'OPTIONS') {
        send_no_content();
        return;
    }

    $route = query_string('r') ?? '';
    if ($route === '' || strlen($route) > 200 || preg_match('#^[A-Za-z0-9/_-]+$#D', $route) !== 1) {
        throw new HttpError(404, 'Route inconnue.');
    }

    if ($route === 'meta') {
        require_method(['GET']);
        $dataDir = resolve_data_dir($config, $apiDir);
        send_json(200, [
            'riot_configured' => $config['riot_api_key'] !== '',
            'platform' => $config['riot_platform'],
            'region' => PLATFORM_REGIONS[$config['riot_platform']],
            'platforms' => array_keys(PLATFORM_REGIONS),
            'password_required' => $config['app_password'] !== '',
            'storage_ok' => storage_probe($dataDir),
        ]);
        return;
    }

    // Toutes les autres routes : mot de passe partagé si configuré.
    if ($config['app_password'] !== '') {
        $given = request_header('X-App-Password') ?? '';
        if (!hash_equals($config['app_password'], $given)) {
            throw new HttpError(401, 'Mot de passe requis ou incorrect.');
        }
    }

    $parts = explode('/', $route);

    if ($parts[0] === 'store' && (count($parts) === 2 || count($parts) === 3)) {
        $collection = $parts[1];
        if (!DocumentStore::isValidCollection($collection)) {
            throw new HttpError(404, 'Collection inconnue.');
        }
        if (count($parts) === 3 && !DocumentStore::isValidId($parts[2])) {
            throw new HttpError(400, 'Identifiant invalide (1 à 64 caractères A-Z, a-z, 0-9 ou -).');
        }
        require_method(count($parts) === 2 ? ['GET'] : ['PUT', 'DELETE']);
        $dataDir = resolve_data_dir($config, $apiDir);
        if ($dataDir === null) {
            throw new HttpError(500, 'Stockage indisponible sur le serveur.');
        }
        $store = new DocumentStore($dataDir);
        if (count($parts) === 2) {
            send_json(200, $store->all($collection));
            return;
        }
        $id = $parts[2];
        if ($method === 'PUT') {
            $doc = read_json_object();
            send_json(200, $store->put($collection, $id, $doc));
            return;
        }
        if (!$store->delete($collection, $id)) {
            throw new HttpError(404, 'Document introuvable.');
        }
        send_no_content();
        return;
    }

    if ($parts[0] === 'riot' && count($parts) === 2
        && in_array($parts[1], ['account', 'summoner', 'league', 'masteries', 'match-ids', 'match'], true)) {
        require_method(['GET']);
        handle_riot($parts[1], $config, $apiDir);
        return;
    }

    throw new HttpError(404, 'Route inconnue.');
}

try {
    handle_request($apiDir);
} catch (HttpError $e) {
    send_error($e->getCode(), $e->getMessage(), $e->headers);
} catch (Throwable $e) {
    error_log('lolhelper: erreur inattendue : ' . get_class($e) . ': ' . $e->getMessage()
        . ' @ ' . $e->getFile() . ':' . $e->getLine());
    if (!headers_sent()) {
        send_error(500, 'Erreur interne du serveur.');
    }
}
