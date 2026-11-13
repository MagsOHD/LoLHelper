// Enemy player profiles (scouting by Riot ID, enemies revealed by the client in Clash/custom games,
// started game): summoner level, rank, top masteries and recent games aggregated into a compact
// RecentSummary + PlaystyleStats. Every Riot call goes through the shared client rate limiter
// (riotGet); profiles are deduplicated while in flight and cached per puuid for the session.
import type { ChampionCatalog } from '../engine';
import type { EnemyPlayerProfile, EnemyProfileSource, MasteryEntry, PlaystyleStats, RecentSummary, Role } from './types';
import { ApiError } from './backend';
import {
  aggregateRecent,
  getAccount,
  mapMasteries,
  pickRank,
  riotGet,
  summarizeMatch,
  SUMMONERS_RIFT_QUEUES,
  type RawLeagueEntry,
  type RawMastery,
  type RawMatch,
  type RiotTransport,
} from './riot';
import { parseRiotId } from '../lib/format';

/** Match history depth: scouting is done ahead of time, client/game profiles must be quick. */
export const SCOUT_MATCH_COUNT = 10;
export const QUICK_MATCH_COUNT = 5;
export const PROFILE_MASTERY_COUNT = 20;
export const PROFILE_CHAMPION_COUNT = 15;
/** Calls per profile without the Riot ID lookup: summoner + league + masteries + match ids. */
export const PROFILE_BASE_CALLS = 4;
/** Profiles built at the same time (the rate limiter is shared anyway; this lets the first ones finish early). */
export const PROFILE_CONCURRENCY = 2;
export const PROFILE_MATCH_CONCURRENCY = 3;
/** Games shorter than this (remakes) are ignored by the playstyle stats. */
export const MIN_GAME_MINUTES = 5;

export const matchCountFor = (source: EnemyProfileSource): number => (source === 'scouting' ? SCOUT_MATCH_COUNT : QUICK_MATCH_COUNT);

/** Upper bound of Riot calls for one profile. */
export function profileCallBudget(matchCount: number, needsAccount: boolean): number {
  return (needsAccount ? 1 : 0) + PROFILE_BASE_CALLS + matchCount;
}

// ---- playstyle aggregation (pure) --------------------------------------------------------------

interface RawChallenges {
  killParticipation?: number;
  soloKills?: number;
  laningPhaseGoldExpAdvantage?: number;
  turretTakedowns?: number;
}

interface RawStyleParticipant {
  puuid?: string;
  teamId?: number;
  win?: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
  totalMinionsKilled?: number;
  neutralMinionsKilled?: number;
  visionScore?: number;
  totalDamageDealtToChampions?: number;
  firstBloodKill?: boolean;
  firstBloodAssist?: boolean;
  turretTakedowns?: number;
  timePlayed?: number;
  challenges?: RawChallenges | null;
}

