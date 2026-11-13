// High-elo meta stats collected by the PHP cron (r=meta-stats), mapped to Data Dragon ids.
// Optional data: any failure resolves to null so composition generation is never blocked.
import type { ChampionCatalog } from '../engine';
import type { GamesWins, MetaStats, Role } from './types';
import { ApiError, backendRequest } from './backend';
import { getCatalog } from './ddragon';
import { mapPosition } from './riot';
import { comparePatchDesc } from './metaTier';

type RawGamesWins = unknown;

/** Payload of GET r=meta-stats (numeric champion keys as strings). */
export interface RawMetaStats {
  available?: boolean;
  patch?: string;
  platform?: string;
  games?: number;
  updated_at?: string;
  champions?: Record<string, Record<string, RawGamesWins>>;
  bans?: Record<string, unknown>;
  matchups?: Record<string, Record<string, Record<string, RawGamesWins>>>;
}

type KeyCatalog = { byKey: ChampionCatalog['byKey'] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;

function gamesWins(v: unknown): GamesWins | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const games = count(v[0]);
  const wins = count(v[1]);
  if (games === null || wins === null || games === 0) return null;
  return [games, Math.min(wins, games)];
}

function championId(key: string, catalog: KeyCatalog): string | null {
  if (!/^\d+$/.test(key)) return null;
  return catalog.byKey(Number(key))?.id ?? null;
}

const entries = (v: unknown): [string, unknown][] => (isObject(v) ? Object.entries(v) : []);

/** Raw payload -> MetaStats (unknown champions and malformed cells dropped); null when unavailable. */
export function mapMetaStats(raw: RawMetaStats | null | undefined, catalog: KeyCatalog): MetaStats | null {
  if (!isObject(raw) || raw.available !== true) return null;
  const games = count(raw.games);
  if (!games) return null;

  const champions: MetaStats['champions'] = {};
  for (const [key, byRole] of entries(raw.champions)) {
    const id = championId(key, catalog);
    if (!id) continue;
    const roles: Partial<Record<Role, GamesWins>> = {};
    for (const [rawRole, cell] of entries(byRole)) {
      const role = mapPosition(rawRole);
      const gw = gamesWins(cell);
      if (role && gw) roles[role] = gw;
    }
    if (Object.keys(roles).length) champions[id] = roles;
  }

  const bans: MetaStats['bans'] = {};
  for (const [key, n] of entries(raw.bans)) {
    const id = championId(key, catalog);
    const c = count(n);
    if (id && c) bans[id] = c;
  }

  const matchups: MetaStats['matchups'] = {};
  for (const [rawRole, byChamp] of entries(raw.matchups)) {
    const role = mapPosition(rawRole);
    if (!role) continue;
    const out: Record<string, Record<string, GamesWins>> = {};
    for (const [key, byOpp] of entries(byChamp)) {
      const id = championId(key, catalog);
      if (!id) continue;
      const opps: Record<string, GamesWins> = {};
      for (const [oppKey, cell] of entries(byOpp)) {
        const opp = championId(oppKey, catalog);
        const gw = gamesWins(cell);
        if (opp && gw) opps[opp] = gw;
      }
      if (Object.keys(opps).length) out[id] = opps;
    }
    if (Object.keys(out).length) matchups[role] = out;
  }

  return {
    patch: typeof raw.patch === 'string' ? raw.patch : '',
    platform: typeof raw.platform === 'string' ? raw.platform : '',
    games,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    champions,
    bans,
    matchups,
  };
}

/** After a failed fetch, wait this long before asking the server again. */
export const META_RETRY_MS = 5 * 60 * 1000;

let metaPromise: Promise<MetaStats | null> | null = null;
let failedAt: number | null = null;
const patchCache = new Map<string, Promise<MetaStats | null>>();

/**
 * r=meta-stats sends Cache-Control max-age=300: always bypass the browser HTTP cache, otherwise a
 * reload right after a collection would show the old snapshot. The session cache above dedupes.
 */
function fetchStats(patch?: string): Promise<MetaStats | null> {
  return Promise.all([
    backendRequest<RawMetaStats>('GET', 'meta-stats', { params: patch ? { patch } : {}, cache: 'no-store' }),
    getCatalog(),
  ]).then(([raw, { catalog }]) => mapMetaStats(raw, catalog));
}

/**
 * Meta stats for this session (fetched once, shared promise). Never rejects: null when nothing has
 * been collected, when the route is missing or on any error (retried after META_RETRY_MS).
 */
export function getMetaStats(now: number = Date.now()): Promise<MetaStats | null> {
  if (metaPromise && failedAt !== null && now - failedAt >= META_RETRY_MS) {
    metaPromise = null;
    failedAt = null;
  }
  if (!metaPromise) {
    metaPromise = fetchStats().catch(() => {
      failedAt = now;
      return null;
    });
  }
  return metaPromise;
}

export const PATCH_PATTERN = /^\d{1,3}\.\d{1,3}$/;

/**
 * Stats of one kept patch (r=meta-stats&patch=), or the served patch when `patch` is empty (shared
 * with getMetaStats). null when the patch is not kept (404) or empty; other errors reject.
 */
