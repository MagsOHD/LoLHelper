// Likely enemy picks for the roles they have not shown yet, and the blind-pick evaluation built on them.
//
// Generic distribution of a role R (champions neither banned nor picked by either team):
//   base   = meta games of (champion, R) when the meta snapshot is usable (pick rate in that role),
//            else curated roles: 1 for the champion's main role, 0.5 / 0.3 / 0.2 for the next ones;
//   × (1 + PRED_LANE_BOOST × max(0, v) × conf)  when our laner in R is locked: v = (smoothed meta duel
//            winrate of the champion vs our laner − 50 %) / 10 %, clamped −1..1, conf = games / (games + 30);
//   × (1 + PRED_TEAM_BOOST × max(0, Δ))          when we have locked picks: Δ = how much better the champion
//            answers our locked lineup than an average champion (trait counter score, enemy point of view).
// Likelihood = weight / sum of the role's weights. A known enemy player (scouted / revealed) holding R mixes
// in their pool: 0.75 × pool share (poolWeights) + 0.25 × generic likelihood; candidates driven by the pool
// carry the player's puuid.
import type { EnemyRoleCandidate, MetaStats, Role } from '../api/types';
import { counterDetails, counterScore } from './analysis';
import { placeholderData, type Catalog, type ChampData } from './catalog';
import { poolEvidence, poolWeights, sortedWeights, type EnemyView } from './enemies';
import { LANE_META_PRIOR, metaMatchup, smoothedRate } from './meta';
import { cmpNum, cmpStr, pyRound } from './pycompat';
import { ROLE_LABELS } from './tables';

export const PRED_LANE_BOOST = 1.0;
export const PRED_TEAM_BOOST = 2.0;
/** Share of a known player's pool in the likelihood of their role. */
export const PRED_PLAYER_MASS = 0.75;
const ROLE_POS_W = [1, 0.5, 0.3, 0.2, 0.2];
/** Candidates kept internally per role (blind evaluation), and shown. */
export const PRED_KEEP = 8;
export const PRED_SHOW = 5;
/** Minimum meta duel games before a duel is cited. */
const CITE_DUEL_MIN = 30;
/** Duel winrate deviation mapped to −1..1 (50 % ± 10 %). */
const DUEL_SPAN = 0.1;

const NEUTRAL = placeholderData('\u0000neutral');

const COUNTER_US: Record<string, string> = {
  dive: 'répond bien à votre dive',
  poke: 'répond bien à votre poke',
  engage: 'répond bien à votre engage',
  split: 'répond bien à votre split push',
  pick: 'résiste bien à vos picks',
  frontline: 'perce bien votre frontline',
  early: 'tient bien face à votre early',
  late: 'punit votre compo qui veut scaler',
};

export interface PredCand extends EnemyRoleCandidate {
  champion_id: string;
  likelihood: number;
}

export interface PredictArgs {
  catalog: Catalog;
  meta: MetaStats | null;
  roles: readonly Role[];
  /** banned + picked by either team */
  excluded: ReadonlySet<string>;
  /** our locked picks with their roles */
  ours: readonly { role: Role; champ: ChampData }[];
  /** enemy champions already picked */
  theirs: readonly ChampData[];
  /** known enemy player holding each role */
  players: ReadonlyMap<Role, EnemyView>;
}

/** -1..1 duel value of `a` vs `b` in `role` (meta, smoothed) and its confidence (games / (games + 30)). */
export function duelValue(meta: MetaStats | null, role: Role, a: string, b: string): [number, number, [number, number] | null] {
  if (!meta) return [0, 0, null];
  const m = metaMatchup(meta, role, a, b);
  if (!m) return [0, 0, null];
  const wr = smoothedRate(m[1], m[0], LANE_META_PRIOR);
  const v = Math.max(-1, Math.min(1, (wr - 0.5) / DUEL_SPAN));
  return [v, m[0] / (m[0] + LANE_META_PRIOR), m];
}

const cap = (s: string): string => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