interface RawStyleMatch {
  info?: {
    queueId?: number;
    gameDuration?: number;
    gameEndTimestamp?: number;
    participants?: RawStyleParticipant[];
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Minutes played: participant timePlayed, else the game duration (milliseconds before patch 11.20). */
function minutesOf(info: NonNullable<RawStyleMatch['info']>, p: RawStyleParticipant): number {
  const played = num(p.timePlayed);
  if (played > 0) return played / 60;
  let d = num(info.gameDuration);
  if (info.gameEndTimestamp === undefined && d > 20_000) d /= 1000;
  return d / 60;
}

/**
 * Averages per game over the Summoner's Rift games of `puuid` (same queues as the recent stats,
 * remakes skipped). Per-minute values are totals / minutes played. Challenge-based values are
 * averaged over the games that carry them; `early_lead` is null when none does. null without games.
 */
export function aggregatePlaystyle(matches: unknown[], puuid: string): PlaystyleStats | null {
  let games = 0;
  let wins = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let cs = 0;
  let vision = 0;
  let damage = 0;
  let minutes = 0;
  let kp = 0;
  let kpGames = 0;
  let solo = 0;
  let soloGames = 0;
  let fb = 0;
  let lead = 0;
  let leadGames = 0;
  let turrets = 0;
  for (const raw of matches) {
    const info = (raw as RawStyleMatch | null)?.info;
    if (!info || typeof info.queueId !== 'number' || !SUMMONERS_RIFT_QUEUES.has(info.queueId)) continue;
    const parts = Array.isArray(info.participants) ? info.participants.filter((p) => p && typeof p === 'object') : [];
    const me = parts.find((p) => p.puuid === puuid);
    if (!me) continue;
    const m = minutesOf(info, me);
    if (m < MIN_GAME_MINUTES) continue;
    const ch = me.challenges && typeof me.challenges === 'object' ? me.challenges : null;
    games += 1;
    wins += me.win ? 1 : 0;
    kills += num(me.kills);
    deaths += num(me.deaths);
    assists += num(me.assists);
    cs += num(me.totalMinionsKilled) + num(me.neutralMinionsKilled);
    vision += num(me.visionScore);
    damage += num(me.totalDamageDealtToChampions);
    minutes += m;
    const kpc = optNum(ch?.killParticipation);
    if (kpc !== null) {
      kp += Math.max(0, Math.min(1, kpc));
      kpGames += 1;
    } else if (typeof me.teamId === 'number') {
      const teamKills = parts.filter((p) => p.teamId === me.teamId).reduce((s, p) => s + num(p.kills), 0);
      kp += teamKills > 0 ? Math.min(1, (num(me.kills) + num(me.assists)) / teamKills) : 0;
      kpGames += 1;
    }
    const sk = optNum(ch?.soloKills);
    if (sk !== null) {
      solo += sk;
      soloGames += 1;
    }
    if (me.firstBloodKill || me.firstBloodAssist) fb += 1;
    const el = optNum(ch?.laningPhaseGoldExpAdvantage);
    if (el !== null) {
      lead += el;
      leadGames += 1;
    }
    turrets += optNum(me.turretTakedowns) ?? num(ch?.turretTakedowns);
  }
  if (!games) return null;
  const perMin = (x: number) => (minutes > 0 ? round2(x / minutes) : 0);
  return {
    games,
    wins,
    kills: round2(kills / games),
    deaths: round2(deaths / games),
    assists: round2(assists / games),
    cs_per_min: perMin(cs),
    vision_per_min: perMin(vision),
    damage_per_min: perMin(damage),
    kill_participation: kpGames ? round2(kp / kpGames) : 0,
    solo_kills: soloGames ? round2(solo / soloGames) : 0,
    first_blood_rate: round2(fb / games),
    early_lead: leadGames ? round2(lead / leadGames) : null,
    turret_takedowns: round2(turrets / games),
    avg_game_minutes: round2(minutes / games),
  };
}

/** Recent block kept in the shared draft document: roles + top champions only (no history lists). */
export function compactRecent(recent: RecentSummary | null | undefined): RecentSummary {
  const roles: Partial<Record<Role, number>> = {};
  for (const [r, n] of Object.entries(recent?.roles ?? {})) if (typeof n === 'number' && n > 0) roles[r as Role] = Math.trunc(n);
  return {
    games: Math.trunc(num(recent?.games)),
    roles,
    champions: (recent?.champions ?? []).slice(0, PROFILE_CHAMPION_COUNT).map((c) => ({
      champion_id: c.champion_id,
      games: Math.trunc(num(c.games)),
      wins: Math.trunc(num(c.wins)),
      kills: round2(num(c.kills)),
      deaths: round2(num(c.deaths)),
      assists: round2(num(c.assists)),
      role: c.role ?? null,
      last_played: c.last_played ?? null,
    })),
  };
}

// ---- profile builder (I/O) ---------------------------------------------------------------------

export interface ProfileRequest {
  source: EnemyProfileSource;
  platform: string;
  /** Known account (client-revealed or started game). */
  puuid?: string | null;
  /** "Name#TAG": resolved through riot/account when no puuid is given (scouting); else display only. */
  riot_id?: string | null;
  champion_id?: string | null;
  role?: Role | null;
  /** Defaults to matchCountFor(source). */
  match_count?: number;
}

export interface ProfileProgress {
  calls: number;
  /** Upper bound, lowered once the match ids are known. */
  total: number;
}

type CatalogLike = { get: ChampionCatalog['get']; byKey: ChampionCatalog['byKey'] };

export interface BuildOptions {
  transport?: RiotTransport;
  onProgress?: (p: ProfileProgress) => void;
  now?: () => number;
}

const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Hard call counter around riotGet. */
class CallBudget {
  calls = 0;
  constructor(public total: number, private readonly t: RiotTransport | undefined, private readonly onProgress?: (p: ProfileProgress) => void) {}
  async get<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
    if (this.calls >= this.total) throw new ApiError('Budget d’appels Riot dépassé.', 429);
    this.calls += 1;
    try {
      return await riotGet<T>(endpoint, params, this.t);
    } finally {
      this.report();
    }
  }
  report(): void {
    this.onProgress?.({ calls: this.calls, total: this.total });
  }
}

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

export interface BuiltProfile {
  profile: EnemyPlayerProfile;
  calls: number;
}

/**
 * One enemy profile: (riot/account when only a Riot ID is known) + summoner + league + masteries
 * (top 20) + match ids (`match_count`) + one riot/match per id (cached by the PHP proxy).
 */
export async function buildEnemyProfile(req: ProfileRequest, catalog: CatalogLike, options: BuildOptions = {}): Promise<BuiltProfile> {
  const count = Math.max(0, Math.min(20, Math.trunc(req.match_count ?? matchCountFor(req.source))));
  let puuid = req.puuid || '';
  let riotId = req.riot_id?.trim() || null;
  const budget = new CallBudget(profileCallBudget(count, !puuid), options.transport, options.onProgress);
  budget.report();
  if (!puuid) {
    const id = riotId ? parseRiotId(riotId) : null;
    if (!id) throw new ApiError('Riot ID invalide : utilisez le format Nom#TAG.', 422);
    if (budget.calls >= budget.total) throw new ApiError('Budget d’appels Riot dépassé.', 429);
    budget.calls += 1;
    try {
      const account = await getAccount(id.game_name, id.tag_line, req.platform, options.transport);
      puuid = account.puuid;
      riotId = `${account.gameName || id.game_name}#${account.tagLine || id.tag_line}`;
    } finally {
      budget.report();
    }
    if (!puuid) throw new ApiError(`Riot ID introuvable : ${riotId}.`, 404);
  }
  const platform = req.platform;
  const [summoner, entries, masteriesRaw, ids] = await Promise.all([
    orNull(budget.get<{ summonerLevel?: number }>('summoner', { platform, puuid })),
    orNull(budget.get<RawLeagueEntry[]>('league', { platform, puuid })),
    orNull(budget.get<RawMastery[]>('masteries', { platform, puuid, count: PROFILE_MASTERY_COUNT })),
    count > 0 ? orNull(budget.get<string[]>('match-ids', { platform, puuid, count })) : Promise.resolve([] as string[]),
  ]);
  if (!summoner && !entries && !masteriesRaw && !ids) {
    throw new ApiError(`Aucun compte League of Legends trouvé sur le serveur ${platform} pour ce joueur.`, 404);
  }
  const matchIds = (Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === 'string').slice(0, count);
  budget.total = budget.calls + matchIds.length;
  budget.report();
  const raws = await mapPool(matchIds, PROFILE_MATCH_CONCURRENCY, (id) => orNull(budget.get<RawMatch>('match', { platform, id })));
  const matches = raws.filter((m): m is RawMatch => !!m && typeof m === 'object');
  const masteries: MasteryEntry[] = mapMasteries(Array.isArray(masteriesRaw) ? masteriesRaw : [], catalog, PROFILE_MASTERY_COUNT);
  const recent = compactRecent(aggregateRecent(matches.map(summarizeMatch), puuid, catalog));
  const now = options.now ? options.now() : Date.now();
  const profile: EnemyPlayerProfile = {
    puuid,
    riot_id: riotId,
    source: req.source,
    summoner_level: typeof summoner?.summonerLevel === 'number' ? summoner.summonerLevel : null,
    rank: pickRank(Array.isArray(entries) ? entries : []),
    masteries,
    recent,
    style: aggregatePlaystyle(matches, puuid),
    champion_id: req.champion_id ?? null,
    role: req.role ?? null,
    fetched_at: new Date(now).toISOString(),
  };
  return { profile, calls: budget.calls };
}

// ---- session service: dedupe, cache, statuses ---------------------------------------------------

export type ProfileState = 'loading' | 'done' | 'error';

export interface ProfileStatus {
  /** Request key: the puuid, or "id:<platform>:<riot id>" for scouting before resolution. */
  key: string;
  source: EnemyProfileSource;
  riot_id: string | null;
  puuid: string | null;
  state: ProfileState;
  error: string | null;
  calls: number;
  total: number;
}

export type ProfileBuilder = (req: ProfileRequest, onProgress: (p: ProfileProgress) => void) => Promise<EnemyPlayerProfile>;

export function requestKey(req: ProfileRequest): string {
  if (req.puuid) return req.puuid;
  return `id:${req.platform}:${(req.riot_id ?? '').trim().toLowerCase()}`;
}

interface CacheEntry {
  profile: EnemyPlayerProfile;
  /** Match history depth it was built with (Infinity for profiles read from the shared document). */
  matches: number;
}

/**
 * Builds profiles once per session: concurrent requests for the same player share one build,
 * finished profiles are cached per puuid (and per Riot ID), profiles already in the shared draft
 * document are seeded so they are never fetched again. Framework-agnostic (subscribe/getStatuses).
 */
export class EnemyProfileService {
  private cache = new Map<string, CacheEntry>();
  private aliases = new Map<string, string>(); // riot id key -> puuid
  private inflight = new Map<string, Promise<EnemyPlayerProfile>>();
  private status = new Map<string, ProfileStatus>();
  private listeners = new Set<() => void>();
  private snapshot: ProfileStatus[] = [];
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly build: ProfileBuilder, private readonly concurrency = PROFILE_CONCURRENCY) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getStatuses = (): ProfileStatus[] => this.snapshot;

