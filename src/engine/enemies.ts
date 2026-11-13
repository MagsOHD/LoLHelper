// Known enemy players (scouted by Riot ID, revealed by the client in Clash / custom games, or read from the
// started game): pools, main roles, style tags, threats, points of attention, phase-by-phase plan.
//
// Identity rule: the only enemy identities ever written to an output (puuid, riot_id) are those of the
// `EnemyPlayerProfile`s given by the caller. A draft slot puuid without a matching profile is ignored.
// Every function is pure and deterministic; sentences are unelided (the public wrappers elide them).
import type {
  ClashPosition,
  EnemyPlayerInsight,
  EnemyPlayerProfile,
  PhaseAttention,
  PlaystyleStats,
  Rank,
  Role,
  TimelineStyle,
} from '../api/types';
import type { Catalog } from './catalog';
import { fmtPoints } from './generator';
import { cmpNum, cmpStr, pyFixed, pyRound } from './pycompat';
import { ROLE_LABELS } from './tables';

const ROLE_ORDER: readonly Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];

// --------------------------------------------------------------------------- thresholds

/** Mastery points on one champion from which a player is a one-trick / specialist. */
export const ONE_TRICK_POINTS = 200_000;
/** Share of the recent games on one champion from which a player is a one-trick (with ≥ OT_MIN_GAMES games). */
export const ONE_TRICK_SHARE = 0.4;
const OT_MIN_GAMES = 5;
/** Below this mastery (and no recent game) a locked champion is "barely played". */
export const LOW_MASTERY_POINTS = 10_000;
/** Recent winrate (≥ 5 games) of a hot / cold streak. */
export const HOT_STREAK_RATE = 0.7;
export const COLD_STREAK_RATE = 0.3;
const STREAK_MIN_GAMES = 5;
/** Ranked winrate (≥ 40 games) flagged as a threat. */
const RANKED_WR_HIGH = 0.6;
const RANKED_WR_MIN_GAMES = 40;
/** Low account level with a high rank / winrate: probable smurf. */
const SMURF_LEVEL = 60;
export const HIGH_TIERS: ReadonlySet<string> = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const SMURF_TIERS: ReadonlySet<string> = new Set(['DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER']);
export const TIER_FR: Record<string, string> = {
  IRON: 'Fer',
  BRONZE: 'Bronze',
  SILVER: 'Argent',
  GOLD: 'Or',
  PLATINUM: 'Platine',
  EMERALD: 'Émeraude',
  DIAMOND: 'Diamant',
  MASTER: 'Maître',
  GRANDMASTER: 'Grand Maître',
  CHALLENGER: 'Challenger',
};

/**
 * Playstyle thresholds (averages per game of PlaystyleStats, at least STYLE_MIN_GAMES games):
 *   aggressive      kills + deaths ≥ 14
 *   first blood     first_blood_rate ≥ 40 %
 *   duelist         solo_kills ≥ 1.5
 *   farm            cs/min ≥ 8 (lanes) / ≥ 6.5 (jungle); weak farm ≤ 5.5 (lanes)
 *   vision          ≥ 2.2/min (support) / ≥ 1.3 (others); weak ≤ 1.2 (support) / ≤ 0.5 (others)
 *   participation   kill_participation ≥ 65 %; low ≤ 40 % (≤ 30 % for top laners)
 *   deaths          ≥ 7 (dies a lot), ≤ 3.5 (careful)
 *   towers          turret_takedowns ≥ 2.5
 *   damage          damage_per_min ≥ 900
 *   lane lead       early_lead in 0..1 = share of games ahead at the end of laning (≥ 60 % / ≤ 35 %),
 *                   otherwise gold + XP lead (≥ +500 / ≤ −500)
 */
export const STYLE_MIN_GAMES = 3;
export const STYLE = {
  aggroKD: 14,
  firstBlood: 0.4,
  soloKills: 1.5,
  csHighLane: 8,
  csHighJungle: 6.5,
  csLowLane: 5.5,
  visionHighSupport: 2.2,
  visionHigh: 1.3,
  visionLowSupport: 1.2,
  visionLow: 0.5,
  kpHigh: 0.65,
  kpLow: 0.4,
  kpLowTop: 0.3,
  deathsHigh: 7,
  deathsLow: 3.5,
  turrets: 2.5,
  damage: 900,
  leadRateHigh: 0.6,
  leadRateLow: 0.35,
  leadAbs: 500,
} as const;

/**
 * Timeline thresholds (averages over the match timelines analysed, at least TL_MIN_GAMES timelines):
 *   early gank        jungler's first gank (kill / assist on an enemy laner) at or before 4:00
 *   late gank         jungler's first gank at or after 6:00 (farming jungler)
 *   lane lead         gold vs lane opponent at 10:00 ≥ +400 / ≤ −400 (only without an early_lead read)
 *   farm at 10:00     ≥ 85 cs (lanes) / ≥ 75 (jungle); weak ≤ 55 (lanes); never for supports
 *                     (only without a cs/min read)
 *   early activity    kills + assists before 10:00 ≥ 2 per game
 *   early deaths      deaths before 10:00 ≥ 1.5 per game; careful ≤ 0.25
 *   first back        at or after 7:00 (late); at or before 3:30 (early, top / mid / ADC only)
 *   level 6           at or before 6:15 (top), 6:45 (jungle), 6:00 (mid), 7:15 (ADC), 8:30 (support)
 *   wards placed      ≤ 0.3/min (lanes), ≤ 0.35 (jungle), ≤ 0.7 (support); many ≥ 1.4 (support) /
 *                     ≥ 0.7 (others) (only without a vision-score read)
 * Times are cited as m:ss rounded to 5 seconds; the matchup plan's timings come 30 seconds before the fact.
 */
export const TL_MIN_GAMES = 2;
export const TIMELINE = {
  earlyGank: 4,
  lateGank: 6,
  gold10: 400,
  cs10HighLane: 85,
  cs10HighJungle: 75,
  cs10LowLane: 55,
  earlyKA: 2,
  earlyDeathsHigh: 1.5,
  earlyDeathsLow: 0.25,
  lateBack: 7,
  earlyBack: 3.5,
  level6: { TOP: 6.25, JUNGLE: 6.75, MID: 6, BOTTOM: 7.25, SUPPORT: 8.5 } as Readonly<Record<Role, number>>,
  wardsLowLane: 0.3,
  wardsLowJungle: 0.35,
  wardsLowSupport: 0.7,
  wardsHighSupport: 1.4,
  wardsHigh: 0.7,
  /** the plan's "before …" timing: this many seconds before the usual minute */
  leadSeconds: 30,
} as const;

/** Clash declared position → role (FILL / UNSELECTED / unknown: no role). */
const CLASH_ROLE: Partial<Record<string, Role>> = {
  TOP: 'TOP',
  JUNGLE: 'JUNGLE',
  MIDDLE: 'MID',
  MID: 'MID',
  BOTTOM: 'BOTTOM',
  UTILITY: 'SUPPORT',
  SUPPORT: 'SUPPORT',
};
export function clashRoleOf(pos: ClashPosition | string | null | undefined): Role | null {
  return typeof pos === 'string' ? (CLASH_ROLE[pos.toUpperCase()] ?? null) : null;
}
/** Separator before the (verbatim, never elided) Clash team name in the Clash style tag. */
export const CLASH_TEAM_SEP = ' · équipe ';

