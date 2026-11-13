// Pure computations behind the Meta page: per-role tier list rows, sorting/filtering, champion
// detail (roles, best/worst lane matchups) and the patch selector mapping.
import type { MetaStats, Role } from './types';
import { ROLES } from './types';
import type { MetaPatchInfo } from './meta';
import { META_WR_PRIOR } from '../engine/meta';
import { norm } from '../lib/format';

/** Rows below this many games are greyed out and their winrate flagged as unreliable. */
export const LOW_SAMPLE_GAMES = 50;
/** Default of the "minimum games" filter. */
export const DEFAULT_MIN_GAMES = 20;
/** Lane duels need this many games to be listed in the champion detail. */
export const MATCHUP_MIN_GAMES = 10;
/** Bayesian prior (games at 50 %) used to rank lane duels. */
export const MATCHUP_PRIOR = 20;
/** Tier list prior: same as the composition engine (winrate pulled toward 50 % by 100 games). */
export const TIER_PRIOR = META_WR_PRIOR;

export type Tier = 'S' | 'A' | 'B' | 'C' | 'D';
/** Lower bound of the smoothed winrate for each tier (D below C). */
export const TIER_THRESHOLDS: [Tier, number][] = [['S', 0.525], ['A', 0.51], ['B', 0.495], ['C', 0.48]];

export function smoothed(wins: number, games: number, prior: number): number {
  return (wins + prior * 0.5) / (games + prior);
}

export function tierOf(score: number): Tier {
  for (const [tier, min] of TIER_THRESHOLDS) if (score >= min) return tier;
  return 'D';
}

export interface TierRow {
  id: string;
  name: string;
  role: Role;
  games: number;
  wins: number;
  /** Raw winrate (0..1). */
  winrate: number;
  /** Winrate pulled toward 50 % (TIER_PRIOR games): ranks small samples honestly. */
  score: number;
  /** null below LOW_SAMPLE_GAMES: too few games to rank, even smoothed. */
  tier: Tier | null;
  /** games / matches of the patch. */
  pickRate: number;
  bans: number;
  banRate: number;
  lowSample: boolean;
}

/** Every champion seen in `role` on this snapshot. */
export function buildTierRows(meta: MetaStats, role: Role, nameOf: (id: string) => string = (id) => id): TierRow[] {
  const total = Math.max(1, meta.games);
  const rows: TierRow[] = [];
  for (const [id, byRole] of Object.entries(meta.champions)) {
    const cell = byRole?.[role];
    if (!cell || !(cell[0] > 0)) continue;
    const [games, rawWins] = cell;
    const wins = Math.max(0, Math.min(games, rawWins));
    const score = smoothed(wins, games, TIER_PRIOR);
    const bans = Math.max(0, meta.bans[id] ?? 0);
    const lowSample = games < LOW_SAMPLE_GAMES;
    rows.push({
      id, name: nameOf(id), role, games, wins,
      winrate: wins / games,
      score,
      tier: lowSample ? null : tierOf(score),
      pickRate: games / total,
      bans,
      banRate: bans / total,
      lowSample,
    });
  }
  return rows;
}

export type SortKey = 'tier' | 'name' | 'winrate' | 'pickRate' | 'banRate' | 'games';
export type SortDir = 'asc' | 'desc';

/** Natural first direction when a column header is clicked. */
export const DEFAULT_DIR: Record<SortKey, SortDir> = {
  tier: 'desc', name: 'asc', winrate: 'desc', pickRate: 'desc', banRate: 'desc', games: 'desc',
};

const VALUE: Record<Exclude<SortKey, 'name'>, (r: TierRow) => number> = {
  tier: (r) => r.score,
  winrate: (r) => r.winrate,
  pickRate: (r) => r.pickRate,
  banRate: (r) => r.banRate,
  games: (r) => r.games,
};

const byName = (a: TierRow, b: TierRow) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });

/** New sorted array; ties: more games first, then name. */
export function sortRows(rows: readonly TierRow[], key: SortKey, dir: SortDir = DEFAULT_DIR[key]): TierRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = key === 'name' ? byName(a, b) : VALUE[key](a) - VALUE[key](b);
    if (primary !== 0) return sign * primary;
    return b.games - a.games || byName(a, b);
  });
}

/** Rows with at least `minGames` games whose name (accent/case-insensitive) contains `query`. */
export function filterRows(rows: readonly TierRow[], opts: { minGames?: number; query?: string }): TierRow[] {
  const min = Math.max(0, opts.minGames ?? 0);
  const q = norm((opts.query ?? '').trim());
  return rows.filter((r) => r.games >= min && (!q || norm(r.name).includes(q) || norm(r.id).includes(q)));
}

