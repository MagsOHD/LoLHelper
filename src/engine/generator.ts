// Composition generator: beam search over (role, champion) per player + local improvement.
import type {
  CompositionSuggestion,
  GenerationOptions,
  PlayerInput,
  PlayerPreferences,
  PoolEntry,
  Role,
  SuggestedPick,
} from '../api/types';
import { counterDetails, counterScore, teamNotes, teamSums, viability } from './analysis';
import { archetypeLabel, TRAITS, type ChampData, type Catalog } from './catalog';
import { cmpNum, cmpStr, pyFixed, pyRound } from './pycompat';
import { COUNTER_FR, ROLE_LABELS, TRAIT_FR } from './tables';
import { allThemes, getTheme, lorePairs, type ThemeDef } from './themes';

export const ROLE_ORDER: readonly Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];
const PREF_FIT = [1.0, 0.8, 0.6, 0.45, 0.35];
const UNLISTED_ROLE_FIT = 0.15;
const AUTO_THEMATIC_FACTOR = 0.95;

/** Pool entry with every optional field filled (pydantic defaults). */
interface FullPoolEntry {
  champion_id: string;
  comfort: number;
  desire: number;
  sources: string[];
  mastery_points: number;
  mastery_level: number;
  recent_games: number;
  recent_wins: number;
}

interface Cand {
  pidx: number;
  role: Role;
  champ: ChampData;
  comfort: number;
  desire: number;
  roleFit: number;
  entry: FullPoolEntry | null;
  locked: boolean;
  iv: number; // individual value used to pre-rank candidates
  comfortPart: number; // real comfort, shown in the score breakdown
  scorePart: number; // comfort part of the score, fading out as exploration rises
}

interface Player {
  idx: number;
  inp: NormPlayer;
  forced: Role | null;
  locked: string | null;
  roleFit: Record<Role, number>;
  pool: Map<string, FullPoolEntry>;
  wanted: Set<string>;
  wantedArch: Set<string>;
  avoided: Set<string>;
  base: Cand[];
}

interface NormPlayer {
  player_id: string;
  name: string;
  preferences: PlayerPreferences;
  role_games: Partial<Record<Role, number>>;
  pool: FullPoolEntry[];
}

interface NormOptions {
  theme: string | null;
  role_assignments: Record<string, Role>;
  locked_picks: Record<string, string>;
  bans: string[];
  enemy_champions: string[];
  count: number;
  exploration: number;
}

interface Parts {
  comfort: number;
  desire: number;
  theme_fit: number;
  balance: number;
  counter?: number;
}

interface Ctx {
  catalog: Catalog;
  options: NormOptions;
  players: Player[];
  excluded: Set<string>;
  enemy: ChampData[];
  wComfort: number;
  wDesire: number;
  wTheme: number;
  wBalance: number;
  wCounter: number;
  penalty: Map<string, number> | null; // diversification during the search
}

/** A lineup's sorted (player index, role, champion) key, as Python's `_key` tuple. */
type KeyTuple = [number, string, string];

// --------------------------------------------------------------------------- normalisation

function normPlayer(p: PlayerInput): NormPlayer {
  const prefs: Partial<PlayerPreferences> = p.preferences ?? {};
  return {
    player_id: p.player_id,
    name: p.name,
    preferences: {
      roles: prefs.roles ?? [],
      wanted_archetypes: prefs.wanted_archetypes ?? [],
      wanted_champions: prefs.wanted_champions ?? [],
      avoided_champions: prefs.avoided_champions ?? [],
    },
    role_games: p.role_games ?? {},
    pool: (p.pool ?? []).map(normEntry),
  };
}

function normEntry(e: PoolEntry): FullPoolEntry {
  return {
    champion_id: e.champion_id,
    comfort: e.comfort,
    desire: e.desire,
    sources: e.sources ?? [],
    mastery_points: e.mastery_points ?? 0,
    mastery_level: e.mastery_level ?? 0,
    recent_games: e.recent_games ?? 0,
    recent_wins: e.recent_wins ?? 0,
  };
}

