<?php
declare(strict_types=1);

if (!defined('LOLHELPER_API')) {
    http_response_code(403);
    exit;
}

/*
 * Collecteur méta haut elo (lancé par cron/collect-meta.php en ligne de commande).
 * Parcourt en boucle les joueurs Challenger/Grandmaster (liste rafraîchie toutes les 24 h),
 * récupère leurs parties classées solo des 3 derniers jours et agrège chaque partie une seule fois.
 */

const META_QUEUE_SOLO = 420;
const META_REMAKE_SECONDS = 300;
const META_SEED_TTL = 86400;
const META_MATCH_WINDOW = 3 * 86400;
const META_IDS_PER_PLAYER = 20;
const META_REJECTED_MAX = 5000;
const META_MAX_NETWORK_ERRORS = 5;
const META_DEFAULT_RETRY_AFTER = 60;

/** Arrêt propre d'une collecte (budget, clé refusée, 429…). */
final class MetaStop extends Exception
{
    public function __construct(string $reason, public readonly int $exitCode = 0)
    {
        parent::__construct($reason);
    }
}

/**
 * Ensemble compact d'identifiants numériques de parties : chaîne triée de blocs 8 octets
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

/**
 * Valide une partie Riot (match-v5). Renvoie :
 *  ['skip' => raison]  (invalid, queue, remake)
 *  ['patch' => '16.19', 'players' => list<array{0:int,1:?string,2:int,3:bool}>, 'bans' => list<int>]
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
    if ($patch === null || !is_int($duration) || $duration < 0 || !is_array($participants) || count($participants) !== 10) {
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
        if (!is_int($champ) || $champ <= 0 || $champ > 1000000 || ($team !== 100 && $team !== 200) || !is_bool($win)) {
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
                if (is_int($c) && $c > 0 && $c <= 1000000) {
                    $bans[$c] = true; // une seule fois par partie
                }
            }
        }
    }
    return ['patch' => $patch, 'players' => $players, 'bans' => array_keys($bans)];
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

/** Agrégats vides d'un patch. */
function meta_empty_stats(string $patch, string $platform): array
{
    return [
        'patch' => $patch,
        'platform' => $platform,
        'games' => 0,
        'updated_at' => gmdate('Y-m-d\TH:i:s\Z'),
        'champions' => [],
        'bans' => [],
        'matchups' => [],
    ];
}