  private emit(): void {
    this.snapshot = [...this.status.values()];
    for (const fn of this.listeners) fn();
  }

  private setStatus(key: string, patch: Partial<ProfileStatus> & Pick<ProfileStatus, 'source'>): void {
    const prev = this.status.get(key);
    this.status.set(key, {
      key,
      riot_id: null,
      puuid: null,
      state: 'loading',
      error: null,
      calls: 0,
      total: 0,
      ...prev,
      ...patch,
    });
    this.emit();
  }

  /** Profiles already known (shared document): never fetched again this session. */
  seed(profiles: EnemyPlayerProfile[] | undefined): void {
    for (const p of profiles ?? []) {
      if (!p?.puuid) continue;
      const cur = this.cache.get(p.puuid);
      if (!cur || cur.profile.fetched_at < p.fetched_at) this.cache.set(p.puuid, { profile: p, matches: Number.POSITIVE_INFINITY });
      if (p.riot_id) this.aliases.set(`id:*:${p.riot_id.toLowerCase()}`, p.puuid);
    }
  }

  cached(req: ProfileRequest): EnemyPlayerProfile | null {
    const want = req.match_count ?? matchCountFor(req.source);
    const puuid = req.puuid || this.aliases.get(requestKey(req)) || (req.riot_id ? this.aliases.get(`id:*:${req.riot_id.trim().toLowerCase()}`) : undefined);
    const hit = puuid ? this.cache.get(puuid) : undefined;
    return hit && hit.matches >= want ? hit.profile : null;
  }

