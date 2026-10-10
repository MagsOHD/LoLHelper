// High-elo meta stats collected by the PHP cron (r=meta-stats), mapped to Data Dragon ids.
// Optional data: any failure resolves to null so composition generation is never blocked.
import type { ChampionCatalog } from '../engine';
import type { GamesWins, MetaStats, Role } from './types';
import { backendRequest } from './backend';
import { getCatalog } from './ddragon';
import { mapPosition } from './riot';

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
    metaPromise = Promise.all([backendRequest<RawMetaStats>('GET', 'meta-stats'), getCatalog()])
      .then(([raw, { catalog }]) => mapMetaStats(raw, catalog))
      .catch(() => {
        failedAt = now;
        return null;
      });
  }
  return metaPromise;
}

/** Tests only. */
export function resetMetaForTests(): void {
  metaPromise = null;
  failedAt = null;
}
