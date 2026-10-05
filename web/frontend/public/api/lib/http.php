<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

const MAX_BODY_BYTES = 262144; // 256 Ko

/** Erreur destinée au client : statut HTTP + message français. */
final class HttpError extends Exception
{
    /** @var array<string,string> */
    public array $headers;

    /** @param array<string,string> $headers */
    public function __construct(int $status, string $detail, array $headers = [])
    {
        parent::__construct($detail, $status);
        $this->headers = $headers;
    }
}

function json_encode_safe(mixed $data): string
{
    return json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
}

function send_common_headers(): void
{
    if (function_exists('header_remove')) {
        header_remove('X-Powered-By');
    }
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: no-referrer');
    header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
}

/** Envoie un corps JSON déjà encodé. */
function send_raw_json(int $status, string $json, array $headers = []): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    foreach ($headers as $name => $value) {
        header($name . ': ' . $value);
    }
    echo $json;
}

function send_json(int $status, mixed $data, array $headers = []): void
{
    send_raw_json($status, json_encode_safe($data), $headers);
}

function send_no_content(): void
{
    http_response_code(204);
}

function send_error(int $status, string $detail, array $headers = []): void
{
    send_json($status, ['detail' => $detail], $headers);
}

/** Paramètre de requête GET sous forme de chaîne (null si absent ou non scalaire). */
function query_string(string $name): ?string
{
    $value = $_GET[$name] ?? null;
    return is_string($value) ? $value : null;
}

function request_method(): string
{
    $m = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    return is_string($m) ? strtoupper($m) : 'GET';
}

function request_header(string $name): ?string
{
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    $value = $_SERVER[$key] ?? null;
    return is_string($value) ? $value : null;
}

/**
 * En-têtes CORS : seulement si l'Origin figure dans la liste blanche de la config.
 * @param list<string> $allowedOrigins
 */
function apply_cors(array $allowedOrigins): void
{
    if (!$allowedOrigins) {
        return;
    }
    header('Vary: Origin');
    $origin = request_header('Origin');
    if ($origin === null || !in_array($origin, $allowedOrigins, true)) {
        return;
    }
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: GET, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-App-Password');
    header('Access-Control-Expose-Headers: Retry-After');
    header('Access-Control-Max-Age: 600');
}

/** Lit le corps de la requête (256 Ko max, sinon 413). */
function read_body(): string
{
    $length = $_SERVER['CONTENT_LENGTH'] ?? ($_SERVER['HTTP_CONTENT_LENGTH'] ?? null);
    if (is_string($length) && $length !== '' && (!ctype_digit($length) || strlen($length) > 12 || (int) $length > MAX_BODY_BYTES)) {
        throw new HttpError(413, 'Requête trop volumineuse (256 Ko maximum).');
    }
    $in = fopen('php://input', 'rb');
    if ($in === false) {
        throw new RuntimeException('php://input indisponible');
    }
    $body = stream_get_contents($in, MAX_BODY_BYTES + 1);
    fclose($in);
    if ($body === false) {
        throw new RuntimeException('lecture du corps impossible');
    }
    if (strlen($body) > MAX_BODY_BYTES) {
        throw new HttpError(413, 'Requête trop volumineuse (256 Ko maximum).');
    }
    return $body;
}

/** Décode un corps JSON qui doit être un objet ; renvoie un stdClass. */
function read_json_object(): stdClass
{
    $body = read_body();
    try {
        $data = json_decode($body, false, 64, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        throw new HttpError(400, 'Corps JSON invalide.');
    }
    if (!($data instanceof stdClass)) {
        throw new HttpError(400, 'Le corps doit être un objet JSON.');
    }
    return $data;
}
