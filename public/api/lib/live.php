<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

/*
 * Draft en direct : données envoyées par le programme compagnon (sélection des champions du client LoL).
 *   PUT r=live-draft                   corps = CompanionPayload (v1 ou v2), validé strictement puis réécrit
 *                                      sous forme canonique (seuls les champs connus sont conservés) ;
 *   GET r=live-draft&players=<id>,<id> document le plus récent reçu il y a moins de 15 minutes.
 * Stockage : collection interne « live » (jamais exposée par store/…), un document live-<playerId> par joueur.
 *
 * v2 : le client League (LCU) fournit des puuid « bruts » (UUID), différents des puuid chiffrés de l'API
 * Riot enregistrés pour les joueurs du site : on reconnaît donc les joueurs par identifiant Riot
 * (riot_id = {game_name, tag_line}, comparaison insensible à la casse). Le joueur local par son riot_id
 * (puis, à défaut, par égalité exacte du puuid) ; chaque allié reçoit player_id quand son riot_id (affiché
 * par le client) est celui d'un joueur du site, puis son riot_id et son puuid sont supprimés avant
 * stockage : le nom d'un coéquipier qui n'est pas un de nos joueurs n'est jamais conservé. Adversaires :
 * le riot_id affiché par le client (Clash, tournoi, personnalisée) est conservé, le puuid brut supprimé.
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

const LIVE_VERSIONS = [1, 2];
// puuid tel que le client League le fournit (v2 : UUID ou autre) ; RIOT_PUUID_PATTERN reste la règle des
// vrais appels à l'API Riot (et des payloads v1).
const LIVE_LCU_PUUID_PATTERN = '/^[A-Za-z0-9_-]{8,100}$/D';
const LIVE_RIOT_ID_MAX_GAME_NAME = 32;
const LIVE_RIOT_ID_MAX_TAG_LINE = 8;
// Contrôle (Cc), format/invisibles (Cf), séparateurs de ligne/paragraphe, « # » : interdits dans un riot_id.
const LIVE_RIOT_ID_FORBIDDEN = '/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}#]/u';

const LIVE_MSG_UNKNOWN_PLAYER = "Ce compte Riot n'est pas dans la liste des joueurs du site.";

function live_msg_unknown_riot_id(array $riotId): string
{
    return 'Le compte ' . $riotId['game_name'] . '#' . $riotId['tag_line'] . " n'est pas dans la liste des joueurs du site.";
}

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

/**
 * puuid facultatif d'une cellule (alliée ou adverse) : absent/null -> "", sinon "" ou un puuid valide
 * ($pattern : RIOT_PUUID_PATTERN en v1, LIVE_LCU_PUUID_PATTERN en v2).
 */
function live_slot_puuid(stdClass $slot, string $path, string $pattern = RIOT_PUUID_PATTERN): string
{
    $puuid = live_optional($slot, 'puuid', '');
    if ($puuid === null) {
        $puuid = '';
    }
    if (!is_string($puuid) || ($puuid !== '' && preg_match($pattern, $puuid) !== 1)) {
        live_invalid($path . '.puuid');
    }
    return $puuid;
}

/** Nombre de caractères d'une chaîne UTF-8 valide (sans dépendre de mbstring). */
function live_strlen(string $s): int
{
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : (int) preg_match_all('/./us', $s);
}

/** Forme de comparaison d'un nom ou d'un tag : sans espaces autour, en minuscules (Unicode si possible). */
function live_fold(string $s): string
{
    $s = trim($s);
    return function_exists('mb_strtolower') ? mb_strtolower($s, 'UTF-8') : strtolower($s);
}

/** Une partie d'identifiant Riot : texte UTF-8 sans caractère interdit, non vide une fois les espaces autour retirés. */
function live_riot_id_part(mixed $v, string $path, int $max): string
{
    if (!is_string($v) || strlen($v) > 4 * $max + 16 || preg_match('//u', $v) !== 1
        || preg_match(LIVE_RIOT_ID_FORBIDDEN, $v) === 1) {
        live_invalid($path);
    }
    $v = trim($v, ' '); // les caractères de contrôle (NUL, tabulation...) sont refusés, pas retirés
    if ($v === '' || live_strlen($v) > $max) {
        live_invalid($path);
    }
    return $v;
}