/** Pool weight of a champion for a player: 65 % share of recent games (in that role), 35 % mastery vs their top. */
const POOL_W_GAMES = 0.65;
const POOL_W_POINTS = 0.35;
/** Masteries below this are not "in the pool" (except with recent games). */
const POOL_MIN_POINTS = 10_000;
/** Inference of a player's slot from a locked champion: champion "clearly" in a pool. */
export const INFER_MIN_GAMES = 2;
export const INFER_MIN_POINTS = 30_000;

const THEIR: Record<Role, string> = {
  TOP: 'leur top',
  JUNGLE: 'leur jungler',
  MID: 'leur mid',
  BOTTOM: 'leur ADC',
  SUPPORT: 'leur support',
};

// --------------------------------------------------------------------------- formatting

/** French decimal with one digit ("1,8"); integers without decimals. */
export function dec1(x: number): string {
  const s = pyFixed(x, 1);
  return (s.endsWith('.0') ? s.slice(0, -2) : s).replace('.', ',');
}

const pct = (x: number): number => pyRound(100 * x);

/** Minutes → "m:ss", rounded to 5 seconds (3.33 → "3:20"). */
export function clock(minutes: number): string {
  const s = Math.max(0, pyRound(minutes * 12) * 5);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** `clock` of TIMELINE.leadSeconds before `minutes` (never before 1:00). */
function clockBefore(minutes: number): string {
  return clock(Math.max(1, (pyRound(minutes * 12) * 5 - TIMELINE.leadSeconds) / 60));
}
const LANE_FR: Partial<Record<Role, string>> = { TOP: 'top', MID: 'mid', BOTTOM: 'bot' };
const plural = (n: number, word: string): string => `${word}${n > 1 ? 's' : ''}`;

export function rankText(r: Rank | null | undefined): string | null {
  if (!r || !r.tier) return null;
  const tier = r.tier.toUpperCase();
  const label = TIER_FR[tier] ?? r.tier;
  if (HIGH_TIERS.has(tier)) return `${label} (${r.lp} LP)`;
  return r.division ? `${label} ${r.division}` : label;
}

// --------------------------------------------------------------------------- normalised view

export interface PoolChamp {
  id: string;
  games: number;
  wins: number;
  points: number;
  /** recent games per role (null = role unknown) */
  byRole: Map<Role | null, number>;
}

export interface EnemyView {
  idx: number;
  prof: EnemyPlayerProfile;
  puuid: string;
  pool: Map<string, PoolChamp>;
  recentGames: number;
  maxPoints: number;
  roleShare: Record<Role, number>;
  /** explicit role of the profile (started game), else null */
  explicitRole: Role | null;
  /** role from the declared Clash position (null for FILL / UNSELECTED / absent) */
  clashRole: Role | null;
  mainRole: Role | null;
  style: PlaystyleStats | null;
  /** timeline facts (≥ TL_MIN_GAMES timelines), else null */
  timeline: TimelineStyle | null;
}

const validRole = (r: unknown): r is Role => typeof r === 'string' && (ROLE_ORDER as readonly string[]).includes(r);
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Normalised profiles: deduplicated by puuid (first kept), at most 10, input order. */
export function enemyViews(profiles: readonly EnemyPlayerProfile[] | null | undefined, catalog: Catalog): EnemyView[] {
  const out: EnemyView[] = [];
  const seen = new Set<string>();
  for (const prof of profiles ?? []) {
    if (!prof || typeof prof.puuid !== 'string' || !prof.puuid || seen.has(prof.puuid)) continue;
    seen.add(prof.puuid);
    if (out.length >= 10) break;
    const pool = new Map<string, PoolChamp>();
    const slot = (cid: string): PoolChamp => {
      let e = pool.get(cid);
      if (!e) pool.set(cid, (e = { id: cid, games: 0, wins: 0, points: 0, byRole: new Map() }));
      return e;
    };
    let sumGames = 0;
    for (const r of prof.recent?.champions ?? []) {
      const cid = r ? catalog.resolve(r.champion_id) : null;
      const g = num(r?.games);
      if (!cid || !(g > 0)) continue;
      const e = slot(cid);
      e.games += g;
      e.wins += Math.max(0, Math.min(g, num(r.wins)));
      const role = validRole(r.role) ? r.role : null;
      e.byRole.set(role, (e.byRole.get(role) ?? 0) + g);
      sumGames += g;
    }
    let maxPoints = 0;
    for (const m of prof.masteries ?? []) {
      const cid = m ? catalog.resolve(m.champion_id) : null;
      const p = num(m?.points);
      if (!cid || !(p > 0)) continue;
      if (p < POOL_MIN_POINTS && !pool.has(cid)) continue;
      const e = slot(cid);
      e.points = Math.max(e.points, p);
      maxPoints = Math.max(maxPoints, p);
    }
    const recentGames = Math.max(num(prof.recent?.games), sumGames);
    // role shares: summary roles, else roles of the recent champions, else catalog roles of the top masteries
    const share = {} as Record<Role, number>;
    for (const r of ROLE_ORDER) share[r] = 0;
    let tot = 0;
    for (const r of ROLE_ORDER) {
      const v = num(prof.recent?.roles?.[r]);
      if (v > 0) {
        share[r] += v;
        tot += v;
      }
    }
    if (!(tot > 0)) {
      for (const e of pool.values()) {
        for (const [r, g] of e.byRole) {
          if (r) {
            share[r] += g;
            tot += g;
          }
        }
      }
    }
    if (!(tot > 0)) {
      const top = [...pool.values()].filter((e) => e.points > 0).sort((a, b) => cmpNum(b.points, a.points) || cmpStr(a.id, b.id));
      for (const e of top.slice(0, 5)) {
        const r = catalog.data(e.id)?.roles[0];
        if (r) {
          share[r] += e.points;
          tot += e.points;
        }
      }
    }
    if (tot > 0) for (const r of ROLE_ORDER) share[r] /= tot;
    const explicitRole = validRole(prof.role) ? prof.role : null;
    const clashRole = clashRoleOf(prof.clash_position);
    let mainRole: Role | null = explicitRole ?? clashRole;
    if (!mainRole) {
      let best = 0;
      for (const r of ROLE_ORDER) {
        if (share[r] > best + 1e-12) {
          best = share[r];
          mainRole = r;
        }
      }
    }
    const style = prof.style && num(prof.style.games) >= STYLE_MIN_GAMES ? prof.style : null;
    const tl = prof.style?.timeline;
    const timeline = tl && typeof tl === 'object' && num(tl.games) >= TL_MIN_GAMES ? tl : null;
    out.push({
      idx: out.length,
      prof,
      puuid: prof.puuid,
      pool,
      recentGames,
      maxPoints,
      roleShare: share,
      explicitRole,
      clashRole,
      mainRole,
      style,
      timeline,
    });
  }
  return out;
}

/** Recent games of a pool champion that count for `role` (games in that role + games of unknown role it can play). */
function gamesIn(e: PoolChamp, role: Role | null, catalog: Catalog): number {
  if (!role) return e.games;
  let g = e.byRole.get(role) ?? 0;
  const unknown = e.byRole.get(null) ?? 0;
  if (unknown && catalog.data(e.id)?.roles.includes(role)) g += unknown;
  return g;
}

/**
 * Pool weight (0..1) of every champion of the player that can go in `role` (any role when null), not in
 * `excluded`: 0.65 × recent games in that role / recent games + 0.35 × mastery points / their top mastery.
 */
export function poolWeights(v: EnemyView, role: Role | null, excluded: ReadonlySet<string>, catalog: Catalog): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of v.pool.values()) {
    if (excluded.has(e.id)) continue;
    const d = catalog.data(e.id);
    if (!d) continue;
    const g = gamesIn(e, role, catalog);
    const playable = !role || d.roles.includes(role) || g > 0;
    if (!playable) continue;
    const pts = !role || d.roles.includes(role) ? e.points : 0;
    const q = (POOL_W_GAMES * g) / Math.max(1, v.recentGames) + (POOL_W_POINTS * pts) / Math.max(1, v.maxPoints);
    if (q > 0) out.set(e.id, q);
  }
  return out;
}

