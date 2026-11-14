<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

/*
 * Collecteur méta par niveau de classement : lancé par cron/collect-meta.php en ligne de commande (seulement
 * dans la plage horaire meta_hours), ou par la route POST r=meta-collect (passage court, mot de passe
 * administrateur, sans restriction d'horaire). Les deux partagent le même verrou.
 *
 * Niveaux (META_TIERS) servis à tour de rôle, un joueur de départ par tour :
 *  - joueurs de départ de MASTER_PLUS : ligues apex (Challenger, Grandmaster, Master) ;
 *  - autres niveaux : league-v4 entries/RANKED_SOLO_5x5/{NIVEAU}/{I..IV}?page=N, la page tournant à chaque
 *    rafraîchissement ; au plus 200 joueurs par niveau, rafraîchis au plus une fois par jour.
 * Une partie compte pour le niveau du joueur par lequel elle a été trouvée. Par niveau et par patch, un tampon
 * circulaire garde les meta_games_per_tier parties les plus récentes (une partie plus récente que la plus ancienne
 * d'un tampon plein la remplace) ; les agrégats servis sont recalculés depuis ce tampon. Un niveau dont le tampon du
 * patch courant est plein de parties des dernières 24 h est laissé de côté jusqu'au lendemain.
 * Rythme : meta_rate requêtes/s au plus (0,25 par défaut) et 60 % de chaque fenêtre de la clé Riot ; sur un 429,
 * pause Retry-After (5 s par défaut, 60 s au plus) puis reprise si le budget de temps le permet.
 */

const META_QUEUE_SOLO = 420;
const META_REMAKE_SECONDS = 300;
const META_SEED_TTL = 86400;
/** Nouvel essai de rafraîchissement des joueurs après un échec (on garde l'ancienne liste en attendant). */
const META_SEED_RETRY = 3600;
const META_MATCH_WINDOW = 3 * 86400;
const META_IDS_PER_PLAYER = 20;
const META_REJECTED_MAX = 5000;
const META_MAX_NETWORK_ERRORS = 5;
const META_DEFAULT_RETRY_AFTER = 5;
const META_MAX_RETRY_AFTER = 60;
const META_SEEDS_PER_TIER = 200;
/** Pages de league-v4 entries parcourues à tour de rôle (une par rafraîchissement, pour chaque division). */
const META_SEED_PAGES = 3;
const META_DIVISIONS = ['I', 'II', 'III', 'IV'];
/** Un tampon plein dont la partie la plus ancienne a moins de 24 h : niveau complet pour la journée. */
const META_RECENT_SECONDS = 86400;
/** Parties lues pendant un passage, réutilisées si un autre niveau les retrouve. */
const META_FETCH_CACHE_MAX = 1000;
/** Enregistrement compact d'une partie (voir meta_pack_record). */
const META_RECORD_SIZE = 73;
const META_ROLE_CODES = ['TOP' => 1, 'JUNGLE' => 2, 'MID' => 3, 'BOTTOM' => 4, 'SUPPORT' => 5];

/** Arrêt propre d'une collecte (budget, clé refusée, 429…). */
final class MetaStop extends Exception
{
    /**
     * @param string $reason message français (ligne de journal)
     * @param string $stop code d'arrêt renvoyé au site : budget, riot_limit, riot_key, riot_down, no_seeds
     * @param int|null $retryAfter secondes de pause demandées par Riot (riot_limit)
     */
    public function __construct(
        string $reason,
        public readonly int $exitCode = 0,
        public readonly string $stop = 'error',
        public readonly ?int $retryAfter = null
    ) {
        parent::__construct($reason);
    }
}

/** Verrou exclusif non bloquant, quelques essais rapprochés (une sonde de meta-status le tient un instant). */
function meta_try_lock($handle): bool
{
    for ($i = 0; $i < 4; $i++) {
        if ($i > 0) {
            usleep(50000);
        }
        if (flock($handle, LOCK_EX | LOCK_NB)) {
            return true;
        }
    }
    return false;
}

/**
 * Ensemble compact d'identifiants numériques de parties (seen-<patch>.bin : parties comptées dans les anciennes
 * statistiques MASTER_PLUS, encore ignorées tant qu'elles comptent) : chaîne triée de blocs 8 octets
 * (entiers non signés big-endian, donc l'ordre des octets = l'ordre numérique) + ajouts en mémoire.
 * 100 000 parties = 800 Ko sur disque comme en mémoire.
 */
final class MetaSeenSet
{
    private string $data = '';
    /** @var array<int, true> */
    private array $added = [];

    public static function load(string $file): self
    {
        $set = new self();
        if (is_file($file)) {
            $raw = @file_get_contents($file);
            if (is_string($raw) && strlen($raw) % 8 === 0) {
                $set->data = $raw;
            } else {
                error_log('lolhelper meta: ' . basename($file) . ' illisible, ensemble réinitialisé');
            }
        }
        return $set;
    }

    public function count(): int
    {
        return intdiv(strlen($this->data), 8) + count($this->added);
    }

    public function has(int $id): bool
    {
        if (isset($this->added[$id])) {
            return true;
        }
        $key = pack('J', $id);
        $pos = $this->lowerBound($key);
        return $pos < intdiv(strlen($this->data), 8) && substr($this->data, $pos * 8, 8) === $key;
    }

    public function add(int $id): void
    {
        if (!$this->has($id)) {
            $this->added[$id] = true;
        }
    }

    /** Fusionne les ajouts (triés) dans la chaîne triée puis écrit le fichier de façon atomique. */
    public function save(string $file): void
    {
        if ($this->added !== []) {
            $ids = array_keys($this->added);
            sort($ids, SORT_NUMERIC);
            $out = '';
            $from = 0;
            foreach ($ids as $id) {
                $key = pack('J', $id);
                $pos = $this->lowerBound($key);
                $out .= substr($this->data, $from * 8, ($pos - $from) * 8) . $key;
                $from = $pos;
            }
            $this->data = $out . substr($this->data, $from * 8);
            $this->added = [];
        }
        write_atomic($file, $this->data);
    }

    /** Première position dont la valeur est >= $key. */
    private function lowerBound(string $key): int
    {
        $lo = 0;
        $hi = intdiv(strlen($this->data), 8);
        while ($lo < $hi) {
            $mid = ($lo + $hi) >> 1;
            if (strcmp(substr($this->data, $mid * 8, 8), $key) < 0) {
                $lo = $mid + 1;
            } else {
                $hi = $mid;
            }
        }
        return $lo;
    }
}

/** Partie numérique d'un identifiant « EUW1_7000000001 » (null si invalide). */
function meta_match_number(mixed $matchId): ?int
{
    if (!is_string($matchId) || preg_match(RIOT_MATCH_ID_PATTERN, $matchId) !== 1) {
        return null;
    }
    return (int) substr($matchId, strpos($matchId, '_') + 1);
}

/** Secondes de pause après un 429 : Retry-After de Riot (5 s s'il manque), entre 1 et 60 s. */
function meta_retry_after_seconds(?string $retryAfter): int
{
    if ($retryAfter === null || preg_match('/^[0-9]{1,5}$/D', trim($retryAfter)) !== 1) {
        return META_DEFAULT_RETRY_AFTER;
    }
    return max(1, min(META_MAX_RETRY_AFTER, (int) trim($retryAfter)));
}

