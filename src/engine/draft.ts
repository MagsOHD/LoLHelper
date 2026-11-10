// Live draft advice: per-friend pick recommendations, ban advice and a read of the (partial) enemy team.
//
// Approach: the draft is turned into a generator context (`prepare`): friends are players (slot role or
// assigned role forced, locked champion as a locked pick), unknown teammates with a locked champion become
// pseudo-players without history (they count for balance/synergy/counters, never for duos), bans and
// every picked champion are excluded, enemy picks (explicit roles kept, others guessed) give the lane
// opponents. Each candidate of a friend is then scored on the partial lineup "locked allies + candidate"
// against the known enemies with the generator's own terms and weights (comfort, desire, form, meta,
// counter incl. meta lane duels and lane_history, duo synergy, theme fit and balance). Differences with a
// full generation, all deliberate:
//   - individual terms (comfort, desire, meta, form) are the candidate's own, not diluted by the lineup
//     mean (other picks are fixed, only this choice moves);
//   - team terms (best playstyle fit, balance) are weighted by how complete the lineup is ((locked + 1) / 5):
//     a first pick should not be told to play a tank because a lone tank "balances" a lineup of one;
//   - the counter part weighs 0.15 instead of 0.12 and the candidate's own lane duel (meta duel + own
//     lane history, the generator's laneVal / laneW) adds a direct bonus (DRAFT_W_LANE): enemy picks are
//     certain here and counter-picking is the point of draft advice.
// Running a constrained generation per friend and aggregating was considered: it explores joint choices of
// the friends still to pick, but gives 5 lineups (too few distinct options per friend), costs ~100× more
// and cannot represent unknown teammates. Friends still to pick are independent here (hovers excluded).
import type {
  BanAdvice,
  DamageType,
  DraftAdvice,
  DraftEnemyAccount,
  DraftInput,
  EngineContext,
  EnemyDraftAnalysis,
  MasteryEntry,
  MetaStats,
  Pick,
  PickRecommendation,
  PlayerInput,
  PlayerPickAdvice,
  Rank,
  Role,
  ThreatInfo,
} from '../api/types';
import { apShare, counterDetails, counterScore, joinNames, SQUISHY_CARRY_ARCHES, teamSums, topBy, viability } from './analysis';
import {
  archetypeLabel,
  DAMAGE_ARCHETYPES,
  placeholderData,
  TRAIT_INDEX as I,
  TRAITS,
  type Catalog,
  type ChampData,
} from './catalog';
import {
  fmtPoints,
  makeCand,
  normOptions,
  normPlayer,
  poolReasons,
  prepare,
  roleFitOf,
  ROLE_ORDER,
  W_DUO,
  W_FORM,
  W_META,
  type Cand,
  type Ctx,
  type NormPlayer,
  type Player,
} from './generator';
import {
  guessEnemyRoles,
  historyLaneEdge,
  laneHistory,
  LANE_META_PRIOR,
  metaLaneEdge,
  metaMatchup,
  metaPickValue,
  metaUsable,
  smoothedRate,
} from './meta';
import { banThreatScores, buildMatchupPlanRaw, damageProfileOf, describeThreat } from './plans';
import { cmpNum, cmpStr, pyRound } from './pycompat';
import { COUNTER_FR, FAMOUS_COMBOS, ROLE_LABELS, TRAIT_FR } from './tables';
import { allThemes } from './themes';

// --------------------------------------------------------------------------- constants

/** Weight of the team counter part (traits + lane shifts, as in generation, where it is 0.12). */
export const DRAFT_W_COUNTER = 0.15;
/**
 * Added to the score: DRAFT_W_LANE × the candidate's own lane duel edge (2 × laneVal − 1, meta duel + own
 * lane history) × its confidence (laneW / 0.15, capped at 1). A 60 % duel over thousands of games ≈ +0.08,
 * i.e. about as much as 30 points of comfort: the direct lane counter is what a draft pick is about.
 */
export const DRAFT_W_LANE = 0.08;
const LANE_CONF_FULL = 0.15;
/** Below this comfort a champion is a "discovery" (not a known champion), unless wanted or hovered. */
export const DRAFT_KNOWN_COMFORT = 0.15;
/** Recommendations per friend: at least 3, at most 5 (the last one may be a discovery). */
const MIN_PICKS = 3;
const MAX_PICKS = 5;
/** Non-pool champions per role pre-selected (by meta value and lane duel) as discovery candidates. */
const DISCOVERY_EXTRAS = 6;
/** A discovery is only proposed when its score is within this margin of the last known pick. */
const DISCOVERY_MARGIN = 0.12;
/** Lane duel value (0..1, 0.5 = neutral) / meta value from which a discovery is "relevant". */
const DISCOVERY_LANE_VAL = 0.7;
const DISCOVERY_META = 0.65;
/** Role assignment: role fit + this × best comfort in the role (+ hover bonus when the hover plays it). */
const ROLE_POOL_BONUS = 0.15;
const ROLE_HOVER_BONUS = 0.3;
/** Minimum meta duel games before a duel is cited in a reason. */
const REASON_DUEL_MIN = 30;
/** Minimum meta role games before a winrate is cited. */
const REASON_META_MIN = 50;

// Ban advice: 0.5 counters to our likely picks, 0.3 meta strength/presence, 0.2 trait threat to our lineup.
const BAN_W_COUNTER = 0.5;
const BAN_W_META = 0.3;
const BAN_W_TRAIT = 0.2;
/** Lane edge (our side, -1..1) at which the counter part saturates (≈ 46 % smoothed winrate). */
const BAN_COUNTER_FULL = 0.15;
/** Champion with no role left open on the enemy side: they can hardly pick it any more. */
const BAN_CLOSED_FACTOR = 0.2;
const BAN_LIMIT = 3;