/** riot_id {game_name, tag_line} validé, ou null (valeur null). @return array{game_name:string,tag_line:string}|null */
function live_riot_id(mixed $v, string $path): ?array
{
    if ($v === null) {
        return null;
    }
    $o = live_object($v, $path);
    return [
        'game_name' => live_riot_id_part(live_required($o, 'game_name', $path . '.'), $path . '.game_name', LIVE_RIOT_ID_MAX_GAME_NAME),
        'tag_line' => live_riot_id_part(live_required($o, 'tag_line', $path . '.'), $path . '.tag_line', LIVE_RIOT_ID_MAX_TAG_LINE),
    ];
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
 * Valide le CompanionPayload (v1 ou v2) et renvoie sa forme canonique (champs inconnus ignorés).
 * v1 : puuid au format de l'API Riot ; équipe adverse = cellule, puuid ("" sauf Clash/tournoi/personnalisée)
 *      et champion.
 * v2 : puuid du client League (LIVE_LCU_PUUID_PATTERN, ou "") + riot_id du joueur local (obligatoire,
 *      null seulement avec un puuid) ; my_team garde provisoirement riot_id/puuid pour la reconnaissance des
 *      amis (live_map_allies les supprime) ; équipe adverse = cellule, riot_id affiché et champion.
 */
function live_validate_payload(stdClass $p): stdClass
{
    $version = live_required($p, 'version', '');
    if (!is_int($version) || !in_array($version, LIVE_VERSIONS, true)) {
        live_invalid('version');
    }
    $v2 = $version === 2;
    $puuidPattern = $v2 ? LIVE_LCU_PUUID_PATTERN : RIOT_PUUID_PATTERN;
    $puuid = live_required($p, 'puuid', '');
    if (!is_string($puuid) || (($puuid !== '' || !$v2) && preg_match($puuidPattern, $puuid) !== 1)) {
        live_invalid('puuid');
    }
    $riotId = null;
    if ($v2) {
        $riotId = live_riot_id(live_required($p, 'riot_id', ''), 'riot_id');
        if ($riotId === null && $puuid === '') {
            live_invalid('riot_id');
        }
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
            'puuid' => live_slot_puuid($slot, $path, $puuidPattern),
            'riot_id' => $v2 ? live_riot_id(live_optional($slot, 'riot_id', null), $path . '.riot_id') : null,
            'champion_key' => live_champion_key(live_optional($slot, 'champion_key', 0), $path . '.champion_key'),
            'intent_key' => live_champion_key(live_optional($slot, 'intent_key', 0), $path . '.intent_key'),
            'position' => live_enum(live_optional($slot, 'position', ''), $path . '.position', LIVE_POSITIONS),
        ];
    }

    $theirTeam = [];
    foreach (live_list(live_optional($p, 'their_team', []), 'their_team', LIVE_MAX_TEAM) as $i => $raw) {
        $path = 'their_team[' . $i . ']';
        $slot = live_object($raw, $path);
        $cell = live_int(live_required($slot, 'cell', $path . '.'), $path . '.cell', 0, LIVE_CELL_MAX);
        $enemyPuuid = live_slot_puuid($slot, $path, $puuidPattern);
        $championKey = live_champion_key(live_optional($slot, 'champion_key', 0), $path . '.champion_key');
        if ($v2) {
            // Le puuid brut du client ne sert à rien pour l'API Riot : seul le nom affiché par le client est gardé.
            $entry = ['cell' => $cell];
            $enemyRiotId = live_riot_id(live_optional($slot, 'riot_id', null), $path . '.riot_id');
            if ($enemyRiotId !== null) {
                $entry['riot_id'] = $enemyRiotId;
            }
            $entry['champion_key'] = $championKey;
            $theirTeam[] = $entry;
        } else {
            $theirTeam[] = ['cell' => $cell, 'puuid' => $enemyPuuid, 'champion_key' => $championKey];
        }
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

    $out = [
        'version' => $version,
        'puuid' => $puuid,
    ];
    if ($v2) {
        $out['riot_id'] = $riotId;
    }
    return (object) ($out + [
        'phase' => $phase,
        'queue_id' => $queueId,
        'local_cell' => $localCell,
        'my_team' => $myTeam,
        'their_team' => $theirTeam,
        'bans' => $bans,
        'actions' => $actions,
        'timer_remaining_ms' => $timer,
        'sent_at' => $sentAt,
    ]);
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

/** Joueurs du site utilisables (identifiant valide). @return list<stdClass> */
function live_players(DocumentStore $store): array
{
    $out = [];
    foreach ($store->all('players') as $player) {
        $id = $player->id ?? null;
        if (is_string($id) && DocumentStore::isValidId($id)) {
            $out[] = $player;
        }
    }
    return $out;
}

/** @param list<stdClass> $players @param array{game_name:string,tag_line:string}|null $riotId */
function live_player_by_riot_id(array $players, ?array $riotId): ?string
{
    if ($riotId === null) {
        return null;
    }
    $gn = live_fold($riotId['game_name']);
    $tl = live_fold($riotId['tag_line']);
    foreach ($players as $player) {
        $pgn = $player->game_name ?? null;
        $ptl = $player->tag_line ?? null;
        if (is_string($pgn) && is_string($ptl) && live_fold($pgn) === $gn && live_fold(ltrim(trim($ptl), '#')) === $tl) {
            return $player->id;
        }
    }
    return null;
}

/** Égalité exacte du puuid (v1, et secours v2). @param list<stdClass> $players */
function live_player_by_puuid(array $players, string $puuid): ?string
{
    if ($puuid === '') {
        return null;
    }
    foreach ($players as $player) {
        if (($player->puuid ?? null) === $puuid) {
            return $player->id;
        }
    }
    return null;
}

/**
 * player_id de chaque allié (cellule locale -> joueur local ; sinon riot_id en v2, puuid en v1), chaque
 * joueur au plus une fois. v2 : riot_id et puuid des alliés supprimés (seul player_id est conservé).
 * @param list<stdClass> $players
 * @return list<array<string,mixed>>
 */
function live_map_allies(stdClass $payload, array $players, string $localId): array
{
    $v2 = $payload->version === 2;
    $ids = [];
    $used = [];
    foreach ($payload->my_team as $i => $slot) {
        if ($payload->local_cell !== null && $slot['cell'] === $payload->local_cell && !isset($used[$localId])) {
            $ids[$i] = $localId;
            $used[$localId] = true;
        }
    }
    foreach ($payload->my_team as $i => $slot) {
        if (isset($ids[$i])) {
            continue;
        }
        $id = $v2 ? live_player_by_riot_id($players, $slot['riot_id']) : live_player_by_puuid($players, $slot['puuid']);
        if ($id !== null && !isset($used[$id])) {
            $ids[$i] = $id;
            $used[$id] = true;
        }
    }
    $out = [];
    foreach ($payload->my_team as $i => $slot) {
        $entry = ['cell' => $slot['cell'], 'player_id' => $ids[$i] ?? null];
        if (!$v2) {
            $entry['puuid'] = $slot['puuid'];
        }
        $out[] = $entry + [
            'champion_key' => $slot['champion_key'],
            'intent_key' => $slot['intent_key'],
            'position' => $slot['position'],
        ];
    }
    return $out;
}

function live_put(DocumentStore $store): void
{
    $payload = live_validate_payload(read_json_object());
    $players = live_players($store);

    $riotId = $payload->riot_id ?? null;
    $playerId = live_player_by_riot_id($players, $riotId) ?? live_player_by_puuid($players, $payload->puuid);
    if ($playerId === null) {
        throw new HttpError(404, $riotId !== null ? live_msg_unknown_riot_id($riotId) : LIVE_MSG_UNKNOWN_PLAYER);
    }

    $payload->my_team = live_map_allies($payload, $players, $playerId);
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