/**
 * Valide une partie Riot (match-v5). Renvoie :
 *  ['skip' => raison]  (invalid, queue, remake)
 *  ['patch' => '16.19', 'created' => secondes, 'players' => list<array{0:int,1:?string,2:int,3:bool}>, 'bans' => list<int>]
 *  avec players = [championId, rôle|null, teamId, victoire].
 */
function meta_parse_match(mixed $match): array
{
    $info = is_array($match) ? ($match['info'] ?? null) : null;
    if (!is_array($info)) {
        return ['skip' => 'invalid'];
    }
    $queue = $info['queueId'] ?? null;
    if (!is_int($queue)) {
        return ['skip' => 'invalid'];
    }
    if ($queue !== META_QUEUE_SOLO) {
        return ['skip' => 'queue'];
    }
    $patch = meta_patch_from_version($info['gameVersion'] ?? null);
    $duration = $info['gameDuration'] ?? null;
    $participants = $info['participants'] ?? null;
    $created = $info['gameCreation'] ?? ($info['gameStartTimestamp'] ?? null);
    $created = is_int($created) ? intdiv($created, 1000) : 0;
    if ($patch === null || !is_int($duration) || $duration < 0 || !is_array($participants) || count($participants) !== 10
        || $created <= 0 || $created > 0xFFFFFFFF) {
        return ['skip' => 'invalid'];
    }
    // Anciennes parties : gameDuration en millisecondes quand gameEndTimestamp est absent.
    if (!array_key_exists('gameEndTimestamp', $info)) {
        $duration = intdiv($duration, 1000);
    }
    if ($duration < META_REMAKE_SECONDS) {
        return ['skip' => 'remake'];
    }

    $players = [];
    $teamWin = [];
    $perTeam = [100 => 0, 200 => 0];
    foreach ($participants as $p) {
        if (!is_array($p)) {
            return ['skip' => 'invalid'];
        }
        $champ = $p['championId'] ?? null;
        $team = $p['teamId'] ?? null;
        $win = $p['win'] ?? null;
        // Clés de champion sur 16 bits (enregistrement compact) : toutes les clés Riot actuelles sont < 1000.
        if (!is_int($champ) || $champ <= 0 || $champ > 0xFFFF || ($team !== 100 && $team !== 200) || !is_bool($win)) {
            return ['skip' => 'invalid'];
        }
        if (($p['gameEndedInEarlySurrender'] ?? false) === true) {
            return ['skip' => 'remake'];
        }
        if (isset($teamWin[$team]) && $teamWin[$team] !== $win) {
            return ['skip' => 'invalid'];
        }
        $teamWin[$team] = $win;
        $perTeam[$team]++;
        $pos = $p['teamPosition'] ?? null;
        $role = is_string($pos) ? (META_ROLE_MAP[$pos] ?? null) : null;
        $players[] = [$champ, $role, $team, $win];
    }
    if ($perTeam[100] !== 5 || $perTeam[200] !== 5 || $teamWin[100] === $teamWin[200]) {
        return ['skip' => 'invalid'];
    }

    $bans = [];
    $teams = $info['teams'] ?? null;
    if (is_array($teams)) {
        foreach ($teams as $t) {
            $list = is_array($t) ? ($t['bans'] ?? null) : null;
            if (!is_array($list)) {
                continue;
            }
            foreach ($list as $b) {
                $c = is_array($b) ? ($b['championId'] ?? null) : null;
                if (is_int($c) && $c > 0 && $c <= 0xFFFF) {
                    $bans[$c] = true; // une seule fois par partie
                }
            }
        }
    }
    return ['patch' => $patch, 'created' => $created, 'players' => $players, 'bans' => array_slice(array_keys($bans), 0, 10)];
}

/**
 * Enregistrement compact (73 octets, entiers big-endian) d'une partie validée par meta_parse_match :
 *   J numéro de partie | N gameCreation (s) | C équipe gagnante (1 = 100, 2 = 200)
 *   10 × [n champion, C rôle (0 = aucun, 1..5 = TOP JUNGLE MID BOTTOM SUPPORT), C équipe (1 | 2)]
 *   10 × n champion banni (0 = vide)
 */
function meta_pack_record(int $n, array $parsed): string
{
    $win = 0;
    $players = '';
    foreach ($parsed['players'] as [$champ, $role, $team, $won]) {
        $code = $team === 100 ? 1 : 2;
        $players .= pack('nCC', $champ, $role === null ? 0 : META_ROLE_CODES[$role], $code);
        if ($won) {
            $win = $code;
        }
    }
    $bans = '';
    for ($i = 0; $i < 10; $i++) {
        $bans .= pack('n', $parsed['bans'][$i] ?? 0);
    }
    return pack('JNC', $n, $parsed['created'], $win) . $players . $bans;
}

/**
 * Relit un enregistrement : même forme que meta_parse_match (players, bans) + n et created.
 * @return array{n:int, created:int, players:list<array{0:int,1:?string,2:int,3:bool}>, bans:list<int>}
 */
function meta_unpack_record(string $rec): array
{
    static $roles = null;
    $roles ??= array_flip(META_ROLE_CODES);
    $h = unpack('Jn/Nt/Cw', $rec);
    $players = [];
    for ($i = 0; $i < 10; $i++) {
        $p = unpack('nc/Cr/Ct', $rec, 13 + $i * 4);
        $players[] = [$p['c'], $roles[$p['r']] ?? null, $p['t'] === 1 ? 100 : 200, $p['t'] === $h['w']];
    }
    $bans = [];
    foreach (unpack('n10', $rec, 53) as $b) {
        if ($b > 0) {
            $bans[] = $b;
        }
    }
    return ['n' => $h['n'], 'created' => $h['t'], 'players' => $players, 'bans' => $bans];
}

/**
 * Ajoute une partie validée aux agrégats d'un patch.
 * champions[champ][rôle] = [parties, victoires] ; bans[champ] += 1 ;
 * matchups[rôle][champ][adversaire] = [parties, victoires de champ] (les deux sens).
 */
function meta_aggregate(array &$stats, array $parsed): void
{
    $stats['games']++;
    $byRole = [];
    foreach ($parsed['players'] as [$champ, $role, $team, $win]) {
        if ($role === null) {
            continue;
        }
        $cell = $stats['champions'][$champ][$role] ?? [0, 0];
        $stats['champions'][$champ][$role] = [$cell[0] + 1, $cell[1] + ($win ? 1 : 0)];
        $byRole[$role][$team][] = [$champ, $win];
    }
    foreach ($parsed['bans'] as $champ) {
        $stats['bans'][$champ] = ($stats['bans'][$champ] ?? 0) + 1;
    }
    foreach ($byRole as $role => $teams) {
        // Exactement un joueur par équipe à ce poste, sinon le duel est ambigu.
        if (count($teams[100] ?? []) !== 1 || count($teams[200] ?? []) !== 1) {
            continue;
        }
        $a = $teams[100][0];
        $b = $teams[200][0];
        if ($a[0] === $b[0]) {
            continue;
        }
        foreach ([[$a, $b], [$b, $a]] as [$me, $them]) {
            $cell = $stats['matchups'][$role][$me[0]][$them[0]] ?? [0, 0];
            $stats['matchups'][$role][$me[0]][$them[0]] = [$cell[0] + 1, $cell[1] + ($me[1] ? 1 : 0)];
        }
    }
}

