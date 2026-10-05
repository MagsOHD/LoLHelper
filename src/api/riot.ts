// Browser-side Riot sync: orchestrates the PHP proxy routes (r=riot/...).
// Ported from the former Python backend (riot/ package).
import type { ChampionCatalog } from '../engine';
import type { MasteryEntry, Rank, RecentChampionStat, RecentSummary, Role } from './types';
import { ROLES } from './types';
import { ApiError, backendRequest, type Params } from './backend';

// ---- rate limiting ---------------------------------------------------------------------------

/** Riot development key limits: 20 requests / 1 s and 100 requests / 2 min. */
export const DEV_KEY_LIMITS: ReadonlyArray<readonly [number, number]> = [
  [20, 1000],
  [100, 120_000],
];

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sliding-window limiter; `limits` = [maxRequests, periodMs][]. */
export class RateLimiter {
  private events: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly maxPeriod: number;

  constructor(
    private readonly limits: ReadonlyArray<readonly [number, number]> = DEV_KEY_LIMITS,
    private readonly clock: () => number = () => Date.now(),
    private readonly sleep: Sleep = (ms) => realSleep(ms),
  ) {
    this.maxPeriod = Math.max(0, ...limits.map(([, p]) => p));
  }

  waitTime(now: number): number {
    while (this.events.length && now - this.events[0] >= this.maxPeriod) this.events.shift();
    let wait = 0;
    for (const [limit, period] of this.limits) {
      const recent = this.events.filter((t) => now - t < period);
      if (recent.length >= limit) {
        // The oldest request that must leave the window before we may send another one.
        wait = Math.max(wait, recent[recent.length - limit] + period - now);
      }
    }
    return wait;
  }

  /** Resolves when a request may be sent (FIFO). */
  acquire(): Promise<void> {
    if (!this.limits.length) return Promise.resolve();
    const next = this.queue.then(async () => {
      for (;;) {
        const now = this.clock();
        const wait = this.waitTime(now);
        if (wait <= 0) {
          this.events.push(now);
          return;
        }
        await this.sleep(wait);
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
  if (!defaultTransport) defaultTransport = { limiter: new RateLimiter(), sleep: realSleep, maxRetries: MAX_RETRIES };
  return defaultTransport;
}

/** Tests only. */
export function setTransportForTests(t: RiotTransport | null): void {
  defaultTransport = t;
}

const RATE_LIMITED_MESSAGE = 'Limite de requêtes Riot atteinte, réessaie dans quelques secondes.';

/** GET r=riot/<endpoint> through the client limiter, retrying 429 (Retry-After) up to maxRetries. */
export async function riotGet<T>(endpoint: string, params: Params, t: RiotTransport = getTransport()): Promise<T> {
  let attempt = 0;
  for (;;) {
    await t.limiter.acquire();
    try {
      return await backendRequest<T>('GET', `riot/${endpoint}`, { params });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 429) throw err;
      if (attempt >= t.maxRetries) throw new ApiError(err.message || RATE_LIMITED_MESSAGE, 429);
      attempt += 1;
      const seconds = err.retryAfter ?? attempt;
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
  return { games: 0, roles: emptyRoles(), champions: [] };
}

/** Python's round(x, 2) for the averages (banker's rounding is irrelevant at this precision). */
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Aggregate match summaries into the Player `recent` block. */
export function aggregateRecent(summaries: MatchSummary[], puuid: string, catalog: CatalogLike): RecentSummary {
  const roles = emptyRoles();
  let games = 0;
  const perChamp = new Map<
    string,
    { games: number; wins: number; kills: number; deaths: number; assists: number; roles: Map<Role, number> }
  >();
  for (const summary of summaries) {
    if (summary.queue_id === null || !SUMMONERS_RIFT_QUEUES.has(summary.queue_id)) continue;
    const me = summary.participants.find((p) => p.puuid === puuid);
    if (!me) continue;
    const championId = resolveChampionId(me, catalog);
    if (!championId) continue;
    games += 1;
    const role = mapPosition(me.teamPosition);
    if (role) roles[role] += 1;
    let stat = perChamp.get(championId);
    if (!stat) {
      stat = { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, roles: new Map() };
      perChamp.set(championId, stat);
    }
    stat.games += 1;
    stat.wins += me.win ? 1 : 0;
    stat.kills += me.kills;
    stat.deaths += me.deaths;
    stat.assists += me.assists;
    if (role) stat.roles.set(role, (stat.roles.get(role) ?? 0) + 1);
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
    });
  }
  champions.sort(
    (a, b) => b.games - a.games || b.wins - a.wins || (a.champion_id < b.champion_id ? -1 : a.champion_id > b.champion_id ? 1 : 0),
  );
  const orderedRoles = Object.fromEntries(ROLES.map((r) => [r, roles[r]])) as Record<Role, number>;
  return { games, roles: orderedRoles, champions };
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
    recent: aggregateRecent(summaries, puuid, catalog),
  };
}