export function getMetaStatsForPatch(patch?: string | null): Promise<MetaStats | null> {
  if (!patch) return getMetaStats();
  if (!PATCH_PATTERN.test(patch)) return Promise.resolve(null);
  let p = patchCache.get(patch);
  if (!p) {
    p = fetchStats(patch).catch((err) => {
      patchCache.delete(patch);
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
    patchCache.set(patch, p);
  }
  return p;
}

/** Forget every cached snapshot (after a collection): generation, draft and the Meta page refetch. */
export function invalidateMetaStats(): void {
  metaPromise = null;
  failedAt = null;
  patchCache.clear();
}

/** Tests only. */
export function resetMetaForTests(): void {
  metaPromise = null;
  failedAt = null;
  patchCache.clear();
}

// ---- collection status / manual collection (r=meta-status, r=meta-collect) --------------------

export interface MetaPatchInfo {
  patch: string;
  games: number;
  updated_at: string;
}

/** Summary of one collector pass (cron or web). */
export interface MetaRunSummary {
  stop: string;
  requests: number;
  new_matches: number;
  patch: string | null;
  games: number;
  duration_s: number;
  /** ISO date of the end of the pass ('' when unknown). */
  at: string;
  /** Who ran the pass (last_run only). */
  source?: 'cron' | 'web';
  /** Server's French explanation of the stop, when given. */
  message?: string;
  /** Seconds before Riot accepts requests again (stop = riot_limit). */
  retry_after?: number;
}

export interface MetaStatus {
  /** The collector lock is held (cron or another click running). */
  collecting: boolean;
  /** admin_password is set on the server (manual collection allowed). */
  admin_enabled: boolean;
  /** Meta collection switched on in config.php (false: neither cron nor button collects). */
  meta_enabled: boolean;
  last_run: MetaRunSummary | null;
  /** Kept patches, most recent first. */
  patches: MetaPatchInfo[];
}

export type CollectResult = { status: 'busy' } | ({ status: 'ok'; patches: MetaPatchInfo[] } & MetaRunSummary);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Accepts [{patch, games, updated_at}] or {"16.19": {games, updated_at}}; invalid entries dropped. */
export function normalizePatches(raw: unknown): MetaPatchInfo[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : entries(raw).map(([patch, info]) => (isObject(info) ? { ...info, patch } : null));
  const seen = new Map<string, MetaPatchInfo>();
  for (const item of list) {
    if (!isObject(item)) continue;
    const patch = str(item.patch);
    if (!PATCH_PATTERN.test(patch) || seen.has(patch)) continue;
    seen.set(patch, { patch, games: Math.trunc(num(item.games)), updated_at: str(item.updated_at) });
  }
  return [...seen.values()].sort((a, b) => comparePatchDesc(a.patch, b.patch));
}

function normalizeRun(v: unknown): MetaRunSummary | null {
  if (!isObject(v)) return null;
  const run: MetaRunSummary = {
    stop: str(v.stop),
    requests: Math.trunc(num(v.requests)),
    new_matches: Math.trunc(num(v.new_matches)),
    patch: PATCH_PATTERN.test(str(v.patch)) ? str(v.patch) : null,
    games: Math.trunc(num(v.games)),
    duration_s: num(v.duration_s),
    at: str(v.at),
  };
  if (typeof v.retry_after === 'number' && v.retry_after >= 0) run.retry_after = v.retry_after;
  if (v.source === 'cron' || v.source === 'web') run.source = v.source;
  if (typeof v.message === 'string' && v.message.trim()) run.message = v.message.trim();
  return run;
}

export function normalizeMetaStatus(raw: unknown): MetaStatus {
  const o = isObject(raw) ? raw : {};
  return {
    collecting: o.collecting === true,
    admin_enabled: o.admin_enabled === true,
    meta_enabled: o.meta_enabled !== false,
    last_run: normalizeRun(o.last_run),
    patches: normalizePatches(o.patches),
  };
}

export function normalizeCollectResult(raw: unknown): CollectResult {
  const o = isObject(raw) ? raw : {};
  if (o.status === 'busy') return { status: 'busy' };
  if (o.status !== 'ok') throw new ApiError('Réponse inattendue du serveur pendant la collecte.', 502);
  const run = normalizeRun(o) as MetaRunSummary;
  return { status: 'ok', ...run, patches: normalizePatches(o.patches) };
}

export function fetchMetaStatus(): Promise<MetaStatus> {
  return backendRequest<unknown>('GET', 'meta-status', { cache: 'no-store' }).then(normalizeMetaStatus);
}

/**
 * One bounded collector pass on the server (≤ meta_web_budget seconds). A 401 about the admin
 * password does not lock the app (only the shared app password does).
 */
export function collectMetaOnce(adminPassword: string): Promise<CollectResult> {
  return backendRequest<unknown>('POST', 'meta-collect', {
    headers: { 'X-Admin-Password': adminPassword },
    cache: 'no-store',
    authEvent: (detail) => !/administrat/i.test(detail ?? ''),
  }).then(normalizeCollectResult);
}