function normOptions(o: GenerationOptions): NormOptions {
  return {
    theme: o.theme ?? null,
    role_assignments: o.role_assignments ?? {},
    locked_picks: o.locked_picks ?? {},
    bans: o.bans ?? [],
    enemy_champions: o.enemy_champions ?? [],
    count: o.count ?? 5,
    exploration: o.exploration ?? 0.2,
  };
}

// --------------------------------------------------------------------------- helpers

function roleFitOf(p: NormPlayer, forced: Role | null): Record<Role, number> {
  const out = {} as Record<Role, number>;
  if (forced) {
    for (const r of ROLE_ORDER) out[r] = r === forced ? 1.0 : 0.0;
    return out;
  }
  const roles = p.preferences.roles;
  const prefs = roles.filter((r, i) => !roles.slice(0, i).includes(r));
  const games = {} as Record<Role, number>;
  for (const r of ROLE_ORDER) games[r] = p.role_games[r] ?? 0;
  const maxGames = Math.max(...ROLE_ORDER.map((r) => games[r]));
  for (const r of ROLE_ORDER) {
    const g = maxGames > 0 ? 0.3 + (0.7 * games[r]) / maxGames : 0.6;
    if (prefs.length) {
      const pref = prefs.includes(r) ? PREF_FIT[prefs.indexOf(r)] : UNLISTED_ROLE_FIT;
      out[r] = maxGames > 0 ? 0.8 * pref + 0.2 * g : pref;
    } else {
      out[r] = g;
    }
  }
  return out;
}

function genericStrength(c: ChampData): number {
  let s = 0;
  for (const v of c.traits) s += v;
  return s;
}

/** Sort key used for exploration / safety-net / theme extras. */
function extraSort(wantedArch: Set<string>): (a: ChampData, b: ChampData) => number {
  return (a, b) =>
    cmpNum(wantedArch.has(a.archetype) ? 0 : 1, wantedArch.has(b.archetype) ? 0 : 1) ||
    cmpNum(genericStrength(b), genericStrength(a)) ||
    cmpStr(a.id, b.id);
}

export function fmtPoints(points: number): string {
  if (points >= 1_000_000) return `${pyFixed(points / 1_000_000, 1)}M`.replace('.', ',').replace(',0M', 'M');
  if (points >= 1000) return `${pyRound(points / 1000)}k`;
  return String(points);
}

const W_NOVELTY = 0.3;

function evaluate(ctx: Ctx, theme: ThemeDef, picks: readonly Cand[]): [number, Parts] {
  const n = picks.length;
  const champs = picks.map((c) => c.champ);
  const sums = teamSums(champs);
  let cs = 0;
  let ds = 0;
  let shown = 0;
  for (const c of picks) cs += c.scorePart;
  for (const c of picks) shown += c.comfortPart;
  for (const c of picks) ds += c.desire;
  const comfort = cs / n;
  const desire = ds / n;
  const fit = theme.fit(champs, sums);
  const bal = viability(champs, sums, theme.ignoreDamageMix);
  let total = ctx.wComfort * comfort + ctx.wDesire * desire + ctx.wTheme * fit + ctx.wBalance * bal;
  let weights = ctx.wComfort + ctx.wDesire + ctx.wTheme + ctx.wBalance;
  const expl = ctx.options.exploration;
  if (expl > 0) {
    // Exploration is the target share of new champions in the lineup (0.2 ≈ one pick out of 5).
    let novelty = 0;
    // A champion counts as new when barely played: comfort 0 -> 1, 0.2 -> 0.5, >= 0.4 -> 0.
    for (const c of picks) novelty += Math.max(0, 1 - c.comfort / 0.4);
    total += W_NOVELTY * (1 - Math.abs(novelty / n - expl));
    weights += W_NOVELTY;
  }
  const parts: Parts = { comfort: shown / n, desire, theme_fit: fit, balance: bal };
  if (ctx.enemy.length) {
    const cnt = counterScore(champs, ctx.enemy);
    total += ctx.wCounter * cnt;
    weights += ctx.wCounter;
    parts.counter = cnt;
  }
  let score = total / weights;
  if (ctx.penalty && ctx.penalty.size) {
    let pen = 0;
    for (const c of picks) pen += ctx.penalty.get(c.champ.id) ?? 0.0;
    score -= pen;
  }
  return [score, parts];
}