/** Cellule [parties, victoires] valide. */
function meta_valid_cell(mixed $c): bool
{
    return is_array($c) && count($c) === 2 && is_int($c[0] ?? null) && is_int($c[1] ?? null) && $c[0] >= 0 && $c[1] >= 0;
}

/** Ajoute les agrégats $add (anciennes statistiques relues) à $stats. */
function meta_merge_stats(array $stats, array $add): array
{
    $stats['games'] += $add['games'];
    foreach ($add['champions'] as $champ => $roles) {
        foreach (is_array($roles) ? $roles : [] as $role => $cell) {
            if (meta_valid_cell($cell)) {
                $cur = $stats['champions'][$champ][$role] ?? [0, 0];
                $stats['champions'][$champ][$role] = [$cur[0] + $cell[0], $cur[1] + $cell[1]];
            }
        }
    }
    foreach ($add['bans'] as $champ => $n) {
        if (is_int($n) && $n >= 0) {
            $stats['bans'][$champ] = ($stats['bans'][$champ] ?? 0) + $n;
        }
    }
    foreach ($add['matchups'] as $role => $champs) {
        foreach (is_array($champs) ? $champs : [] as $champ => $opponents) {
            foreach (is_array($opponents) ? $opponents : [] as $opp => $cell) {
                if (meta_valid_cell($cell)) {
                    $cur = $stats['matchups'][$role][$champ][$opp] ?? [0, 0];
                    $stats['matchups'][$role][$champ][$opp] = [$cur[0] + $cell[0], $cur[1] + $cell[1]];
                }
            }
        }
    }
    return $stats;
}

/** Agrégats vides d'un niveau et d'un patch. */
function meta_empty_stats(string $patch, string $platform, ?string $tier = null): array
{
    return [
        'patch' => $patch,
        'tier' => $tier,
        'platform' => $platform,
        'games' => 0,
        'updated_at' => gmdate('Y-m-d\TH:i:s\Z'),
        'champions' => [],
        'bans' => [],
        'matchups' => [],
    ];
}

/**
 * Agrégats recalculés depuis des enregistrements compacts.
 * @param iterable<string> $records
 */
function meta_stats_from_records(iterable $records, string $patch, string $platform, string $tier): array
{
    $stats = meta_empty_stats($patch, $platform, $tier);
    foreach ($records as $rec) {
        meta_aggregate($stats, meta_unpack_record($rec));
    }
    return $stats;
}

/** Vérifie la forme d'un fichier d'agrégats relu (sinon null : on repart de zéro). */
function meta_valid_stats(?array $s, string $patch): ?array
{
    if ($s === null || ($s['patch'] ?? null) !== $patch || !is_int($s['games'] ?? null) || $s['games'] < 0) {
        return null;
    }
    foreach (['champions', 'bans', 'matchups'] as $k) {
        if (!is_array($s[$k] ?? null)) {
            return null;
        }
    }
    return $s;
}

/** Encode les agrégats : les tables vides restent des objets JSON. */
function meta_encode_stats(array $stats): string
{
    foreach (['champions', 'bans', 'matchups'] as $k) {
        if ($stats[$k] === []) {
            $stats[$k] = new stdClass();
        }
    }
    return json_encode_safe($stats);
}

/** ISO 8601 UTC d'un instant (null si absent). */
function meta_iso(?int $t): ?string
{
    return $t === null ? null : gmdate('Y-m-d\TH:i:s\Z', $t);
}

/**
 * Entrelace des listes (1er de chaque, puis 2e…), sans doublon, au plus $max éléments.
 * @param list<list<string>> $lists
 * @return list<string>
 */
function meta_interleave(array $lists, int $max): array
{
    $out = [];
    $seen = [];
    for ($i = 0; count($out) < $max; $i++) {
        $any = false;
        foreach ($lists as $list) {
            if (!isset($list[$i])) {
                continue;
            }
            $any = true;
            $v = $list[$i];
            if (!isset($seen[$v])) {
                $seen[$v] = true;
                $out[] = $v;
                if (count($out) >= $max) {
                    break;
                }
            }
        }
        if (!$any) {
            break;
        }
    }
    return $out;
}

/**
 * Tampon circulaire des parties d'un niveau et d'un patch : au plus $capacity enregistrements de
 * META_RECORD_SIZE octets, triés du plus ancien au plus récent (gameCreation puis numéro), dans une seule chaîne
 * (500 parties = 36 Ko en mémoire comme sur disque). Plein, une partie plus récente que la plus ancienne la remplace.
 */
final class MetaRingBuffer
{
    private string $data = '';
    /** @var array<int, true>|null numéros présents, construit à la demande */
    private ?array $ids = null;
    private bool $dirty = false;

    public function __construct(public readonly int $capacity)
    {
    }

    /** Relit un fichier (trié, dédoublonné, réduit à la capacité si elle a baissé : les plus anciennes partent). */
    public static function load(string $file, int $capacity): self
    {
        $buf = new self($capacity);
        if (!is_file($file)) {
            return $buf;
        }
        $raw = @file_get_contents($file);
        if (!is_string($raw) || strlen($raw) % META_RECORD_SIZE !== 0) {
            error_log('lolhelper meta: ' . basename($file) . ' illisible, tampon réinitialisé');
            $buf->dirty = true;
            return $buf;
        }
        $byKey = [];
        $byNumber = [];
        foreach ($raw === '' ? [] : str_split($raw, META_RECORD_SIZE) as $rec) {
            $n = substr($rec, 0, 8);
            if (!isset($byNumber[$n])) {
                $byNumber[$n] = true;
                $byKey[self::key($rec)] = $rec;
            }
        }
        ksort($byKey, SORT_STRING);
        $records = array_values($byKey);
        if (count($records) > $capacity) {
            $records = array_slice($records, -$capacity);
        }
        $buf->data = implode('', $records);
        $buf->dirty = $buf->data !== $raw;
        return $buf;
    }

    /** Clé de tri : gameCreation puis numéro (octets big-endian : ordre des octets = ordre numérique). */
    private static function key(string $rec): string
    {
        return substr($rec, 8, 4) . substr($rec, 0, 8);
    }

    public function count(): int
    {
        return intdiv(strlen($this->data), META_RECORD_SIZE);
    }

    public function isFull(): bool
    {
        return $this->count() >= $this->capacity;
    }

    public function isDirty(): bool
    {
        return $this->dirty;
    }

    public function has(int $n): bool
    {
        if ($this->ids === null) {
            $this->ids = [];
            for ($i = 0, $c = $this->count(); $i < $c; $i++) {
                $this->ids[unpack('J', $this->data, $i * META_RECORD_SIZE)[1]] = true;
            }
        }
        return isset($this->ids[$n]);
    }

    /** gameCreation (s) de la partie la plus ancienne / la plus récente ; null si vide. */
    public function oldestTime(): ?int
    {
        return $this->data === '' ? null : unpack('N', $this->data, 8)[1];
    }

    public function newestTime(): ?int
    {
        return $this->data === '' ? null : unpack('N', $this->data, strlen($this->data) - META_RECORD_SIZE + 8)[1];
    }

