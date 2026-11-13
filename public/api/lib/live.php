<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

/*
 * Draft en direct : données envoyées par le programme compagnon (sélection des champions du client LoL).
 *   PUT r=live-draft                   corps = CompanionPayload, validé strictement puis réécrit sous forme
 *                                      canonique (seuls les champs connus sont conservés) ;
 *   GET r=live-draft&players=<id>,<id> document le plus récent reçu il y a moins de 15 minutes.
 * Stockage : collection interne « live » (jamais exposée par store/…), un document live-<playerId> par joueur.
 */

const LIVE_COLLECTION = 'live';
const LIVE_FRESH_SECONDS = 900; // 15 minutes, horloge du serveur
const LIVE_MAX_QUERY_PLAYERS = 5;
const LIVE_MAX_TEAM = 5;
const LIVE_MAX_BANS = 5;
const LIVE_MAX_ACTIONS = 30;
const LIVE_MAX_STRING = 100;
const LIVE_CHAMPION_KEY_MAX = 2000;
const LIVE_CELL_MIN = -1; // le client utilise -1 pour « aucune cellule »
const LIVE_CELL_MAX = 9;
const LIVE_TIMER_MAX_MS = 3600000;
const LIVE_PHASES = ['planning', 'ban_pick', 'finalization', 'game_starting', 'none'];
const LIVE_POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility', ''];
const LIVE_ACTION_TYPES = ['ban', 'pick'];
const LIVE_SENT_AT_PATTERN = '/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/D';
const LIVE_RECEIVED_AT_PATTERN = '/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/D';

const LIVE_MSG_UNKNOWN_PLAYER = "Ce compte Riot n'est pas dans la liste des joueurs du site.";

function live_invalid(string $field): never
{
    throw new HttpError(400, 'Données du compagnon invalides : ' . $field . '.');
}

function live_int(mixed $v, string $path, int $min, int $max): int
{
    if (!is_int($v) || $v < $min || $v > $max) {
        live_invalid($path);
    }
    return $v;
}

function live_bool(mixed $v, string $path): bool
{
    if (!is_bool($v)) {
        live_invalid($path);
    }
    return $v;
}

/** @param list<string> $allowed */
function live_enum(mixed $v, string $path, array $allowed): string
{
    if (!is_string($v) || !in_array($v, $allowed, true)) {
        live_invalid($path);
    }
    return $v;
}

function live_object(mixed $v, string $path): stdClass
{
    if (!($v instanceof stdClass)) {
        live_invalid($path);
    }
    return $v;
}

/** @return list<mixed> */
function live_list(mixed $v, string $path, int $max): array
{
    if (!is_array($v) || !array_is_list($v) || count($v) > $max) {
        live_invalid($path);
    }
    return $v;
}

function live_champion_key(mixed $v, string $path): int
{
    return live_int($v, $path, 0, LIVE_CHAMPION_KEY_MAX);
}

/** Champ obligatoire d'un objet. */
function live_required(stdClass $o, string $name, string $path): mixed
{
    if (!property_exists($o, $name)) {
        live_invalid($path . $name);
    }
    return $o->$name;
}

/** Champ facultatif : $default s'il est absent (une valeur présente, même null, est validée par l'appelant). */
function live_optional(stdClass $o, string $name, mixed $default): mixed
{
    return property_exists($o, $name) ? $o->$name : $default;
}

/** puuid facultatif d'une cellule (alliée ou adverse) : absent/null -> "", sinon "" ou un puuid Riot valide. */
function live_slot_puuid(stdClass $slot, string $path): string
{
    $puuid = live_optional($slot, 'puuid', '');
    if ($puuid === null) {
        $puuid = '';
    }
    if (!is_string($puuid) || ($puuid !== '' && preg_match(RIOT_PUUID_PATTERN, $puuid) !== 1)) {
        live_invalid($path . '.puuid');
    }
    return $puuid;
}

/** @return list<int> */
function live_key_list(mixed $v, string $path, int $max): array
{
    $out = [];
    foreach (live_list($v, $path, $max) as $i => $key) {
        $out[] = live_champion_key($key, $path . '[' . $i . ']');
    }
    return $out;
}