/** Enemy accounts (game started): mastery points on their champion. */
export const ONE_TRICK_POINTS = 200_000;
const HIGH_MASTERY_POINTS = 50_000;
const LOW_MASTERY_POINTS = 10_000;
const HIGH_TIERS: ReadonlySet<string> = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const TIER_FR: Record<string, string> = {
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

const PLAYSTYLES = allThemes().filter((t) => !t.thematic);
/** Average champion (every trait at 1) used as the reference for "good answer" reasons. */
const NEUTRAL = placeholderData('\u0000neutral');
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

const BAN_TRAIT_WHY: Record<string, string> = {
  dive: 'Plonge facilement sur vos carries fragiles',
  poke: "Sa poke punit une compo qui manque d'engage",
  pick: 'Attrape facilement un joueur isolé',
  engage: 'Engage dévastateur face à une compo qui protège peu',
  split: 'Split push difficile à contenir pour votre compo',
  early: 'Très fort tôt alors que votre compo a besoin de temps',
  late: 'Scale mieux que votre compo, qui veut finir vite',
  generic: 'Champion polyvalent et dangereux',
};

// --------------------------------------------------------------------------- draft normalisation

interface AllySlot {
  idx: number;
  friend: PlayerInput | null;
  champ: string | null; // resolved champion id
  locked: boolean;
  role: Role | null; // explicit (slot) role
}

interface EnemyPickIn {
  champion_id: string;
  role: Role | null;
}

function allySlots(players: PlayerInput[], draft: DraftInput, catalog: Catalog): AllySlot[] {
  const byId = new Map<string, PlayerInput>();
  for (const p of players) if (p && p.player_id && !byId.has(p.player_id)) byId.set(p.player_id, p);
  const seen = new Set<string>();
  const usedRoles = new Set<Role>();
  return (draft.ally ?? []).slice(0, 5).map((s, idx) => {
    const pid = s?.player_id ?? null;
    let friend: PlayerInput | null = null;
    if (pid && byId.has(pid) && !seen.has(pid)) {
      friend = byId.get(pid)!;
      seen.add(pid);
    }
    let role = s?.role && ROLE_ORDER.includes(s.role) ? s.role : null;
    if (role && usedRoles.has(role)) role = null; // two slots on one role: the first one keeps it
    if (role) usedRoles.add(role);
    const champ = s?.champion_id ? catalog.resolve(s.champion_id) : null;
    return { idx, friend, champ, locked: !!s?.locked && champ !== null, role };
  });
}

function enemyPicks(draft: DraftInput, catalog: Catalog): EnemyPickIn[] {
  const out: EnemyPickIn[] = [];
  const seen = new Set<string>();
  const usedRoles = new Set<Role>();
  for (const s of (draft.enemy ?? []).slice(0, 5)) {
    const cid = s?.champion_id ? catalog.resolve(s.champion_id) : null;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    let role = s.role && ROLE_ORDER.includes(s.role) ? s.role : null;
    if (role && usedRoles.has(role)) role = null;
    if (role) usedRoles.add(role);
    out.push({ champion_id: cid, role });
  }
  const guessed = guessEnemyRoles(out, catalog);
  return out.map((e, i) => ({ champion_id: e.champion_id, role: guessed[i] }));
}

// --------------------------------------------------------------------------- roles

function bestComfortIn(p: NormPlayer, role: Role, catalog: Catalog): number {
  let best = 0;
  for (const e of p.pool) {
    const d = catalog.data(e.champion_id);
    if (d && d.roles.includes(role)) best = Math.max(best, e.comfort);
  }
  return best;
}

/**
 * Role of every slot: explicit slot roles first; locked champions without a role take their first catalog
 * role still free (a friend's flex champion: the role they prefer); friends still to pick share the free
 * roles (exhaustive search, max total fit, deterministic tie-break). `null` when no role is left.
 */
export function assignDraftRoles(slots: readonly AllySlot[], catalog: Catalog): (Role | null)[] {
  const roles: (Role | null)[] = slots.map((s) => s.role);
  const taken = new Set<Role>();
  for (const r of roles) if (r) taken.add(r);
  for (const s of slots) {
    if (roles[s.idx] || !s.locked || !s.champ) continue;
    const d = catalog.data(s.champ);
    let cands = (d?.roles ?? []).filter((r) => !taken.has(r));
    if (s.friend && cands.length > 1) {
      const fit = roleFitOf(normPlayer(s.friend), null);
      cands = [...cands].sort((a, b) => cmpNum(fit[b], fit[a]));
    }
    for (const r of ROLE_ORDER) if (!taken.has(r) && !cands.includes(r)) cands.push(r);
    const r = cands[0] ?? null;
    roles[s.idx] = r;
    if (r) taken.add(r);
  }
  const open = slots.filter((s) => s.friend && !s.locked && !roles[s.idx]);
  if (!open.length) return roles;
  const free = ROLE_ORDER.filter((r) => !taken.has(r));
  const fits = open.map((s) => {
    const np = normPlayer(s.friend!);
    const fit = roleFitOf(np, null);
    const hover = s.champ ? catalog.data(s.champ) : undefined;
    const out = {} as Record<Role, number>;
    for (const r of free) {
      out[r] = fit[r] + ROLE_POOL_BONUS * bestComfortIn(np, r, catalog) + (hover?.roles.includes(r) ? ROLE_HOVER_BONUS : 0);
    }
    return out;
  });
  let best: (Role | null)[] = open.map(() => null);
  let bestScore = -1;
  const cur: (Role | null)[] = [];
  const used = new Set<Role>();
  const rec = (i: number, acc: number): void => {
    if (i === open.length) {
      if (acc > bestScore + 1e-9) {
        bestScore = acc;
        best = [...cur];
      }
      return;
    }
    let any = false;
    for (const r of free) {
      if (used.has(r)) continue;
      any = true;
      used.add(r);
      cur.push(r);
      rec(i + 1, acc + fits[i][r]);
      cur.pop();
      used.delete(r);
    }
    if (!any) {
      cur.push(null);
      rec(i + 1, acc);
      cur.pop();
    }
  };
  rec(0, 0);
  open.forEach((s, i) => (roles[s.idx] = best[i]));
  return roles;
}

// --------------------------------------------------------------------------- pick scoring

interface Scored {
  cand: Cand;
  score: number;
  discovery: boolean;
  hover: boolean;
}

function laneShift(picks: readonly Cand[]): number {
  let shift = 0;
  for (const c of picks) if (c.laneW > 0) shift += c.laneW * (2 * c.laneVal - 1);
  return shift;
}

function duoValue(ctx: Ctx, cand: Cand, other: Cand): number {
  return ctx.duo?.[cand.pidx]?.[other.pidx]?.get(cand.champ.id)?.get(other.champ.id) ?? 0;
}

/**
 * Score (≈ 0..1) of `cand` added to the locked allies `fixed`, with the generator's terms: individual
 * terms of the candidate, team terms of the partial lineup (weighted by its completeness), counter vs the
 * known enemies (traits + lane duels), form and duo bonuses.
 */
export function scoreDraftPick(ctx: Ctx, cand: Cand, fixed: readonly Cand[]): number {
  const lineup = [...fixed, cand];
  const champs = lineup.map((c) => c.champ);
  const sums = teamSums(champs);
  const tw = Math.min(1, lineup.length / 5);
  let fit = 0;
  for (const t of PLAYSTYLES) fit = Math.max(fit, t.fit(champs, sums));
  const bal = viability(champs, sums);
  let total = ctx.wComfort * cand.scorePart + ctx.wDesire * cand.desire + tw * (ctx.wTheme * fit + ctx.wBalance * bal);
  let weights = ctx.wComfort + ctx.wDesire + tw * (ctx.wTheme + ctx.wBalance);
  if (ctx.enemy.length) {
    let cnt = counterScore(champs, ctx.enemy);
    if (ctx.laneOn) {
      const shift = laneShift(lineup);
      if (shift !== 0) cnt = clamp01(cnt + shift);
    }
    total += DRAFT_W_COUNTER * cnt;
    weights += DRAFT_W_COUNTER;
  }
  if (ctx.meta) {
    total += W_META * cand.meta;
    weights += W_META;
  }
  let score = total / weights;
  if (cand.laneW > 0) score += DRAFT_W_LANE * (2 * cand.laneVal - 1) * Math.min(1, cand.laneW / LANE_CONF_FULL);
  if (ctx.formOn) score += W_FORM * cand.formPart;
  if (ctx.duo) {
    let d = 0;
    for (const f of fixed) d += duoValue(ctx, cand, f);
    if (d !== 0) score += W_DUO * Math.max(-1, Math.min(1, d));
  }
  return score;
}

// --------------------------------------------------------------------------- reasons

function metaRoleStat(meta: MetaStats, cid: string, role: Role): [number, number] | null {
  const v = meta.champions[cid]?.[role];
  if (!v || !(v[0] > 0)) return null;
  return [v[0], Math.max(0, Math.min(v[0], v[1] || 0))];
}

function friendName(ctx: Ctx, pidx: number): string {
  return ctx.players[pidx].inp.name || ctx.players[pidx].inp.player_id;
}

function pickReasons(ctx: Ctx, s: Scored, fixed: readonly Cand[], friends: ReadonlySet<number>): string[] {
  const c = s.cand;
  const pl = ctx.players[c.pidx];
  const d = c.champ;
  const out: string[] = [];
  if (s.hover) out.push('Ton choix actuel (survol)');
  out.push(...poolReasons(ctx, c).slice(0, 2));
  const opp = ctx.enemyRole.get(c.role);
  const oppName = opp ? ctx.catalog.name(opp) : '';
  let laneFav = false;
  // lane duel (meta, then the player's own games)
  const lane: string[] = [];
  if (opp && ctx.meta) {
    const m = metaMatchup(ctx.meta, c.role, d.id, opp);
    if (m && m[0] >= REASON_DUEL_MIN) {
      const wr = smoothedRate(m[1], m[0], LANE_META_PRIOR);
      const pct = pyRound((100 * m[1]) / m[0]);
      if (wr >= 0.52) {
        lane.push(`Bon contre ${oppName} (duel favorable sur ce patch, ${pct} %)`);
        laneFav = true;
      } else if (wr <= 0.48) {
        lane.push(`Duel difficile contre ${oppName} sur ce patch (${pct} %)`);
      }
    }
  }
  if (opp) {
    const h = laneHistory(pl.inp, d.id, opp, (id) => ctx.catalog.resolve(id));
    if (h && h[0] >= 2) {
      const [g, w] = h;
      if (w / g >= 0.6) {
        lane.push(`Tu gagnes souvent ce duel contre ${oppName} (${w} victoire${w > 1 ? 's' : ''} sur ${g})`);
        laneFav = true;
      } else if (w / g <= 0.34) {
        lane.push(`Tu perds souvent ce duel contre ${oppName} (${w} victoire${w > 1 ? 's' : ''} sur ${g})`);
      }
    }
  }
  if (s.discovery) {
    out.push(
      laneFav
        ? 'Peu joué, mais un vrai contre dans ce duel'
        : c.meta >= DISCOVERY_META
          ? 'Peu joué, mais très fort sur ce patch'
          : 'Peu joué : une option si tes champions sont pris',
    );
  }
  out.push(...lane);
  // team answer to the enemy lineup, compared with an average champion in this slot
  if (ctx.enemy.length) {
    const others = fixed.map((x) => x.champ);
    const avg = new Map(counterDetails([...others, NEUTRAL], ctx.enemy).map((l) => [l.key, l.answer]));
    const after = counterDetails([...others, d], ctx.enemy).sort(
      (a, b) => cmpNum(b.threat, a.threat) || cmpStr(a.key, b.key),
    );
    for (const l of after) {
      if (l.threat >= 0.5 && l.answer >= 0.6 && l.answer - (avg.get(l.key) ?? 0) >= 0.1) {
        out.push(`Bonne réponse ${COUNTER_FR[l.key]}`);
        break;
      }
    }
  }
  // synergy with the locked allies
  const F = fixed.map((x) => x.champ);
  const syn: string[] = [];
  if (F.length) {
    let maxFront = 0;
    for (const x of F) maxFront = Math.max(maxFront, x.t.frontline);
    if (maxFront < 2 && d.t.frontline >= 2) syn.push('Complète la frontline');
    if (!F.some((x) => x.t.engage >= 3) && d.t.engage >= 3) syn.push("Apporte l'engage qui manque");
    const carries = F.filter((x) => x.t.late >= 3 && SQUISHY_CARRY_ARCHES.has(x.archetype));
    if (carries.length && !F.some((x) => x.t.peel >= 3) && d.t.peel >= 3) syn.push(`Peut protéger ${carries[0].name}`);
    for (const [a, b] of FAMOUS_COMBOS) {
      const other = d.id === a ? b : d.id === b ? a : null;
      const mate = other ? F.find((x) => x.id === other) : undefined;
      if (mate) {
        syn.push(`Combo connu avec ${mate.name}`);
        break;
      }
    }
    for (const f of fixed) {
      if (!friends.has(f.pidx)) continue;
      const v = duoValue(ctx, c, f);
      if (v >= 0.15) syn.push(`Duo qui gagne souvent avec ${friendName(ctx, f.pidx)} (${f.champ.name})`);
      else if (v <= -0.15) syn.push(`Duo qui perd souvent avec ${friendName(ctx, f.pidx)} (${f.champ.name})`);
    }
    if (F.length >= 2) {
      const share = apShare(F);
      if (share <= 0.25 && d.damage === 'AP') syn.push('Apporte les dégâts magiques qui manquent');
      else if (share >= 0.75 && d.damage === 'AD') syn.push('Apporte les dégâts physiques qui manquent');
      else if (F.length >= 3 && share <= 0.25 && d.damage === 'AD') syn.push('Attention : encore des dégâts physiques');
      else if (F.length >= 3 && share >= 0.75 && d.damage === 'AP') syn.push('Attention : encore des dégâts magiques');
    }
  }
  out.push(...syn.slice(0, 2));
  if (ctx.meta) {
    const st = metaRoleStat(ctx.meta, d.id, c.role);
    if (st && st[0] >= REASON_META_MIN) {
      const pct = pyRound((100 * st[1]) / st[0]);
      if (c.meta >= 0.62) out.push(`Fort sur ce patch (${pct} % de victoires en ${ROLE_LABELS[c.role]})`);
      else if (c.meta <= 0.3) out.push(`En difficulté sur ce patch (${pct} % de victoires)`);
    }
  }
  if (ctx.formOn) {
    if (c.formPart >= 0.3) out.push('En forme sur ce champion');
    else if (c.formPart <= -0.3) out.push('Série difficile sur ce champion');
  }
  if (out.length < 2) {
    // what the champion brings that the locked allies lack most
    const sums = teamSums(F);
    let bestT: number | null = null;
    let bestV = 0;
    TRAITS.forEach((_, i) => {
      if (d.traits[i] < 2) return;
      const v = d.traits[i] - sums[i] / Math.max(1, F.length);
      if (v > bestV) {
        bestV = v;
        bestT = i;
      }
    });
    if (bestT !== null) out.push(`Apporte ${TRAIT_FR[TRAITS[bestT]]} à la compo`);
  }
  return out.slice(0, 5);
}

// --------------------------------------------------------------------------- per-friend picks

function pickAdvice(
  ctx: Ctx,
  pl: Player,
  role: Role | null,
  takenRoles: ReadonlySet<Role>,
  fixed: readonly Cand[],
  blocked: ReadonlySet<string>,
  hover: string | null,
  friends: ReadonlySet<number>,
): PickRecommendation[] {
  const allowed: readonly Role[] = role ? [role] : ROLE_ORDER.filter((r) => !takenRoles.has(r));
  if (!allowed.length) return [];
  const ok = (cid: string): boolean => !ctx.excluded.has(cid) && !blocked.has(cid);
  const cands: Cand[] = pl.base.filter((c) => allowed.includes(c.role) && ok(c.champ.id));
  const have = new Set(cands.map((c) => `${c.champ.id}\u0001${c.role}`));
  const push = (d: ChampData, r: Role): void => {
    const k = `${d.id}\u0001${r}`;
    if (have.has(k)) return;
    have.add(k);
    cands.push(makeCand(ctx, pl, r, d, pl.pool.get(d.id) ?? null));
  };
  // the friend's own hover and wished champions are always considered
  if (hover && ok(hover)) {
    const d = ctx.catalog.data(hover);
    if (d) {
      const rs = allowed.filter((r) => d.roles.includes(r));
      for (const r of rs.length ? rs : [allowed[0]]) push(d, r);
    }
  }
  for (const w of pl.wanted) {
    const d = ctx.catalog.data(w);
    if (!d || !ok(d.id) || pl.avoided.has(d.id)) continue;
    for (const r of allowed) if (d.roles.includes(r)) push(d, r);
  }
  // discovery candidates: strong meta values / lane duels outside the pool
  if (ctx.meta || ctx.laneOn) {
    for (const r of allowed) {
      const extra: Cand[] = [];
      for (const d of ctx.catalog.allData()) {
        if (!d.roles.includes(r) || !ok(d.id) || pl.avoided.has(d.id) || have.has(`${d.id}\u0001${r}`)) continue;
        if ((pl.pool.get(d.id)?.comfort ?? 0) >= DRAFT_KNOWN_COMFORT) continue;
        extra.push(makeCand(ctx, pl, r, d, pl.pool.get(d.id) ?? null));
      }
      const pre = (c: Cand): number =>
        W_META * c.meta + DRAFT_W_LANE * (2 * c.laneVal - 1) * Math.min(1, c.laneW / LANE_CONF_FULL);
      extra.sort((a, b) => cmpNum(pre(b), pre(a)) || cmpStr(a.champ.id, b.champ.id));
      for (const c of extra.slice(0, DISCOVERY_EXTRAS)) {
        have.add(`${c.champ.id}\u0001${r}`);
        cands.push(c);
      }
    }
  }
  // score, best role per champion
  const bestByChamp = new Map<string, Scored>();
  for (const c of cands) {
    const s: Scored = {
      cand: c,
      score: scoreDraftPick(ctx, c, fixed),
      hover: c.champ.id === hover,
      discovery: c.comfort < DRAFT_KNOWN_COMFORT && !pl.wanted.has(c.champ.id) && c.champ.id !== hover,
    };
    const cur = bestByChamp.get(c.champ.id);
    if (!cur || s.score > cur.score + 1e-12 || (Math.abs(s.score - cur.score) <= 1e-12 && cmpStr(c.role, cur.cand.role) < 0)) {
      bestByChamp.set(c.champ.id, s);
    }
  }
  const all = [...bestByChamp.values()].sort((a, b) => cmpNum(b.score, a.score) || cmpStr(a.cand.champ.id, b.cand.champ.id));
  const known = all.filter((s) => !s.discovery);
  const disc = all.filter((s) => s.discovery);
  let chosen: Scored[] = known.slice(0, MAX_PICKS - 1);
  const floor = chosen.length ? chosen[chosen.length - 1].score - DISCOVERY_MARGIN : -Infinity;
  const relevant = disc.find(
    (s) =>
      s.score >= floor &&
      ((s.cand.laneW >= 0.05 && s.cand.laneVal >= DISCOVERY_LANE_VAL) || (ctx.meta !== null && s.cand.meta >= DISCOVERY_META)),
  );
  let tail: Scored | null = relevant ?? null;
  if (!tail && known.length > chosen.length) chosen.push(known[chosen.length]);
  if (chosen.length + (tail ? 1 : 0) < MIN_PICKS) {
    // thin pool: fill with the best remaining options (discoveries included)
    for (const s of all) {
      if (chosen.length + (tail ? 1 : 0) >= MIN_PICKS) break;
      if (!chosen.includes(s) && s !== tail) chosen.push(s);
    }
    chosen.sort((a, b) => cmpNum(b.score, a.score) || cmpStr(a.cand.champ.id, b.cand.champ.id));
  }
  // the hovered champion is always shown
  const hov = all.find((s) => s.hover);
  if (hov && !chosen.includes(hov) && tail !== hov) {
    if (chosen.length + (tail ? 1 : 0) >= MAX_PICKS) {
      if (tail) tail = null;
      else chosen.pop();
    }
    chosen.push(hov);
    chosen.sort((a, b) => cmpNum(b.score, a.score) || cmpStr(a.cand.champ.id, b.cand.champ.id));
  }
  if (tail) chosen.push(tail);
  return chosen.slice(0, MAX_PICKS).map((s) => ({
    champion_id: s.cand.champ.id,
    score: pyRound(clamp01(s.score) * 100, 1),
    comfort: pyRound(s.cand.comfort, 3),
    reasons: pickReasons(ctx, s, fixed, friends),
  }));
}

// --------------------------------------------------------------------------- bans

interface LikelyPick {
  pl: Player;
  champ: ChampData;
  role: Role;
  w: number;
}

function likelyPicks(ctx: Ctx, pl: Player, role: Role | null, takenIds: ReadonlySet<string>): LikelyPick[] {
  const out: LikelyPick[] = [];
  const entries = [...pl.pool.values()].sort(
    (a, b) => cmpNum(b.comfort, a.comfort) || cmpStr(a.champion_id, b.champion_id),
  );
  for (const e of entries) {
    if (out.length >= 3) break;
    if (e.comfort < 0.2) break;
    const d = ctx.catalog.data(e.champion_id);
    if (!d || takenIds.has(d.id) || pl.avoided.has(d.id)) continue;
    const r = role ? (d.roles.includes(role) ? role : null) : (d.roles[0] ?? null);
    if (!r) continue;
    out.push({ pl, champ: d, role: r, w: e.comfort });
  }
  return out;
}

function banAdvice(
  ctx: Ctx,
  likely: readonly LikelyPick[],
  ourLineup: readonly Pick[],
  taken: ReadonlySet<string>,
  enemyOpen: ReadonlySet<Role>,
): BanAdvice[] {
  const catalog = ctx.catalog;
  const meta = ctx.meta;
  const resolve = (id: string): string | null => catalog.resolve(id);
  const ours = new Set(likely.map((l) => l.champ.id));
  const traits = new Map<string, [number, string]>();
  const traitList = banThreatScores(ourLineup, taken, catalog);
  const traitMax = traitList.length ? Math.max(traitList[0][0], 1e-9) : 1;
  for (const [s, cid, key] of traitList) traits.set(cid, [s / traitMax, key]);
  const scored: [number, string, string][] = [];
  for (const c of catalog.allData()) {
    if (taken.has(c.id) || ours.has(c.id) || !c.roles.length) continue;
    // counters to our likely picks (meta duel + own lane history), in a role the enemy can still fill
    let counter = 0;
    let counterWhy = '';
    for (const lp of likely) {
      if (!c.roles.includes(lp.role) || !enemyOpen.has(lp.role)) continue;
      const metaE = meta ? metaLaneEdge(meta, lp.role, lp.champ.id, c.id) : 0;
      const hist = laneHistory(lp.pl.inp, lp.champ.id, c.id, resolve);
      const histE = historyLaneEdge(hist);
      const t = lp.w * Math.max(0, -(metaE + 0.5 * histE));
      if (t > counter + 1e-12) {
        counter = t;
        const who = lp.pl.inp.name || lp.pl.inp.player_id;
        if (meta && Math.abs(metaE) >= Math.abs(0.5 * histE)) {
          const m = metaMatchup(meta, lp.role, c.id, lp.champ.id);
          const pct = m ? pyRound((100 * m[1]) / m[0]) : null;
          counterWhy =
            pct !== null
              ? `Contre ${lp.champ.name} de ${who} : ${c.name} gagne ${pct} % de ces duels sur ce patch`
              : `Contre ${lp.champ.name} de ${who} sur ce patch`;
        } else if (hist) {
          const [g, w] = hist;
          counterWhy = `${who} perd souvent contre ${c.name} avec ${lp.champ.name} (${w} victoire${w > 1 ? 's' : ''} sur ${g})`;
        }
      }
    }
    const counterC = Math.min(1, counter / BAN_COUNTER_FULL);
    // meta strength and presence
    let metaC = 0;
    let metaWhy = '';
    if (meta) {
      const roles = c.roles.filter((r) => enemyOpen.has(r));
      let bestV = 0;
      let bestR: Role | null = null;
      for (const r of roles.length ? roles : c.roles) {
        const v = metaPickValue(meta, c.id, r);
        if (v > bestV) {
          bestV = v;
          bestR = r;
        }
      }
      const banShare = Math.max(0, Number(meta.bans?.[c.id] ?? 0)) / Math.max(1, meta.games);
      metaC = 0.6 * clamp01((bestV - 0.45) / 0.3) + 0.4 * clamp01(banShare / 0.25);
      const st = bestR ? metaRoleStat(meta, c.id, bestR) : null;
      const parts: string[] = [];
      const wr = st && st[0] >= REASON_META_MIN ? pyRound((100 * st[1]) / st[0]) : null;
      if (wr !== null && wr >= 52) parts.push(`${wr} % de victoires`);
      if (banShare >= 0.05) parts.push(`banni dans ${pyRound(100 * banShare)} % des parties`);
      const head = wr !== null && wr >= 52 ? 'Très fort sur ce patch' : 'Très présent sur ce patch';
      metaWhy = parts.length ? `${head} (${parts.join(', ')})` : head;
    }
    const tr = traits.get(c.id);
    const traitC = tr ? tr[0] : 0;
    const open = c.roles.some((r) => enemyOpen.has(r)) ? 1 : BAN_CLOSED_FACTOR;
    const parts: [number, string][] = [
      [BAN_W_COUNTER * counterC, counterWhy],
      [BAN_W_META * metaC, metaWhy],
      [BAN_W_TRAIT * traitC, tr ? BAN_TRAIT_WHY[tr[1]] ?? BAN_TRAIT_WHY.generic : ''],
    ];
    const total = open * (parts[0][0] + parts[1][0] + parts[2][0]);
    if (!(total > 0)) continue;
    let why = '';
    let top = 0;
    for (const [v, w] of parts) {
      if (w && v > top) {
        top = v;
        why = w;
      }
    }
    scored.push([total, c.id, why || BAN_TRAIT_WHY.generic]);
  }
  scored.sort((a, b) => cmpNum(b[0], a[0]) || cmpStr(a[1], b[1]));
  return scored.slice(0, BAN_LIMIT).map(([, cid, why]) => ({ champion_id: cid, why }));
}

// --------------------------------------------------------------------------- enemy analysis

function championStrength(c: ChampData): string | null {
  if (c.t.engage >= 3) return `${c.name} peut lancer un gros engage`;
  if (c.t.early >= 3) return `${c.name} est très fort en début de partie`;
  if (c.t.late >= 3 && DAMAGE_ARCHETYPES.has(c.archetype)) return `${c.name} devient très dangereux en fin de partie`;
  if (c.t.pick >= 3) return `${c.name} attrape facilement un joueur isolé`;
  if (c.t.splitpush >= 3) return `${c.name} peut mettre la pression en split push`;
  if (c.t.poke >= 3) return `${c.name} use à distance avant les combats`;
  if (c.t.frontline >= 3) return `${c.name} encaisse beaucoup en première ligne`;
  return null;
}

/** Strengths and weaknesses of the enemy picks, more assertive as the lineup fills up. */
function enemyNotes(champs: readonly ChampData[]): [string[], string[]] {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const n = champs.length;
  if (!n) return [strengths, weaknesses];
  const full = n >= 5;
  const f = n / 5;
  const s = teamSums(champs);
  if (n <= 2) {
    for (const c of champs) {
      const t = championStrength(c);
      if (t) strengths.push(t);
    }
  }
  const front = topBy(champs, 'frontline');
  if (front.length && n >= 2 && s[I.frontline] >= 5 * f) strengths.push(`Frontline solide (${joinNames(front)})`);
  else if (!front.length && n >= 3) {
    weaknesses.push(
      full ? 'Peu de frontline : leurs carries sont exposés' : "Pas encore de frontline : leurs carries restent exposés pour l'instant",
    );
  }
  const eng = topBy(champs, 'engage', 3);
  if (eng.length && n >= 2) strengths.push(`Engage fiable avec ${joinNames(eng)}`);
  else if (!eng.length && n >= 4 && s[I.engage] < 3 * f) {
    weaknesses.push(full ? 'Aucun engage fiable : ils auront du mal à forcer les combats' : "Pas encore d'engage fiable");
  }
  if (n >= 3) {
    const share = apShare(champs);
    const sure = full ? '' : " pour l'instant";
    if (share <= 0.05) weaknesses.push(`Dégâts 100 % physiques${sure} → l'armure est rentable`);
    else if (share >= 0.95) weaknesses.push(`Dégâts 100 % magiques${sure} → la résistance magique est rentable`);
    else if (share < 0.25) weaknesses.push(`Dégâts surtout physiques${sure} → l'armure est rentable`);
    else if (share > 0.75) weaknesses.push(`Dégâts surtout magiques${sure} → la résistance magique est rentable`);
    else if (full) strengths.push("Bon mélange de dégâts AD/AP : difficile de s'équiper contre eux");
  }
  const poke = topBy(champs, 'poke', 3);
  if (poke.length >= 2) strengths.push(`Poke à longue portée (${joinNames(poke)})`);
  if (n >= 3) {
    const split = topBy(champs, 'splitpush', 3, 1);
    if (split.length) strengths.push(`${split[0].name} peut tenir une lane seul en split push`);
    if (s[I.cc] >= 9 * f) strengths.push('Beaucoup de contrôles : ne vous faites pas attraper');
    const early = s[I.early] / n;
    const late = s[I.late] / n;
    if (early >= 2.2 && late < 1.8) {
      strengths.push('Très forts en début de partie');
      weaknesses.push("Faiblissent en fin de partie : tenez jusqu'à vos objets");
    } else if (late >= 2.4 && early < 1.4) {
      strengths.push('Très forts en fin de partie');
      weaknesses.push('Début de partie fragile : punissez-les tôt');
    } else if (late >= 2.4) {
      strengths.push('Très forts en fin de partie');
    } else if (early >= 2.2) {
      strengths.push('Fort début de partie');
    }
  }
  if (n >= 3) {
    const sure = full ? '' : " pour l'instant";
    if (s[I.cc] < 4 * f) weaknesses.push(`Peu de contrôles${sure} : leurs cibles sont faciles à approcher`);
    if (s[I.waveclear] < 5 * f) weaknesses.push(`Waveclear faible${sure} : assiégez leurs tours`);
    if (s[I.mobility] / n < 1) weaknesses.push(`Peu de mobilité${sure} : vulnérables aux engages et aux picks`);
    if (s[I.peel] / n < 0.8 && champs.some((c) => SQUISHY_CARRY_ARCHES.has(c.archetype))) {
      weaknesses.push(`Peu de protection pour leurs carries${sure} : plongez dessus`);
    }
  }
  if (n <= 2 && !weaknesses.length) {
    weaknesses.push(
      n === 1
        ? "Un seul champion connu : impossible de juger leurs faiblesses pour l'instant"
        : 'Trop peu de champions connus pour juger leurs faiblesses',
    );
  }
  return [strengths, weaknesses];
}

function championWinCondition(c: ChampData): string {
  if (c.t.early >= 3) return `Prendre l'avance tôt avec ${c.name}`;
  if (c.t.late >= 3 && DAMAGE_ARCHETYPES.has(c.archetype)) return `Faire durer la partie pour que ${c.name} scale`;
  if (c.t.engage >= 3) return `Lancer les combats avec ${c.name}`;
  if (c.t.splitpush >= 3) return `Mettre la pression en split push avec ${c.name}`;
  if (c.t.pick >= 3) return `Attraper un joueur isolé avec ${c.name}`;
  return `Jouer autour de ${c.name} (${archetypeLabel(c.archetype).toLowerCase()})`;
}

function masteryOf(acc: DraftEnemyAccount, cid: string, catalog: Catalog): number | null {
  if (acc.champion_mastery && Number.isFinite(acc.champion_mastery.points)) return acc.champion_mastery.points;
  const m = (acc.masteries ?? []).find((x) => catalog.resolve(x.champion_id) === cid);
  return m ? m.points : null;
}

function mainMastery(acc: DraftEnemyAccount, catalog: Catalog): MasteryEntry | null {
  let best: MasteryEntry | null = null;
  for (const m of acc.masteries ?? []) {
    if (!catalog.resolve(m.champion_id)) continue;
    if (!best || m.points > best.points || (m.points === best.points && cmpStr(m.champion_id, best.champion_id) < 0)) best = m;
  }
  return best;
}

function rankText(r: Rank | null | undefined): string | null {
  if (!r || !r.tier) return null;
  const tier = r.tier.toUpperCase();
  const label = TIER_FR[tier] ?? r.tier;
  if (HIGH_TIERS.has(tier)) return `${label} (${r.lp} LP)`;
  return r.division ? `${label} ${r.division}` : label;
}

/** Threat / strength / weakness adjustments from the enemy accounts (known once the game has started). */
function applyAccounts(
  out: EnemyDraftAnalysis,
  accounts: readonly DraftEnemyAccount[],
  enemy: readonly EnemyPickIn[],
  ally: readonly Pick[],
  catalog: Catalog,
): void {
  const byChamp = new Map<string, DraftEnemyAccount>();
  for (const a of accounts) {
    const cid = a?.champion_id ? catalog.resolve(a.champion_id) : null;
    if (cid && !byChamp.has(cid)) byChamp.set(cid, a);
  }
  const order = new Map(out.threats.map((t, i) => [t.champion_id, i]));
  for (const e of enemy) {
    const acc = byChamp.get(e.champion_id);
    if (!acc) continue;
    const name = catalog.name(e.champion_id);
    const pts = masteryOf(acc, e.champion_id, catalog);
    const tier = acc.rank?.tier ? acc.rank.tier.toUpperCase() : '';
    const rank = rankText(acc.rank);
    let delta = 0;
    const notes: string[] = [];
    if (pts !== null && pts >= ONE_TRICK_POINTS) {
      delta += 1;
      notes.push(`son joueur a ${fmtPoints(pts)} points de maîtrise sur ${name} (probable one-trick)`);
      out.strengths.push(`${name} est joué par un spécialiste (${fmtPoints(pts)} points de maîtrise)`);
    } else if (pts !== null && pts >= HIGH_MASTERY_POINTS) {
      notes.push(`champion bien maîtrisé par son joueur (${fmtPoints(pts)} points)`);
    } else if (pts !== null && pts < LOW_MASTERY_POINTS) {
      delta -= 1;
      notes.push(`peu joué par son joueur (${fmtPoints(pts)} points de maîtrise)`);
      const main = mainMastery(acc, catalog);
      const mainId = main ? catalog.resolve(main.champion_id) : null;
      if (main && mainId && mainId !== e.champion_id && main.points >= HIGH_MASTERY_POINTS) {
        out.weaknesses.push(
          `${name} est peu joué par son joueur (${fmtPoints(pts)} points), habitué à ${catalog.name(mainId)} : punissez ses erreurs`,
        );
      } else {
        out.weaknesses.push(`${name} est peu joué par son joueur (${fmtPoints(pts)} points) : punissez ses erreurs`);
      }
    }
    if (HIGH_TIERS.has(tier)) {
      delta += 1;
      notes.push(`joueur ${rank}`);
    } else if (rank && notes.length) {
      notes.push(`classé ${rank}`);
    }
    if (!notes.length && !delta) continue;
    const sentence = `${notes.join(', ')}.`;
    const cap = `${sentence[0].toUpperCase()}${sentence.slice(1)}`;
    const existing = out.threats.find((t) => t.champion_id === e.champion_id);
    if (existing) {
      existing.danger = Math.max(1, Math.min(3, existing.danger + delta));
      existing.why = `${existing.why} ${cap}`;
    } else if (delta > 0) {
      const d = describeThreat(ally, e.champion_id, catalog);
      out.threats.push({
        champion_id: e.champion_id,
        danger: Math.max(1, Math.min(3, 1 + delta)),
        why: `${d.why} ${cap}`,
        how_to_handle: d.how_to_handle,
      });
      order.set(e.champion_id, order.size);
    }
  }
  out.threats.sort((a, b) => b.danger - a.danger || order.get(a.champion_id)! - order.get(b.champion_id)!);
  out.threats = out.threats.slice(0, 5);
}

function enemyAnalysis(
  enemy: readonly EnemyPickIn[],
  ally: readonly Pick[],
  accounts: readonly DraftEnemyAccount[],
  catalog: Catalog,
  context: EngineContext,
): EnemyDraftAnalysis | null {
  if (!enemy.length) return null;
  const n = enemy.length;
  const enemyP: Pick[] = enemy.map((e) => ({ champion_id: e.champion_id, role: e.role ?? ROLE_ORDER[0] }));
  const plan = buildMatchupPlanRaw([...ally], enemyP, catalog, context);
  const champs = enemy.map((e) => catalog.data(e.champion_id)!).filter(Boolean);
  const [strengths, weaknesses] = enemyNotes(champs);
  let identity: string;
  let themes = plan.enemy_themes;
  let win = plan.enemy_win_conditions;
  if (n === 1) {
    const c = champs[0];
    identity = `Un seul champion adverse connu : ${c.name} (${archetypeLabel(c.archetype).toLowerCase()}). Trop tôt pour lire leur plan de jeu.`;
    themes = [];
    win = [championWinCondition(c)];
  } else if (n === 2) {
    const label = plan.enemy_identity.match(/« ([^»]+) »/)?.[1];
    identity = `Deux champions adverses connus (${joinNames(champs)})${label ? ` : tendance « ${label} » à confirmer` : ''}.`;
    themes = themes.slice(0, 1);
    win = win.slice(0, 2);
  } else if (n < 5) {
    identity = `${plan.enemy_identity.replace(/\.$/, '')} (${n}/5 champions connus, compo encore incomplète).`;
  } else {
    identity = plan.enemy_identity;
  }
  const prof = damageProfileOf(enemyP, catalog);
  const damage: Partial<Record<DamageType, number>> = { AD: prof.AD ?? 0, AP: prof.AP ?? 0, MIXED: prof.MIXED ?? 0 };
  const out: EnemyDraftAnalysis = {
    identity,
    themes,
    strengths,
    weaknesses,
    win_conditions: win,
    threats: plan.threats.map((t): ThreatInfo => ({ ...t })),
    damage_profile: damage,
  };
  if (accounts.length) applyAccounts(out, accounts, enemy, ally, catalog);
  out.strengths = out.strengths.slice(0, 6);
  out.weaknesses = out.weaknesses.slice(0, 6);
  return out;
}

// --------------------------------------------------------------------------- entry point

/** Unelided draft advice (the public wrapper applies French elision). */
export function recommendDraftRaw(
  players: PlayerInput[],
  draft: DraftInput,
  catalog: Catalog,
  context: EngineContext = {},
): DraftAdvice {
  context = context ?? {};
  const slots = allySlots(players ?? [], draft ?? { ally: [], enemy: [], bans: [] }, catalog);
  const enemy = enemyPicks(draft ?? { ally: [], enemy: [], bans: [] }, catalog);
  const roles = assignDraftRoles(slots, catalog);
  const takenRoles = new Set<Role>();
  for (const r of roles) if (r) takenRoles.add(r);

  // generator context: friends + locked unknown teammates (pseudo-players without history)
  const members = slots.filter((s) => s.friend || s.locked);
  const inputs: PlayerInput[] = members.map((s) =>
    s.friend
      ? s.friend
      : {
          player_id: `\u0000mate${s.idx}`,
          name: 'Coéquipier',
          preferences: { roles: [], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] },
          role_games: {},
          pool: [],
        },
  );
  const roleAssign: Record<string, Role> = {};
  const lockedPicks: Record<string, string> = {};
  members.forEach((s, i) => {
    const r = roles[s.idx];
    if (r) roleAssign[inputs[i].player_id] = r;
    if (s.locked && s.champ) lockedPicks[inputs[i].player_id] = s.champ;
  });
  const bans = (draft?.bans ?? []).map((b) => catalog.resolve(b) ?? b);
  const options = normOptions({
    role_assignments: roleAssign,
    locked_picks: lockedPicks,
    bans,
    enemy_champions: enemy.map((e) => e.champion_id),
    exploration: 0,
    count: 1,
  });
  const ctx = prepare(
    inputs.map(normPlayer),
    options,
    catalog,
    { meta: metaUsable(context.meta) ? context.meta : null },
    enemy.map((e) => e.role),
  );
  const friendIdx = new Set<number>();
  members.forEach((s, i) => {
    if (s.friend) friendIdx.add(i);
  });
  const fixed: Cand[] = [];
  for (const pl of ctx.players) if (pl.locked && pl.base.length) fixed.push(pl.base[0]);
  const fixedPicks: Pick[] = fixed.map((c) => ({
    role: c.role,
    champion_id: c.champ.id,
    player_id: friendIdx.has(c.pidx) ? ctx.players[c.pidx].inp.player_id : null,
  }));

  // every champion already picked or hovered, both sides
  const taken = new Set<string>(ctx.excluded);
  for (const s of slots) if (s.champ) taken.add(s.champ);

  const advice: PlayerPickAdvice[] = [];
  const likely: LikelyPick[] = [];
  members.forEach((s, i) => {
    if (!s.friend) return;
    const pl = ctx.players[i];
    const role = roles[s.idx];
    if (s.locked) {
      advice.push({ player_id: s.friend.player_id, role, locked_champion_id: s.champ, picks: [] });
      const own = fixed.find((c) => c.pidx === i);
      if (own) likely.push({ pl, champ: own.champ, role: own.role, w: 1 });
      return;
    }
    const blocked = new Set<string>();
    for (const o of slots) if (o.idx !== s.idx && o.champ) blocked.add(o.champ);
    const picks = pickAdvice(ctx, pl, role, takenRoles, fixed, blocked, s.champ, friendIdx);
    advice.push({ player_id: s.friend.player_id, role, locked_champion_id: null, picks });
    const hover = s.champ ? catalog.data(s.champ) : undefined;
    const hoverRole = hover ? (role && hover.roles.includes(role) ? role : role ?? hover.roles[0] ?? null) : null;
    if (hover && hoverRole) likely.push({ pl, champ: hover, role: hoverRole, w: 1 });
    likely.push(...likelyPicks(ctx, pl, role, taken));
  });

  // ban advice: against our locked picks plus each open friend's main champion
  const enemyOpen = new Set<Role>(ROLE_ORDER);
  for (const e of enemy) if (e.role) enemyOpen.delete(e.role);
  const lineupForBans: Pick[] = [...fixedPicks];
  const seenPl = new Set<Player>();
  for (const lp of likely) {
    if (fixed.some((c) => c.pidx === lp.pl.idx) || seenPl.has(lp.pl)) continue;
    seenPl.add(lp.pl);
    lineupForBans.push({ role: lp.role, champion_id: lp.champ.id });
  }
  const bansOut = banAdvice(ctx, likely, lineupForBans, taken, enemyOpen);

  const enemyOut = enemyAnalysis(enemy, fixedPicks, draft?.enemy_accounts ?? [], catalog, {
    meta: context.meta,
    players: players ?? [],
  });
  return { players: advice, bans: bansOut, enemy: enemyOut };
}
