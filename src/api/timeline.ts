// Playstyle facts from match-v5 timelines (r=riot/match-timeline, cached forever by the PHP proxy):
// gold and CS at 10:00, early kills/deaths, the jungler's first gank, first back, wards placed and
// the level 6 timing. Pure functions (unit-tested with a compact timeline fixture).
import type { Role, TimelineStyle } from './types';
import { mapPosition, SUMMONERS_RIFT_QUEUES } from './riot';

/** Timelines fetched per enemy profile (among the recent games already fetched). */
export const TIMELINE_COUNT = 3;
/** Games shorter than this have no 10:00 frame worth reading: not analysed. */
export const TIMELINE_MIN_MINUTES = 10;
export const MINUTE_MS = 60_000;
/** Frame read for the "at 10 minutes" values. */
export const LANE_FRAME_MS = 10 * MINUTE_MS;
/** A jungler's first takedown on an enemy laner before this counts as their first gank. */
export const GANK_WINDOW_MS = 8 * MINUTE_MS;
/** Purchases before this are the starting items, the first one after is the first back. */
export const FIRST_BACK_AFTER_MS = 2 * MINUTE_MS;
/** Upgrades granted outside the shop (support quest): not a back. */
const AUTO_UPGRADE_ITEMS = new Set([3866, 3867, 3869, 3870, 3871, 3876, 3877]);

// ---- raw shapes (only the fields read) -----------------------------------------------------------

interface RawParticipantFrame {
  participantId?: number;
  totalGold?: number;
  minionsKilled?: number;
  jungleMinionsKilled?: number;
  level?: number;
}

interface RawTimelineEvent {
  type?: string;
  timestamp?: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  creatorId?: number;
  participantId?: number;
  itemId?: number;
  level?: number;
  wardType?: string;
}

interface RawFrame {
  timestamp?: number;
  participantFrames?: Record<string, RawParticipantFrame>;
  events?: RawTimelineEvent[];
}

export interface RawTimeline {
  metadata?: { matchId?: string; participants?: string[] };
  info?: { frameInterval?: number; frames?: RawFrame[]; participants?: { participantId?: number; puuid?: string }[] };
}

interface RawGameParticipant {
  puuid?: string;
  teamId?: number;
  teamPosition?: string;
  individualPosition?: string;
  timePlayed?: number;
}