/**
 * Valide le CompanionPayload et renvoie sa forme canonique (champs inconnus ignorés : en particulier, rien
 * d'autre que la cellule, le puuid et le champion n'est conservé pour l'équipe adverse ; ce puuid est ""
 * sauf quand le client League affiche lui-même les adversaires — Clash, tournoi, partie personnalisée).
 */
function live_validate_payload(stdClass $p): stdClass
{
    if (live_required($p, 'version', '') !== 1) {
        live_invalid('version');
    }
    $puuid = live_required($p, 'puuid', '');
    if (!is_string($puuid) || preg_match(RIOT_PUUID_PATTERN, $puuid) !== 1) {
        live_invalid('puuid');
    }
    $phase = live_enum(live_required($p, 'phase', ''), 'phase', LIVE_PHASES);

    $queueId = live_optional($p, 'queue_id', null);
    if ($queueId !== null) {
        $queueId = live_int($queueId, 'queue_id', -1, 99999);
    }
    $localCell = live_optional($p, 'local_cell', null);
    if ($localCell !== null) {
        $localCell = live_int($localCell, 'local_cell', LIVE_CELL_MIN, LIVE_CELL_MAX);
    }

    $myTeam = [];
    foreach (live_list(live_optional($p, 'my_team', []), 'my_team', LIVE_MAX_TEAM) as $i => $raw) {
        $path = 'my_team[' . $i . ']';
        $slot = live_object($raw, $path);
        $myTeam[] = [
            'cell' => live_int(live_required($slot, 'cell', $path . '.'), $path . '.cell', 0, LIVE_CELL_MAX),
            'puuid' => live_slot_puuid($slot, $path),
            'champion_key' => live_champion_key(live_optional($slot, 'champion_key', 0), $path . '.champion_key'),
            'intent_key' => live_champion_key(live_optional($slot, 'intent_key', 0), $path . '.intent_key'),
            'position' => live_enum(live_optional($slot, 'position', ''), $path . '.position', LIVE_POSITIONS),
        ];
    }

    $theirTeam = [];
    foreach (live_list(live_optional($p, 'their_team', []), 'their_team', LIVE_MAX_TEAM) as $i => $raw) {
        $path = 'their_team[' . $i . ']';
        $slot = live_object($raw, $path);
        $theirTeam[] = [
            'cell' => live_int(live_required($slot, 'cell', $path . '.'), $path . '.cell', 0, LIVE_CELL_MAX),
            'puuid' => live_slot_puuid($slot, $path),
            'champion_key' => live_champion_key(live_optional($slot, 'champion_key', 0), $path . '.champion_key'),
        ];
    }

    $bansRaw = live_optional($p, 'bans', null);
    $bans = (object) ['mine' => [], 'theirs' => []];
    if ($bansRaw !== null) {
        $bansObj = live_object($bansRaw, 'bans');
        $bans->mine = live_key_list(live_optional($bansObj, 'mine', []), 'bans.mine', LIVE_MAX_BANS);
        $bans->theirs = live_key_list(live_optional($bansObj, 'theirs', []), 'bans.theirs', LIVE_MAX_BANS);
    }

    $actions = [];
    foreach (live_list(live_optional($p, 'actions', []), 'actions', LIVE_MAX_ACTIONS) as $i => $raw) {
        $path = 'actions[' . $i . ']';
        $a = live_object($raw, $path);
        $actions[] = [
            'type' => live_enum(live_required($a, 'type', $path . '.'), $path . '.type', LIVE_ACTION_TYPES),
            'champion_key' => live_champion_key(live_optional($a, 'champion_key', 0), $path . '.champion_key'),
            'completed' => live_bool(live_optional($a, 'completed', false), $path . '.completed'),
            'ally' => live_bool(live_required($a, 'ally', $path . '.'), $path . '.ally'),
            'cell' => live_int(live_optional($a, 'cell', -1), $path . '.cell', LIVE_CELL_MIN, LIVE_CELL_MAX),
            'in_progress' => live_bool(live_optional($a, 'in_progress', false), $path . '.in_progress'),
        ];
    }

    $timer = live_optional($p, 'timer_remaining_ms', null);
    if ($timer !== null) {
        if ((!is_int($timer) && !is_float($timer)) || !is_finite((float) $timer) || abs((float) $timer) > LIVE_TIMER_MAX_MS) {
            live_invalid('timer_remaining_ms');
        }
        $timer = max(0, (int) round((float) $timer)); // un léger négatif (fin de phase) vaut 0
    }

    $sentAt = live_optional($p, 'sent_at', null);
    if ($sentAt !== null && (!is_string($sentAt) || strlen($sentAt) > LIVE_MAX_STRING
        || preg_match(LIVE_SENT_AT_PATTERN, $sentAt) !== 1)) {
        live_invalid('sent_at');
    }

    return (object) [
        'version' => 1,
        'puuid' => $puuid,
        'phase' => $phase,
        'queue_id' => $queueId,
        'local_cell' => $localCell,
        'my_team' => $myTeam,
        'their_team' => $theirTeam,
        'bans' => $bans,
        'actions' => $actions,
        'timer_remaining_ms' => $timer,
        'sent_at' => $sentAt,
    ];
}