/** Likely picks per role (best first, PRED_KEEP per role; callers show PRED_SHOW). Deterministic. */
export function predictRoles(a: PredictArgs): Map<Role, PredCand[]> {
  const out = new Map<Role, PredCand[]>();
  const { catalog, meta } = a;
  const ourChamps = a.ours.map((o) => o.champ);
  const baseCounter = ourChamps.length ? counterScore([...a.theirs, NEUTRAL], ourChamps) : 0;
  const avgLines = ourChamps.length ? new Map(counterDetails([...a.theirs, NEUTRAL], ourChamps).map((l) => [l.key, l.answer])) : null;
  const all = catalog.allData();
  for (const role of a.roles) {
    const laner = a.ours.find((o) => o.role === role)?.champ ?? null;
    let metaTotal = 0;
    if (meta) for (const c of all) metaTotal += Math.max(0, meta.champions[c.id]?.[role]?.[0] ?? 0);
    const useMeta = !!meta && metaTotal > 0;
    const rows: { c: ChampData; w: number; why: string[] }[] = [];
    for (const c of all) {
      if (a.excluded.has(c.id)) continue;
      let base = 0;
      const why: string[] = [];
      if (useMeta) {
        const g = Math.max(0, meta!.champions[c.id]?.[role]?.[0] ?? 0);
        if (!(g > 0)) continue;
        base = g;
        const share = g / Math.max(1, meta!.games);
        const p = pyRound(100 * share);
        why.push(p >= 1 ? `${p >= 5 ? 'très joué' : 'joué'} en ${ROLE_LABELS[role]} sur ce patch (${p} % des parties)` : `joué en ${ROLE_LABELS[role]} sur ce patch`);
      } else {
        const i = c.roles.indexOf(role);
        if (i < 0) continue;
        base = ROLE_POS_W[Math.min(i, ROLE_POS_W.length - 1)];
        why.push(i === 0 ? `champion habituel en ${ROLE_LABELS[role]}` : `peut aussi être joué en ${ROLE_LABELS[role]}`);
      }
      let f = 1;
      if (laner) {
        const [v, conf, m] = duelValue(meta, role, c.id, laner.id);
        if (v > 0) {
          f *= 1 + PRED_LANE_BOOST * v * conf;
          if (m && m[0] >= CITE_DUEL_MIN && v * conf >= 0.15) {
            why.push(`bat ${laner.name} dans ${pyRound((100 * m[1]) / m[0])} % des duels sur ce patch`);
          }
        }
      }
      if (ourChamps.length) {
        const delta = counterScore([...a.theirs, c], ourChamps) - baseCounter;
        if (delta > 0) {
          f *= 1 + PRED_TEAM_BOOST * delta;
          if (delta >= 0.03 && avgLines && ourChamps.length >= 2) {
            let bestKey: string | null = null;
            let bestGain = 0.08;
            for (const l of counterDetails([...a.theirs, c], ourChamps)) {
              const gain = (l.answer - (avgLines.get(l.key) ?? 0)) * (l.threat + 0.05);
              if (l.threat >= 0.4 && gain > bestGain) {
                bestGain = gain;
                bestKey = l.key;
              }
            }
            if (bestKey) why.push(COUNTER_US[bestKey]);
          }
        }
      }
      rows.push({ c, w: base * f, why });
    }
    let total = 0;
    for (const r of rows) total += r.w;
    const generic = new Map<string, { l: number; why: string[] }>();
    for (const r of rows) generic.set(r.c.id, { l: total > 0 ? r.w / total : 0, why: r.why });
    // known player's pool
    const pl = a.players.get(role);
    const pw = pl ? poolWeights(pl, role, a.excluded, catalog) : new Map<string, number>();
    let pTot = 0;
    for (const v of pw.values()) pTot += v;
    const mass = pTot > 0 ? PRED_PLAYER_MASS : 0;
    const topPool = pTot > 0 ? sortedWeights(pw)[0][0] : null;
    const ids = new Set<string>([...generic.keys(), ...pw.keys()]);
    const cands: PredCand[] = [];
    for (const cid of ids) {
      const g = generic.get(cid);
      const gl = (1 - mass) * (g?.l ?? 0);
      const pq = mass > 0 ? (mass * (pw.get(cid) ?? 0)) / pTot : 0;
      const l = gl + pq;
      if (!(l > 0)) continue;
      const fromPlayer = pq > 0 && pq >= gl;
      let why: string;
      if (fromPlayer) {
        const ev = poolEvidence(pl!, cid);
        why = `${cid === topPool ? 'Champion principal de ce joueur' : 'Dans le pool de ce joueur'}${ev ? ` (${ev})` : ''}`;
        const extra = g?.why.slice(1) ?? [];
        if (extra.length) why += `, ${extra[0]}`;
      } else {
        why = cap((g?.why ?? []).slice(0, 2).join(', '));
      }
      cands.push({ champion_id: cid, likelihood: l, why, ...(fromPlayer ? { player_puuid: pl!.puuid } : {}) });
    }
    cands.sort((x, y) => cmpNum(y.likelihood, x.likelihood) || cmpStr(x.champion_id, y.champion_id));
    out.set(role, cands.slice(0, PRED_KEEP));
  }
  return out;
}