/** Champion ids sorted by weight (best first, id tie-break). */
export function sortedWeights(w: Map<string, number>): [string, number][] {
  return [...w.entries()].sort((a, b) => cmpNum(b[1], a[1]) || cmpStr(a[0], b[0]));
}

/** Short French evidence of a champion in the player's pool ("6 parties sur 10 récentes, 412k points"). */
export function poolEvidence(v: EnemyView, cid: string): string {
  const e = v.pool.get(cid);
  if (!e) return '';
  const parts: string[] = [];
  if (e.games > 0) parts.push(`${e.games} ${plural(e.games, 'partie')} sur ${v.recentGames} récentes`);
  if (e.points >= POOL_MIN_POINTS) parts.push(`${fmtPoints(e.points)} points`);
  return parts.join(', ');
}

/** True when `cid` is clearly in the player's pool (≥ 2 recent games or ≥ 30k mastery points). */
export function clearlyInPool(v: EnemyView, cid: string): boolean {
  const e = v.pool.get(cid);
  return !!e && (e.games >= INFER_MIN_GAMES || e.points >= INFER_MIN_POINTS);
}

export interface OneTrick {
  champion: string;
  points: number | null; // when ≥ ONE_TRICK_POINTS
  games: number | null; // when ≥ ONE_TRICK_SHARE of recent games
  total: number;
}

/** One-trick: top mastery ≥ 200k points, or ≥ 40 % of ≥ 5 recent games on one champion. */
export function oneTrickOf(v: EnemyView): OneTrick | null {
  let topM: PoolChamp | null = null;
  let topR: PoolChamp | null = null;
  for (const e of v.pool.values()) {
    if (e.points > 0 && (!topM || e.points > topM.points || (e.points === topM.points && cmpStr(e.id, topM.id) < 0))) topM = e;
    if (e.games > 0 && (!topR || e.games > topR.games || (e.games === topR.games && cmpStr(e.id, topR.id) < 0))) topR = e;
  }
  const byShare = !!topR && v.recentGames >= OT_MIN_GAMES && topR.games / v.recentGames >= ONE_TRICK_SHARE;
  const byPoints = !!topM && topM.points >= ONE_TRICK_POINTS;
  if (!byShare && !byPoints) return null;
  const champ = byShare ? topR! : topM!;
  return {
    champion: champ.id,
    points: champ.points >= ONE_TRICK_POINTS ? champ.points : null,
    games: byShare ? champ.games : null,
    total: v.recentGames,
  };
}

export function otEvidence(ot: OneTrick): string {
  const parts: string[] = [];
  if (ot.points !== null) parts.push(`${fmtPoints(ot.points)} points`);
  if (ot.games !== null) parts.push(`${ot.games} parties sur ${ot.total} récentes`);
  return parts.join(', ');
}

/** [wins, games] of the recent games (style stats first, else the recent champions). */
function recentRecord(v: EnemyView): [number, number] {
  const st = v.prof.style;
  if (st && num(st.games) > 0) return [Math.max(0, Math.min(num(st.games), num(st.wins))), num(st.games)];
  let g = 0;
  let w = 0;
  for (const e of v.pool.values()) {
    g += e.games;
    w += e.wins;
  }
  return [w, g];
}

// --------------------------------------------------------------------------- style

type StyleKey =
  | 'aggro'
  | 'firstBlood'
  | 'solo'
  | 'csHigh'
  | 'csLow'
  | 'visionHigh'
  | 'visionLow'
  | 'kpHigh'
  | 'kpLow'
  | 'deathsHigh'
  | 'deathsLow'
  | 'turrets'
  | 'damage'
  | 'leadHigh'
  | 'leadLow'
  // timeline facts
  | 'earlyGank'
  | 'lateGank'
  | 'earlyActive'
  | 'earlyDeaths'
  | 'safeEarly'
  | 'fastSix'
  | 'lateBack'
  | 'earlyBack';

