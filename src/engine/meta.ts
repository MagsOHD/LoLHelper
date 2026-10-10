// High-elo meta stats (collected by the PHP cron) and players' recent history, turned into small scores.
// Every helper is pure; callers check `metaUsable` / data presence so that absent data changes nothing.
import type { ChampionInfo, GamesWins, MetaStats, PlayerInput, Role } from '../api/types';

const ROLE_ORDER: readonly Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];

// --------------------------------------------------------------------------- constants

/** Below this many aggregated matches the meta snapshot is ignored (too noisy). */
export const META_MIN_GAMES = 100;
/** Bayesian prior (in games at 50 %) for a champion's role winrate. */
export const META_WR_PRIOR = 100;
/** Winrate deviation mapped to the full 0..1 range: 50 % ± 10 % -> 0..1. */
export const META_WR_SPAN = 0.1;
/** Presence (pick share + half the ban share, per match) at which the presence component saturates. */
export const META_PRESENCE_FULL = 0.2;
/** Share of the presence component in a champion's meta value (the rest is the smoothed winrate). */
export const META_PRESENCE_SHARE = 0.2;

/** Bayesian prior (games at 50 %) for a meta lane matchup. */
export const LANE_META_PRIOR = 30;
/** Minimum meta duels before a matchup is cited in the lane advice. */
export const LANE_META_CITE_MIN = 50;
/** Laplace prior for the player's own lane history (games at 50 %). */
export const LANE_HIST_PRIOR = 2;
/** Games of lane history giving half confidence. */
export const LANE_HIST_HALF = 3;
/** Smoothing prior (games at 50 %) for a duo's champion pair. */
export const DUO_PRIOR = 3;

// --------------------------------------------------------------------------- generic helpers

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Winrate pulled toward 50 % by `prior` virtual games. */
export function smoothedRate(wins: number, games: number, prior: number): number {
  return (wins + prior * 0.5) / (games + prior);
}

/** True when the meta snapshot holds enough matches to be used. */
export function metaUsable(meta: MetaStats | null | undefined): meta is MetaStats {
  return !!meta && Number(meta.games) >= META_MIN_GAMES && !!meta.champions;
}

function gw(v: GamesWins | undefined | null): [number, number] | null {
  if (!v || !(v[0] > 0)) return null;
  return [v[0], Math.max(0, Math.min(v[0], v[1] || 0))];
}

/**
 * 0..1 value of a champion in a role on the current patch: 80 % Bayesian-smoothed role winrate
 * (around 50 %, ±10 % spans the range), 20 % presence (pick share + half the ban share).
 * Unseen champion/role: 0.4 (neutral winrate, no presence).
 */
export function metaPickValue(meta: MetaStats, championId: string, role: Role): number {
  const total = Math.max(1, meta.games);
  const stat = gw(meta.champions[championId]?.[role]);
  const games = stat ? stat[0] : 0;
  const wins = stat ? stat[1] : 0;
  const wr = smoothedRate(wins, games, META_WR_PRIOR);
  const wrScore = clamp01(0.5 + (wr - 0.5) / (2 * META_WR_SPAN));
  const bans = Math.max(0, Number(meta.bans?.[championId] ?? 0));
  const presence = clamp01((games / total + (0.5 * bans) / total) / META_PRESENCE_FULL);
  return (1 - META_PRESENCE_SHARE) * wrScore + META_PRESENCE_SHARE * presence;
}

/** [games, wins of `championId`] of the meta duel `championId` vs `opponentId` in `role` (falls back on the reverse entry). */
export function metaMatchup(meta: MetaStats, role: Role, championId: string, opponentId: string): [number, number] | null {
  const byRole = meta.matchups?.[role];
  if (!byRole) return null;
  const direct = gw(byRole[championId]?.[opponentId]);
  if (direct) return direct;
  const rev = gw(byRole[opponentId]?.[championId]);
  return rev ? [rev[0], rev[0] - rev[1]] : null;
}

/** -1..1 edge of `championId` against `opponentId` in `role` (smoothed meta winrate), 0 when unknown. */
export function metaLaneEdge(meta: MetaStats, role: Role, championId: string, opponentId: string): number {
  const m = metaMatchup(meta, role, championId, opponentId);
  if (!m) return 0;
  return 2 * (smoothedRate(m[1], m[0], LANE_META_PRIOR) - 0.5);
}

// --------------------------------------------------------------------------- players' history

/** [games, wins] of the player's own duels with `championId` against `opponentId` (any role). */
export function laneHistory(
  player: Pick<PlayerInput, 'lane_history'> | null | undefined,
  championId: string,
  opponentId: string,
  resolve: (id: string) => string | null = (id) => id,
): [number, number] | null {
  let games = 0;
  let wins = 0;
  for (const h of player?.lane_history ?? []) {
    if (!(h.games > 0)) continue;
    if (resolve(h.champion_id) !== championId || resolve(h.opponent_id) !== opponentId) continue;
    games += h.games;
    wins += Math.max(0, Math.min(h.games, h.wins || 0));
  }
  return games > 0 ? [games, wins] : null;
}

/** -1..1 edge from the player's own lane history, weighted by games (3 games = half confidence). */
export function historyLaneEdge(hist: [number, number] | null): number {
  if (!hist) return 0;
  const [games, wins] = hist;
  const conf = games / (games + LANE_HIST_HALF);
  return conf * 2 * (smoothedRate(wins, games, LANE_HIST_PRIOR) - 0.5);
}

// --------------------------------------------------------------------------- enemy roles

/**
 * Deterministic enemy role guess (same rule as the matchup route): explicit roles are kept; every other
 * champion takes, in input order, its first catalog role not already taken, else the first free role
 * (TOP, JUNGLE, MID, BOTTOM, SUPPORT order). `null` when all five roles are already taken.
 */
export function guessEnemyRoles(
  enemy: readonly { champion_id: string; role?: Role | null }[],
  catalog: { get(championId: string): ChampionInfo | undefined },
): (Role | null)[] {
  const taken = new Set<Role>();
  for (const e of enemy) if (e.role) taken.add(e.role);
  return enemy.map((e) => {
    if (e.role) return e.role;
    const champ = catalog.get(e.champion_id);
    const candidates = (champ?.roles ?? []).filter((r) => !taken.has(r));
    for (const r of ROLE_ORDER) if (!taken.has(r) && !candidates.includes(r)) candidates.push(r);
    const role = candidates[0] ?? null;
    if (role) taken.add(role);
    return role;
  });
}