// --------------------------------------------------------------------------- setup

function makeCand(pl: Player, role: Role, d: ChampData, e: FullPoolEntry | null, expl: number, locked = false): Cand {
  const comfort = e ? e.comfort : 0.0;
  let desire = e ? e.desire : 0.0;
  if (pl.wanted.has(d.id)) desire = 1.0;
  else if (pl.wantedArch.has(d.archetype)) desire = Math.max(desire, 0.6);
  const roleFit = pl.roleFit[role];
  return {
    pidx: pl.idx,
    role,
    champ: d,
    comfort,
    desire,
    roleFit,
    entry: e,
    locked,
    iv: 0.0,
    comfortPart: 0.75 * comfort + 0.25 * roleFit,
    scorePart: 0.75 * (1 - expl) * comfort + 0.25 * roleFit,
  };
}

function prepare(players: NormPlayer[], options: NormOptions, catalog: Catalog): Ctx {
  const expl = options.exploration;
  const excluded = new Set(options.bans.map((b) => catalog.resolve(b) ?? b));
  const enemyData: ChampData[] = [];
  for (const e of options.enemy_champions) {
    const d = catalog.data(e);
    if (d) {
      enemyData.push(d);
      excluded.add(d.id);
    }
  }
  const locked = new Map<string, string>();
  for (const [pid, cid] of Object.entries(options.locked_picks)) {
    const r = catalog.resolve(cid);
    if (r) locked.set(pid, r);
  }

  const ctx: Ctx = {
    catalog,
    options,
    players: [],
    excluded,
    enemy: enemyData,
    wComfort: 0.32,
    wDesire: 0.14 + 0.06 * expl,
    wTheme: options.theme ? 0.3 : 0.26,
    wBalance: 0.18,
    wCounter: 0.12,
    penalty: null,
  };
  const allChamps = catalog.allData();
  players.forEach((p, idx) => {
    const forced = Object.prototype.hasOwnProperty.call(options.role_assignments, p.player_id)
      ? options.role_assignments[p.player_id]
      : null;
    const pool = new Map<string, FullPoolEntry>();
    for (const e of p.pool) {
      const cid = catalog.resolve(e.champion_id);
      if (cid && !pool.has(cid)) pool.set(cid, e);
    }
    ctx.players.push({
      idx,
      inp: p,
      forced: forced || null,
      locked: locked.get(p.player_id) ?? null,
      roleFit: roleFitOf(p, forced || null),
      pool,
      wanted: new Set(p.preferences.wanted_champions.map((c) => catalog.resolve(c) ?? c)),
      wantedArch: new Set(p.preferences.wanted_archetypes),
      avoided: new Set(p.preferences.avoided_champions.map((c) => catalog.resolve(c) ?? c)),
      base: [],
    });
  });

  for (const pl of ctx.players) {
    const blocked = new Set(excluded);
    for (const [pid, cid] of locked) if (pid !== pl.inp.player_id) blocked.add(cid);
    const roles: readonly Role[] = pl.forced ? [pl.forced] : ROLE_ORDER;
    const cands: Cand[] = [];
    if (pl.locked) {
      const d = catalog.data(pl.locked);
      if (d) {
        let viable = roles.filter((r) => d.roles.includes(r));
        if (!viable.length) viable = [...roles];
        const e = pl.pool.get(d.id) ?? null;
        for (const r of viable) cands.push(makeCand(pl, r, d, e, expl, true));
      }
      pl.base = cands;
      continue;
    }
    const seen = new Set<string>();
    const seenKey = (cid: string, r: Role): string => `${cid}\u0001${r}`;
    const ordered = [...pl.pool.keys()].sort((a, b) => {
      const ea = pl.pool.get(a)!;
      const eb = pl.pool.get(b)!;
      return cmpNum(eb.comfort, ea.comfort) || cmpNum(eb.desire, ea.desire) || cmpStr(a, b);
    });
    for (const cid of ordered) {
      const e = pl.pool.get(cid)!;
      if (blocked.has(cid) || pl.avoided.has(cid)) continue;
      if (e.comfort < 0.01 && !pl.wanted.has(cid) && expl <= 0) continue;
      const d = catalog.data(cid);
      if (!d) continue;
      for (const r of roles) {
        if (d.roles.includes(r)) {
          cands.push(makeCand(pl, r, d, e, expl));
          seen.add(seenKey(cid, r));
        }
      }
    }
    const sorter = extraSort(pl.wantedArch);
    // exploration: unknown champions of the player's main roles
    const nExtra = pyRound(expl * 10);
    if (nExtra) {
      let mainRoles = roles.filter((r) => pl.roleFit[r] >= 0.6);
      if (!mainRoles.length) mainRoles = [...roles];
      for (const r of mainRoles) {
        const poolR = allChamps.filter(
          (c) =>
            c.roles.includes(r) && !seen.has(seenKey(c.id, r)) && !blocked.has(c.id) && !pl.avoided.has(c.id),
        );
        poolR.sort(sorter);
        for (const c of poolR.slice(0, nExtra)) {
          cands.push(makeCand(pl, r, c, null, expl));
          seen.add(seenKey(c.id, r));
        }
      }
    }
    // safety net: every allowed role must have a few options
    for (const r of roles) {
      let have = 0;
      for (const c of cands) if (c.role === r) have += 1;
      if (have < 3) {
        const poolR = allChamps.filter(
          (c) =>
            c.roles.includes(r) && !seen.has(seenKey(c.id, r)) && !blocked.has(c.id) && !pl.avoided.has(c.id),
        );
        poolR.sort(sorter);
        for (const c of poolR.slice(0, 3 - have)) {
          cands.push(makeCand(pl, r, c, null, expl));
          seen.add(seenKey(c.id, r));
        }
      }
    }
    pl.base = cands;
  }
  return ctx;
}

