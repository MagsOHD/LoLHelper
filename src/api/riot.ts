// Browser-side Riot sync: orchestrates the PHP proxy routes (r=riot/...).
// Ported from the former Python backend (riot/ package).
import type { ChampionCatalog } from '../engine';
import type {
  AllyChampionPair,
  AllyHistory,
  LaneHistoryEntry,
  MasteryEntry,
  Rank,
  RecentChampionStat,
  RecentSummary,
  Role,
} from './types';
import { ROLES } from './types';
import { ApiError, backendRequest, type Params } from './backend';

// ---- rate limiting ---------------------------------------------------------------------------

/** [maxRequests, periodMs] pairs. */
export type Limits = ReadonlyArray<readonly [number, number]>;

/** Riot development key limits: 20 requests / 1 s and 100 requests / 2 min (assumed until a header says otherwise). */
export const DEV_KEY_LIMITS: Limits = [
  [20, 1000],
  [100, 120_000],
];
/** Share of each application window one browser aims for (the key is shared by the team and the collector). */
export const BROWSER_SHARE = 0.3;
/** The PHP gate answers 429 locally above this share of a window (user-facing calls). */
export const USER_SHARE = 0.95;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "20:1,100:120" (X-App-Rate-Limit: limit:seconds, or X-App-Rate-Limit-Count: count:seconds) ->
 * [[20, 1000], [100, 120000]]. Malformed pairs are dropped; null/empty -> [].
 */
export function parseRateLimitHeader(value: string | null | undefined): [number, number][] {
  if (!value) return [];
  const out: [number, number][] = [];
  for (const part of value.split(',')) {
    const m = /^\s*(\d{1,7})\s*:\s*(\d{1,6})\s*$/.exec(part);
    if (!m) continue;
    const n = Number(m[1]);
    const seconds = Number(m[2]);
    if (seconds > 0) out.push([n, seconds * 1000]);
  }
  return out.sort((a, b) => a[1] - b[1]);
}

/** Per-browser limits: `share` of each application window (at least 1, never above the window itself). */
export function browserLimits(app: Limits, share: number = BROWSER_SHARE): [number, number][] {
  return app
    .filter(([n, p]) => n > 0 && p > 0)
    .map(([n, p]): [number, number] => [Math.min(n, Math.max(1, Math.floor(n * share))), p]);
}

const sameLimits = (a: Limits, b: Limits) => a.length === b.length && a.every(([n, p], i) => n === b[i][0] && p === b[i][1]);

export interface RateLimiterOptions {
  /** Follow the application limits passed through by the PHP proxy (X-App-Rate-Limit[-Count]). */
  adaptive?: boolean;
  /** Share of each window this browser may use when adaptive (BROWSER_SHARE). */
  share?: number;
}

/**
 * Sliding-window limiter; `limits` = [maxRequests, periodMs][] (empty = disabled, e.g. tests).
 * Adaptive limiters re-derive their windows from the key's application limit seen in the proxied
 * headers, back off while the key's shared usage is near the server gate, and pause everyone on a
 * 429 + Retry-After.
 */
export class RateLimiter {
  private events: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private maxPeriod = 0;
  private pausedUntil = 0;
  private limitsNow: Limits;
  private appLimits: Limits | null = null;
  /** An X-App-Rate-Limit-Count header was seen: responses without one come from the PHP cache. */
  seenCounts = false;
  readonly adaptive: boolean;
  readonly share: number;
  /** Wakes a waiting acquire early (slot refunded, limits raised). */
  private wake: (() => void) | null = null;

  constructor(
    limits: Limits = browserLimits(DEV_KEY_LIMITS),
    private readonly clock: () => number = () => Date.now(),
    private readonly sleep: Sleep = (ms) => realSleep(ms),
    options: RateLimiterOptions = {},
  ) {
    this.limitsNow = limits;
    this.maxPeriod = Math.max(0, ...limits.map(([, p]) => p));
    this.adaptive = Boolean(options.adaptive) && limits.length > 0;
    this.share = options.share ?? BROWSER_SHARE;
  }

  /** Current per-browser windows. */
  get limits(): Limits {
    return this.limitsNow;
  }

  /** Application limits of the key as last seen (null before any header). */
  get keyLimits(): Limits | null {
    return this.appLimits;
  }

