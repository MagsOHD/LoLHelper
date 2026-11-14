// Rank levels of the collected meta (r=meta-stats&tier=): French labels, per-tier progress of the
// collector (r=meta-status `tiers`, `window`) and the level used by generation and the draft: the
// tier closest to the median solo rank of the friends involved, a manual override (localStorage) and
// a fallback to the nearest tier with enough games.
import type { MetaTier, Rank } from './types';
import { META_TIERS } from './types';

export const META_TIER_LABELS: Record<MetaTier, string> = {
  IRON: 'Fer',
  BRONZE: 'Bronze',
  SILVER: 'Argent',
  GOLD: 'Or',
  PLATINUM: 'Platine',
  EMERALD: 'Émeraude',
  DIAMOND: 'Diamant',
  MASTER_PLUS: 'Master+',
};

export const tierLabel = (t: MetaTier): string => META_TIER_LABELS[t];

/** A tier needs this many games to guide the advice (same threshold as the engine's META_MIN_GAMES). */
export const TIER_ENOUGH_GAMES = 100;

const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

/** MetaTier value, or a Riot league tier (MASTER/GRANDMASTER/CHALLENGER -> MASTER_PLUS); null otherwise. */
export function toMetaTier(v: unknown): MetaTier | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if ((META_TIERS as string[]).includes(s)) return s as MetaTier;
  if (APEX.has(s) || s === 'MASTER+') return 'MASTER_PLUS';
  return null;
}

// ---- collector progress (r=meta-status) --------------------------------------------------------

export interface MetaTierProgress {
  tier: MetaTier;
  patch: string;
  /** Matches kept for this tier and patch (ring buffer of the most recent ones). */
  games: number;
  /** Buffer size (config meta_games_per_tier). */
  target: number;
  /** ISO dates of the oldest/newest kept game ('' when unknown). */
  oldest: string;
  newest: string;
}

/** Automatic (cron) collection hours, local time of the server: start inclusive, end exclusive. */
export interface MetaWindow {
  start: number;
  end: number;
  open: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

/** ISO string, or epoch (ms or s) -> ISO; '' when unusable. */
function isoDate(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return '';
}

const patchNum = (p: string): [number, number] => {
  const [a = 0, b = 0] = p.split('.').map(Number);
  return [a || 0, b || 0];
};
const newerPatch = (a: string, b: string): boolean => {
  const [am, an] = patchNum(a);
  const [bm, bn] = patchNum(b);
  return am > bm || (am === bm && an > bn);
};

/**
 * r=meta-status `tiers` -> one entry per tier (its most recent patch), in META_TIERS order.
 * Accepts a list of {tier, patch, games, target, oldest, newest} or an object keyed by tier.
 */
export function normalizeTierProgress(raw: unknown): MetaTierProgress[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : isObj(raw) ? Object.entries(raw).map(([tier, v]) => (isObj(v) ? { tier, ...v } : null)) : [];
  const byTier = new Map<MetaTier, MetaTierProgress>();
  for (const item of list) {
    if (!isObj(item)) continue;
    const tier = toMetaTier(item.tier);
    if (!tier) continue;
    const entry: MetaTierProgress = {
      tier,
      patch: typeof item.patch === 'string' ? item.patch : '',
      games: nonNeg(item.games),
      target: nonNeg(item.target),
      oldest: isoDate(item.oldest),
      newest: isoDate(item.newest),
    };
    const prev = byTier.get(tier);
    if (!prev || newerPatch(entry.patch, prev.patch) || (entry.patch === prev.patch && entry.games > prev.games)) {
      byTier.set(tier, entry);
    }
  }
  return META_TIERS.flatMap((t) => (byTier.has(t) ? [byTier.get(t) as MetaTierProgress] : []));
}

export function normalizeWindow(raw: unknown): MetaWindow | null {
  if (!isObj(raw)) return null;
  const hour = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 24 ? v : null);
  const start = hour(raw.start);
  const end = hour(raw.end);
  if (start === null || end === null) return null;
  return { start, end, open: raw.open === true };
}

/** "Collecte automatique entre 4 h et 15 h". */
export function formatWindow(w: MetaWindow): string {
  return `Collecte automatique entre ${w.start} h et ${w.end} h`;
}

// ---- friends' rank -> tier ---------------------------------------------------------------------

const DIVISION: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3 };

/**
 * Solo queue rank on one scale: IRON IV = 0 … DIAMOND I = 27, Master+ = 28 and above.
 * null for flex ranks, unranked players or unknown tiers.
 */
export function soloRankScore(rank: Rank | null | undefined): number | null {
  if (!rank || rank.queue !== 'RANKED_SOLO_5x5') return null;
  const tier = (rank.tier || '').toUpperCase();
  if (APEX.has(tier)) return 28 + ['MASTER', 'GRANDMASTER', 'CHALLENGER'].indexOf(tier);
  const i = META_TIERS.indexOf(tier as MetaTier);
  if (i < 0 || i >= 7) return null;
  return i * 4 + (DIVISION[(rank.division || '').toUpperCase()] ?? 1.5);
}

/** Tier containing the median solo rank of `ranks` (unranked ignored); null when nobody is ranked. */
export function medianTier(ranks: readonly (Rank | null | undefined)[]): { tier: MetaTier | null; ranked: number } {
  const scores = ranks.map(soloRankScore).filter((s): s is number => s !== null).sort((a, b) => a - b);
  if (!scores.length) return { tier: null, ranked: 0 };
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2;
  return { tier: META_TIERS[Math.min(7, Math.floor(median / 4))], ranked: scores.length };
}

