<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

const STORE_COLLECTIONS = ['players', 'teams', 'saved'];
const STORE_MAX_DOCS = 500;
const STORE_ID_PATTERN = '/^[A-Za-z0-9-]{1,64}$/D';

/** Crée (0700) et vérifie un dossier inscriptible. */
function ensure_writable_dir(string $dir): bool
{
    if (!is_dir($dir)) {
        $old = umask(0077);
        $ok = @mkdir($dir, 0700, true);
        umask($old);
        if (!$ok && !is_dir($dir)) {
            return false;
        }
    }
    return is_writable($dir);
}

/**
 * Dossier de données : config data_dir, sinon <home>/lolhelper-data (hors www/),
 * et en dernier recours <api>/data/ (protégé par .htaccess). null si rien n'est inscriptible.
 */
function resolve_data_dir(array $config, string $apiDir): ?string
{
    static $cache = [];
    $cacheKey = ($config['data_dir'] ?? '') . "\0" . $apiDir;
    if (array_key_exists($cacheKey, $cache)) {
        return $cache[$cacheKey];
    }
    $primary = $config['data_dir'] ?? (dirname($apiDir, 2) . DIRECTORY_SEPARATOR . 'lolhelper-data');
    $result = null;
    if (ensure_writable_dir($primary)) {
        $result = $primary;
    } else {
        $fallback = $apiDir . DIRECTORY_SEPARATOR . 'data';
        if (ensure_writable_dir($fallback)) {
            protect_web_dir($fallback);
            $result = $fallback;
        } else {
            error_log('lolhelper: aucun dossier de données inscriptible');
        }
    }
    $cache[$cacheKey] = $result;
    return $result;
}

/** Ajoute un .htaccess « tout refuser » et un index vide dans un dossier situé sous www/. */
function protect_web_dir(string $dir): void
{
    $ht = $dir . '/.htaccess';
    if (!is_file($ht)) {
        @file_put_contents(
            $ht,
            "Options -Indexes\n<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
            . "<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n"
        );
    }
    $index = $dir . '/index.html';
    if (!is_file($index)) {
        @file_put_contents($index, '');
    }
}

/** Vérifie qu'une écriture réelle fonctionne dans le dossier de données. */
function storage_probe(?string $dir): bool
{
    if ($dir === null) {
        return false;
    }
    $probe = $dir . '/.probe-' . bin2hex(random_bytes(6));
    $ok = @file_put_contents($probe, 'ok') === 2;
    @unlink($probe);
    return $ok;
}

/** Écriture atomique : fichier temporaire dans le même dossier puis rename. */
function write_atomic(string $path, string $content): void
{
    $tmp = $path . '.tmp-' . bin2hex(random_bytes(8));
    $written = @file_put_contents($tmp, $content);
    if ($written !== strlen($content)) {
        @unlink($tmp);
        throw new RuntimeException('écriture impossible : ' . $tmp);
    }
    @chmod($tmp, 0600);
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException('rename impossible : ' . $path);
    }
}

final class DocumentStore
{
    private string $dir;

    public function __construct(string $dir)
    {
        $this->dir = $dir;
    }

    public static function isValidCollection(string $c): bool
    {
        return in_array($c, STORE_COLLECTIONS, true);
    }

    public static function isValidId(string $id): bool
    {
        return preg_match(STORE_ID_PATTERN, $id) === 1;
    }

    /** @return list<stdClass> */
    public function all(string $collection): array
    {
        return $this->withLock($collection, LOCK_SH, function (string $file): array {
            return $this->readDocs($file);
        });
    }

    public function put(string $collection, string $id, stdClass $doc): stdClass
    {
        $doc->id = $id;
        return $this->withLock($collection, LOCK_EX, function (string $file) use ($id, $doc): stdClass {
            $docs = $this->readDocs($file);
            $found = false;
            foreach ($docs as $i => $existing) {
                if (($existing->id ?? null) === $id) {
                    $docs[$i] = $doc;
                    $found = true;
                    break;
                }
            }
            if (!$found) {
                if (count($docs) >= STORE_MAX_DOCS) {
                    throw new HttpError(413, 'Trop de documents dans cette collection (500 maximum).');
                }
                $docs[] = $doc;
            }
            write_atomic($file, json_encode_safe($docs));
            return $doc;
        });
    }

    public function delete(string $collection, string $id): bool
    {
        return $this->withLock($collection, LOCK_EX, function (string $file) use ($id): bool {
            $docs = $this->readDocs($file);
            $kept = [];
            $found = false;
            foreach ($docs as $existing) {
                if (($existing->id ?? null) === $id) {
                    $found = true;
                    continue;
                }
                $kept[] = $existing;
            }
            if ($found) {
                write_atomic($file, json_encode_safe($kept));
            }
            return $found;
        });
    }

    /** @return list<stdClass> */
    private function readDocs(string $file): array
    {
        if (!is_file($file)) {
            return [];
        }
        $raw = file_get_contents($file);
        if ($raw === false) {
            throw new RuntimeException('lecture impossible : ' . $file);
        }
        if (trim($raw) === '') {
            return [];
        }
        $data = json_decode($raw, false, 512, JSON_THROW_ON_ERROR);
        if (!is_array($data)) {
            throw new RuntimeException('fichier de collection corrompu : ' . $file);
        }
        return array_values(array_filter($data, static fn ($d) => $d instanceof stdClass));
    }

    /**
     * @template T
     * @param callable(string):T $fn
     * @return T
     */
    private function withLock(string $collection, int $mode, callable $fn): mixed
    {
        if (!self::isValidCollection($collection)) {
            throw new InvalidArgumentException('collection invalide');
        }
        $file = $this->dir . '/' . $collection . '.json';
        $lock = fopen($this->dir . '/' . $collection . '.lock', 'c');
        if ($lock === false) {
            throw new RuntimeException('verrou impossible : ' . $collection);
        }
        try {
            if (!flock($lock, $mode)) {
                throw new RuntimeException('flock impossible : ' . $collection);
            }
            return $fn($file);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}