const byIv = (a: Cand, b: Cand): number =>
  cmpNum(b.iv, a.iv) || cmpStr(a.champ.id, b.champ.id) || cmpStr(a.role, b.role);

function themeCandidates(ctx: Ctx, pl: Player, theme: ThemeDef, explicit: boolean, limit: number): Cand[] {
  const cands = [...pl.base];
  if (theme.thematic && !pl.locked) {
    const perRole = explicit ? 6 : pyRound(ctx.options.exploration * 6);
    if (perRole) {
      const blocked = new Set(ctx.excluded);
      for (const [pid, cid] of Object.entries(ctx.options.locked_picks)) {
        if (pid !== pl.inp.player_id) blocked.add(ctx.catalog.resolve(cid) ?? cid);
      }
      const have = new Set(cands.map((c) => `${c.champ.id}\u0001${c.role}`));
      const roles: readonly Role[] = pl.forced ? [pl.forced] : ROLE_ORDER;
      const sorter = extraSort(pl.wantedArch);
      for (const r of roles) {
        const extra = ctx.catalog
          .allData()
          .filter(
            (c) =>
              c.roles.includes(r) &&
              !have.has(`${c.id}\u0001${r}`) &&
              !blocked.has(c.id) &&
              !pl.avoided.has(c.id) &&
              theme.affinity(c) > 0,
          );
        extra.sort(sorter);
        for (const c of extra.slice(0, perRole)) cands.push(makeCand(pl, r, c, null, ctx.options.exploration));
      }
    }
  }
  const wt = ctx.wTheme * (theme.thematic ? 1.0 : 0.8);
  for (const c of cands) {
    c.iv = ctx.wComfort * c.scorePart + ctx.wDesire * c.desire + wt * theme.affinity(c.champ);
  }
  cands.sort(byIv);
  // keep the best overall while guaranteeing a few options per role
  const chosen: Cand[] = [];
  const inChosen = new Set<Cand>();
  const perRoleCount = new Map<Role, number>();
  for (const c of cands) {
    const k = perRoleCount.get(c.role) ?? 0;
    if (k < 3) {
      chosen.push(c);
      inChosen.add(c);
      perRoleCount.set(c.role, k + 1);
    }
  }
  for (const c of cands) {
    if (chosen.length >= limit + 5) break;
    if (!inChosen.has(c)) {
      chosen.push(c);
      inChosen.add(c);
    }
  }
  chosen.sort(byIv);
  return chosen;
}