  setLimits(limits: Limits): void {
    if (!limits.length || sameLimits(limits, this.limitsNow)) return;
    this.limitsNow = limits;
    this.maxPeriod = Math.max(this.maxPeriod, ...limits.map(([, p]) => p));
    this.wakeUp();
  }

  private wakeUp(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Nobody sends before now + ms (local 429 + Retry-After, key nearly exhausted). */
  pauseFor(ms: number, now: number = this.clock()): void {
    if (!this.limitsNow.length || !(ms > 0)) return;
    this.pausedUntil = Math.max(this.pausedUntil, now + ms);
  }

  /**
   * Key limits / shared counts seen in a response (adaptive limiters only). The browser keeps
   * `share` of each window; when the key's count reaches the server gate (USER_SHARE) in a window,
   * sending pauses for about the time the excess needs to drain (uniform spread assumption).
   */
  observe(app: Limits, counts: Limits, now: number = this.clock()): void {
    if (!this.adaptive) return;
    if (app.length) {
      this.appLimits = app;
      this.setLimits(browserLimits(app, this.share));
    }
    if (counts.length) this.seenCounts = true;
    const known = app.length ? app : this.appLimits ?? DEV_KEY_LIMITS;
    for (const [count, period] of counts) {
      const limit = known.find(([, p]) => p === period)?.[0];
      if (!limit) continue;
      const gate = Math.floor(limit * USER_SHARE);
      if (count < gate) continue;
      const drain = Math.ceil(((count - gate + 1) * period) / limit);
      this.pauseFor(Math.min(period, Math.max(250, drain)), now);
    }
  }

  /** observe() from the proxied response headers. */
  observeHeaders(headers: Headers | null | undefined, now: number = this.clock()): void {
    if (!headers || !this.adaptive) return;
    this.observe(parseRateLimitHeader(headers.get('X-App-Rate-Limit')), parseRateLimitHeader(headers.get('X-App-Rate-Limit-Count')), now);
  }

  /** Gives back the slot taken at `token` (the answer came from the PHP cache: no Riot call). */
  refund(token: number): void {
    const i = this.events.lastIndexOf(token);
    if (i >= 0) {
      this.events.splice(i, 1);
      this.wakeUp();
    }
  }

  waitTime(now: number): number {
    while (this.events.length && now - this.events[0] >= this.maxPeriod) this.events.shift();
    let wait = Math.max(0, this.pausedUntil - now);
    for (const [limit, period] of this.limitsNow) {
      const recent = this.events.filter((t) => now - t < period);
      if (recent.length >= limit) {
        // The oldest request that must leave the window before we may send another one.
        wait = Math.max(wait, recent[recent.length - limit] + period - now);
      }
    }
    return wait;
  }

  /** Resolves (FIFO) with a token identifying the slot when a request may be sent. */
  acquire(): Promise<number> {
    if (!this.limitsNow.length) return Promise.resolve(-1);
    const next = this.queue.then(async () => {
      for (;;) {
        const now = this.clock();
        const wait = this.waitTime(now);
        if (wait <= 0) {
          this.events.push(now);
          return now;
        }
        await Promise.race([this.sleep(wait), new Promise<void>((resolve) => { this.wake = resolve; })]);
        this.wake = null;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

// ---- transport -------------------------------------------------------------------------------

export const MAX_RETRIES = 3;

export interface RiotTransport {
  limiter: RateLimiter;
  sleep: Sleep;
  maxRetries: number;
}

let defaultTransport: RiotTransport | null = null;

export function getTransport(): RiotTransport {
  if (!defaultTransport) {
    defaultTransport = {
      limiter: new RateLimiter(browserLimits(DEV_KEY_LIMITS), undefined, undefined, { adaptive: true }),
      sleep: realSleep,
      maxRetries: MAX_RETRIES,
    };
  }
  return defaultTransport;
}

/** Tests only. */
export function setTransportForTests(t: RiotTransport | null): void {
  defaultTransport = t;
}

export function rateLimitedMessage(retryAfter?: number): string {
  return retryAfter && retryAfter > 0
    ? `Limite de requêtes Riot atteinte (clé du site partagée) : réessaie dans ${Math.ceil(retryAfter)} s.`
    : 'Limite de requêtes Riot atteinte, réessaie dans quelques secondes.';
}

/**
 * GET r=riot/<endpoint> through the client limiter. The proxied X-App-Rate-Limit headers adapt the
 * limiter; a 429 (local gate or Riot, Retry-After) pauses every request of this browser and is
 * retried up to maxRetries, then fails with a French message. Answers served from the PHP cache
 * (X-Cache: HIT, or no count header once the proxy is known to pass them) give their slot back.
 */
export async function riotGet<T>(endpoint: string, params: Params, t: RiotTransport = getTransport()): Promise<T> {
  let attempt = 0;
  for (;;) {
    const token = await t.limiter.acquire();
    let counted = false;
    let cacheHit = false;
    try {
      const data = await backendRequest<T>('GET', `riot/${endpoint}`, {
        params,
        onHeaders: (h) => {
          cacheHit = (h.get('X-Cache') ?? '').toUpperCase() === 'HIT';
          counted = h.get('X-App-Rate-Limit-Count') !== null;
          t.limiter.observeHeaders(h);
        },
      });
      if (cacheHit || (!counted && t.limiter.seenCounts)) t.limiter.refund(token);
      return data;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 429) throw err;
      const seconds = err.retryAfter ?? attempt + 1;
      if (attempt >= t.maxRetries) throw new ApiError(rateLimitedMessage(err.retryAfter), 429, err.retryAfter);
      attempt += 1;
      t.limiter.pauseFor(seconds * 1000);
      await t.sleep(seconds * 1000);
    }
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

async function orEmpty<T>(p: Promise<T[] | null | undefined>): Promise<T[]> {
  try {
    return (await p) ?? [];
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

// ---- endpoints -------------------------------------------------------------------------------

export interface RiotAccount {
  puuid: string;
  gameName?: string;
  tagLine?: string;
}

export async function getAccount(gameName: string, tagLine: string, platform: string, t?: RiotTransport): Promise<RiotAccount> {
  const tag = tagLine.trim().replace(/^#+/, '');
  try {
    return await riotGet<RiotAccount>('account', { platform, gameName: gameName.trim(), tagLine: tag }, t);
  } catch (err) {
    if (isNotFound(err)) {
      throw new ApiError(`Riot ID introuvable : ${gameName}#${tagLine}. Vérifiez l'orthographe et le tag.`, 404);
    }
    // 400 from the proxy = parameter validation (except the "no key" case).
    if (err instanceof ApiError && err.status === 400 && !/clé/i.test(err.message)) {
      throw new ApiError(`Riot ID invalide : ${gameName}#${tagLine}. Vérifiez l'orthographe et le tag.`, 422);
    }
    throw err;
  }
}

interface RawSummoner {
  profileIconId?: number;
  summonerLevel?: number;
}

async function getSummoner(puuid: string, platform: string, t?: RiotTransport): Promise<RawSummoner> {
  try {
    return await riotGet<RawSummoner>('summoner', { platform, puuid }, t);
  } catch (err) {
    if (isNotFound(err)) {
      throw new ApiError(`Aucun compte League of Legends trouvé sur le serveur ${platform} pour ce joueur.`, 404);
    }
    throw err;
  }
}

// ---- pure aggregation helpers (aggregate.py) -------------------------------------------------

/** Summoner's Rift queues kept for "recent" stats: ranked solo, ranked flex, normal draft, quickplay. */
export const SUMMONERS_RIFT_QUEUES: ReadonlySet<number> = new Set([420, 440, 400, 490]);
export const RANK_QUEUES = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'] as const;
const POSITION_TO_ROLE: Record<string, Role> = {
  TOP: 'TOP',
  JUNGLE: 'JUNGLE',
  MIDDLE: 'MID',
  MID: 'MID',
  BOTTOM: 'BOTTOM',
  UTILITY: 'SUPPORT',
  SUPPORT: 'SUPPORT',
};

export function mapPosition(teamPosition: string | null | undefined): Role | null {
  return POSITION_TO_ROLE[(teamPosition || '').toUpperCase()] ?? null;
}

export interface RawLeagueEntry {
  queueType?: string;
  tier?: string;
  rank?: string;
  leaguePoints?: number;
  wins?: number;
  losses?: number;
}

export function pickRank(entries: RawLeagueEntry[] | null | undefined): Rank | null {
  const byQueue = new Map<string | undefined, RawLeagueEntry>();
  for (const e of entries ?? []) byQueue.set(e.queueType, e);
  for (const queue of RANK_QUEUES) {
    const e = byQueue.get(queue);
    if (e) {
      return {
        queue,
        tier: e.tier ?? '',
        division: e.rank ?? '',
        lp: Math.trunc(Number(e.leaguePoints ?? 0)),
        wins: Math.trunc(Number(e.wins ?? 0)),
        losses: Math.trunc(Number(e.losses ?? 0)),
      };
    }
  }
  return null;
}

export interface RawMastery {
  championId?: number;
  championLevel?: number;
  championPoints?: number;
  lastPlayTime?: number | null;
}

type CatalogLike = { get: ChampionCatalog['get']; byKey: ChampionCatalog['byKey'] };

/** champion-mastery-v4 entries -> MasteryEntry (numeric championId -> Data Dragon id). */
export function mapMasteries(raw: RawMastery[] | null | undefined, catalog: CatalogLike, limit = 30): MasteryEntry[] {
  const out: MasteryEntry[] = [];
  for (const entry of raw ?? []) {
    const champ = catalog.byKey(Number(entry.championId ?? -1));
    if (!champ) continue;
    out.push({
      champion_id: champ.id,
      level: Math.trunc(Number(entry.championLevel ?? 0)),
      points: Math.trunc(Number(entry.championPoints ?? 0)),
      last_play_time: entry.lastPlayTime ?? null,
    });
  }
  out.sort((a, b) => b.points - a.points);
  return out.slice(0, limit);
}

export interface MatchParticipant {
  puuid?: string;
  /** 100 (blue) / 200 (red); null when absent from the payload. */
  teamId: number | null;
  championName?: string;
  championId?: number;
  teamPosition: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
}

export interface MatchSummary {
  match_id: string | null;
  queue_id: number | null;
  game_creation: number | null;
  participants: MatchParticipant[];
}

interface RawParticipant {
  puuid?: string;
  championName?: string;
  championId?: number;
  teamId?: number;
  teamPosition?: string;
  individualPosition?: string;
  win?: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
}

export interface RawMatch {
  metadata?: { matchId?: string };
  info?: { queueId?: number; gameCreation?: number; participants?: RawParticipant[] };
}

/** Compact, puuid-independent summary of a match-v5 payload. */
export function summarizeMatch(raw: RawMatch): MatchSummary {
  const info = raw.info ?? {};
  return {
    match_id: raw.metadata?.matchId ?? null,
    queue_id: info.queueId ?? null,
    game_creation: info.gameCreation ?? null,
    participants: (info.participants ?? []).map((p) => ({
      puuid: p.puuid,
      teamId: typeof p.teamId === 'number' ? p.teamId : null,
      championName: p.championName,
      championId: p.championId,
      teamPosition: p.teamPosition || p.individualPosition || '',
      win: Boolean(p.win),
      kills: Math.trunc(Number(p.kills ?? 0)),
      deaths: Math.trunc(Number(p.deaths ?? 0)),
      assists: Math.trunc(Number(p.assists ?? 0)),
    })),
  };
}

export function resolveChampionId(p: MatchParticipant, catalog: CatalogLike): string | null {
  const name = p.championName || '';
  if (name) {
    const champ = catalog.get(name);
    if (champ) return champ.id;
  }
  if (p.championId !== undefined && p.championId !== null) {
    const champ = catalog.byKey(Number(p.championId));
    if (champ) return champ.id;
  }
  return name || null;
}

export function emptyRoles(): Record<Role, number> {
  return { TOP: 0, JUNGLE: 0, MID: 0, BOTTOM: 0, SUPPORT: 0 };
}

export function emptyRecent(): RecentSummary {
  return { games: 0, roles: emptyRoles(), champions: [], lane_matchups: [], allies: [] };
}

/** Caps on the stored history (the player doc is rewritten on every sync). */
export const MAX_LANE_MATCHUPS = 50;
export const MAX_ALLIES = 50;
export const MAX_ALLY_PAIRS = 20;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const roleIndex = (r: Role) => ROLES.indexOf(r);

function sameTeam(a: MatchParticipant, b: MatchParticipant): boolean | null {
  if (a.teamId === null || b.teamId === null) return null;
  return a.teamId === b.teamId;
}

/** The enemy laner: the only opposite-team participant on the same position (null if none/ambiguous). */
export function findLaneOpponent(me: MatchParticipant, participants: MatchParticipant[]): MatchParticipant | null {
  const role = mapPosition(me.teamPosition);
  if (!role) return null;
  const found = participants.filter((p) => p !== me && sameTeam(me, p) === false && mapPosition(p.teamPosition) === role);
  return found.length === 1 ? found[0] : null;
}

export interface AggregateOptions {
  /** Puuids always kept in `allies` even beyond MAX_ALLIES (other tracked players). */
  keepPuuids?: Iterable<string>;
}

/** Python's round(x, 2) for the averages (banker's rounding is irrelevant at this precision). */
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Aggregate match summaries into the Player `recent` block. */
export function aggregateRecent(
  summaries: MatchSummary[],
  puuid: string,
  catalog: CatalogLike,
  options: AggregateOptions = {},
): RecentSummary {
  const roles = emptyRoles();
  let games = 0;
  const perChamp = new Map<
    string,
    {
      games: number;
      wins: number;
      kills: number;
      deaths: number;
      assists: number;
      roles: Map<Role, number>;
      lastPlayed: number | null;
    }
  >();
  const lanes = new Map<string, LaneHistoryEntry>();
  const allies = new Map<string, { games: number; wins: number; pairs: Map<string, AllyChampionPair> }>();
  for (const summary of summaries) {
    if (summary.queue_id === null || !SUMMONERS_RIFT_QUEUES.has(summary.queue_id)) continue;
    const me = summary.participants.find((p) => p.puuid === puuid);
    if (!me) continue;
    const championId = resolveChampionId(me, catalog);
    if (!championId) continue;
    games += 1;
    const win = me.win ? 1 : 0;
    const role = mapPosition(me.teamPosition);
    if (role) roles[role] += 1;
    let stat = perChamp.get(championId);
    if (!stat) {
      stat = { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, roles: new Map(), lastPlayed: null };
      perChamp.set(championId, stat);
    }
    stat.games += 1;
    stat.wins += win;
    stat.kills += me.kills;
    stat.deaths += me.deaths;
    stat.assists += me.assists;
    if (role) stat.roles.set(role, (stat.roles.get(role) ?? 0) + 1);
    const created = summary.game_creation;
    if (typeof created === 'number' && Number.isFinite(created) && (stat.lastPlayed === null || created > stat.lastPlayed)) {
      stat.lastPlayed = created;
    }

    // Lane duel actually played (same position, enemy team).
    const opponent = role ? findLaneOpponent(me, summary.participants) : null;
    const opponentId = opponent ? resolveChampionId(opponent, catalog) : null;
    if (role && opponentId) {
      const key = `${role}|${championId}|${opponentId}`;
      const entry = lanes.get(key) ?? { champion_id: championId, opponent_id: opponentId, role, games: 0, wins: 0 };
      entry.games += 1;
      entry.wins += win;
      lanes.set(key, entry);
    }

    // Games played on the same team as other accounts.
    for (const p of summary.participants) {
      if (p === me || !p.puuid || p.puuid === puuid || sameTeam(me, p) !== true) continue;
      const allyChamp = resolveChampionId(p, catalog);
      let ally = allies.get(p.puuid);
      if (!ally) {
        ally = { games: 0, wins: 0, pairs: new Map() };
        allies.set(p.puuid, ally);
      }
      ally.games += 1;
      ally.wins += win;
      if (allyChamp) {
        const key = `${championId}|${allyChamp}`;
        const pair = ally.pairs.get(key) ?? { champion_id: championId, ally_champion_id: allyChamp, games: 0, wins: 0 };
        pair.games += 1;
        pair.wins += win;
        ally.pairs.set(key, pair);
      }
    }
  }

  const champions: RecentChampionStat[] = [];
  for (const [champion_id, s] of perChamp) {
    // most_common(1): highest count, first inserted on ties.
    let best: Role | null = null;
    let bestCount = 0;
    for (const [r, n] of s.roles) {
      if (n > bestCount) {
        best = r;
        bestCount = n;
      }
    }
    champions.push({
      champion_id,
      games: s.games,
      wins: s.wins,
      kills: round2(s.kills / s.games),
      deaths: round2(s.deaths / s.games),
      assists: round2(s.assists / s.games),
      role: best,
      last_played: s.lastPlayed,
    });
  }
  champions.sort((a, b) => b.games - a.games || b.wins - a.wins || cmpStr(a.champion_id, b.champion_id));

  const lane_matchups = [...lanes.values()]
    .sort(
      (a, b) =>
        b.games - a.games ||
        b.wins - a.wins ||
        roleIndex(a.role) - roleIndex(b.role) ||
        cmpStr(a.champion_id, b.champion_id) ||
        cmpStr(a.opponent_id, b.opponent_id),
    )
    .slice(0, MAX_LANE_MATCHUPS);

  const allyList: AllyHistory[] = [...allies.entries()]
    .map(([allyPuuid, a]) => ({
      puuid: allyPuuid,
      games: a.games,
      wins: a.wins,
      pairs: [...a.pairs.values()]
        .sort(
          (x, y) =>
            y.games - x.games ||
            y.wins - x.wins ||
            cmpStr(x.champion_id, y.champion_id) ||
            cmpStr(x.ally_champion_id, y.ally_champion_id),
        )
        .slice(0, MAX_ALLY_PAIRS),
    }))
    .sort((a, b) => b.games - a.games || b.wins - a.wins || cmpStr(a.puuid, b.puuid));
  // Keep the most frequent teammates, plus every tracked player whatever the cap.
  const keep = new Set(options.keepPuuids ?? []);
  const kept = new Set(allyList.slice(0, MAX_ALLIES).map((a) => a.puuid));
  const alliesOut = allyList.filter((a) => kept.has(a.puuid) || keep.has(a.puuid));

  const orderedRoles = Object.fromEntries(ROLES.map((r) => [r, roles[r]])) as Record<Role, number>;
  return { games, roles: orderedRoles, champions, lane_matchups, allies: alliesOut };
}

// ---- high level (player_data.py) -------------------------------------------------------------

export const MATCH_COUNT = 20;
export const MATCH_CONCURRENCY = 3;

/** Run `fn` over `items` with at most `concurrency` in flight; results keep `items` order. */
async function mapPool<I, O>(items: I[], concurrency: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return out;
}

export async function fetchMatchSummaries(
  matchIds: string[],
  platform: string,
  t?: RiotTransport,
  concurrency = MATCH_CONCURRENCY,
): Promise<MatchSummary[]> {
  const results = await mapPool(matchIds, concurrency, async (id) => {
    try {
      return summarizeMatch(await riotGet<RawMatch>('match', { platform, id }, t));
    } catch (err) {
      if (isNotFound(err)) return null; // match vanished: skipped
      throw err;
    }
  });
  return results.filter((s): s is MatchSummary => s !== null);
}

export interface RiotFields {
  profile_icon_id: number | null;
  summoner_level: number | null;
  rank: Rank | null;
  masteries: MasteryEntry[];
  recent: RecentSummary;
}

/** Everything we store about a player from the Riot API. */
export async function fetchPlayerData(
  puuid: string,
  platform: string,
  catalog: CatalogLike,
  t?: RiotTransport,
  options: AggregateOptions = {},
): Promise<RiotFields> {
  const [summoner, entries, masteriesRaw, matchIds] = await Promise.all([
    getSummoner(puuid, platform, t),
    orEmpty(riotGet<RawLeagueEntry[]>('league', { platform, puuid }, t)),
    orEmpty(riotGet<RawMastery[]>('masteries', { platform, puuid, count: 30 }, t)),
    orEmpty(riotGet<string[]>('match-ids', { platform, puuid, count: MATCH_COUNT }, t)),
  ]);
  const summaries = await fetchMatchSummaries(matchIds, platform, t);
  return {
    profile_icon_id: summoner.profileIconId ?? null,
    summoner_level: summoner.summonerLevel ?? null,
    rank: pickRank(entries),
    masteries: mapMasteries(masteriesRaw, catalog),
    recent: aggregateRecent(summaries, puuid, catalog, options),
  };
}