    /**
     * Ajoute un enregistrement. false : déjà présent, ou tampon plein et partie pas plus récente que la plus ancienne.
     */
    public function offer(string $rec): bool
    {
        if (strlen($rec) !== META_RECORD_SIZE) {
            return false;
        }
        $n = unpack('J', $rec)[1];
        if ($this->has($n)) {
            return false;
        }
        $key = self::key($rec);
        if ($this->isFull()) {
            if ($this->count() === 0 || strcmp($key, self::key(substr($this->data, 0, META_RECORD_SIZE))) <= 0) {
                return false;
            }
            unset($this->ids[unpack('J', $this->data)[1]]);
            $this->data = substr($this->data, META_RECORD_SIZE);
        }
        $lo = 0;
        $hi = $this->count();
        while ($lo < $hi) {
            $mid = ($lo + $hi) >> 1;
            if (strcmp(self::key(substr($this->data, $mid * META_RECORD_SIZE, META_RECORD_SIZE)), $key) < 0) {
                $lo = $mid + 1;
            } else {
                $hi = $mid;
            }
        }
        $at = $lo * META_RECORD_SIZE;
        $this->data = substr($this->data, 0, $at) . $rec . substr($this->data, $at);
        $this->ids[$n] = true;
        $this->dirty = true;
        return true;
    }

    /** @return Generator<int, string> enregistrements, du plus ancien au plus récent */
    public function records(): Generator
    {
        for ($i = 0, $c = $this->count(); $i < $c; $i++) {
            yield substr($this->data, $i * META_RECORD_SIZE, META_RECORD_SIZE);
        }
    }

    public function save(string $file): void
    {
        write_atomic($file, $this->data);
        $this->dirty = false;
    }
}

/**
 * En CLI, DOCUMENT_ROOT est vide : on le devine pour retrouver le même dossier de données que
 * l'API web (OVH : ~/www, donc ~/lolhelper-data). Premier ancêtre nommé www/public_html/htdocs,
 * sinon le dossier qui contient api/ (application à la racine du site).
 */
function meta_cli_document_root(string $apiDir): string
{
    $api = realpath($apiDir);
    $api = $api !== false ? $api : $apiDir;
    $dir = dirname($api);
    while (true) {
        if (in_array(basename($dir), ['www', 'public_html', 'htdocs'], true)) {
            return $dir;
        }
        $parent = dirname($dir);
        if ($parent === $dir) {
            break;
        }
        $dir = $parent;
    }
    return dirname($api);
}

final class MetaCollector
{
    private float $start;
    private float $lastRequest = 0.0;
    private int $requests = 0;
    private int $newMatches = 0;
    private int $networkErrors = 0;
    private string $platform;
    private string $region;
    /** Dossier de données (riot_limits.json), parent du dossier méta. */
    private string $limitsDir;
    private int $capacity;
    /** @var array<string,mixed> */
    private array $state = [];
    /**
     * @var array<string, array{buffer:MetaRingBuffer, legacy:int, seen:?MetaSeenSet, dirty:bool, updated_at:string}>
     * « NIVEAU patch » => seau chargé (legacy = parties des anciennes statistiques MASTER_PLUS encore comptées)
     */
    private array $buckets = [];
    /** @var list<string> patchs conservés, du plus récent au plus ancien */
    private array $patches = [];
    /** @var array<int, true> */
    private array $rejected = [];
    /** @var array<string, array<string, array<string,mixed>>> résumé relu au début : niveau => patch => entrée */
    private array $summaryTiers = [];
    /** @var array<int, array{0:string,1:string}> parties lues pendant ce passage : numéro => [patch, enregistrement] */
    private array $fetched = [];
    /** @var array<string, int> parties par patch, tous niveaux confondus (dernière sauvegarde) */
    private array $totals = [];

    public function __construct(private array $config, private string $metaDir, ?float $start = null)
    {
        $this->start = $start ?? microtime(true);
        $this->platform = $config['riot_platform'];
        $this->region = PLATFORM_REGIONS[$this->platform];
        $this->limitsDir = dirname($metaDir);
        $this->capacity = $config['meta_games_per_tier'];
    }

    /** Lance une collecte (cron) ; renvoie le code de sortie du script. */
    public function run(): int
    {
        return $this->runPass('cron')['exit'];
    }

