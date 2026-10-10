// Champion pool of a player: how well they know each champion and how much they want it.
import type {
  ManualPoolEntry,
  MasteryEntry,
  PlayerPreferences,
  PoolEntry,
  PoolSource,
  RecentChampionStat,
} from '../api/types';
import type { Catalog } from './catalog';
import { cmpNum, cmpStr, pyRound } from './pycompat';

export const FULL_MASTERY_POINTS = 500_000; // points at which mastery comfort saturates
const DAY_MS = 86_400_000;
const FRESH_DAYS = 30; // no decay below this
const STALE_DAYS = 365; // maximum decay reached here
const MAX_DECAY = 0.4;

const DESIRE_WANTED_CHAMPION = 1.0;
const DESIRE_WANTED_ARCHETYPE = 0.6;
const DESIRE_PLAYED = 0.3; // baseline desire for champions the player plays on their own

/** Log-scaled: 1k ≈ 0.11, 10k ≈ 0.39, 50k ≈ 0.63, 125k ≈ 0.78, 500k = 1. */
export function masteryComfort(points: number, level: number): number {
  const k = Math.max(0, points) / 1000;
  const base = Math.log1p(k) / Math.log1p(FULL_MASTERY_POINTS / 1000);
  return Math.min(1.0, base + 0.01 * Math.min(Math.max(level, 0), 10));
}

export function recencyFactor(lastPlayTime: number | null | undefined, nowMs: number | null | undefined): number {
  if (!lastPlayTime || !nowMs) return 1.0;
  const days = Math.max(0.0, (nowMs - lastPlayTime) / DAY_MS);
  const stale = Math.min(1.0, Math.max(0.0, days - FRESH_DAYS) / (STALE_DAYS - FRESH_DAYS));
  return 1.0 - MAX_DECAY * stale;
}

// Recent form (only computed from stats that carry `last_played`, i.e. synced by the current data layer).
const FORM_PRIOR_GAMES = 4; // shrinkage: form *= games / (games + 4) -> 1 game = 20 %, 8 games = 67 %
const FORM_WR_SHARE = 0.7; // winrate vs KDA share of the raw form
const FORM_KDA_NEUTRAL = 2.5; // (k + a) / max(1, d) considered neutral; 0 -> -1, 5+ -> +1
const FORM_FRESH_DAYS = 14; // full weight below this age of the last game
const FORM_STALE_DAYS = 90; // form fades to 0 at this age

/**
 * Recent form on a champion, -1..1: 70 % winrate deviation ((wins/games - 0.5) * 2), 30 % KDA
 * ((k + a) / max(1, d) around 2.5, k/d/a are per-game averages), shrunk toward 0 for small samples
 * (games / (games + 4)) and faded with the age of the last game (full under 14 days, 0 at 90 days).
 */
export function computeForm(
  games: number,
  wins: number,
  kills: number,
  deaths: number,
  assists: number,
  lastPlayed: number | null | undefined,
  nowMs: number | null | undefined,
): number {
  if (!(games > 0)) return 0;
  const wr = Math.max(0, Math.min(1, wins / games));
  const wrSig = (wr - 0.5) * 2;
  const kda = (kills + assists) / Math.max(1, deaths);
  // all-zero k/d/a = missing data, not a terrible game
  const kdaSig = kills + deaths + assists > 0 ? Math.max(-1, Math.min(1, (kda - FORM_KDA_NEUTRAL) / FORM_KDA_NEUTRAL)) : 0;
  const raw = FORM_WR_SHARE * wrSig + (1 - FORM_WR_SHARE) * kdaSig;
  const shrink = games / (games + FORM_PRIOR_GAMES);
  let recency = 1;
  if (lastPlayed && nowMs) {
    const days = Math.max(0, (nowMs - lastPlayed) / DAY_MS);
    recency = 1 - Math.min(1, Math.max(0, days - FORM_FRESH_DAYS) / (FORM_STALE_DAYS - FORM_FRESH_DAYS));
  }
  return Math.max(-1, Math.min(1, raw * shrink * recency));
}

export function recentComfort(games: number, wins: number): number {
  if (games <= 0) return 0.0;
  let value = 0.3 + 0.4 * Math.min(1.0, games / 8);
  if (games >= 3) value += 0.4 * (wins / games - 0.5);
  return Math.max(0.0, Math.min(1.0, value));
}

interface Slot {
  mastery: number;
  recent: number;
  manual: number | null;
  sources: PoolSource[];
  points: number;
  level: number;
  games: number;
  wins: number;
  // recent form inputs (per-game averages weighted by games); `played` = latest last_played, null when absent
  kSum: number;
  dSum: number;
  aSum: number;
  played: number | null;
}

/**
 * Merge masteries, recent games, manual entries and wishes into a sorted pool.
 * `nowMs` defaults to the most recent mastery play time or recent `last_played` (keeps the result deterministic).
 * `form` is only set on champions whose recent stats carry `last_played`.
 */