interface StyleRead {
  key: StyleKey;
  tag: string;
  /** the number cited, ready to insert ("62 % de premiers sangs") */
  fact: string;
  /** timeline facts: the usual minute (gank, back, level 6) */
  at?: number;
  /** early gank: the lane favoured */
  lane?: Role | null;
  /** the read comes from the match timelines */
  tl?: boolean;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const signed = (x: number): string => (x > 0 ? `+${pyRound(x)}` : `${pyRound(x)}`);
/** French singular below 2 ("1,7 mort"), plural from 2. */
const unit = (x: number, word: string): string => `${word}${x >= 2 ? 's' : ''}`;

/**
 * Style facts of a player, in priority order. `role` adapts the farm / vision / participation thresholds.
 * `timeline` (≥ TL_MIN_GAMES timelines) adds the timeline facts; without it the reads are unchanged.
 */
export function styleReads(style: PlaystyleStats | null, role: Role | null, timeline: TimelineStyle | null = null): StyleRead[] {
  const st = style && num(style.games) >= STYLE_MIN_GAMES ? style : null;
  const tl = timeline && num(timeline.games) >= TL_MIN_GAMES ? timeline : null;
  if (!st && !tl) return [];
  const out: StyleRead[] = [];
  const k = num(st?.kills);
  const d = num(st?.deaths);
  const fb = num(st?.first_blood_rate);
  const solo = num(st?.solo_kills);
  const cs = num(st?.cs_per_min);
  const vis = num(st?.vision_per_min);
  const kp = num(st?.kill_participation);
  const tw = num(st?.turret_takedowns);
  const dmg = num(st?.damage_per_min);
  if (st && k + d >= STYLE.aggroKD) {
    out.push({ key: 'aggro', tag: `Très agressif (${dec1(k + d)} kills + morts par partie)`, fact: `${dec1(k + d)} kills + morts par partie` });
  }
  if (st && fb >= STYLE.firstBlood) {
    out.push({ key: 'firstBlood', tag: `Cherche le premier sang (${pct(fb)} % des parties)`, fact: `${pct(fb)} % de premiers sangs` });
  }
  if (tl && (role === 'JUNGLE' || !role) && fin(tl.first_gank_minute) && tl.first_gank_minute > 0) {
    const g = tl.first_gank_minute;
    const lane = validRole(tl.first_gank_lane) && LANE_FR[tl.first_gank_lane] ? tl.first_gank_lane : null;
    const where = lane ? `, surtout ${LANE_FR[lane]}` : '';
    if (g <= TIMELINE.earlyGank) {
      out.push({
        key: 'earlyGank',
        tag: `Jungler qui gank tôt : premier gank vers ${clock(g)}${where} (sur ${num(tl.games)} parties)`,
        fact: `premier gank vers ${clock(g)}${where}`,
        at: g,
        lane,
        tl: true,
      });
    } else if (g >= TIMELINE.lateGank) {
      out.push({
        key: 'lateGank',
        tag: `Jungler farmeur : premier gank vers ${clock(g)} seulement`,
        fact: `premier gank vers ${clock(g)}`,
        at: g,
        lane,
        tl: true,
      });
    }
  }
  if (st && solo >= STYLE.soloKills) {
    out.push({ key: 'solo', tag: `Gagne ses duels (${dec1(solo)} solo kills par partie)`, fact: `${dec1(solo)} solo kills par partie` });
  }
  const lead = st?.early_lead;
  let leadRead = false;
  if (st && typeof lead === 'number' && Number.isFinite(lead)) {
    leadRead = true;
    if (Math.abs(lead) <= 1) {
      if (lead >= STYLE.leadRateHigh) {
        out.push({ key: 'leadHigh', tag: `Gagne souvent sa lane (en avance dans ${pct(lead)} % des parties)`, fact: `en avance en fin de lane dans ${pct(lead)} % des parties` });
      } else if (lead >= 0 && lead <= STYLE.leadRateLow) {
        out.push({ key: 'leadLow', tag: `Perd souvent sa lane (en avance dans ${pct(lead)} % des parties seulement)`, fact: `en avance en fin de lane dans ${pct(lead)} % des parties seulement` });
      } else leadRead = false;
    } else if (lead >= STYLE.leadAbs) {
      out.push({ key: 'leadHigh', tag: `Prend l'avance en lane (+${pyRound(lead)} or et XP en moyenne)`, fact: `+${pyRound(lead)} or et XP en fin de lane` });
    } else if (lead <= -STYLE.leadAbs) {
      out.push({ key: 'leadLow', tag: `Perd souvent sa lane (${pyRound(lead)} or et XP en moyenne)`, fact: `${pyRound(lead)} or et XP en fin de lane` });
    } else leadRead = false;
  }
  if (tl && !leadRead && fin(tl.gold_diff_10)) {
    const gd = tl.gold_diff_10;
    if (gd >= TIMELINE.gold10) {
      out.push({ key: 'leadHigh', tag: `Prend l'avance en lane : ${signed(gd)} or à 10 min en moyenne`, fact: `${signed(gd)} or à 10 min`, tl: true });
    } else if (gd <= -TIMELINE.gold10) {
      out.push({ key: 'leadLow', tag: `Perd souvent sa lane : ${signed(gd)} or à 10 min en moyenne`, fact: `${signed(gd)} or à 10 min`, tl: true });
    }
  }
  if (tl) {
    const ka = num(tl.kills_before_10);
    const de = num(tl.deaths_before_10);
    if (ka >= TIMELINE.earlyKA) {
      out.push({ key: 'earlyActive', tag: `Très actif avant 10 min (${dec1(ka)} kills + assists par partie)`, fact: `${dec1(ka)} kills + assists avant 10 min`, tl: true });
    }
    if (de >= TIMELINE.earlyDeathsHigh) {
      out.push({ key: 'earlyDeaths', tag: `Meurt souvent tôt (${dec1(de)} ${unit(de, 'mort')} avant 10 min par partie)`, fact: `${dec1(de)} ${unit(de, 'mort')} avant 10 min par partie`, tl: true });
    } else if (de <= TIMELINE.earlyDeathsLow && fin(tl.deaths_before_10)) {
      out.push({ key: 'safeEarly', tag: `Prudent en début de partie (${dec1(de)} mort avant 10 min par partie)`, fact: `${dec1(de)} mort avant 10 min par partie`, tl: true });
    }
    const l6 = tl.level6_minute;
    if (fin(l6) && l6 > 0 && l6 <= (role ? TIMELINE.level6[role] : TIMELINE.level6.MID)) {
      out.push({ key: 'fastSix', tag: `Niveau 6 rapide (${clock(l6)})`, fact: `niveau 6 vers ${clock(l6)}`, at: l6, tl: true });
    }
  }
  let csRead = false;
  if (st && role !== 'SUPPORT') {
    const high = role === 'JUNGLE' ? STYLE.csHighJungle : STYLE.csHighLane;
    if (cs >= high) {
      out.push({ key: 'csHigh', tag: `Farm avant tout (${dec1(cs)} cs/min)`, fact: `${dec1(cs)} cs/min` });
      csRead = true;
    } else if (role !== 'JUNGLE' && cs > 0 && cs <= STYLE.csLowLane) {
      out.push({ key: 'csLow', tag: `Farm faible (${dec1(cs)} cs/min)`, fact: `${dec1(cs)} cs/min` });
      csRead = true;
    }
  }
  if (tl && !csRead && role !== 'SUPPORT' && fin(tl.cs_10) && tl.cs_10 > 0) {
    const c10 = pyRound(tl.cs_10);
    if (tl.cs_10 >= (role === 'JUNGLE' ? TIMELINE.cs10HighJungle : TIMELINE.cs10HighLane)) {
      out.push({ key: 'csHigh', tag: `Farm solide : ${c10} cs à 10 min`, fact: `${c10} cs à 10 min`, tl: true });
    } else if (role !== 'JUNGLE' && tl.cs_10 <= TIMELINE.cs10LowLane) {
      out.push({ key: 'csLow', tag: `Farm faible : ${c10} cs à 10 min`, fact: `${c10} cs à 10 min`, tl: true });
    }
  }
  const vHigh = role === 'SUPPORT' ? STYLE.visionHighSupport : STYLE.visionHigh;
  const vLow = role === 'SUPPORT' ? STYLE.visionLowSupport : STYLE.visionLow;
  let visRead = false;
  if (st && vis >= vHigh) {
    out.push({ key: 'visionHigh', tag: `Gros travail de vision (${dec1(vis)} par minute)`, fact: `${dec1(vis)} de score de vision par minute` });
    visRead = true;
  } else if (st && vis <= vLow) {
    out.push({ key: 'visionLow', tag: `Vision faible (${dec1(vis)} par minute)`, fact: `${dec1(vis)} de score de vision par minute` });
    visRead = true;
  }
  if (tl && !visRead && fin(tl.wards_per_min) && tl.wards_per_min >= 0) {
    const w = tl.wards_per_min;
    const low = role === 'SUPPORT' ? TIMELINE.wardsLowSupport : role === 'JUNGLE' ? TIMELINE.wardsLowJungle : TIMELINE.wardsLowLane;
    const high = role === 'SUPPORT' ? TIMELINE.wardsHighSupport : TIMELINE.wardsHigh;
    if (w <= low) {
      out.push({ key: 'visionLow', tag: `Pose peu de balises (${dec1(w)}/min)`, fact: `${dec1(w)} ${unit(w, 'balise')} par minute`, tl: true });
    } else if (w >= high) {
      out.push({ key: 'visionHigh', tag: `Pose beaucoup de balises (${dec1(w)}/min)`, fact: `${dec1(w)} ${unit(w, 'balise')} par minute`, tl: true });
    }
  }
  if (tl && fin(tl.first_back_minute) && tl.first_back_minute > 0) {
    const b = tl.first_back_minute;
    if (b >= TIMELINE.lateBack) {
      out.push({ key: 'lateBack', tag: `Retour en base tardif (${clock(b)})`, fact: `premier retour en base vers ${clock(b)}`, at: b, tl: true });
    } else if (b <= TIMELINE.earlyBack && (role === 'TOP' || role === 'MID' || role === 'BOTTOM')) {
      out.push({ key: 'earlyBack', tag: `Retour en base précoce (${clock(b)})`, fact: `premier retour en base vers ${clock(b)}`, at: b, tl: true });
    }
  }
  if (!st) return out;
  const kpLow = role === 'TOP' ? STYLE.kpLowTop : STYLE.kpLow;
  if (kp >= STYLE.kpHigh) out.push({ key: 'kpHigh', tag: `Toujours dans les combats (${pct(kp)} % de participation)`, fact: `${pct(kp)} % de participation aux kills` });
  else if (kp > 0 && kp <= kpLow) out.push({ key: 'kpLow', tag: `Joue souvent seul (${pct(kp)} % de participation)`, fact: `${pct(kp)} % de participation aux kills` });
  if (d >= STYLE.deathsHigh) out.push({ key: 'deathsHigh', tag: `Meurt beaucoup (${dec1(d)} morts par partie)`, fact: `${dec1(d)} morts par partie` });
  else if (d <= STYLE.deathsLow) out.push({ key: 'deathsLow', tag: `Meurt rarement (${dec1(d)} morts par partie)`, fact: `${dec1(d)} morts par partie` });
  if (tw >= STYLE.turrets) out.push({ key: 'turrets', tag: `Pousse les tours (${dec1(tw)} par partie)`, fact: `${dec1(tw)} tours par partie` });
  if (dmg >= STYLE.damage) out.push({ key: 'damage', tag: `Gros dégâts (${pyRound(dmg)} par minute)`, fact: `${pyRound(dmg)} dégâts par minute` });
  return out;
}

/** Style tag of the Clash information ("Poste Clash déclaré : Mid · équipe Les Fous [FOU]"), null without it. */
export function clashTag(prof: EnemyPlayerProfile): string | null {
  const pos = typeof prof.clash_position === 'string' ? prof.clash_position.toUpperCase() : null;
  const r = clashRoleOf(pos);
  const team = prof.clash_team && typeof prof.clash_team.name === 'string' ? prof.clash_team.name.trim() : '';
  const abbr = prof.clash_team && typeof prof.clash_team.abbreviation === 'string' ? prof.clash_team.abbreviation.trim() : '';
  let head: string | null = null;
  if (r) head = `Poste Clash déclaré : ${ROLE_LABELS[r]}`;
  else if (pos === 'FILL') head = 'Poste Clash déclaré : Fill (tous rôles)';
  else if (team) head = 'Joueur Clash';
  if (!head) return null;
  return team ? `${head}${CLASH_TEAM_SEP}${team}${abbr && abbr !== team ? ` [${abbr}]` : ''}` : head;
}

// --------------------------------------------------------------------------- insight

export interface InsightOpts {
  /** Their champion when known (linked slot, game). */
  champion: string | null;
  role: Role | null;
  /** Champions they cannot pick any more (bans, picks of both teams). */
  excluded: ReadonlySet<string>;
  /** Likely picks when the champion is unknown (already computed by the predictions), else from the pool. */
  likely?: string[];
  /** Bans are still possible (draft before the end of the ban phases). */
  bansOpen?: boolean;
}

/** One insight per enemy player: style tags, threats, attention points, likely picks. */
export function enemyInsight(v: EnemyView, o: InsightOpts, catalog: Catalog): EnemyPlayerInsight {
  const prof = v.prof;
  const role = o.role ?? v.mainRole;
  const champ = o.champion;
  const reads = styleReads(v.style, role, v.timeline);
  const has = (k: StyleKey): StyleRead | undefined => reads.find((r) => r.key === k);
  const threats: string[] = [];
  const attention: string[] = [];
  const ot = oneTrickOf(v);
  if (ot) {
    const onIt = !champ || champ === ot.champion;
    if (onIt) threats.push(`One-trick ${catalog.name(ot.champion)} (${otEvidence(ot)})`);
    if (!champ && !o.excluded.has(ot.champion)) {
      attention.push(
        o.bansOpen === false
          ? `Préparez le matchup contre ${catalog.name(ot.champion)} : son champion fétiche (${otEvidence(ot)})`
          : `Bannissez ${catalog.name(ot.champion)} ou préparez ce matchup (${otEvidence(ot)})`,
      );
    }
  }
  if (champ) {
    const e = v.pool.get(champ);
    const name = catalog.name(champ);
    const share = e && v.recentGames >= OT_MIN_GAMES ? e.games / v.recentGames : 0;
    if (e && (!ot || ot.champion !== champ) && (e.points >= ONE_TRICK_POINTS || share >= ONE_TRICK_SHARE)) {
      threats.push(`Spécialiste de ${name} (${poolEvidence(v, champ)})`);
    } else if ((!e || (e.games === 0 && e.points < LOW_MASTERY_POINTS)) && (v.pool.size > 0 || v.maxPoints > 0)) {
      const pts = e?.points ?? 0;
      const main = ot ? ot.champion : sortedWeights(poolWeights(v, null, new Set(), catalog))[0]?.[0];
      const habit = main && main !== champ ? `, habitué à ${catalog.name(main)}` : '';
      attention.push(
        `Peu d'expérience sur ${name} (${pts ? `${fmtPoints(pts)} points` : 'aucune maîtrise notable'}, aucune partie récente${habit}) : punissez ses erreurs tôt`,
      );
    }
  }
  const tier = prof.rank?.tier ? prof.rank.tier.toUpperCase() : '';
  const rt = rankText(prof.rank);
  if (HIGH_TIERS.has(tier) && rt) threats.push(`Joueur ${rt}`);
  const rw = num(prof.rank?.wins);
  const rl = num(prof.rank?.losses);
  if (rw + rl >= RANKED_WR_MIN_GAMES && rw / (rw + rl) >= RANKED_WR_HIGH) {
    threats.push(`${pct(rw / (rw + rl))} % de victoires en classé (${rw} V / ${rl} D)`);
  }
  const level = num(prof.summoner_level);
  if (level > 0 && level <= SMURF_LEVEL && (SMURF_TIERS.has(tier) || (rw + rl >= 20 && rw / (rw + rl) >= RANKED_WR_HIGH))) {
    threats.push(`Compte de niveau ${level}${rt ? ` déjà ${rt}` : ''} : probablement plus fort que son compte`);
  }
  const [w, g] = recentRecord(v);
  if (g >= STREAK_MIN_GAMES && w / g >= HOT_STREAK_RATE) threats.push(`En forme : ${w} victoires sur ${g} parties récentes`);
  else if (g >= STREAK_MIN_GAMES && w / g <= COLD_STREAK_RATE) {
    attention.push(`Série difficile (${w} ${plural(w, 'victoire')} sur ${g}) : mettez-lui la pression tôt`);
  }
  // style → what to do about it
  const eg = has('earlyGank');
  if (eg) {
    const lane = eg.lane ? LANE_FR[eg.lane] : null;
    attention.push(
      `Gank tôt (${eg.fact}) : ${lane ? `wardez l'entrée de jungle côté ${lane}` : 'wardez les entrées de votre jungle'} avant ${clockBefore(eg.at!)}`,
    );
  }
  const fb = has('firstBlood');
  if (fb) {
    attention.push(
      role === 'JUNGLE'
        ? `Envahit tôt (${fb.fact}) : wardez votre jungle vers 2:30 et restez groupés au niveau 1`
        : `Cherche le kill tôt (${fb.fact}) : respectez ses niveaux 2 et 3`,
    );
  }
  const solo = has('solo');
  if (solo) attention.push(`Gagne ses 1v1 (${solo.fact}) : ne l'affrontez pas seul, jouez avec votre jungler`);
  const lead = has('leadLow');
  if (lead && role !== 'JUNGLE' && role !== 'SUPPORT') attention.push(`Perd souvent sa lane (${lead.fact}) : jouez agressif contre lui`);
  const vis = has('visionLow');
  if (vis) attention.push(`Warde peu (${vis.fact}) : tendez des embuscades dans sa zone`);
  const deaths = has('deathsHigh');
  if (deaths) attention.push(`Meurt souvent (${deaths.fact}) : punissez ses prises de risque`);
  const kpLow = has('kpLow');
  if (kpLow && has('csHigh')) attention.push(`Farme et rejoint peu les combats (${kpLow.fact}) : forcez les objectifs à 5 contre 4`);
  const tw = has('turrets');
  if (tw) attention.push(`Pousse beaucoup les tours (${tw.fact}) : gardez de la vision sur sa lane`);
  const six = has('fastSix');
  if (six && role !== 'SUPPORT') attention.push(`Niveau 6 rapide (${clock(six.at!)}) : respectez son ultime dès ${clockBefore(six.at!)}`);
  const lb = has('lateBack');
  if (lb) attention.push(`Retour en base tardif (${clock(lb.at!)}) : punissable par un recall synchronisé`);
  const ed = has('earlyDeaths');
  if (ed && !deaths) attention.push(`Meurt souvent tôt (${ed.fact}) : jouez autour de lui avant 10:00`);
  const lg = has('lateGank');
  if (lg) attention.push(`Farme sa jungle (${lg.fact}) : jouez agressif en lane avant ${clockBefore(lg.at!)}`);
  let likely: string[] = [];
  if (!champ) {
    likely = o.likely ?? sortedWeights(poolWeights(v, role, o.excluded, catalog)).slice(0, 3).map(([cid]) => cid);
  }
  const clash = clashTag(prof);
  return {
    puuid: v.puuid,
    riot_id: prof.riot_id ?? null,
    role: role ?? null,
    champion_id: champ,
    level: level > 0 ? level : null,
    rank: prof.rank ?? null,
    style_tags: clash ? [clash, ...reads.slice(0, 5).map((r) => r.tag)] : reads.slice(0, 5).map((r) => r.tag),
    threats: threats.slice(0, 4),
    attention_points: attention.slice(0, 4),
    likely_picks: likely,
  };
}

// --------------------------------------------------------------------------- linking

export interface EnemySlotIn {
  idx: number;
  champ: string | null; // resolved
  role: Role | null; // explicit
  puuid: string | null;
}

/**
 * Which enemy slot every known player is on: slot puuid = profile puuid, else profile champion = slot
 * champion, else inference: a locked champion clearly in exactly one remaining pool (≥ 2 recent games or
 * ≥ 30k points), that pool matching exactly one remaining champion; repeated until stable.
 * Returns profile idx → slot idx.
 */
export function linkProfiles(views: readonly EnemyView[], slots: readonly EnemySlotIn[], catalog: Catalog): Map<number, number> {
  const link = new Map<number, number>();
  const usedSlot = new Set<number>();
  for (const v of views) {
    const s = slots.find((x) => x.puuid && x.puuid === v.puuid && !usedSlot.has(x.idx));
    if (s) {
      link.set(v.idx, s.idx);
      usedSlot.add(s.idx);
    }
  }
  for (const v of views) {
    if (link.has(v.idx)) continue;
    const cid = v.prof.champion_id ? catalog.resolve(v.prof.champion_id) : null;
    if (!cid) continue;
    const s = slots.find((x) => x.champ === cid && !usedSlot.has(x.idx) && !x.puuid);
    if (s) {
      link.set(v.idx, s.idx);
      usedSlot.add(s.idx);
    }
  }
  for (;;) {
    const freeViews = views.filter((v) => !link.has(v.idx) && !(v.prof.champion_id && catalog.resolve(v.prof.champion_id)));
    const freeSlots = slots.filter((s) => s.champ && !usedSlot.has(s.idx) && !s.puuid);
    const bySlot = new Map<number, EnemyView[]>();
    const byView = new Map<number, number>();
    for (const s of freeSlots) {
      const m = freeViews.filter((v) => clearlyInPool(v, s.champ!));
      bySlot.set(s.idx, m);
      for (const v of m) byView.set(v.idx, (byView.get(v.idx) ?? 0) + 1);
    }
    let changed = false;
    for (const s of freeSlots) {
      const m = bySlot.get(s.idx)!;
      if (m.length === 1 && byView.get(m[0].idx) === 1) {
        link.set(m[0].idx, s.idx);
        usedSlot.add(s.idx);
        changed = true;
      }
    }
    if (!changed) changed = linkByClash(freeViews, freeSlots, link, usedSlot, catalog);
    if (!changed) break;
  }
  return link;
}

/**
 * Clash declared positions as slot evidence (only players without an explicit role): a free slot's locked
 * champion goes to the one player whose declared role is the slot's role (or, slot role unknown, one of the
 * champion's roles) and who has it in their pool (any game or mastery) or whose declared role is the slot's
 * explicit role — when that player matches no other slot. Returns true when a link was added.
 */
function linkByClash(
  freeViews: readonly EnemyView[],
  freeSlots: readonly EnemySlotIn[],
  link: Map<number, number>,
  usedSlot: Set<number>,
  catalog: Catalog,
): boolean {
  const clashViews = freeViews.filter((v) => v.clashRole && !v.explicitRole);
  if (!clashViews.length) return false;
  const bySlot = new Map<number, EnemyView[]>();
  const byView = new Map<number, number>();
  for (const s of freeSlots) {
    const roles = s.role ? [s.role] : (catalog.data(s.champ!)?.roles ?? []);
    const m = clashViews.filter((v) => roles.includes(v.clashRole!) && (v.pool.has(s.champ!) || s.role === v.clashRole));
    bySlot.set(s.idx, m);
    for (const v of m) byView.set(v.idx, (byView.get(v.idx) ?? 0) + 1);
  }
  let changed = false;
  for (const s of freeSlots) {
    const m = bySlot.get(s.idx)!;
    if (m.length === 1 && byView.get(m[0].idx) === 1 && !link.has(m[0].idx)) {
      link.set(m[0].idx, s.idx);
      usedSlot.add(s.idx);
      changed = true;
    }
  }
  return changed;
}

/** Role a known player most likely holds with `cid` (their share among the champion's roles), null if no evidence. */
export function linkedRole(v: EnemyView, cid: string, catalog: Catalog): Role | null {
  if (v.explicitRole) return v.explicitRole;
  const d = catalog.data(cid);
  const e = v.pool.get(cid);
  // declared Clash position: kept unless the champion cannot go there (no catalog role, no game there)
  if (v.clashRole && (!d || d.roles.includes(v.clashRole) || (e?.byRole.get(v.clashRole) ?? 0) > 0)) return v.clashRole;
  let best: Role | null = null;
  let bestV = 0;
  for (const r of ROLE_ORDER) {
    let s = v.roleShare[r] * (d?.roles.includes(r) ? 1 : 0.3);
    if (e) s += (e.byRole.get(r) ?? 0) / Math.max(1, e.games);
    if (s > bestV + 1e-12) {
      bestV = s;
      best = r;
    }
  }
  return bestV >= 0.2 ? best : null;
}

/** Fit of a declared Clash role in the open-role search (other roles: CLASH_OTHER_W × role share). */
export const CLASH_ROLE_FIT = 1.5;
const CLASH_OTHER_W = 0.5;

/**
 * Open roles for players whose champion is unknown: exhaustive search maximising the sum of role shares
 * (explicit roles = 2; a declared Clash role = 1.5, other roles half their share), a role needs a fit
 * ≥ 0.15; deterministic. Returns profile idx → role.
 */
export function assignOpenRoles(views: readonly EnemyView[], open: readonly Role[], forced: ReadonlyMap<number, Role>): Map<number, Role> {
  const out = new Map<number, Role>();
  const free = open.filter((r) => ![...forced.values()].includes(r));
  for (const [i, r] of forced) if (open.includes(r)) out.set(i, r);
  const list = views.filter((v) => !forced.has(v.idx));
  const fit = (v: EnemyView, r: Role): number =>
    v.explicitRole
      ? v.explicitRole === r
        ? 2
        : 0
      : v.clashRole
        ? v.clashRole === r
          ? CLASH_ROLE_FIT
          : CLASH_OTHER_W * v.roleShare[r]
        : v.roleShare[r];
  let best: (Role | null)[] = list.map(() => null);
  let bestScore = 0;
  const cur: (Role | null)[] = [];
  const used = new Set<Role>();
  const rec = (i: number, acc: number): void => {
    if (i === list.length) {
      if (acc > bestScore + 1e-9) {
        bestScore = acc;
        best = [...cur];
      }
      return;
    }
    cur.push(null);
    rec(i + 1, acc);
    cur.pop();
    for (const r of free) {
      if (used.has(r)) continue;
      const f = fit(list[i], r);
      if (f < 0.15) continue;
      used.add(r);
      cur.push(r);
      rec(i + 1, acc + f);
      cur.pop();
      used.delete(r);
    }
  };
  rec(0, 0);
  list.forEach((v, i) => {
    if (best[i]) out.set(v.idx, best[i]!);
  });
  return out;
}

// --------------------------------------------------------------------------- matchup plan: phases

export interface KnownEnemy {
  view: EnemyView;
  champion: string | null;
  role: Role | null;
}

/**
 * Early / mid / late points of attention tied to concrete enemies (role, champion and the number that
 * justifies the point), at most 3 per phase, phase then role order.
 */
export function phaseAttention(known: readonly KnownEnemy[], catalog: Catalog): PhaseAttention[] {
  const rows: [number, number, number, PhaseAttention][] = [];
  const PH = { early: 0, mid: 1, late: 2 } as const;
  const sorted = [...known].sort(
    (a, b) => cmpNum(a.role ? ROLE_ORDER.indexOf(a.role) : 9, b.role ? ROLE_ORDER.indexOf(b.role) : 9) || a.view.idx - b.view.idx,
  );
  sorted.forEach((k, order) => {
    const role = k.role ?? k.view.mainRole;
    const reads = styleReads(k.view.style, role, k.view.timeline);
    const has = (key: StyleKey): StyleRead | undefined => reads.find((r) => r.key === key);
    const who = role ? THEIR[role] : 'un adversaire';
    const champ = k.champion ? catalog.name(k.champion) : null;
    const tag = (fact?: string): string => {
      const parts = [champ, fact].filter(Boolean);
      return parts.length ? ` (${parts.join(', ')})` : '';
    };
    const add = (phase: 'early' | 'mid' | 'late', prio: number, text: string): void => {
      rows.push([PH[phase], prio, order, { phase, text, enemy_puuid: k.view.puuid }]);
    };
    const ot = oneTrickOf(k.view);
    // timeline facts: concrete timings
    const eg = has('earlyGank');
    if (eg) {
      const lane = eg.lane ? LANE_FR[eg.lane] : null;
      const ward =
        eg.lane === 'MID'
          ? 'wardez les deux entrées de jungle autour du mid'
          : lane
            ? `wardez l'entrée de jungle côté ${lane}`
            : 'wardez les entrées de votre jungle';
      add('early', 0, `Early : ${who}${tag(eg.fact)} gank tôt : ${ward} avant ${clockBefore(eg.at!)}${lane ? ` et jouez prudemment en ${lane}` : ''}.`);
    }
    const six = has('fastSix');
    if (six && role !== 'SUPPORT') {
      add(
        'early',
        1,
        role === 'JUNGLE'
          ? `Early : ${who}${tag(six.fact)} a son ultime tôt : attendez-vous à un gank avec ultime dès ${clockBefore(six.at!)}.`
          : `Early : ${who}${tag(six.fact)} a son ultime tôt : respectez-le dès ${clockBefore(six.at!)}, ne restez pas en lane avec peu de PV.`,
      );
    }
    const lback = has('lateBack');
    if (lback && role !== 'JUNGLE') {
      add('early', 2, `Early : ${who}${tag(lback.fact)} rentre tard : rentrez avant lui sur une vague poussée et revenez avec l'avantage d'objets avant ${clock(lback.at!)}.`);
    } else if (lback) {
      add('early', 2, `Early : ${who}${tag(lback.fact)} rentre tard : envahissez sa jungle pendant son retour (vers ${clock(lback.at!)}).`);
    }
    const eback = has('earlyBack');
    if (eback) add('early', 2, `Early : ${who}${tag(eback.fact)} rentre tôt : poussez la vague sous sa tour avant ${clock(eback.at!)} pour lui faire perdre or et XP.`);
    const lgank = has('lateGank');
    if (lgank) add('early', 2, `Early : ${who}${tag(lgank.fact)} farme sa jungle : jouez agressif en lane avant ${clockBefore(lgank.at!)} et contestez ses camps.`);
    const edeath = has('earlyDeaths');
    if (edeath) {
      add(
        'early',
        2,
        role === 'JUNGLE'
          ? `Early : ${who}${tag(edeath.fact)} se met souvent en danger : envahissez sa jungle avant 10:00 avec vos lanes prioritaires.`
          : `Early : ${who}${tag(edeath.fact)} se met souvent en danger : jouez autour de sa lane avant 10:00.`,
      );
    }
    const eact = has('earlyActive');
    if (eact && role === 'JUNGLE') add('early', 3, `Early : ${who}${tag(eact.fact)} est très actif : gardez des balises dans la rivière jusqu'à 10:00.`);
    const fb = has('firstBlood');
    if (fb && role === 'JUNGLE') add('early', 0, `Early : ${who}${tag(fb.fact)} envahit souvent : wardez votre jungle à 2:30.`);
    else if (fb) add('early', 1, `Early : ${who}${tag(fb.fact)} cherche le kill tôt : respectez ses niveaux 2 et 3.`);
    const solo = has('solo');
    if (solo && role !== 'SUPPORT') add('early', 1, `Early : ${who}${tag(solo.fact)} gagne ses duels : jouez sous votre tour et appelez votre jungler.`);
    const lh = has('leadHigh');
    if (lh && !solo && role !== 'JUNGLE') add('early', 2, `Early : ${who}${tag(lh.fact)} gagne souvent sa lane : évitez les échanges longs.`);
    const ll = has('leadLow');
    if (ll && role !== 'JUNGLE' && role !== 'SUPPORT') add('early', 2, `Early : ${who}${tag(ll.fact)} perd souvent sa lane : jouez agressif pour creuser l'écart.`);
    if (ot && k.champion && ot.champion === k.champion) {
      add('early', 3, `Early : ${who} est un spécialiste de ${champ} (${otEvidence(ot)}) : ne sous-estimez pas ses pics de puissance.`);
    }
    const vl = has('visionLow');
    if (vl) add('mid', 0, `Mid : ${who}${tag(vl.fact)} warde peu : tendez des embuscades sur son chemin.`);
    const tw = has('turrets');
    if (tw) add('mid', 1, `Mid : ${who}${tag(tw.fact)} pousse en side : gardez de la vision sur sa lane avant chaque objectif.`);
    const vh = has('visionHigh');
    if (vh && (role === 'SUPPORT' || role === 'JUNGLE')) {
      add('mid', 2, `Mid : ${who}${tag(vh.fact)} contrôle la vision : nettoyez ses wards avant les objectifs.`);
    }
    const kh = has('kpHigh');
    if (kh && role !== 'SUPPORT') add('mid', 3, `Mid : ${who}${tag(kh.fact)} suit tous les combats : ne vous battez pas en infériorité numérique.`);
    const dh = has('deathsHigh');
    if (dh) add('late', 0, `Late : ${who}${tag(dh.fact)} se place souvent mal : ciblez-le en premier.`);
    const dmg = has('damage');
    if (dmg) add('late', 1, `Late : ${who}${tag(dmg.fact)} porte leur équipe : gardez vos contrôles pour lui.`);
    const kl = has('kpLow');
    if (kl && role !== 'SUPPORT') add('late', 2, `Late : ${who}${tag(kl.fact)} rejoint peu les combats : forcez les objectifs quand il est en side.`);
  });
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const out: PhaseAttention[] = [];
  const count = [0, 0, 0];
  for (const [ph, , , p] of rows) {
    if (count[ph] >= 3) continue;
    count[ph] += 1;
    out.push(p);
  }
  return out;
}

/** Role label used in sentences ("Mid", "ADC"...). */
export function roleLabel(r: Role | null | undefined): string {
  return r ? ROLE_LABELS[r] : '';
}

// --------------------------------------------------------------------------- matchup plan

/**
 * Enemy players of a matchup plan (game started / revealed): every profile is matched to an enemy pick
 * (its champion, else its explicit role, else a champion clearly in exactly one pool), then gets an
 * insight; the attention points follow the phases.
 */
export function matchupEnemies(
  ally: readonly { champion_id: string }[],
  enemy: readonly { champion_id: string; role?: Role | null }[],
  profiles: readonly EnemyPlayerProfile[],
  catalog: Catalog,
): { players: EnemyPlayerInsight[]; attention: PhaseAttention[] } {
  const views = enemyViews(profiles, catalog);
  const slots: EnemySlotIn[] = enemy.map((p, idx) => ({
    idx,
    champ: catalog.resolve(p.champion_id),
    role: validRole(p.role) ? p.role : null,
    puuid: null,
  }));
  const links = linkProfiles(views, slots, catalog);
  const used = new Set(links.values());
  for (const v of views) {
    if (links.has(v.idx) || !v.explicitRole) continue;
    if (v.prof.champion_id && catalog.resolve(v.prof.champion_id)) continue;
    const s = slots.find((x) => x.role === v.explicitRole && !used.has(x.idx));
    if (s) {
      links.set(v.idx, s.idx);
      used.add(s.idx);
    }
  }
  // then the declared Clash position (players without an explicit role)
  for (const v of views) {
    if (links.has(v.idx) || v.explicitRole || !v.clashRole) continue;
    if (v.prof.champion_id && catalog.resolve(v.prof.champion_id)) continue;
    const s = slots.find((x) => x.role === v.clashRole && !used.has(x.idx));
    if (s) {
      links.set(v.idx, s.idx);
      used.add(s.idx);
    }
  }
  const excluded = new Set<string>();
  for (const p of [...ally, ...enemy]) {
    const c = catalog.resolve(p.champion_id);
    if (c) excluded.add(c);
  }
  const known: KnownEnemy[] = views.map((v) => {
    const si = links.get(v.idx);
    if (si !== undefined) return { view: v, champion: slots[si].champ, role: slots[si].role ?? v.explicitRole ?? v.clashRole };
    const pc = v.prof.champion_id ? catalog.resolve(v.prof.champion_id) : null;
    return { view: v, champion: pc, role: v.explicitRole ?? v.mainRole };
  });
  const players = known.map((k) => enemyInsight(k.view, { champion: k.champion, role: k.role, excluded, bansOpen: false }, catalog));
  return { players, attention: phaseAttention(known, catalog) };
}