    /**
     * Un passage de collecte borné par meta_time_budget. Écrit last_run.json (sauf si occupé).
     * summary : {status: ok|busy|error, stop, message, requests, new_matches, patch, games, patches,
     *            duration_s[, retry_after]} ; {status: busy} si une autre collecte tient le verrou.
     * games / patches : tous niveaux confondus.
     * @param string $source « cron » ou « web » (enregistré dans last_run.json)
     * @return array{exit:int, summary:array<string,mixed>}
     */
    public function runPass(string $source): array
    {
        if (!ensure_writable_dir($this->metaDir)) {
            error_log('lolhelper meta: dossier non inscriptible : ' . $this->metaDir);
            return ['exit' => 1, 'summary' => ['status' => 'error', 'stop' => 'storage', 'message' => 'dossier de données non inscriptible']];
        }
        $lock = @fopen($this->metaDir . '/' . META_LOCK_FILE, 'c');
        if ($lock === false) {
            error_log('lolhelper meta: verrou impossible');
            return ['exit' => 1, 'summary' => ['status' => 'error', 'stop' => 'storage', 'message' => 'verrou impossible']];
        }
        if (!meta_try_lock($lock)) {
            fclose($lock);
            error_log('lolhelper meta: collecte déjà en cours, rien à faire');
            return ['exit' => 0, 'summary' => ['status' => 'busy']];
        }
        $reason = 'tour complet';
        $stop = 'tour complet';
        $retryAfter = null;
        $status = 'ok';
        $exit = 0;
        $failure = null;
        try {
            $this->loadState();
            $blocked = (int) $this->state['blocked_until'];
            $wait = $blocked - time();
            if ($wait > 0 && !$this->fitsBudget($wait)) {
                $reason = 'pause demandée par Riot (429) jusqu\'à ' . gmdate('H:i:s', $blocked) . ' UTC';
                $stop = 'riot_limit';
                $retryAfter = $wait;
            } else {
                if ($wait > 0) {
                    usleep($wait * 1000000);
                }
                $this->state['blocked_until'] = 0;
                $reason = $this->collect();
            }
        } catch (MetaStop $e) {
            $reason = $e->getMessage();
            $exit = $e->exitCode;
            $stop = $e->stop;
            $retryAfter = $e->retryAfter;
        } catch (Throwable $e) {
            $failure = $e; // relancée après sauvegarde et libération du verrou
            $status = 'error';
            $stop = 'error';
            $reason = 'erreur inattendue';
        } finally {
            try {
                $this->checkpoint();
            } catch (Throwable $e) {
                error_log('lolhelper meta: sauvegarde impossible : ' . $e->getMessage());
                $exit = 1;
                $status = 'error';
                $stop = 'save_error';
                $reason = 'sauvegarde impossible';
            }
            $latest = $this->patches[0] ?? '-';
            $games = $this->totals[$latest] ?? 0;
            $duration = microtime(true) - $this->start;
            $summary = [
                'status' => $status,
                'stop' => $stop,
                'message' => $reason,
                'requests' => $this->requests,
                'new_matches' => $this->newMatches,
                'patch' => $latest === '-' ? null : $latest,
                'games' => $games,
                'patches' => meta_patch_list(meta_read_summary($this->metaDir)),
                'duration_s' => round($duration, 1),
            ];
            if ($stop === 'riot_limit') {
                $summary['retry_after'] = max(1, (int) $retryAfter);
            }
            try {
                write_atomic($this->metaDir . '/' . META_LAST_RUN_FILE, json_encode_safe(
                    $summary + ['at' => gmdate('Y-m-d\TH:i:s\Z'), 'source' => $source]
                ));
            } catch (Throwable $e) {
                error_log('lolhelper meta: last_run.json non écrit : ' . $e->getMessage());
            }
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        if ($failure !== null) {
            throw $failure;
        }
        error_log(sprintf(
            'lolhelper meta: %s, %d requêtes, %d nouvelles parties, patch %s (%d parties), %.1f s, arrêt : %s',
            $this->platform,
            $this->requests,
            $this->newMatches,
            $latest,
            $games,
            $duration,
            $reason
        ));
        return ['exit' => $exit, 'summary' => $summary];
    }

    /**
     * Tourniquet des niveaux : un joueur de départ par tour, niveau suivant ensuite. Un niveau sort du passage
     * quand tous ses joueurs ont été vus une fois (ou s'il est complet pour la journée) ; le passage s'arrête
     * quand plus aucun niveau ne reste (« tour complet »). Un tour interrompu reprend au même joueur.
     * @return string raison de l'arrêt (journal)
     */
    private function collect(): string
    {
        $tiers = $this->config['meta_tiers'];
        $n = count($tiers);
        $visited = [];
        /** @var array<string, string> $out niveau => round | full | no_seeds */
        $out = [];
        $turns = 0;
        while (true) {
            $tier = null;
            $idx = 0;
            for ($k = 0; $k < $n; $k++) {
                $idx = (((int) $this->state['tier_cursor']) + $k) % $n;
                $candidate = $tiers[$idx];
                if (isset($out[$candidate])) {
                    continue;
                }
                if ($this->tierComplete($candidate)) {
                    $out[$candidate] = 'full';
                    continue;
                }
                $tier = $candidate;
                break;
            }
            if ($tier === null) {
                break;
            }
            $this->state['tier_cursor'] = $idx;
            if (!$this->ensureSeeds($tier)) {
                $out[$tier] = 'no_seeds';
                $this->state['tier_cursor'] = ($idx + 1) % $n;
                continue;
            }
            $seeds = $this->state['tiers'][$tier]['seeds'];
            $count = count($seeds);
            $cursor = $this->state['tiers'][$tier]['cursor'] % $count;
            $this->collectPlayer($tier, $seeds[$cursor]);
            $this->state['tiers'][$tier]['cursor'] = ($cursor + 1) % $count;
            $this->state['tier_cursor'] = ($idx + 1) % $n;
            $visited[$tier] = ($visited[$tier] ?? 0) + 1;
            if ($visited[$tier] >= $count) {
                $out[$tier] = 'round';
            }
            $turns++;
            $this->checkpoint();
        }
        $kinds = array_count_values($out);
        if ($turns === 0 && ($kinds['no_seeds'] ?? 0) > 0) {
            throw new MetaStop('aucun joueur de départ (ligues indisponibles)', stop: 'no_seeds');
        }
        if ($turns === 0 && ($kinds['full'] ?? 0) === $n) {
            return 'tour complet : tous les niveaux ont leurs ' . $this->capacity . ' parties des dernières 24 h, reprise demain';
        }
        return 'tour complet';
    }

    /** État d'un niveau (valeurs par défaut s'il n'a jamais été servi). */
    private function tierState(string $tier): array
    {
        return $this->state['tiers'][$tier] ?? self::cleanTierState([]);
    }

    /**
     * Niveau complet pour aujourd'hui : tampon du patch courant plein de parties des dernières 24 h
     * (constaté une fois, le niveau reste de côté jusqu'au lendemain, date locale du fuseau de config.php).
     */
    private function tierComplete(string $tier): bool
    {
        $current = $this->patches[0] ?? null;
        if ($current === null) {
            return false;
        }
        $buffer = $this->bucket($tier, $current)['buffer'];
        if (!$buffer->isFull()) {
            return false;
        }
        $today = meta_local_day($this->config);
        if (($this->tierState($tier)['done_day'] ?? null) === $today) {
            return true;
        }
        if ((int) $buffer->oldestTime() >= time() - META_RECENT_SECONDS) {
            $this->state['tiers'][$tier] = ['done_day' => $today] + $this->tierState($tier);
            error_log("lolhelper meta: $tier complet ({$this->capacity} parties des dernières 24 h), repris demain");
            return true;
        }
        return false;
    }

    /** Joueurs de départ du niveau, rafraîchis au plus une fois par jour ; false si aucun. */
    private function ensureSeeds(string $tier): bool
    {
        $ts = $this->tierState($tier);
        $stale = $ts['seeds'] === [] || time() - $ts['refreshed_at'] >= META_SEED_TTL
            || ($tier === 'MASTER_PLUS' && $ts['leagues'] !== $this->config['meta_apex']);
        if ($stale) {
            $this->refreshSeeds($tier);
        }
        return $this->tierState($tier)['seeds'] !== [];
    }

    /**
     * MASTER_PLUS : ligues apex configurées, chacune triée par LP décroissants, entrelacées.
     * Autres niveaux : une page par division (page tournante), au plus 50 joueurs par division, entrelacés.
     * Au plus META_SEEDS_PER_TIER joueurs, sans doublon. En cas d'échec, l'ancienne liste est gardée.
     */
    private function refreshSeeds(string $tier): void
    {
        $ts = $this->tierState($tier);
        $lists = [];
        $page = null;
        if ($tier === 'MASTER_PLUS') {
            foreach ($this->config['meta_apex'] as $league) {
                $url = riot_base_url($this->platform) . '/lol/league/v4/' . strtolower($league) . 'leagues/by-queue/RANKED_SOLO_5x5';
                [$status, $data] = $this->get($url);
                $entries = is_array($data) ? ($data['entries'] ?? null) : null;
                if ($status !== 200 || !is_array($entries)) {
                    error_log("lolhelper meta: ligue $league indisponible (HTTP $status)");
                    continue;
                }
                $list = [];
                foreach ($entries as $e) {
                    $puuid = is_array($e) ? ($e['puuid'] ?? null) : null;
                    if (is_string($puuid) && preg_match(RIOT_PUUID_PATTERN, $puuid) === 1) {
                        $lp = $e['leaguePoints'] ?? 0;
                        $list[] = [$puuid, is_int($lp) ? $lp : 0];
                    }
                }
                usort($list, static fn (array $a, array $b): int => [$b[1], $a[0]] <=> [$a[1], $b[0]]);
                $lists[] = array_column($list, 0);
            }
        } else {
            $perDivision = intdiv(META_SEEDS_PER_TIER, count(META_DIVISIONS));
            $page = 1 + ($ts['page_rot'] % META_SEED_PAGES);
            foreach ($page > 1 ? [$page, 1] : [1] as $try) {
                foreach (META_DIVISIONS as $division) {
                    $url = riot_base_url($this->platform) . "/lol/league/v4/entries/RANKED_SOLO_5x5/$tier/$division?page=$try";
                    [$status, $data] = $this->get($url);
                    if ($status !== 200 || !is_array($data) || !array_is_list($data)) {
                        error_log("lolhelper meta: $tier $division page $try indisponible (HTTP $status)");
                        continue;
                    }
                    $list = [];
                    foreach ($data as $e) {
                        $puuid = is_array($e) ? ($e['puuid'] ?? null) : null;
                        if (is_string($puuid) && preg_match(RIOT_PUUID_PATTERN, $puuid) === 1) {
                            $list[] = $puuid;
                            if (count($list) >= $perDivision) {
                                break;
                            }
                        }
                    }
                    $lists[] = $list;
                }
                if (meta_interleave($lists, 1) !== []) {
                    $page = $try;
                    break;
                }
                $lists = [];
            }
        }
        $seeds = meta_interleave($lists, META_SEEDS_PER_TIER);
        if ($seeds === []) {
            if ($ts['seeds'] !== []) {
                // On garde l'ancienne liste ; nouvel essai dans une heure.
                $ts['refreshed_at'] = time() - META_SEED_TTL + META_SEED_RETRY;
                $this->state['tiers'][$tier] = $ts;
            }
            error_log("lolhelper meta: aucun joueur de départ pour $tier");
            return;
        }
        $ts['seeds'] = $seeds;
        $ts['refreshed_at'] = time();
        $ts['cursor'] = 0;
        if ($tier === 'MASTER_PLUS') {
            $ts['leagues'] = $this->config['meta_apex'];
        } else {
            $ts['page_rot'] = $page; // page suivante au prochain rafraîchissement
        }
        $this->state['tiers'][$tier] = $ts;
    }

    private function collectPlayer(string $tier, string $puuid): void
    {
        // Tampon du patch courant plein : seules les parties plus récentes que sa plus ancienne peuvent entrer.
        $startTime = time() - META_MATCH_WINDOW;
        $current = $this->patches[0] ?? null;
        if ($current !== null) {
            $buffer = $this->bucket($tier, $current)['buffer'];
            if ($buffer->isFull()) {
                $startTime = max($startTime, (int) $buffer->oldestTime());
            }
        }
        $url = riot_base_url($this->region) . '/lol/match/v5/matches/by-puuid/' . rawurlencode($puuid)
            . '/ids?queue=' . META_QUEUE_SOLO . '&type=ranked&start=0&count=' . META_IDS_PER_PLAYER
            . '&startTime=' . $startTime;
        [$status, $ids] = $this->get($url);
        if ($status !== 200 || !is_array($ids)) {
            return;
        }
        foreach (array_slice($ids, 0, META_IDS_PER_PLAYER) as $matchId) {
            $n = meta_match_number($matchId);
            if ($n === null || $this->isKnown($tier, $n)) {
                continue;
            }
            $this->collectMatch($tier, $matchId, $n);
        }
    }

    private function collectMatch(string $tier, string $matchId, int $n): void
    {
        if (isset($this->fetched[$n])) {
            [$patch, $rec] = $this->fetched[$n];
        } else {
            [$status, $data] = $this->get(riot_base_url($this->region) . '/lol/match/v5/matches/' . rawurlencode($matchId));
            if ($status === 404 || ($status === 200 && $data === null)) {
                $this->reject($n);
                return;
            }
            if ($status !== 200) {
                return; // erreur passagère : la partie sera retentée
            }
            $parsed = meta_parse_match($data);
            if (isset($parsed['skip'])) {
                $this->reject($n);
                return;
            }
            $patch = $parsed['patch'];
            $rec = meta_pack_record($n, $parsed);
            if (count($this->fetched) >= META_FETCH_CACHE_MAX) {
                $this->fetched = array_slice($this->fetched, -intdiv(META_FETCH_CACHE_MAX, 2), null, true);
            }
            $this->fetched[$n] = [$patch, $rec];
        }
        if (!$this->keepPatch($patch)) {
            $this->reject($n); // patch plus ancien que ceux conservés
            return;
        }
        $this->bucket($tier, $patch);
        $key = "$tier $patch";
        if (!$this->buckets[$key]['buffer']->offer($rec)) {
            $this->reject($n); // tampon plein de parties plus récentes
            return;
        }
        $this->buckets[$key]['dirty'] = true;
        $this->buckets[$key]['updated_at'] = gmdate('Y-m-d\TH:i:s\Z');
        $this->newMatches++;
    }

    private function isKnown(string $tier, int $n): bool
    {
        if (isset($this->rejected[$n])) {
            return true;
        }
        foreach ($this->patches as $p) {
            $b = $this->bucket($tier, $p);
            if ($b['buffer']->has($n)) {
                return true;
            }
            if ($b['legacy'] > 0) {
                $key = "$tier $p";
                $this->buckets[$key]['seen'] ??= MetaSeenSet::load($this->metaDir . "/seen-$p.bin");
                if ($this->buckets[$key]['seen']->has($n)) {
                    return true;
                }
            }
        }
        return false;
    }

    private function reject(int $n): void
    {
        $this->rejected[$n] = true;
        if (count($this->rejected) > META_REJECTED_MAX) {
            $this->rejected = array_slice($this->rejected, -META_REJECTED_MAX, null, true);
        }
    }

    /** Patch conservé (ajouté s'il est plus récent que le plus ancien gardé, le plus ancien partant alors) ; false si trop ancien. */
    private function keepPatch(string $patch): bool
    {
        if (in_array($patch, $this->patches, true)) {
            return true;
        }
        $oldest = $this->patches[META_KEEP_PATCHES - 1] ?? null;
        if ($oldest !== null && version_compare($patch, $oldest) < 0) {
            return false;
        }
        $this->patches = meta_sort_patches([...$this->patches, $patch]);
        while (count($this->patches) > META_KEEP_PATCHES) {
            $old = array_pop($this->patches);
            foreach (META_TIERS as $t) {
                unset($this->buckets["$t $old"], $this->summaryTiers[$t][$old]);
                @unlink($this->metaDir . "/buffer-$t-$old.bin");
                @unlink($this->metaDir . "/stats-$t-$old.json");
            }
            @unlink($this->metaDir . "/stats-$old.json");
            @unlink($this->metaDir . "/legacy-$old.json");
            @unlink($this->metaDir . "/seen-$old.bin");
            error_log("lolhelper meta: patch $old abandonné (nouveau patch $patch)");
        }
        $this->state['patches'] = $this->patches;
        return true;
    }

    /** Charge paresseusement le seau d'un niveau et d'un patch ; agrégats à recalculer s'ils ne suivent pas le tampon. */
    private function bucket(string $tier, string $patch): array
    {
        $key = "$tier $patch";
        if (!isset($this->buckets[$key])) {
            $buffer = MetaRingBuffer::load($this->metaDir . "/buffer-$tier-$patch.bin", $this->capacity);
            $legacy = 0;
            if ($tier === META_LEGACY_TIER) {
                $old = meta_valid_stats(meta_read_json($this->metaDir . "/legacy-$patch.json"), $patch);
                $legacy = $old['games'] ?? 0;
            }
            $info = $this->summaryTiers[$tier][$patch] ?? null;
            $games = $buffer->count() + $legacy;
            $hasFile = is_file($this->metaDir . "/stats-$tier-$patch.json");
            $this->buckets[$key] = [
                'buffer' => $buffer,
                'legacy' => $legacy,
                'seen' => null,
                'dirty' => $buffer->isDirty() || ($games > 0 && (($info['games'] ?? -1) !== $games || !$hasFile)) || ($games === 0 && $hasFile),
                'updated_at' => is_string($info['updated_at'] ?? null) ? $info['updated_at'] : gmdate('Y-m-d\TH:i:s\Z'),
            ];
        }
        return $this->buckets[$key];
    }

    /** Réécrit stats-<NIVEAU>-<patch>.json depuis le tampon (+ anciennes statistiques encore comptées). */
    private function writeStats(string $tier, string $patch): void
    {
        $key = "$tier $patch";
        $b = $this->buckets[$key];
        $file = $this->metaDir . "/stats-$tier-$patch.json";
        $stats = meta_stats_from_records($b['buffer']->records(), $patch, $this->platform, $tier);
        if ($b['legacy'] > 0) {
            $old = meta_valid_stats(meta_read_json($this->metaDir . "/legacy-$patch.json"), $patch);
            if ($old !== null) {
                $stats = meta_merge_stats($stats, $old);
            } else {
                $this->buckets[$key]['legacy'] = 0;
            }
        }
        if ($stats['games'] === 0) {
            @unlink($file);
            return;
        }
        $stats['updated_at'] = $b['updated_at'];
        write_atomic($file, meta_encode_stats($stats));
    }

    /**
     * Un appel Riot borné par meta_time_budget. Rythme : au plus meta_rate requêtes/s (espacement 1/meta_rate),
     * puis garde partagée des limites (riot_limits.php) : l'appel ne part que sous 60 % de chaque fenêtre de la
     * clé, sinon le collecteur dort jusqu'à ce que la fenêtre se libère (dans son budget de temps).
     * 429 Riot : pause Retry-After (5 s par défaut, 60 s au plus) puis nouvel essai si le budget le permet,
     * sinon arrêt « riot_limit » (pause enregistrée pour le passage suivant).
     * @return array{0:int, 1:mixed} statut + JSON décodé (null si invalide ou erreur)
     */
    private function get(string $url): array
    {
        while (true) {
            $rate = $this->config['meta_rate'];
            $pacing = ($rate !== null && $rate > 0) ? $this->lastRequest + 1.0 / $rate - microtime(true) : 0.0;
            $this->sleepWithinBudget($pacing, 'budget de temps atteint');
            while (($wait = riot_gate_acquire($this->limitsDir, $url, RIOT_COLLECTOR_SHARE_PCT, $sentAt = microtime(true))) > 0) {
                $this->sleepWithinBudget($wait + 0.02, 'budget de temps atteint (attente de la limite de la clé Riot)');
            }
            $this->lastRequest = $sentAt;
            $this->requests++;
            [$status, $body, $retryAfter, $rateHeaders] = riot_http_get($this->config['riot_api_key'], $url);
            riot_limits_record($this->limitsDir, $url, $sentAt, $status, $rateHeaders, $retryAfter);

            if ($status === 401 || $status === 403) {
                throw new MetaStop("clé API Riot refusée (HTTP $status) : renouvelle-la dans config.php", 1, 'riot_key');
            }
            if ($status === 429) {
                $seconds = meta_retry_after_seconds($retryAfter);
                if (!$this->fitsBudget($seconds)) {
                    $this->state['blocked_until'] = time() + $seconds;
                    throw new MetaStop("limite Riot atteinte (429), pause de $seconds s au-delà du budget de temps", 0, 'riot_limit', $seconds);
                }
                error_log("lolhelper meta: limite Riot atteinte (429), pause de $seconds s puis reprise");
                usleep($seconds * 1000000);
                continue;
            }
            if ($status === 0 || $status >= 500) {
                if (++$this->networkErrors >= META_MAX_NETWORK_ERRORS) {
                    throw new MetaStop('serveur Riot indisponible', stop: 'riot_down');
                }
                return [$status, null];
            }
            $this->networkErrors = 0;
            if ($status !== 200) {
                return [$status, null];
            }
            try {
                return [200, json_decode($body, true, 64, JSON_THROW_ON_ERROR)];
            } catch (JsonException $e) {
                return [200, null];
            }
        }
    }

    /** Une attente de $wait secondes tient-elle dans le budget de temps ? */
    private function fitsBudget(float $wait): bool
    {
        return microtime(true) + max(0.0, $wait) - $this->start < $this->config['meta_time_budget'];
    }

    /** Dort $wait secondes, sauf si cela dépasse le budget de temps (arrêt propre « budget »). */
    private function sleepWithinBudget(float $wait, string $reason): void
    {
        if (!$this->fitsBudget($wait)) {
            throw new MetaStop($reason, stop: 'budget');
        }
        if ($wait > 0) {
            usleep((int) ($wait * 1e6));
        }
    }

    /** État d'un niveau relu (valeurs invalides remplacées par les défauts). */
    private static function cleanTierState(array $raw): array
    {
        $seeds = [];
        foreach (is_array($raw['seeds'] ?? null) ? $raw['seeds'] : [] as $p) {
            if (is_string($p) && preg_match(RIOT_PUUID_PATTERN, $p) === 1 && count($seeds) < META_SEEDS_PER_TIER) {
                $seeds[] = $p;
            }
        }
        $leagues = is_array($raw['leagues'] ?? null)
            ? array_values(array_filter($raw['leagues'], static fn (mixed $l): bool => is_string($l) && in_array($l, META_APEX_LEAGUES, true)))
            : [];
        $int = static fn (mixed $v): int => is_int($v) && $v >= 0 ? $v : 0;
        $day = $raw['done_day'] ?? null;
        return [
            'seeds' => $seeds,
            'refreshed_at' => $int($raw['refreshed_at'] ?? null),
            'cursor' => $int($raw['cursor'] ?? null),
            'page_rot' => $int($raw['page_rot'] ?? null),
            'leagues' => $leagues,
            'done_day' => is_string($day) && preg_match('/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/D', $day) === 1 ? $day : null,
        ];
    }

    private function loadState(): void
    {
        $s = meta_read_json($this->metaDir . '/state.json') ?? [];
        if (($s['platform'] ?? null) !== $this->platform) {
            if ($s !== []) {
                error_log('lolhelper meta: serveur changé, collecte réinitialisée');
            }
            foreach (glob($this->metaDir . '/{stats-*.json,seen-*.bin,buffer-*.bin,legacy-*.json,summary.json}', GLOB_BRACE) ?: [] as $f) {
                @unlink($f);
            }
            $s = [];
        }
        $patches = [];
        foreach (is_array($s['patches'] ?? null) ? $s['patches'] : [] as $p) {
            if (is_string($p) && preg_match(META_PATCH_PATTERN, $p) === 1 && !in_array($p, $patches, true)) {
                $patches[] = $p;
            }
        }
        $this->patches = array_slice(meta_sort_patches($patches), 0, META_KEEP_PATCHES);
        $this->rejected = [];
        foreach (is_array($s['rejected'] ?? null) ? $s['rejected'] : [] as $n) {
            if (is_int($n) && $n >= 0) {
                $this->rejected[$n] = true;
            }
        }
        $tiers = [];
        foreach (META_TIERS as $t) {
            if (is_array($s['tiers'][$t] ?? null)) {
                $tiers[$t] = self::cleanTierState($s['tiers'][$t]);
            }
        }
        // État v1 (collecteur haut elo) : joueurs apex à plat -> MASTER_PLUS.
        if (!isset($tiers['MASTER_PLUS']) && is_array($s['seeds'] ?? null)) {
            $tiers['MASTER_PLUS'] = self::cleanTierState([
                'seeds' => $s['seeds'],
                'refreshed_at' => $s['seed_refreshed_at'] ?? 0,
                'cursor' => $s['cursor'] ?? 0,
                'leagues' => $s['seed_tiers'] ?? [],
            ]);
        }
        $cursor = $s['tier_cursor'] ?? 0;
        $this->state = [
            'v' => 2,
            'platform' => $this->platform,
            'tier_cursor' => is_int($cursor) && $cursor >= 0 ? $cursor : 0,
            'tiers' => $tiers,
            'blocked_until' => is_int($s['blocked_until'] ?? null) ? $s['blocked_until'] : 0,
            'patches' => $this->patches,
            'rejected' => [],
        ];
        $this->summaryTiers = meta_read_tier_summary($this->metaDir);
        $this->migrateLegacyStats();
    }

    /**
     * Fichiers d'avant la collecte par niveau (stats-<patch>.json, sans niveau) : ils deviennent MASTER_PLUS.
     * Les agrégats sont d'abord écrits sous le nouveau nom (servis aussitôt), puis l'ancien fichier devient
     * legacy-<patch>.json, ajouté aux parties du tampon MASTER_PLUS tant que celui-ci n'est pas plein.
     */
    private function migrateLegacyStats(): void
    {
        foreach (glob($this->metaDir . '/stats-*.json') ?: [] as $file) {
            if (preg_match('#/stats-([0-9]{1,3}\.[0-9]{1,3})\.json$#D', $file, $m) !== 1) {
                continue;
            }
            $patch = $m[1];
            $old = meta_valid_stats(meta_read_json($file), $patch);
            if ($old === null || !in_array($patch, $this->patches, true)) {
                @unlink($file);
                @unlink($this->metaDir . "/seen-$patch.bin");
                continue;
            }
            $new = $this->metaDir . '/stats-' . META_LEGACY_TIER . "-$patch.json";
            if (!is_file($new)) {
                write_atomic($new, meta_encode_stats(['tier' => META_LEGACY_TIER] + $old));
            }
            if (!@rename($file, $this->metaDir . "/legacy-$patch.json")) {
                throw new RuntimeException("migration impossible : stats-$patch.json");
            }
            error_log("lolhelper meta: statistiques du patch $patch ({$old['games']} parties) reprises pour " . META_LEGACY_TIER);
        }
    }

    /**
     * Sauvegarde : tampons d'abord, puis agrégats, résumé et état. Un arrêt brutal entre les deux laisse des
     * agrégats en retard sur le tampon, recalculés au passage suivant (le résumé ne correspond plus).
     */
    private function checkpoint(): void
    {
        if ($this->state === []) {
            return;
        }
        $tiersOut = [];
        $totals = [];
        foreach ($this->patches as $patch) {
            $totals[$patch] = ['games' => 0, 'updated_at' => ''];
        }
        foreach (META_TIERS as $tier) {
            $tracked = in_array($tier, $this->config['meta_tiers'], true);
            foreach ($this->patches as $patch) {
                $key = "$tier $patch";
                if (!$tracked && !isset($this->buckets[$key]) && !isset($this->summaryTiers[$tier][$patch])) {
                    continue;
                }
                $b = $this->bucket($tier, $patch);
                if ($b['legacy'] > 0 && $b['buffer']->isFull()) {
                    // Tampon plein de parties récentes : les anciennes statistiques ne comptent plus.
                    @unlink($this->metaDir . "/legacy-$patch.json");
                    @unlink($this->metaDir . "/seen-$patch.bin");
                    $this->buckets[$key]['legacy'] = 0;
                    $this->buckets[$key]['seen'] = null;
                    $this->buckets[$key]['dirty'] = true;
                    error_log("lolhelper meta: anciennes statistiques du patch $patch remplacées par les $this->capacity parties récentes de $tier");
                }
                if ($b['buffer']->isDirty()) {
                    $b['buffer']->save($this->metaDir . "/buffer-$tier-$patch.bin");
                }
                if ($this->buckets[$key]['dirty']) {
                    $this->writeStats($tier, $patch);
                    $this->buckets[$key]['dirty'] = false;
                }
                $b = $this->buckets[$key];
                $games = $b['buffer']->count() + $b['legacy'];
                if ($games === 0) {
                    continue;
                }
                $tiersOut[$tier][$patch] = [
                    'games' => $games,
                    'updated_at' => $b['updated_at'],
                    'oldest' => meta_iso($b['buffer']->oldestTime()),
                    'newest' => meta_iso($b['buffer']->newestTime()),
                ];
                $totals[$patch]['games'] += $games;
                $totals[$patch]['updated_at'] = max($totals[$patch]['updated_at'], $b['updated_at']);
            }
        }
        foreach ($totals as $patch => $t) {
            if ($t['updated_at'] === '') {
                $totals[$patch]['updated_at'] = gmdate('Y-m-d\TH:i:s\Z');
            }
        }
        $this->summaryTiers = $tiersOut;
        $this->totals = array_map(static fn (array $t): int => $t['games'], $totals);
        write_atomic($this->metaDir . '/summary.json', json_encode_safe([
            'v' => 2,
            'platform' => $this->platform,
            'updated_at' => gmdate('Y-m-d\TH:i:s\Z'),
            'patches' => $totals ?: new stdClass(),
            'tiers' => $tiersOut ?: new stdClass(),
        ]));
        $state = $this->state;
        $state['patches'] = $this->patches;
        $state['rejected'] = array_keys($this->rejected);
        $state['last_run_at'] = time();
        $state['tiers'] = $state['tiers'] ?: new stdClass();
        write_atomic($this->metaDir . '/state.json', json_encode_safe($state));
    }
}

/**
 * Route POST r=meta-collect (mot de passe partagé déjà vérifié) : un passage court du collecteur,
 * déclenché depuis le site. En-tête X-Admin-Password = admin_password de config.php.
 * Même verrou que le cron : si une collecte tourne déjà, répond 200 {"status": "busy"}.
 */
function handle_meta_collect(array $config, string $apiDir): void
{
    $start = microtime(true);
    if ($config['admin_password'] === '') {
        throw new HttpError(403, 'Collecte manuelle désactivée : définissez admin_password dans config.php.');
    }
    if (!hash_equals($config['admin_password'], request_secret_header('X-Admin-Password'))) {
        throw new HttpError(401, 'Mot de passe administrateur incorrect.');
    }
    $dataDir = resolve_data_dir($config, $apiDir);
    if (!$config['meta_enabled']) {
        send_json(200, [
            'status' => 'ok',
            'stop' => 'disabled',
            'message' => 'collecte désactivée (meta_enabled = false)',
            'requests' => 0,
            'new_matches' => 0,
        ] + meta_dir_overview($dataDir) + ['duration_s' => 0.0]);
        return;
    }
    if ($config['riot_api_key'] === '') {
        throw new HttpError(400, RIOT_MSG_NO_KEY);
    }
    if ($dataDir === null) {
        throw new HttpError(500, 'Stockage indisponible sur le serveur.');
    }

    $budget = $config['meta_web_budget'];
    ignore_user_abort(true); // un onglet fermé ne coupe pas la sauvegarde
    if (function_exists('set_time_limit')) {
        @set_time_limit($budget + 30);
    }
    $collector = new MetaCollector(array_replace($config, ['meta_time_budget' => $budget]), meta_dir($dataDir), $start);
    $summary = $collector->runPass('web')['summary'];
    if ($summary['status'] === 'error') {
        throw new HttpError(500, $summary['stop'] === 'save_error'
            ? 'Sauvegarde des statistiques méta impossible sur le serveur.'
            : 'Stockage indisponible sur le serveur.');
    }
    send_json(200, $summary);
}