// ---- champion detail ------------------------------------------------------------------------

export interface RoleLine {
  role: Role;
  games: number;
  winrate: number;
  pickRate: number;
  /** Share of this champion's games played in the role. */
  share: number;
}

export interface MatchupLine {
  opponent: string;
  games: number;
  wins: number;
  winrate: number;
  score: number;
}

export interface ChampionDetail {
  id: string;
  games: number;
  bans: number;
  banRate: number;
  /** Most played first. */
  roles: RoleLine[];
}

export function championDetail(meta: MetaStats, id: string): ChampionDetail {
  const total = Math.max(1, meta.games);
  const byRole = meta.champions[id] ?? {};
  const lines: RoleLine[] = [];
  let games = 0;
  for (const role of ROLES) {
    const c = byRole[role];
    if (c && c[0] > 0) {
      games += c[0];
      lines.push({ role, games: c[0], winrate: Math.min(c[0], c[1]) / c[0], pickRate: c[0] / total, share: 0 });
    }
  }
  for (const l of lines) l.share = games ? l.games / games : 0;
  lines.sort((a, b) => b.games - a.games);
  const bans = Math.max(0, meta.bans[id] ?? 0);
  return { id, games, bans, banRate: bans / total, roles: lines };
}

/** Lane duels of `id` in `role` with ≥ minGames games (direct entries, reverse ones as fallback). */
export function laneMatchups(meta: MetaStats, role: Role, id: string, minGames = MATCHUP_MIN_GAMES): MatchupLine[] {
  const byRole = meta.matchups[role];
  if (!byRole) return [];
  const cells = new Map<string, [number, number]>();
  for (const [opp, c] of Object.entries(byRole[id] ?? {})) {
    if (opp !== id && c && c[0] > 0) cells.set(opp, [c[0], Math.min(c[0], c[1])]);
  }
  for (const [opp, vs] of Object.entries(byRole)) {
    const c = vs?.[id];
    if (opp === id || cells.has(opp) || !c || !(c[0] > 0)) continue;
    cells.set(opp, [c[0], c[0] - Math.min(c[0], c[1])]);
  }
  const out: MatchupLine[] = [];
  for (const [opponent, [games, wins]] of cells) {
    if (games < minGames) continue;
    out.push({ opponent, games, wins, winrate: wins / games, score: smoothed(wins, games, MATCHUP_PRIOR) });
  }
  return out;
}

/** Best (smoothed > 50 %, best first) and worst (< 50 %, worst first) duels, `limit` each. */
export function bestWorstMatchups(lines: readonly MatchupLine[], limit = 5): { best: MatchupLine[]; worst: MatchupLine[] } {
  const tie = (a: MatchupLine, b: MatchupLine) => b.games - a.games || a.opponent.localeCompare(b.opponent);
  const best = lines.filter((l) => l.score > 0.5).sort((a, b) => b.score - a.score || tie(a, b)).slice(0, limit);
  const worst = lines.filter((l) => l.score < 0.5).sort((a, b) => a.score - b.score || tie(a, b)).slice(0, limit);
  return { best, worst };
}

// ---- patch selector -------------------------------------------------------------------------

/** "16.9" < "16.18" (numeric compare); most recent first. */
export function comparePatchDesc(a: string, b: string): number {
  const [am = 0, an = 0] = a.split('.').map(Number);
  const [bm = 0, bn = 0] = b.split('.').map(Number);
  return bm - am || bn - an;
}

export interface PatchOption {
  value: string;
  games: number;
  updated_at: string;
  /** The patch r=meta-stats serves by default (used by generation and the draft). */
  served: boolean;
}

/**
 * Selector options: kept patches with games (most recent first), plus the served patch when the
 * status route did not list it (older PHP API).
 */
export function patchOptions(patches: readonly MetaPatchInfo[], served: { patch: string; games: number; updated_at: string } | null): PatchOption[] {
  const out: PatchOption[] = patches
    .filter((p) => p.games > 0)
    .map((p) => ({ value: p.patch, games: p.games, updated_at: p.updated_at, served: p.patch === served?.patch }));
  if (served?.patch && !out.some((o) => o.value === served.patch)) {
    out.push({ value: served.patch, games: served.games, updated_at: served.updated_at, served: true });
  }
  return out.sort((a, b) => comparePatchDesc(a.value, b.value));
}

/**
 * Patch to request for a selection: null = the served (default) snapshot, shared with generation;
 * a kept patch otherwise. Unknown selections fall back to the default.
 */
export function resolvePatch(selected: string | null, options: readonly PatchOption[]): string | null {
  if (!selected) return null;
  const opt = options.find((o) => o.value === selected);
  if (!opt || opt.served) return null;
  return opt.value;
}