/** The match-v5 payload of the same game (positions, teams, duration). */
export interface RawTimelineMatch {
  metadata?: { matchId?: string };
  info?: { queueId?: number; gameDuration?: number; gameEndTimestamp?: number; participants?: RawGameParticipant[] };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round2 = (x: number) => Math.round(x * 100) / 100;
const round1 = (x: number) => Math.round(x * 10) / 10;

function matchMinutes(m: RawTimelineMatch, me: RawGameParticipant | undefined): number {
  const played = fin(me?.timePlayed) ?? 0;
  if (played > 0) return played / 60;
  let d = fin(m.info?.gameDuration) ?? 0;
  if (m.info?.gameEndTimestamp === undefined && d > 20_000) d /= 1000;
  return d / 60;
}

/**
 * Games worth a timeline among those already fetched (most recent first, as given): Summoner's Rift
 * queues, the player present, at least TIMELINE_MIN_MINUTES long. Returns their match ids.
 */
export function pickTimelineGames(matches: unknown[], puuid: string, max: number = TIMELINE_COUNT): string[] {
  const out: string[] = [];
  for (const raw of matches) {
    if (out.length >= max) break;
    if (!isObj(raw)) continue;
    const m = raw as RawTimelineMatch;
    const id = m.metadata?.matchId;
    if (typeof id !== 'string' || !id || out.includes(id)) continue;
    if (typeof m.info?.queueId !== 'number' || !SUMMONERS_RIFT_QUEUES.has(m.info.queueId)) continue;
    const me = (m.info.participants ?? []).find((p) => p && p.puuid === puuid);
    if (!me || matchMinutes(m, me) < TIMELINE_MIN_MINUTES) continue;
    out.push(id);
  }
  return out;
}

/** What one timeline says about the player. */
export interface TimelineGameFacts {
  role: Role | null;
  gold_diff_10: number | null;
  cs_10: number | null;
  kills_before_10: number;
  deaths_before_10: number;
  /** Jungle games only (undefined otherwise); null when no gank before 8:00. */
  first_gank?: { minute: number; lane: Role } | null;
  first_back_minute: number | null;
  wards: number;
  minutes: number;
  level6_minute: number | null;
}

/** participantId -> puuid from the timeline (info.participants, else metadata order). */
function participantIds(t: RawTimeline): Map<number, string> {
  const ids = new Map<number, string>();
  for (const p of t.info?.participants ?? []) {
    if (p && typeof p.participantId === 'number' && typeof p.puuid === 'string') ids.set(p.participantId, p.puuid);
  }
  if (!ids.size) (t.metadata?.participants ?? []).forEach((puuid, i) => typeof puuid === 'string' && ids.set(i + 1, puuid));
  return ids;
}

function frameNear(frames: RawFrame[], at: number, tolerance = MINUTE_MS / 2): RawFrame | null {
  let best: RawFrame | null = null;
  let gap = Infinity;
  for (const f of frames) {
    const ts = fin(f?.timestamp);
    if (ts === null) continue;
    const d = Math.abs(ts - at);
    if (d <= tolerance && d < gap) {
      best = f;
      gap = d;
    }
  }
  return best;
}

const GANK_LANE: Partial<Record<Role, Role>> = { TOP: 'TOP', MID: 'MID', BOTTOM: 'BOTTOM', SUPPORT: 'BOTTOM' };

/** Facts for `puuid` in one game; null when the timeline does not match the game or the player. */
export function timelineGameFacts(timeline: unknown, match: unknown, puuid: string): TimelineGameFacts | null {
  if (!isObj(timeline) || !isObj(match)) return null;
  const t = timeline as RawTimeline;
  const m = match as RawTimelineMatch;
  const tid = t.metadata?.matchId;
  const mid = m.metadata?.matchId;
  if (tid && mid && tid !== mid) return null;
  const frames = Array.isArray(t.info?.frames) ? t.info!.frames!.filter(isObj) as RawFrame[] : [];
  if (!frames.length) return null;
  const parts = (m.info?.participants ?? []).filter(isObj) as RawGameParticipant[];
  const byPuuid = new Map(parts.filter((p) => typeof p.puuid === 'string').map((p) => [p.puuid as string, p]));
  const ids = participantIds(t);
  let meId: number | null = null;
  for (const [pid, pu] of ids) if (pu === puuid) meId = pid;
  const me = byPuuid.get(puuid);
  if (meId === null || !me) return null;
  const position = (p: RawGameParticipant | undefined) => mapPosition(p?.teamPosition || p?.individualPosition || '');
  const info = (pid: number) => byPuuid.get(ids.get(pid) ?? '');
  const myRole = position(me);
  const enemy = (pid: number) => {
    const p = info(pid);
    return !!p && typeof p.teamId === 'number' && typeof me.teamId === 'number' && p.teamId !== me.teamId;
  };

  // 10:00 frame: gold vs the lane opponent (only enemy on the same position), lane + jungle CS.
  let gold_diff_10: number | null = null;
  let cs_10: number | null = null;
  const f10 = frameNear(frames, LANE_FRAME_MS);
  const mine = f10?.participantFrames?.[String(meId)];
  if (mine) {
    const cs = (fin(mine.minionsKilled) ?? 0) + (fin(mine.jungleMinionsKilled) ?? 0);
    cs_10 = cs;
    const opp = myRole ? [...ids.keys()].filter((pid) => pid !== meId && enemy(pid) && position(info(pid)) === myRole) : [];
    const oppFrame = opp.length === 1 ? f10?.participantFrames?.[String(opp[0])] : undefined;
    const g1 = fin(mine.totalGold);
    const g2 = fin(oppFrame?.totalGold);
    if (g1 !== null && g2 !== null) gold_diff_10 = g1 - g2;
  }

  const events = frames
    .flatMap((f) => (Array.isArray(f.events) ? f.events.filter(isObj) as RawTimelineEvent[] : []))
    .filter((e) => fin(e.timestamp) !== null)
    .sort((a, b) => (a.timestamp as number) - (b.timestamp as number));

  let kills = 0;
  let deaths = 0;
  let gank: { minute: number; lane: Role } | null = null;
  let firstBack: number | null = null;
  let wards = 0;
  let level6: number | null = null;
  for (const e of events) {
    const ts = e.timestamp as number;
    switch (e.type) {
      case 'CHAMPION_KILL': {
        const involved = e.killerId === meId || (Array.isArray(e.assistingParticipantIds) && e.assistingParticipantIds.includes(meId));
        if (ts < LANE_FRAME_MS) {
          if (involved) kills += 1;
          if (e.victimId === meId) deaths += 1;
        }
        if (myRole === 'JUNGLE' && !gank && involved && ts < GANK_WINDOW_MS && typeof e.victimId === 'number' && enemy(e.victimId)) {
          const victimRole = position(info(e.victimId));
          const lane = victimRole ? GANK_LANE[victimRole] : undefined;
          if (lane) gank = { minute: ts / MINUTE_MS, lane };
        }
        break;
      }
      case 'ITEM_PURCHASED':
        if (firstBack === null && e.participantId === meId && ts > FIRST_BACK_AFTER_MS && !AUTO_UPGRADE_ITEMS.has(e.itemId ?? -1)) firstBack = ts / MINUTE_MS;
        break;
      case 'WARD_PLACED':
        if (e.creatorId === meId && e.wardType !== 'UNDEFINED') wards += 1;
        break;
      case 'LEVEL_UP':
        if (level6 === null && e.participantId === meId && (fin(e.level) ?? 0) >= 6) level6 = ts / MINUTE_MS;
        break;
    }
  }
  if (level6 === null) {
    // No LEVEL_UP events: first frame showing level 6.
    for (const f of frames) {
      const lv = fin(f.participantFrames?.[String(meId)]?.level);
      const ts = fin(f.timestamp);
      if (lv !== null && lv >= 6 && ts !== null) {
        level6 = ts / MINUTE_MS;
        break;
      }
    }
  }
  const lastFrame = Math.max(0, ...frames.map((f) => fin(f.timestamp) ?? 0)) / MINUTE_MS;
  const minutes = matchMinutes(m, me) || lastFrame;
  return {
    role: myRole,
    gold_diff_10,
    cs_10,
    kills_before_10: kills,
    deaths_before_10: deaths,
    ...(myRole === 'JUNGLE' ? { first_gank: gank } : {}),
    first_back_minute: firstBack,
    wards,
    minutes,
    level6_minute: level6,
  };
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const LANE_ORDER: Role[] = ['TOP', 'MID', 'BOTTOM'];

/**
 * Averages over the analysed games. Gold/CS over the games with a 10:00 frame (gold: with a single
 * lane opponent); first gank over the jungle games that had one (lane = most frequent, then top >
 * mid > bot); wards per minute = wards placed / minutes played. null without any usable game.
 */
export function aggregateTimelines(games: (TimelineGameFacts | null)[]): TimelineStyle | null {
  const ok = games.filter((g): g is TimelineGameFacts => !!g);
  if (!ok.length) return null;
  const gold = avg(ok.map((g) => g.gold_diff_10).filter((x): x is number => x !== null));
  const cs = avg(ok.map((g) => g.cs_10).filter((x): x is number => x !== null));
  const ganks = ok.map((g) => g.first_gank).filter((x): x is { minute: number; lane: Role } => !!x);
  const lanes = new Map<Role, number>();
  for (const g of ganks) lanes.set(g.lane, (lanes.get(g.lane) ?? 0) + 1);
  const lane = [...lanes.entries()].sort((a, b) => b[1] - a[1] || LANE_ORDER.indexOf(a[0]) - LANE_ORDER.indexOf(b[0]))[0]?.[0] ?? null;
  const back = avg(ok.map((g) => g.first_back_minute).filter((x): x is number => x !== null));
  const l6 = avg(ok.map((g) => g.level6_minute).filter((x): x is number => x !== null));
  const minutes = ok.reduce((n, g) => n + g.minutes, 0);
  const gankMinute = avg(ganks.map((g) => g.minute));
  return {
    games: ok.length,
    gold_diff_10: gold === null ? null : Math.round(gold),
    cs_10: cs === null ? null : round1(cs),
    kills_before_10: round2(ok.reduce((n, g) => n + g.kills_before_10, 0) / ok.length),
    deaths_before_10: round2(ok.reduce((n, g) => n + g.deaths_before_10, 0) / ok.length),
    first_gank_minute: gankMinute === null ? null : round2(gankMinute),
    first_gank_lane: lane,
    first_back_minute: back === null ? null : round2(back),
    wards_per_min: minutes > 0 ? round2(ok.reduce((n, g) => n + g.wards, 0) / minutes) : 0,
    level6_minute: l6 === null ? null : round2(l6),
  };
}

/** Timelines (by match id) + the matches already fetched -> TimelineStyle of `puuid`. */
export function extractTimelineStyle(timelines: Record<string, unknown>, matches: unknown[], puuid: string): TimelineStyle | null {
  const byId = new Map<string, unknown>();
  for (const m of matches) {
    const id = isObj(m) ? (m as RawTimelineMatch).metadata?.matchId : undefined;
    if (typeof id === 'string') byId.set(id, m);
  }
  const facts = Object.entries(timelines).map(([id, t]) => (byId.has(id) ? timelineGameFacts(t, byId.get(id), puuid) : null));
  return aggregateTimelines(facts);
}

/** "3:20" from a minute value. */
export function formatClock(minutes: number): string {
  const total = Math.max(0, Math.round(minutes * 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