// --------------------------------------------------------------------------- search

function keyOf(picks: readonly Cand[]): KeyTuple[] {
  const k: KeyTuple[] = picks.map((c) => [c.pidx, c.role, c.champ.id]);
  k.sort(cmpTuple);
  return k;
}

function cmpTuple(a: KeyTuple, b: KeyTuple): number {
  return cmpNum(a[0], b[0]) || cmpStr(a[1], b[1]) || cmpStr(a[2], b[2]);
}

function cmpKey(a: readonly KeyTuple[], b: readonly KeyTuple[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = cmpTuple(a[i], b[i]);
    if (d) return d;
  }
  return a.length - b.length;
}

function keyString(k: readonly KeyTuple[]): string {
  return k.map((t) => `${t[0]}\u0001${t[1]}\u0001${t[2]}`).join('\u0002');
}

interface State {
  score: number;
  picks: Cand[];
  key: KeyTuple[];
}

interface Found {
  score: number;
  parts: Parts;
  picks: Cand[];
  key: KeyTuple[];
}

const byStateScore = (a: { score: number; key: KeyTuple[] }, b: { score: number; key: KeyTuple[] }): number =>
  cmpNum(b.score, a.score) || cmpKey(a.key, b.key);

function search(ctx: Ctx, theme: ThemeDef, explicit: boolean, beam: number, limit: number, keep: number): Found[] {
  const perPlayer = ctx.players.map((pl) => themeCandidates(ctx, pl, theme, explicit, limit));
  const order = ctx.players.map((_, i) => i).sort((a, b) => cmpNum(perPlayer[a].length, perPlayer[b].length) || a - b);
  let states: State[] = [{ score: 0.0, picks: [], key: [] }];
  for (const i of order) {
    const nxt = new Map<string, State>();
    for (const st of states) {
      const picks = st.picks;
      const usedRoles = new Set(picks.map((c) => c.role));
      const usedChamps = new Set(picks.map((c) => c.champ.id));
      for (const c of perPlayer[i]) {
        if (usedRoles.has(c.role) || usedChamps.has(c.champ.id)) continue;
        const next = [...picks, c];
        const key = keyOf(next);
        const ks = keyString(key);
        if (nxt.has(ks)) continue;
        const [score] = evaluate(ctx, theme, next);
        nxt.set(ks, { score, picks: next, key });
      }
    }
    if (!nxt.size) return [];
    states = [...nxt.values()].sort(byStateScore).slice(0, beam);
  }

  const results = new Map<string, Found>();
  for (const st of states.slice(0, Math.max(keep, 3))) {
    const picks = improve(ctx, theme, st.picks, perPlayer);
    const [score, parts] = evaluate(ctx, theme, picks);
    const key = keyOf(picks);
    results.set(keyString(key), { score, parts, picks, key });
  }
  for (const st of states) {
    const ks = keyString(st.key);
    if (!results.has(ks)) {
      results.set(ks, { score: st.score, parts: evaluate(ctx, theme, st.picks)[1], picks: st.picks, key: st.key });
    }
  }
  return [...results.values()].sort(byStateScore);
}