// --------------------------------------------------------------------------- blind evaluation

export interface BlindEval {
  /** likelihood-weighted mean duel value (−1..1, confidence-weighted) against the likely candidates */
  expected: number;
  /** worst duel value among candidates of likelihood ≥ BLIND_WORST_MIN (≤ 0, 0 when none is bad) */
  worst: number;
  worstOpp: string | null;
  /** meta duel [games, wins] of the worst one, when the meta gave it */
  worstDuel: [number, number] | null;
  worstFromHistory: boolean;
  /** share of the likelihood with duel data */
  coverage: number;
  /** candidates we beat (e ≥ 0.25), best first */
  beats: string[];
}

/** Candidates below this relative likelihood do not define the worst case. */
export const BLIND_WORST_MIN = 0.08;

/**
 * Blind pick value of `champ` in `role` against the predicted candidates: per candidate
 * e = conf_meta × v_meta + 0.5 × conf_hist × v_hist (v = duel value −1..1, own history: smoothed winrate
 * (prior 2) − 50 % over 25 %, conf = games / (games + 3)), clamped −1..1.
 */
export function blindEval(
  meta: MetaStats | null,
  role: Role,
  champ: string,
  preds: readonly PredCand[],
  hist: ((opp: string) => [number, number] | null) | null,
): BlindEval {
  let sum = 0;
  let wsum = 0;
  let cov = 0;
  let worst = 0;
  let worstOpp: string | null = null;
  let worstDuel: [number, number] | null = null;
  let worstFromHistory = false;
  const beats: [number, string][] = [];
  let ltot = 0;
  for (const p of preds) ltot += p.likelihood;
  if (!(ltot > 0)) return { expected: 0, worst: 0, worstOpp: null, worstDuel: null, worstFromHistory: false, coverage: 0, beats: [] };
  for (const p of preds) {
    if (p.champion_id === champ) continue;
    const [v, conf, m] = duelValue(meta, role, champ, p.champion_id);
    let e = v * conf;
    let any = m !== null;
    let fromHist = false;
    const h = hist ? hist(p.champion_id) : null;
    if (h && h[0] > 0) {
      const hv = Math.max(-1, Math.min(1, (smoothedRate(h[1], h[0], 2) - 0.5) / 0.25));
      const hc = h[0] / (h[0] + 3);
      e += 0.5 * hv * hc;
      any = true;
      fromHist = Math.abs(0.5 * hv * hc) > Math.abs(v * conf);
    }
    e = Math.max(-1, Math.min(1, e));
    const rel = p.likelihood / ltot;
    sum += rel * e;
    wsum += rel;
    if (any) cov += rel;
    if (rel >= BLIND_WORST_MIN && e < worst - 1e-12) {
      worst = e;
      worstOpp = p.champion_id;
      worstDuel = m;
      worstFromHistory = fromHist;
    }
    if (e >= 0.25) beats.push([e, p.champion_id]);
  }
  beats.sort((x, y) => cmpNum(y[0], x[0]) || cmpStr(x[1], y[1]));
  return {
    expected: wsum > 0 ? sum / wsum : 0,
    worst,
    worstOpp,
    worstDuel,
    worstFromHistory,
    coverage: cov,
    beats: beats.map(([, c]) => c),
  };
}