export interface AdviceTierChoice {
  /** Tier to request from r=meta-stats; null = the server's default (no per-tier progress known). */
  tier: MetaTier | null;
  /** Automatic choice (median rank, or the default when nobody is ranked). */
  auto: MetaTier;
  /** Override when set, else `auto` (before the fallback). */
  requested: MetaTier;
  mode: 'auto' | 'override';
  /** Friends with a solo rank among those given. */
  ranked: number;
  /** `requested` had fewer than TIER_ENOUGH_GAMES games: `tier` is the nearest tier with enough. */
  fallback: boolean;
  /** Games of `tier` (null when unknown). */
  games: number | null;
  /** Games of `requested` (null when unknown). */
  requestedGames: number | null;
}

function mostGames(tiers: readonly MetaTierProgress[]): MetaTier | null {
  let best: MetaTierProgress | null = null;
  for (const t of tiers) if (t.games > 0 && (!best || t.games > best.games)) best = t;
  return best?.tier ?? null;
}

/** `requested` when it has enough games, else the nearest tier with enough (higher on ties), else the most played. */
export function fallbackTier(requested: MetaTier, games: ReadonlyMap<MetaTier, number>, min = TIER_ENOUGH_GAMES): MetaTier {
  if ((games.get(requested) ?? 0) >= min) return requested;
  const i = META_TIERS.indexOf(requested);
  let best: MetaTier | null = null;
  let bestD = Infinity;
  for (let j = 0; j < META_TIERS.length; j++) {
    const t = META_TIERS[j];
    if ((games.get(t) ?? 0) < min) continue;
    const d = Math.abs(j - i);
    if (d <= bestD) {
      best = t;
      bestD = d;
    }
  }
  if (best !== null) return best;
  let top = requested;
  for (const t of META_TIERS) if ((games.get(t) ?? 0) > (games.get(top) ?? 0)) top = t;
  return top;
}

/**
 * Tier used by generation and the draft for these friends' ranks. Nobody ranked: MASTER_PLUS (or
 * the tier with most games when Master+ has too few). Per-tier progress unknown (older server):
 * no fallback, and the server's default when nothing points to a tier.
 */
export function chooseAdviceTier(input: {
  ranks: readonly (Rank | null | undefined)[];
  tiers: readonly MetaTierProgress[];
  override?: MetaTier | null;
  minGames?: number;
}): AdviceTierChoice {
  const min = input.minGames ?? TIER_ENOUGH_GAMES;
  const games = new Map(input.tiers.map((t) => [t.tier, t.games] as const));
  const known = input.tiers.length > 0;
  const { tier: median, ranked } = medianTier(input.ranks);
  const auto: MetaTier = median
    ?? (!known || (games.get('MASTER_PLUS') ?? 0) >= min ? 'MASTER_PLUS' : mostGames(input.tiers) ?? 'MASTER_PLUS');
  const override = input.override ?? null;
  const requested = override ?? auto;
  const mode = override ? 'override' : 'auto';
  if (!known) {
    return { tier: override || median ? requested : null, auto, requested, mode, ranked, fallback: false, games: null, requestedGames: null };
  }
  const tier = fallbackTier(requested, games, min);
  return {
    tier, auto, requested, mode, ranked,
    fallback: tier !== requested,
    games: games.get(tier) ?? 0,
    requestedGames: games.get(requested) ?? 0,
  };
}

const nf = (n: number) => n.toLocaleString('fr-FR');

/** French explanation of a choice (Méta page). */
export function describeAdviceTier(c: AdviceTierChoice): string {
  const parts: string[] = [];
  if (c.mode === 'override') parts.push(`Niveau choisi à la main : ${tierLabel(c.requested)}.`);
  else if (c.ranked) parts.push(`Rang solo médian de tes amis (${c.ranked} classé${c.ranked > 1 ? 's' : ''}) : ${tierLabel(c.auto)}.`);
  else parts.push(`Aucun ami classé en solo : ${tierLabel(c.auto)} par défaut.`);
  if (c.fallback && c.tier) {
    parts.push(`${tierLabel(c.requested)} n’a que ${nf(c.requestedGames ?? 0)} partie${(c.requestedGames ?? 0) > 1 ? 's' : ''} : les conseils utilisent ${tierLabel(c.tier)}, le niveau proche le plus fourni.`);
  }
  return parts.join(' ');
}

// ---- manual override (localStorage, per device) ------------------------------------------------

const OVERRIDE_KEY = 'lolhelper:meta-tier';
const listeners = new Set<() => void>();
let memoryOverride: MetaTier | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Tier chosen on the Méta page, null = automatic. */
export function loadTierOverride(): MetaTier | null {
  const s = storage();
  if (!s) return memoryOverride;
  try {
    return toMetaTier(s.getItem(OVERRIDE_KEY));
  } catch {
    return memoryOverride;
  }
}

export function saveTierOverride(tier: MetaTier | null): void {
  memoryOverride = tier;
  const s = storage();
  try {
    if (s && tier) s.setItem(OVERRIDE_KEY, tier);
    else s?.removeItem(OVERRIDE_KEY);
  } catch {
    /* storage unavailable: kept in memory for this page load */
  }
  for (const l of listeners) l();
}

export function subscribeTierOverride(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