/** Horodatage serveur ISO 8601 UTC à la milliseconde (ordre lexicographique = ordre chronologique). */
function live_now_iso(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
}

/** Liste d'identifiants de joueurs du paramètre players (1 à 5, sans doublon). @return list<string> */
function live_query_players(): array
{
    $raw = query_string('players');
    if ($raw === null || $raw === '' || strlen($raw) > 400) {
        throw new HttpError(400, 'Paramètre players invalide (1 à 5 identifiants séparés par des virgules).');
    }
    $ids = array_values(array_unique(explode(',', $raw)));
    if (count($ids) > LIVE_MAX_QUERY_PLAYERS) {
        throw new HttpError(400, 'Paramètre players invalide (1 à 5 identifiants séparés par des virgules).');
    }
    foreach ($ids as $id) {
        if (!DocumentStore::isValidId($id)) {
            throw new HttpError(400, 'Paramètre players invalide (1 à 5 identifiants séparés par des virgules).');
        }
    }
    return $ids;
}

/** Route live-draft (GET ou PUT, mot de passe déjà vérifié). */
function handle_live_draft(array $config, string $apiDir): void
{
    require_method(['GET', 'PUT']);
    $isPut = request_method() === 'PUT';
    $ids = $isPut ? [] : live_query_players();
    $dataDir = resolve_data_dir($config, $apiDir);
    if ($dataDir === null) {
        throw new HttpError(500, 'Stockage indisponible sur le serveur.');
    }
    $store = new DocumentStore($dataDir);
    if ($isPut) {
        live_put($store);
    } else {
        live_get($store, $ids);
    }
}

function live_put(DocumentStore $store): void
{
    $payload = live_validate_payload(read_json_object());

    $playerId = null;
    foreach ($store->all('players') as $player) {
        $id = $player->id ?? null;
        if (($player->puuid ?? null) === $payload->puuid && is_string($id) && DocumentStore::isValidId($id)) {
            $playerId = $id;
            break;
        }
    }
    if ($playerId === null) {
        throw new HttpError(404, LIVE_MSG_UNKNOWN_PLAYER);
    }

    $payload->player_id = $playerId;
    $payload->received_at = live_now_iso();
    $store->put(LIVE_COLLECTION, 'live-' . $playerId, $payload);
    send_json(200, ['ok' => true, 'player_id' => $playerId]);
}

/** @param list<string> $ids */
function live_get(DocumentStore $store, array $ids): void
{
    $wanted = [];
    foreach ($ids as $id) {
        $wanted['live-' . $id] = $id;
    }
    $now = time();
    $best = null;
    foreach ($store->all(LIVE_COLLECTION) as $doc) {
        $docId = $doc->id ?? null;
        if (!is_string($docId) || !isset($wanted[$docId]) || ($doc->player_id ?? null) !== $wanted[$docId]) {
            continue;
        }
        $at = $doc->received_at ?? null;
        if (!is_string($at) || preg_match(LIVE_RECEIVED_AT_PATTERN, $at) !== 1) {
            continue;
        }
        $ts = strtotime($at);
        if ($ts === false || $now - $ts >= LIVE_FRESH_SECONDS || $ts > $now + 60) {
            continue;
        }
        if ($best === null || strcmp($at, $best->received_at) > 0) {
            $best = $doc;
        }
    }
    if ($best !== null) {
        unset($best->id);
    }
    send_json(200, ['live' => $best]);
}