/** Vérifie la forme d'un fichier stats-<patch>.json relu (sinon null : on repart de zéro). */
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
    /** @var array<string,mixed> */
    private array $state = [];
    /** @var array<string, array{stats:array, seen:MetaSeenSet, dirty:bool}> patch => seau chargé */
    private array $buckets = [];
    /** @var list<string> patchs conservés, du plus récent au plus ancien */
    private array $patches = [];
    /** @var array<int, true> */
    private array $rejected = [];

    public function __construct(private array $config, private string $metaDir, ?float $start = null)
    {
        $this->start = $start ?? microtime(true);
        $this->platform = $config['riot_platform'];
        $this->region = PLATFORM_REGIONS[$this->platform];
    }

    /** Lance une collecte ; renvoie le code de sortie du script. */
    public function run(): int
    {
        if (!ensure_writable_dir($this->metaDir)) {
            error_log('lolhelper meta: dossier non inscriptible : ' . $this->metaDir);
            return 1;
        }
        $lock = @fopen($this->metaDir . '/collect.lock', 'c');
        if ($lock === false) {
            error_log('lolhelper meta: verrou impossible');
            return 1;
        }
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            fclose($lock);
            error_log('lolhelper meta: collecte déjà en cours, rien à faire');
            return 0;
        }
        $reason = 'tour complet';
        $exit = 0;
        try {
            $this->loadState();
            $blocked = (int) ($this->state['blocked_until'] ?? 0);
            if ($blocked > time()) {
                $reason = 'pause demandée par Riot (429) jusqu\'à ' . gmdate('H:i:s', $blocked) . ' UTC';
            } else {
                $this->collect();
            }
        } catch (MetaStop $stop) {
            $reason = $stop->getMessage();
            $exit = $stop->exitCode;
        } finally {
            try {
                $this->checkpoint();
            } catch (Throwable $e) {
                error_log('lolhelper meta: sauvegarde impossible : ' . $e->getMessage());
                $exit = 1;
            }
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        $latest = $this->patches[0] ?? '-';
        $games = isset($this->buckets[$latest]) ? $this->buckets[$latest]['stats']['games'] : 0;
        error_log(sprintf(
            'lolhelper meta: %s, %d requêtes, %d nouvelles parties, patch %s (%d parties), %.1f s, arrêt : %s',
            $this->platform,
            $this->requests,
            $this->newMatches,
            $latest,
            $games,
            microtime(true) - $this->start,
            $reason
        ));
        return $exit;
    }

    private function collect(): void
    {
        $tiers = $this->config['meta_tiers'];
        $seeds = $this->state['seeds'];
        if (!$seeds || time() - (int) $this->state['seed_refreshed_at'] >= META_SEED_TTL
            || $this->state['seed_tiers'] !== $tiers) {
            $this->refreshSeeds($tiers);
            $seeds = $this->state['seeds'];
        }
        $count = count($seeds);
        if ($count === 0) {
            throw new MetaStop('aucun joueur de départ');
        }
        $windowStart = time() - META_MATCH_WINDOW;
        for ($visited = 0; $visited < $count; $visited++) {
            $cursor = ((int) $this->state['cursor']) % $count;
            $this->collectPlayer($seeds[$cursor], $windowStart);
            $this->state['cursor'] = ($cursor + 1) % $count;
            $this->checkpoint();
        }
    }

    /** Liste des joueurs : paliers configurés, triés par LP décroissants, sans doublon. */
    private function refreshSeeds(array $tiers): void
    {
        $paths = [
            'CHALLENGER' => 'challengerleagues',
            'GRANDMASTER' => 'grandmasterleagues',
            'MASTER' => 'masterleagues',
        ];
        $seeds = [];
        foreach ($tiers as $tier) {
            $url = riot_base_url($this->platform) . '/lol/league/v4/' . $paths[$tier] . '/by-queue/RANKED_SOLO_5x5';
            [$status, $data] = $this->get($url);
            $entries = is_array($data) ? ($data['entries'] ?? null) : null;
            if ($status !== 200 || !is_array($entries)) {
                error_log("lolhelper meta: ligue $tier indisponible (HTTP $status)");
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
            foreach ($list as [$puuid]) {
                $seeds[$puuid] = true;
            }
        }
        if (!$seeds) {
            // On garde l'ancienne liste si elle existe ; nouvel essai au prochain passage.
            if ($this->state['seeds']) {
                return;
            }
            throw new MetaStop('aucun joueur de départ (ligues indisponibles)');
        }
        $this->state['seeds'] = array_keys($seeds);
        $this->state['seed_tiers'] = $tiers;
        $this->state['seed_refreshed_at'] = time();
        $this->state['cursor'] = ((int) $this->state['cursor']) % count($seeds);
    }

    private function collectPlayer(string $puuid, int $windowStart): void
    {
        $url = riot_base_url($this->region) . '/lol/match/v5/matches/by-puuid/' . rawurlencode($puuid)
            . '/ids?queue=' . META_QUEUE_SOLO . '&type=ranked&start=0&count=' . META_IDS_PER_PLAYER
            . '&startTime=' . $windowStart;
        [$status, $ids] = $this->get($url);
        if ($status !== 200 || !is_array($ids)) {
            return;
        }
        foreach (array_slice($ids, 0, META_IDS_PER_PLAYER) as $matchId) {
            $n = meta_match_number($matchId);
            if ($n === null || $this->isKnown($n)) {
                continue;
            }
            $this->collectMatch($matchId, $n);
        }
    }

    private function collectMatch(string $matchId, int $n): void
    {
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
        $bucket = $this->bucketFor($parsed['patch']);
        if ($bucket === null) {
            $this->reject($n); // patch plus ancien que ceux conservés
            return;
        }
        meta_aggregate($this->buckets[$bucket]['stats'], $parsed);
        $this->buckets[$bucket]['stats']['updated_at'] = gmdate('Y-m-d\TH:i:s\Z');
        $this->buckets[$bucket]['seen']->add($n);
        $this->buckets[$bucket]['dirty'] = true;
        $this->newMatches++;
    }

    private function isKnown(int $n): bool
    {
        if (isset($this->rejected[$n])) {
            return true;
        }
        foreach ($this->patches as $p) {
            if ($this->bucket($p)['seen']->has($n)) {
                return true;
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

    /** Seau du patch (créé si plus récent que le plus ancien conservé) ; null si trop ancien. */
    private function bucketFor(string $patch): ?string
    {
        if (in_array($patch, $this->patches, true)) {
            $this->bucket($patch);
            return $patch;
        }
        $oldest = $this->patches[META_KEEP_PATCHES - 1] ?? null;
        if ($oldest !== null && version_compare($patch, $oldest) < 0) {
            return null;
        }
        $this->buckets[$patch] = [
            'stats' => meta_empty_stats($patch, $this->platform),
            'seen' => new MetaSeenSet(),
            'dirty' => true,
        ];
        $this->patches = meta_sort_patches([...$this->patches, $patch]);
        while (count($this->patches) > META_KEEP_PATCHES) {
            $old = array_pop($this->patches);
            unset($this->buckets[$old]);
            @unlink($this->metaDir . "/stats-$old.json");
            @unlink($this->metaDir . "/seen-$old.bin");
            error_log("lolhelper meta: patch $old abandonné (nouveau patch $patch)");
        }
        $this->state['patches'] = $this->patches;
        return $patch;
    }

    /** Charge paresseusement un seau conservé. */
    private function bucket(string $patch): array
    {
        if (!isset($this->buckets[$patch])) {
            $stats = meta_valid_stats(meta_read_json($this->metaDir . "/stats-$patch.json"), $patch);
            $this->buckets[$patch] = $stats === null
                ? ['stats' => meta_empty_stats($patch, $this->platform), 'seen' => new MetaSeenSet(), 'dirty' => false]
                : ['stats' => $stats, 'seen' => MetaSeenSet::load($this->metaDir . "/seen-$patch.bin"), 'dirty' => false];
        }
        return $this->buckets[$patch];
    }

    /**
     * Un appel Riot rythmé par meta_rate et borné par meta_time_budget.
     * @return array{0:int, 1:mixed} statut + JSON décodé (null si invalide ou erreur)
     */
    private function get(string $url): array
    {
        $rate = $this->config['meta_rate'];
        $budget = $this->config['meta_time_budget'];
        $now = microtime(true);
        $wait = $rate > 0 ? $this->lastRequest + 1.0 / $rate - $now : 0.0;
        if ($now + max(0.0, $wait) - $this->start >= $budget) {
            throw new MetaStop('budget de temps atteint');
        }
        if ($wait > 0) {
            usleep((int) ($wait * 1e6));
        }
        $this->lastRequest = microtime(true);
        $this->requests++;
        [$status, $body, $retryAfter] = riot_http_get($this->config['riot_api_key'], $url);

        if ($status === 401 || $status === 403) {
            throw new MetaStop("clé API Riot refusée (HTTP $status) : renouvelle-la dans config.php", 1);
        }
        if ($status === 429) {
            $seconds = ($retryAfter !== null && preg_match('/^[0-9]{1,5}$/D', $retryAfter) === 1)
                ? max(1, min(3600, (int) $retryAfter)) : META_DEFAULT_RETRY_AFTER;
            $this->state['blocked_until'] = time() + $seconds;
            throw new MetaStop("limite Riot atteinte (429), pause de $seconds s");
        }
        if ($status === 0 || $status >= 500) {
            if (++$this->networkErrors >= META_MAX_NETWORK_ERRORS) {
                throw new MetaStop('serveur Riot indisponible');
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

    private function loadState(): void
    {
        $s = meta_read_json($this->metaDir . '/state.json') ?? [];
        if (($s['platform'] ?? null) !== $this->platform) {
            if ($s !== []) {
                error_log('lolhelper meta: serveur changé, collecte réinitialisée');
            }
            foreach (glob($this->metaDir . '/{stats-*.json,seen-*.bin,summary.json}', GLOB_BRACE) ?: [] as $f) {
                @unlink($f);
            }
            $s = [];
        }
        $seeds = [];
        foreach (is_array($s['seeds'] ?? null) ? $s['seeds'] : [] as $p) {
            if (is_string($p) && preg_match(RIOT_PUUID_PATTERN, $p) === 1) {
                $seeds[] = $p;
            }
        }
        $tiers = is_array($s['seed_tiers'] ?? null) ? array_values(array_filter($s['seed_tiers'], 'is_string')) : [];
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
        $this->state = [
            'v' => 1,
            'platform' => $this->platform,
            'seeds' => $seeds,
            'seed_tiers' => $tiers,
            'seed_refreshed_at' => is_int($s['seed_refreshed_at'] ?? null) ? $s['seed_refreshed_at'] : 0,
            'cursor' => is_int($s['cursor'] ?? null) && $s['cursor'] >= 0 ? $s['cursor'] : 0,
            'blocked_until' => is_int($s['blocked_until'] ?? null) ? $s['blocked_until'] : 0,
            'patches' => $this->patches,
            'rejected' => [],
        ];
    }

    /**
     * Sauvegarde : ensembles « vus » d'abord, puis agrégats, résumé et état. Un arrêt brutal entre
     * les deux peut perdre quelques parties, jamais les compter deux fois.
     */
    private function checkpoint(): void
    {
        if ($this->state === []) {
            return;
        }
        foreach ($this->buckets as $patch => $b) {
            if ($b['dirty']) {
                $b['seen']->save($this->metaDir . "/seen-$patch.bin");
            }
        }
        $summary = [];
        foreach ($this->patches as $patch) {
            $b = $this->bucket($patch);
            if ($b['dirty']) {
                write_atomic($this->metaDir . "/stats-$patch.json", meta_encode_stats($b['stats']));
                $this->buckets[$patch]['dirty'] = false;
            }
            $summary[$patch] = ['games' => $b['stats']['games'], 'updated_at' => $b['stats']['updated_at']];
        }
        write_atomic($this->metaDir . '/summary.json', json_encode_safe([
            'platform' => $this->platform,
            'updated_at' => gmdate('Y-m-d\TH:i:s\Z'),
            'patches' => $summary ?: new stdClass(),
        ]));
        $this->state['patches'] = $this->patches;
        $this->state['rejected'] = array_keys($this->rejected);
        $this->state['last_run_at'] = time();
        write_atomic($this->metaDir . '/state.json', json_encode_safe($this->state));
    }
}