function improve(ctx: Ctx, theme: ThemeDef, start: Cand[], perPlayer: Cand[][]): Cand[] {
  let picks = start;
  let [best] = evaluate(ctx, theme, picks);
  for (let iter = 0; iter < 3; iter++) {
    let improved = false;
    for (let pos = 0; pos < picks.length; pos++) {
      let cur = picks[pos];
      let others = [...picks.slice(0, pos), ...picks.slice(pos + 1)];
      const usedRoles = new Set(others.map((c) => c.role));
      const usedChamps = new Set(others.map((c) => c.champ.id));
      for (const c of perPlayer[cur.pidx]) {
        if (c === cur || usedRoles.has(c.role) || usedChamps.has(c.champ.id)) continue;
        const trial = [...others.slice(0, pos), c, ...others.slice(pos)];
        const [s] = evaluate(ctx, theme, trial);
        if (s > best + 1e-9) {
          best = s;
          picks = trial;
          improved = true;
          cur = c;
          others = [...picks.slice(0, pos), ...picks.slice(pos + 1)];
        }
      }
    }
    // swap the (role, champion) of two players when both know the other's pick
    const lookup = perPlayer.map((cands) => {
      const m = new Map<string, Cand>();
      for (const c of cands) m.set(`${c.role}\u0001${c.champ.id}`, c);
      return m;
    });
    for (let a = 0; a < picks.length; a++) {
      for (let b = a + 1; b < picks.length; b++) {
        const pa = picks[a];
        const pb = picks[b];
        const ca = lookup[pa.pidx].get(`${pb.role}\u0001${pb.champ.id}`);
        const cb = lookup[pb.pidx].get(`${pa.role}\u0001${pa.champ.id}`);
        if (ca === undefined || cb === undefined) continue;
        const trial = [...picks];
        trial[a] = ca;
        trial[b] = cb;
        const [s] = evaluate(ctx, theme, trial);
        if (s > best + 1e-9) {
          best = s;
          picks = trial;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return picks;
}

// --------------------------------------------------------------------------- output

function reasonsFor(ctx: Ctx, theme: ThemeDef, c: Cand, picks: readonly Cand[]): string[] {
  const pl = ctx.players[c.pidx];
  const out: string[] = [];
  const e = c.entry;
  if (c.locked) out.push('Choix verrouillé');
  if (e && e.mastery_points >= 1000) {
    const pts = fmtPoints(e.mastery_points);
    out.push(e.comfort >= 0.45 ? `Champion maîtrisé (${pts} points)` : `Déjà joué (${pts} points de maîtrise)`);
  }
  if (e && e.recent_games > 0) {
    const wr = pyRound((100 * e.recent_wins) / e.recent_games);
    const plural = e.recent_games > 1 ? 's' : '';
    out.push(`Joué récemment (${e.recent_games} partie${plural}, ${wr} % de victoires)`);
  }
  if (e && e.sources.includes('manual') && e.mastery_points < 1000 && e.recent_games === 0) {
    out.push(`Dans ton pool (confort ${pyRound(e.comfort * 100)} %)`);
  }
  if (pl.wanted.has(c.champ.id)) {
    out.push('Champion que tu as envie de jouer');
  } else if (pl.wantedArch.has(c.champ.archetype)) {
    out.push(`Correspond à ton envie : ${archetypeLabel(c.champ.archetype)}`);
  }
  if (c.comfort < 0.1 && !pl.wanted.has(c.champ.id) && !c.locked) {
    out.push('Découverte : un nouveau champion à essayer');
  }
  const label = ROLE_LABELS[c.role];
  const prefs = pl.inp.preferences.roles;
  if (pl.forced) out.push(`Rôle imposé : ${label}`);
  else if (prefs.length && prefs[0] === c.role) out.push(`Ton rôle préféré (${label})`);
  else if (prefs.includes(c.role)) out.push(`Rôle souhaité (${label})`);
  else if (prefs.length) out.push(`Rôle de dépannage (${label})`);
  else if ((pl.inp.role_games[c.role] ?? 0) > 0) out.push(`Rôle que tu joues souvent (${label})`);
  // contribution to the theme
  if (theme.thematic) {
    if (theme.pairsTheme) {
      const ids = new Set(picks.map((p) => p.champ.id));
      for (const [a, b, desc] of lorePairs()) {
        if ((c.champ.id === a || c.champ.id === b) && ids.has(a) && ids.has(b)) {
          const other = c.champ.id === a ? b : a;
          out.push(`Lien de lore avec ${ctx.catalog.name(other)} : ${desc}`);
          break;
        }
      }
    } else if (theme.isMember(c.champ)) {
      out.push(`Colle au thème : ${theme.label}`);
    }
  } else {
    let bestT: number | null = null;
    let bestV = 0.0;
    for (const [i, w] of theme.weights) {
      const v = c.champ.traits[i] * w;
      if (c.champ.traits[i] >= 2 && v > bestV) {
        bestT = i;
        bestV = v;
      }
    }
    if (bestT !== null) out.push(`Apporte ${TRAIT_FR[TRAITS[bestT]]} à la compo`);
  }
  return out;
}

function suggestion(ctx: Ctx, theme: ThemeDef, score: number, parts: Parts, picks: Cand[]): CompositionSuggestion {
  const champs = picks.map((c) => c.champ);
  const [strengths, warnings] = teamNotes(champs, theme.ignoreDamageMix);
  if (theme.thematic) {
    const members = theme.membersIn(champs).length;
    const need = theme.requiredMembers(champs.length);
    if (members >= need) {
      strengths.unshift(`Thème respecté : ${members}/${champs.length} champions « ${theme.label} »`);
    } else {
      warnings.unshift(`Thème partiellement respecté : ${members}/${champs.length} champions « ${theme.label} »`);
    }
  }
  if (ctx.enemy.length) {
    const lines = counterDetails(champs, ctx.enemy).sort((a, b) => cmpNum(b.threat, a.threat) || cmpStr(a.key, b.key));
    for (const l of lines) {
      if (l.threat >= 0.5 && l.answer >= 0.7) strengths.push(`Bonne réponse ${COUNTER_FR[l.key]}`);
      else if (l.threat >= 0.5 && l.answer < 0.4) warnings.push(`Peu de réponses ${COUNTER_FR[l.key]}`);
    }
  }
  const ordered = [...picks].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const sp: SuggestedPick[] = ordered.map((c) => ({
    role: c.role,
    champion_id: c.champ.id,
    player_id: ctx.players[c.pidx].inp.player_id,
    comfort: pyRound(c.comfort, 3),
    desire: pyRound(c.desire, 3),
    reasons: reasonsFor(ctx, theme, c, picks),
  }));
  return {
    theme: theme.key,
    theme_label: theme.label,
    score: pyRound(score * 100, 1),
    breakdown: {
      comfort: pyRound(parts.comfort * 100, 1),
      desire: pyRound(parts.desire * 100, 1),
      theme_fit: pyRound(parts.theme_fit * 100, 1),
      balance: pyRound(parts.balance * 100, 1),
      counter: parts.counter !== undefined ? pyRound(parts.counter * 100, 1) : null,
    },
    picks: sp,
    strengths: strengths.slice(0, 6),
    warnings: warnings.slice(0, 5),
  };
}

function differs(a: readonly KeyTuple[], b: readonly KeyTuple[], minDiff: number): boolean {
  const sa = new Set(a.map((t) => t.join('\u0001')));
  const sb = new Set(b.map((t) => t.join('\u0001')));
  let sym = 0;
  for (const x of sa) if (!sb.has(x)) sym += 1;
  for (const x of sb) if (!sa.has(x)) sym += 1;
  return Math.floor(sym / 2) >= minDiff;
}

function champSetKey(picks: readonly Cand[]): string {
  return [...new Set(picks.map((c) => c.champ.id))].sort(cmpStr).join('\u0001');
}

/** Unelided suggestions (the public wrapper applies French elision). */
export function generateCompositionsRaw(
  playersIn: PlayerInput[],
  optionsIn: GenerationOptions,
  catalog: Catalog,
): CompositionSuggestion[] {
  if (!playersIn.length) return [];
  if (playersIn.length > 5) throw new Error('Une composition compte au plus 5 joueurs');
  const options = normOptions(optionsIn);
  const ctx = prepare(playersIn.map(normPlayer), options, catalog);
  const count = options.count;
  const sat = (t: ThemeDef, picks: readonly Cand[]): boolean => t.satisfied(picks.map((c) => c.champ));

  const theme = getTheme(options.theme);
  if (theme !== null) {
    // repeated searches, each one penalising the picks already proposed -> diverse lineups
    let chosen: Found[] = [];
    const keys = new Set<string>();
    ctx.penalty = new Map();
    for (let it = 0; it < count * 2; it++) {
      if (chosen.filter((r) => sat(theme, r.picks)).length >= count) break;
      const found = search(ctx, theme, true, 16, 20, 3);
      const fresh = found.filter((r) => !keys.has(champSetKey(r.picks)));
      const ok = fresh.filter((r) => sat(theme, r.picks));
      const next = ok.length ? ok[0] : fresh.length ? fresh[0] : null;
      if (next === null) break;
      keys.add(champSetKey(next.picks));
      chosen.push(next);
      for (const c of next.picks) ctx.penalty.set(c.champ.id, (ctx.penalty.get(c.champ.id) ?? 0.0) + 0.02);
    }
    ctx.penalty = null;
    chosen = chosen.map((r) => {
      const [score, parts] = evaluate(ctx, theme, r.picks);
      return { score, parts, picks: r.picks, key: r.key };
    });
    if (chosen.some((r) => sat(theme, r.picks))) chosen = chosen.filter((r) => sat(theme, r.picks));
    chosen.sort(byStateScore);
    return chosen.slice(0, count).map((r) => suggestion(ctx, theme, r.score, r.parts, r.picks));
  }

  // automatic mode: best lineups across diverse themes
  const perTheme: [ThemeDef, Found[]][] = [];
  for (const t of allThemes()) {
    let found = search(ctx, t, false, 8, 14, 2);
    if (t.thematic) {
      // fun themes stay in the mix but a strategic lineup wins a tie
      found = found
        .filter((r) => sat(t, r.picks) && r.picks.length >= 3)
        .map((r) => ({ ...r, score: r.score * AUTO_THEMATIC_FACTOR }));
    }
    if (found.length) perTheme.push([t, found]);
  }
  perTheme.sort((a, b) => cmpNum(b[1][0].score, a[1][0].score) || cmpStr(a[0].key, b[0].key));
  const chosenT: [ThemeDef, Found][] = [];
  const keys: KeyTuple[][] = [];
  for (let depth = 0; depth < 3; depth++) {
    for (const [t, found] of perTheme) {
      if (chosenT.length >= count) break;
      if (depth >= found.length) continue;
      let r = found[depth];
      let k = r.key;
      if (keys.some((o) => !differs(k, o, depth === 0 ? 2 : 1))) {
        // same lineup already proposed under another theme: try the next one
        const alt = found.slice(depth + 1).find((x) => keys.every((o) => differs(x.key, o, 1)));
        if (alt === undefined) continue;
        r = alt;
        k = alt.key;
      }
      chosenT.push([t, r]);
      keys.push(k);
    }
    if (chosenT.length >= count) break;
  }
  chosenT.sort((a, b) => cmpNum(b[1].score, a[1].score) || cmpStr(a[0].key, b[0].key));
  return chosenT.map(([t, r]) => suggestion(ctx, t, r.score, r.parts, r.picks));
}