export function computePool(
  masteries: MasteryEntry[],
  recent: RecentChampionStat[],
  manual: ManualPoolEntry[],
  preferences: Partial<PlayerPreferences>,
  catalog: Catalog,
  nowMs?: number | null,
): PoolEntry[] {
  let now: number | null = nowMs ?? null;
  if (nowMs === undefined || nowMs === null) {
    const times = masteries.map((m) => m.last_play_time).filter((t): t is number => Boolean(t));
    for (const r of recent) if (r.last_played) times.push(r.last_played);
    now = times.length ? Math.max(...times) : null;
  }

  const avoided = new Set((preferences.avoided_champions ?? []).map((c) => catalog.resolve(c) ?? c));
  const wantedChamps = new Set((preferences.wanted_champions ?? []).map((c) => catalog.resolve(c) ?? c));
  const wantedArch = new Set(preferences.wanted_archetypes ?? []);
  const entries = new Map<string, Slot>();

  const slot = (cid: string): Slot => {
    let e = entries.get(cid);
    if (!e) {
      e = {
        mastery: 0.0,
        recent: 0.0,
        manual: null,
        sources: [],
        points: 0,
        level: 0,
        games: 0,
        wins: 0,
        kSum: 0,
        dSum: 0,
        aSum: 0,
        played: null,
      };
      entries.set(cid, e);
    }
    return e;
  };
  const addSource = (e: Slot, s: PoolSource): void => {
    if (!e.sources.includes(s)) e.sources.push(s);
  };

  for (const m of masteries) {
    const cid = catalog.resolve(m.champion_id);
    if (!cid || avoided.has(cid)) continue;
    const e = slot(cid);
    e.mastery = Math.max(e.mastery, masteryComfort(m.points, m.level) * recencyFactor(m.last_play_time, now));
    e.points = Math.max(e.points, m.points);
    e.level = Math.max(e.level, m.level);
    addSource(e, 'mastery');
  }

  for (const r of recent) {
    const cid = catalog.resolve(r.champion_id);
    if (!cid || avoided.has(cid) || r.games <= 0) continue;
    const e = slot(cid);
    e.games += r.games;
    e.wins += r.wins;
    e.recent = recentComfort(e.games, e.wins);
    e.kSum += (Number(r.kills) || 0) * r.games;
    e.dSum += (Number(r.deaths) || 0) * r.games;
    e.aSum += (Number(r.assists) || 0) * r.games;
    if (r.last_played) e.played = Math.max(e.played ?? 0, r.last_played);
    addSource(e, 'recent');
  }

  for (const mp of manual) {
    const cid = catalog.resolve(mp.champion_id);
    if (!cid || avoided.has(cid)) continue;
    const e = slot(cid);
    e.manual = mp.comfort;
    addSource(e, 'manual');
  }

  for (const cid of [...wantedChamps].sort(cmpStr)) {
    if (avoided.has(cid) || catalog.get(cid) === undefined) continue;
    addSource(slot(cid), 'wanted');
  }

  if (wantedArch.size) {
    for (const champ of catalog.all()) {
      if (wantedArch.has(champ.archetype) && !avoided.has(champ.id)) addSource(slot(champ.id), 'wanted');
    }
  }

  const pool: PoolEntry[] = [];
  for (const [cid, e] of entries) {
    const comfort = e.manual !== null ? e.manual : 1 - (1 - e.mastery) * (1 - e.recent);
    const champ = catalog.get(cid);
    let desire = 0.0;
    if (comfort > 0) {
      const played = DESIRE_PLAYED + (e.games > 0 ? 0.15 : 0.0);
      desire = Math.max(desire, played);
    }
    if (champ && wantedArch.has(champ.archetype)) {
      desire = Math.max(desire, DESIRE_WANTED_ARCHETYPE + (comfort > 0 ? 0.1 : 0.0));
    }
    if (wantedChamps.has(cid)) desire = DESIRE_WANTED_CHAMPION;
    const entry: PoolEntry = {
      champion_id: cid,
      comfort: pyRound(Math.max(0.0, Math.min(1.0, comfort)), 4),
      desire: pyRound(Math.min(1.0, desire), 4),
      sources: e.sources,
      mastery_points: e.points,
      mastery_level: e.level,
      recent_games: e.games,
      recent_wins: e.wins,
    };
    if (e.played !== null && e.games > 0) {
      const g = e.games;
      const form = computeForm(g, e.wins, e.kSum / g, e.dSum / g, e.aSum / g, e.played, now);
      entry.form = pyRound(form, 4) + 0; // + 0: no -0
    }
    pool.push(entry);
  }
  pool.sort(
    (a, b) => cmpNum(b.comfort, a.comfort) || cmpNum(b.desire, a.desire) || cmpStr(a.champion_id, b.champion_id),
  );
  return pool;
}