  isPending(key: string): boolean {
    return this.inflight.has(key);
  }

  /** Cached profile, the build already in flight, or a new build (queued behind `concurrency`). */
  request(req: ProfileRequest): Promise<EnemyPlayerProfile> {
    const hit = this.cached(req);
    const key = requestKey(req);
    if (hit) return Promise.resolve(withRequest(hit, req));
    const running = this.inflight.get(key);
    if (running) return running.then((p) => withRequest(p, req));
    const want = req.match_count ?? matchCountFor(req.source);
    this.setStatus(key, { source: req.source, riot_id: req.riot_id ?? null, puuid: req.puuid ?? null, state: 'loading', error: null, calls: 0, total: 0 });
    const job = (async () => {
      await this.slot();
      try {
        const profile = await this.build(req, (p) => this.setStatus(key, { source: req.source, calls: p.calls, total: p.total }));
        this.cache.set(profile.puuid, { profile, matches: want });
        this.aliases.set(key, profile.puuid);
        if (profile.riot_id) this.aliases.set(`id:*:${profile.riot_id.toLowerCase()}`, profile.puuid);
        if (req.riot_id) this.aliases.set(`id:*:${req.riot_id.trim().toLowerCase()}`, profile.puuid);
        this.setStatus(key, { source: req.source, state: 'done', puuid: profile.puuid, riot_id: profile.riot_id ?? req.riot_id ?? null });
        return profile;
      } catch (err) {
        this.setStatus(key, { source: req.source, state: 'error', error: err instanceof Error ? err.message : 'Profil indisponible.' });
        throw err;
      } finally {
        this.inflight.delete(key);
        this.release();
      }
    })();
    this.inflight.set(key, job);
    return job.then((p) => withRequest(p, req));
  }

  /** Drops a status line (removed scouting entry / dismissed error). The cache is kept. */
  forget(key: string): void {
    if (this.status.delete(key)) this.emit();
  }

  private slot(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => {
      this.active += 1;
      resolve();
    }));
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

/** The cached profile seen through a new request (source, champion, role, display Riot ID). */
function withRequest(p: EnemyPlayerProfile, req: ProfileRequest): EnemyPlayerProfile {
  return {
    ...p,
    source: req.source,
    riot_id: p.riot_id ?? req.riot_id ?? null,
    champion_id: req.champion_id ?? p.champion_id ?? null,
    role: req.role ?? p.role ?? null,
  };
}

/** Aggregated progress of the builds in flight (for the "Appels Riot" bar). */
export function overallProgress(statuses: ProfileStatus[]): { loading: number; calls: number; total: number } {
  const loading = statuses.filter((s) => s.state === 'loading');
  return {
    loading: loading.length,
    calls: loading.reduce((n, s) => n + s.calls, 0),
    total: loading.reduce((n, s) => n + Math.max(s.total, s.calls), 0),
  };
}
