// Game plan ("comment jouer la compo") and matchup plan ("comment jouer contre eux").
import type { GamePlan, LaneMatchup, MatchupPlan, PhasePlan, Pick, Role, RoleTip, ThreatInfo } from '../api/types';
import { counterDetails, DIVE_ARCHES, DPS_ARCHES, joinNames, SQUISHY_CARRY_ARCHES, teamNotes } from './analysis';
import { archetypeLabel, DAMAGE_ARCHETYPES, placeholderData, type ChampData, type Catalog } from './catalog';
import { cmpNum, cmpStr, pyRound } from './pycompat';
import {
  ARCH_JOB,
  ARCH_PLAY,
  ARCH_SPIKES,
  AVOID,
  ENEMY_WIN,
  FAMOUS_COMBOS,
  KNOCKUP_DUO,
  KNOCKUPS_LIST,
  LANE_RULES,
  LATE,
  MID,
  WIN,
} from './tables';
import { detectThemes, lorePairs, type ThemeDef } from './themes';

const ROLE_ORDER: readonly Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];

type Champ = ChampData;
type Fmt = Map<string, string>;
type Scored = [ThemeDef, number];

// --------------------------------------------------------------------------- team view

/** Python `==` between two ChampData dataclasses (`x in (a, b)`). */
function champEq(a: Champ | null, b: Champ | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.archetype === b.archetype &&
    a.damage === b.damage &&
    a.region === b.region &&
    a.traits.join(',') === b.traits.join(',') &&
    a.roles.join(',') === b.roles.join(',') &&
    [...a.groups].sort().join(',') === [...b.groups].sort().join(',')
  );
}

function best(champs: readonly Champ[], key: (c: Champ) => number, minimum = 0): Champ | null {
  let bestC: Champ | null = null;
  let bestV: number | null = null;
  for (const c of champs) {
    const v = key(c);
    if (v < minimum) continue;
    if (bestV === null || v > bestV || (v === bestV && bestC !== null && c.name < bestC.name)) {
      bestC = c;
      bestV = v;
    }
  }
  return bestC;
}

function carryScore(c: Champ): number {
  return (
    c.t.late * 2 +
    (DAMAGE_ARCHETYPES.has(c.archetype) ? 2 : 0) +
    (c.archetype === 'marksman' ? 1 : 0) +
    c.t.teamfight * 0.3
  );
}

class Team {
  constructor(readonly picks: [Role | null, Champ][]) {}

  get champs(): Champ[] {
    return this.picks.map(([, c]) => c);
  }

  byRole(role: Role): Champ | null {
    for (const [r, c] of this.picks) if (r === role) return c;
    return null;
  }

  get n(): number {
    return this.picks.length;
  }

  avg(trait: keyof Champ['t']): number {
    return this.n ? this.total(trait) / this.n : 0.0;
  }

  total(trait: keyof Champ['t']): number {
    let s = 0;
    for (const c of this.champs) s += c.t[trait];
    return s;
  }

  get engager(): Champ | null {
    return best(this.champs, (c) => c.t.engage * 2 + c.t.cc + c.t.frontline * 0.5, 4);
  }

  get carry(): Champ | null {
    return best(this.champs, carryScore, 0);
  }

  get frontliner(): Champ | null {
    return best(this.champs, (c) => c.t.frontline, 2);
  }

  get peeler(): Champ | null {
    const carry = this.carry;
    return best(
      this.champs.filter((c) => c !== carry),
      (c) => c.t.peel * 2 + c.t.cc * 0.5,
      4,
    );
  }

  get poker(): Champ | null {
    return best(this.champs, (c) => c.t.poke, 2);
  }

  get splitter(): Champ | null {
    return best(this.champs, (c) => c.t.splitpush, 3);
  }

  get picker(): Champ | null {
    return best(this.champs, (c) => c.t.pick * 2 + c.t.cc, 5);
  }

  get ccHolder(): Champ | null {
    return best(this.champs, (c) => c.t.cc, 2);
  }

  aoe(exclude: Champ | null = null): Champ | null {
    return best(
      this.champs.filter((c) => c !== exclude),
      (c) => c.t.teamfight + (DAMAGE_ARCHETYPES.has(c.archetype) ? 1 : 0),
      3,
    );
  }

  fmt(): Fmt {
    const d: Fmt = new Map();
    const roles: [string, Champ | null][] = [
      ['engager', this.engager],
      ['carry', this.carry],
      ['frontliner', this.frontliner],
      ['peeler', this.peeler],
      ['poker', this.poker],
      ['splitter', this.splitter],
      ['picker', this.picker],
    ];
    for (const [key, c] of roles) if (c !== null) d.set(key, c.name);
    const get = (k: string, dflt: string): string => d.get(k) ?? dflt;
    const setDefault = (k: string, v: string): void => {
      if (!d.has(k)) d.set(k, v);
    };
    const jg = this.byRole('JUNGLE');
    d.set('jungler', jg ? jg.name : 'votre jungler');
    const aoe = this.aoe(this.engager);
    d.set('tf', aoe ? aoe.name : get('carry', 'vos carries'));
    const divers = this.champs.filter(
      (c) => DIVE_ARCHES.has(c.archetype) || (c.archetype === 'vanguard' && c.t.mobility >= 2),
    );
    d.set('divers', joinNames(divers.slice(0, 3)) || get('engager', 'vos plongeurs'));
    const skArches = new Set(['skirmisher', 'diver', 'juggernaut', 'assassin']);
    const sk = this.champs.filter((c) => skArches.has(c.archetype));
    d.set('skirmishers', joinNames(sk.slice(0, 3)) || d.get('jungler')!);
    setDefault('carry', 'votre carry');
    setDefault('engager', get('frontliner', 'votre frontline'));
    setDefault('peeler', get('frontliner', 'votre support'));
    setDefault('poker', d.get('carry')!);
    setDefault('splitter', get('frontliner', d.get('carry')!));
    setDefault('picker', d.get('engager')!);
    setDefault('frontliner', d.get('engager')!);
    return d;
  }
}

function makeTeam(picks: readonly Pick[], catalog: Catalog): Team {
  const out: [Role | null, Champ][] = picks.map((p) => [
    p.role ?? null,
    catalog.data(p.champion_id) ?? placeholderData(p.champion_id),
  ]);
  const idx = (r: Role | null): number => (r !== null && ROLE_ORDER.includes(r) ? ROLE_ORDER.indexOf(r) : 9);
  out.sort((a, b) => idx(a[0]) - idx(b[0]));
  return new Team(out);
}

/** The playstyle used for strategic advice (thematic themes have no strategy of their own). */
function strategyTheme(themes: Scored[], team: Team): ThemeDef | null {
  for (const [t] of themes) if (!t.thematic) return t;
  for (const [t] of detectThemes(team.champs, 10)) if (!t.thematic) return t;
  return null;
}

function fill(text: string, fmt: Fmt): string {
  return text.replace(/\{(\w+)\}/g, (_m, k: string) => fmt.get(k) ?? 'votre équipe');
}

function F(fmt: Fmt, key: string): string {
  return fmt.get(key) ?? 'votre équipe';
}

// --------------------------------------------------------------------------- game plan

function identity(team: Team, themes: Scored[], strat: ThemeDef | null, prefix = 'Compo'): string {
  if (!team.n) return 'Aucun champion sélectionné.';
  const label = themes.length ? themes[0][0].label : 'équilibrée';
  let head = `${prefix} « ${label} »`;
  if (themes.length && themes[0][0].thematic && strat) head += ` jouée en « ${strat.label} »`;
  const roles: string[] = [];
  const eng = team.engager;
  const carry = team.carry;
  if (eng && eng !== carry) roles.push(`${eng.name} lance les combats`);
  if (carry) roles.push(`${carry.name} porte les dégâts`);
  const peel = team.peeler;
  if (
    peel &&
    !champEq(peel, eng) &&
    !champEq(peel, carry) &&
    ((strat && strat.key === 'protect_carry') || peel.t.peel >= 3)
  ) {
    roles.push(`${peel.name} protège ${carry ? carry.name : 'les carries'}`);
  }
  const split = team.splitter;
  if (split && !champEq(split, eng) && !champEq(split, carry) && strat && strat.key === 'split_push') {
    roles.push(`${split.name} met la pression en split push`);
  }
  const poke = team.poker;
  if (poke && poke !== carry && poke.t.poke >= 3 && roles.length < 3) {
    roles.push(`${poke.name} use l'adversaire à distance`);
  }
  if (!roles.length) return `${head}.`;
  return `${head} : ${roles.slice(0, -1).join(', ')}${roles.length > 1 ? ' et ' : ''}${roles[roles.length - 1]}.`;
}

function phasesOf(team: Team, strat: ThemeDef | null, fmt: Fmt): PhasePlan[] {
  const earlyAvg = team.avg('early');
  const lateAvg = team.avg('late');
  const tips: string[] = [];
  let summary: string;
  if (earlyAvg >= 2.2) summary = "Votre début de partie est fort : prenez l'initiative.";
  else if (earlyAvg <= 1.4) summary = 'Votre début de partie est faible : farmez et évitez les morts inutiles.';
  else summary = 'Début de partie équilibré : jouez vos lanes favorables.';
  const byName = (a: Champ, b: Champ): number => cmpStr(a.name, b.name);
  const strong = team.champs.filter((c) => c.t.early >= 3).sort(byName);
  const weak = team.champs.filter((c) => c.t.early <= 1 && c.t.late >= 3).sort(byName);
  for (const c of strong.slice(0, 2)) {
    tips.push(
      `${c.name} : gros potentiel en début de partie, cherche les échanges et les kills avant que l'adversaire ne scale`,
    );
  }
  for (const c of weak.slice(0, 2)) {
    tips.push(`${c.name} : début de partie difficile, farme en sécurité, son moment viendra`);
  }
  const jg = team.byRole('JUNGLE');
  if (jg) {
    const lanes = team.champs.filter((c) => c !== jg && c.t.early >= 2 && c.t.cc >= 2);
    const target = lanes.length ? lanes[0].name : null;
    if (jg.t.early >= 2) {
      tips.push(`${jg.name} peut ganker tôt${target ? `, en priorité avec ${target}` : ''} ou envahir`);
    } else {
      tips.push(`${jg.name} doit farmer et contre-ganker plutôt que de forcer des ganks`);
    }
  }
  if (strat && ['pick', 'skirmish', 'early_snowball'].includes(strat.key)) {
    tips.push('Prenez le contrôle de la vision autour du premier drake et des Larves du Néant');
  }
  const phases: PhasePlan[] = [{ phase: 'early', summary, tips }];

  const key = strat ? strat.key : 'engage';
  const [midS, midT] = MID[key] ?? MID.engage;
  const [lateS0, lateT] = LATE[key] ?? LATE.engage;
  let lateS = lateS0;
  const midTips = midT.map((t) => fill(t, fmt));
  const splitter = team.splitter;
  if (splitter && key !== 'split_push') {
    midTips.push(`${splitter.name} peut split push entre deux objectifs pour attirer l'attention`);
  }
  const lateTips = lateT.map((t) => fill(t, fmt));
  const carry = team.carry;
  if (carry && SQUISHY_CARRY_ARCHES.has(carry.archetype)) {
    const front = team.frontliner;
    lateTips.push(
      `${carry.name} se place derrière ${front ? front.name : "le reste de l'équipe"} et tape ce qui est à portée`,
    );
  }
  if (lateAvg >= 2.4) lateS += ' Le temps joue pour vous.';
  else if (lateAvg <= 1.5) lateS += " Attention : l'adversaire scale probablement mieux.";
  phases.push({ phase: 'mid', summary: fill(midS, fmt), tips: midTips });
  phases.push({ phase: 'late', summary: fill(lateS, fmt), tips: lateTips });
  return phases;
}

function spikesOf(team: Team, catalog: Catalog): string[] {
  const out: string[] = [];
  for (const [, c] of team.picks) {
    const spikes = catalog.meta(c.id).power_spikes;
    if (spikes.length) out.push(`${c.name} : ${spikes.slice(0, 2).join(', ')}`);
    else out.push(`${c.name} : ${ARCH_SPIKES[c.archetype] ?? ARCH_SPIKES.specialist}`);
  }
  return out;
}

function combosOf(team: Team): string[] {
  const ids = new Map<string, Champ>();
  for (const c of team.champs) ids.set(c.id, c);
  const out: string[] = [];
  const usedPairs = new Set<string>();

  const add = (a: Champ, b: Champ, text: string): void => {
    const pair = a.id === b.id ? a.id : [a.id, b.id].sort(cmpStr).join('\u0001');
    if (usedPairs.has(pair) || a === b) return;
    usedPairs.add(pair);
    out.push(`${a.name} + ${b.name} : ${text}`);
  };

  for (const [a, b, text] of FAMOUS_COMBOS) {
    if (ids.has(a) && ids.has(b)) add(ids.get(a)!, ids.get(b)!, text);
  }
  for (const [duo, text] of Object.entries(KNOCKUP_DUO)) {
    if (ids.has(duo)) {
      for (const k of KNOCKUPS_LIST) {
        if (ids.has(k) && k !== duo) {
          const kc = ids.get(k)!;
          add(kc, ids.get(duo)!, `${kc.name} projette les adversaires en l'air, ${text}`);
          break;
        }
      }
    }
  }
  const eng = team.engager;
  if (eng && eng.t.engage >= 3) {
    const aoe = team.aoe(eng);
    if (aoe) add(eng, aoe, `${eng.name} engage, ${aoe.name} déclenche ses dégâts de zone sur les cibles regroupées`);
  }
  const carry = team.carry;
  const peel = team.peeler;
  if (carry && peel && carry.t.late >= 3 && peel.t.peel >= 2) {
    add(
      peel,
      carry,
      `${peel.name} garde ${carry.name} en vie : plus le combat dure, plus ${carry.name} fait de dégâts`,
    );
  }
  const catcher = best(
    team.champs.filter((c) => c.t.pick >= 3 && c.t.cc >= 2),
    (c) => c.t.cc + c.t.pick,
    0,
  );
  const burst = best(
    team.champs.filter((c) => c !== catcher && (c.archetype === 'assassin' || c.archetype === 'burst_mage')),
    (c) => c.t.pick,
    0,
  );
  if (catcher && burst) {
    add(catcher, burst, `${catcher.name} immobilise une cible, ${burst.name} la tue avant qu'elle ne réagisse`);
  }
  const divers = team.champs.filter((c) => DIVE_ARCHES.has(c.archetype) && c.t.mobility >= 2);
  if (divers.length >= 2) add(divers[0], divers[1], 'plongez ensemble sur la même cible pour la tuer instantanément');
  const pairs = lorePairs().filter(([a, b]) => ids.has(a) && ids.has(b));
  for (const [a, b, d] of pairs.slice(0, 1)) {
    add(ids.get(a)!, ids.get(b)!, `lien de lore (${d}) : jouez-les ensemble sur la même lane ou le même côté`);
  }
  return out.slice(0, 5);
}

function objectivesOf(team: Team, strat: ThemeDef | null, fmt: Fmt): string[] {
  const out: string[] = [];
  const early = team.avg('early');
  const late = team.avg('late');
  const key = strat ? strat.key : '';
  if (early >= 2 || ['early_snowball', 'skirmish', 'dive'].includes(key)) {
    out.push(
      `Larves du Néant et Héraut : prenez-les tôt avec la priorité de lane, ${F(fmt, 'jungler')} en tête`,
    );
    out.push('Drakes : contestez dès le premier, votre début de partie le permet');
  } else {
    out.push(
      'Premiers drakes : ne les contestez que si vos lanes ont la priorité, sinon échangez (Larves, farm, plaques)',
    );
  }
  if (key === 'poke_siege' || team.total('poke') >= 6) {
    out.push('Tours : utilisez le Héraut et la poke pour prendre les plaques et les tours extérieures');
  }
  const splitter = team.splitter;
  if (splitter) {
    out.push(`Tours latérales : ${splitter.name} les fait tomber pendant que l'équipe menace un objectif`);
  }
  const fast = team.champs.filter((c) => c.t.objective >= 3).sort((a, b) => cmpStr(a.name, b.name));
  if (fast.length) {
    out.push(`${joinNames(fast.slice(0, 2))} tape(nt) très vite les objectifs : Nashor rapide possible après un pick`);
  }
  if (late >= 2.3) {
    out.push(
      'Âme du dragon et Nashor : vos combats de fin de partie sont les plus forts, jouez-les sans vous précipiter',
    );
  } else {
    out.push('Nashor : prenez-le après un combat gagné ou un pick sur un carry adverse');
  }
  return out;
}

function roleTipsOf(team: Team, strat: ThemeDef | null, catalog: Catalog): RoleTip[] {
  const tipsOut: RoleTip[] = [];
  const eng = team.engager;
  const carry = team.carry;
  const peel = team.peeler;
  const front = team.frontliner;
  const split = team.splitter;
  const poke = team.poker;
  const picker = team.picker;
  for (const [role, c] of team.picks) {
    const tips: string[] = [];
    const play = catalog.meta(c.id).playstyle || (ARCH_PLAY[c.archetype] ?? '');
    if (play) tips.push(play);
    if (c === carry) {
      tips.push(
        `Ton job : faire les dégâts. Reste derrière ${front && front !== c ? front.name : 'ta frontline'} et tape ce qui est à portée.`,
      );
    } else if (c === eng) {
      const target = carry ? carry.name : 'tes carries';
      tips.push(`Ton job : lancer les combats. Engage quand ${target} est à portée pour suivre.`);
    } else if (c === peel) {
      tips.push(
        `Ton job : protéger ${carry ? carry.name : 'tes carries'}. Garde tes sorts pour les plongeurs adverses.`,
      );
    } else if (c === split && strat && strat.key === 'split_push') {
      tips.push(
        'Ton job : pousser une lane latérale et attirer plusieurs adversaires. Garde Téléportation ou une sortie.',
      );
    } else if (c === poke && c.t.poke >= 3) {
      tips.push("Ton job : user l'adversaire avant les combats sans te mettre à portée d'engage.");
    } else if (c === picker) {
      tips.push('Ton job : attraper une cible isolée. Joue autour de la vision et des buissons.');
    } else if (c === front) {
      tips.push('Ton job : encaisser en première ligne et absorber les sorts adverses.');
    } else {
      tips.push(
        ARCH_JOB[c.archetype] ??
          "Ton job : apporter tes dégâts et tes contrôles en suivant l'engage de l'équipe.",
      );
    }
    if (role === 'JUNGLE') {
      const strong = team.champs.filter((x) => x !== c && x.t.early >= 2 && x.t.cc >= 2);
      if (strong.length) tips.push(`Joue autour des lanes fortes (${joinNames(strong.slice(0, 2))}) pour tes ganks.`);
    } else if (role === 'SUPPORT' && carry && carry !== c) {
      tips.push(
        `Vision : prépare les objectifs 1 minute à l'avance et ne laisse pas ${carry.name} sans couverture.`,
      );
    }
    tipsOut.push({ role: role as Role, champion_id: c.id, tips: tips.slice(0, 3) });
  }
  return tipsOut;
}

function avoidOf(team: Team, strat: ThemeDef | null, fmt: Fmt): string[] {
  const out = (AVOID[strat ? strat.key : ''] ?? []).map((t) => fill(t, fmt));
  const [, warnings] = teamNotes(team.champs);
  const joined = warnings.join(' ');
  if (joined.includes('Pas de frontline')) {
    out.push("Se faire engager en ligne droite : sans frontline, gardez vos distances et vos sorts défensifs");
  }
  if (joined.includes('100% AD') || joined.includes('majoritairement AD')) {
    out.push("Les combats longs contre une équipe qui empile l'armure : cherchez les picks");
  }
  if (joined.includes('100% AP') || joined.includes('majoritairement AP')) {
    out.push('Les combats longs contre une équipe qui empile la résistance magique : cherchez les picks');
  }
  if (joined.includes('Waveclear faible')) {
    out.push('Laisser les vagues s\'accumuler sur vos tours : vous aurez du mal à défendre');
  }
  if (joined.includes("Peu d'engage")) {
    out.push(
      "Attendre que l'adversaire fasse une erreur sans créer de pression : poussez les vagues et prenez la vision",
    );
  }
  if (team.avg('late') >= 2.4 && (!strat || strat.key !== 'scaling')) {
    out.push(`Les combats inutiles avant que ${F(fmt, 'carry')} ait ses objets`);
  }
  return out.slice(0, 5);
}

function damageProfile(team: Team): Record<string, number> {
  const weights: Record<string, number> = { AD: 0.0, AP: 0.0, MIXED: 0.0 };
  const mid = new Set(['juggernaut', 'diver', 'specialist']);
  for (const c of team.champs) {
    const w = DAMAGE_ARCHETYPES.has(c.archetype) ? 1.5 : mid.has(c.archetype) ? 1.0 : 0.5;
    weights[c.damage in weights ? c.damage : 'MIXED'] += w;
  }
  const keys = ['AD', 'AP', 'MIXED'];
  let total = 0;
  for (const k of keys) total += weights[k];
  if (total <= 0) return { AD: 0.0, AP: 0.0, MIXED: 0.0 };
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = pyRound(weights[k] / total, 3);
  let s = 0;
  for (const k of keys) s += out[k];
  const drift = pyRound(1.0 - s, 3);
  let top = keys[0];
  for (const k of keys) if (out[k] > out[top]) top = k;
  out[top] = pyRound(out[top] + drift, 3);
  return out;
}

/** Unelided game plan (the public wrapper applies French elision). */
export function buildGamePlanRaw(picks: Pick[], catalog: Catalog): GamePlan {
  const team = makeTeam(picks, catalog);
  const themes = detectThemes(team.champs);
  const strat = strategyTheme(themes, team);
  const fmt = team.fmt();
  let win = strat ? (WIN[strat.key] ?? []).map((t) => fill(t, fmt)) : [];
  if (themes.length && themes[0][0].thematic) {
    win.push(`Assumer le thème « ${themes[0][0].label} » : jouez sur les forces de vos champions`);
  }
  if (!win.length) win = ['Jouer groupé autour des objectifs'];
  if (!team.n) {
    return {
      identity: 'Aucun champion sélectionné.',
      detected_themes: [],
      win_conditions: [],
      phases: [],
      power_spikes: [],
      key_combos: [],
      objectives: [],
      role_tips: [],
      avoid: [],
      damage_profile: { AD: 0.0, AP: 0.0, MIXED: 0.0 },
    };
  }
  return {
    identity: identity(team, themes, strat),
    detected_themes: themes.map(([t]) => t.key),
    win_conditions: win,
    phases: phasesOf(team, strat, fmt),
    power_spikes: spikesOf(team, catalog),
    key_combos: combosOf(team),
    objectives: objectivesOf(team, strat, fmt),
    role_tips: roleTipsOf(team, strat, catalog),
    avoid: avoidOf(team, strat, fmt),
    damage_profile: damageProfile(team),
  };
}

// --------------------------------------------------------------------------- matchup plan

function howToWin(ours: Team, enemy: Team, ourStrat: ThemeDef | null, theirFmt: Fmt): string[] {
  const out: string[] = [];
  const fmt = ours.fmt();
  if (ourStrat && (WIN[ourStrat.key] ?? []).length) {
    const s = fill(WIN[ourStrat.key][0], fmt);
    out.push(`Votre plan : ${s[0].toLowerCase()}${s.slice(1)}`);
  }
  const lines = counterDetails(ours.champs, enemy.champs).sort(
    (a, b) => cmpNum(b.threat, a.threat) || cmpStr(a.key, b.key),
  );
  const eng = ours.engager;
  const peel = ours.peeler;
  const cc = ours.ccHolder;
  for (const l of lines) {
    if (l.threat < 0.45 || out.length >= 5) continue;
    if (l.key === 'dive') {
      const protector = peel ?? ours.frontliner ?? cc;
      const divers = enemy.champs.filter((c) => DIVE_ARCHES.has(c.archetype));
      const top = divers.length ? divers[0].name : 'leurs plongeurs';
      if (protector) {
        out.push(
          `Leur dive vise vos carries : restez groupés autour de ${protector.name} et gardez vos contrôles pour ${top}`,
        );
      } else {
        out.push(`Leur dive vise vos carries : jouez groupés et gardez Flash / sorts défensifs pour ${top}`);
      }
    } else if (l.key === 'poke') {
      if (eng && eng.t.engage >= 2) {
        out.push(`Ne subissez pas leur poke : ${eng.name} doit engager vite ou contourner par un flanc`);
      } else {
        out.push('Ne restez pas sous leur poke : reculez pour vous soigner et défendez sous tour avec le waveclear');
      }
    } else if (l.key === 'engage') {
      let text = `Espacez-vous face à l'engage de ${F(theirFmt, 'engager')}`;
      if (peel) text += `, puis ${peel.name} contre-engage sur ceux qui ont plongé`;
      out.push(text);
    } else if (l.key === 'split') {
      const ans = ours.splitter ?? best(ours.champs, (c) => c.t.waveclear + c.t.frontline, 0);
      out.push(
        `${ans ? ans.name : 'Un joueur solide'} répond à ${F(theirFmt, 'splitter')} ; les autres forcent un objectif à 5 contre 4`,
      );
    } else if (l.key === 'pick') {
      out.push(
        `Déplacez-vous groupés et wardez avant d'entrer dans la jungle : ${F(theirFmt, 'picker')} attend un isolé`,
      );
    } else if (l.key === 'frontline') {
      const dps = ours.champs.filter((c) => DPS_ARCHES.has(c.archetype));
      const who = dps.length ? dps[0].name : 'vos carries';
      out.push(
        `Leur frontline est épaisse : ${who} tape ce qui est à portée, ne forcez pas un accès impossible à leurs carries`,
      );
    } else if (l.key === 'early') {
      if (ours.avg('early') + 0.3 < enemy.avg('early')) {
        out.push(
          'Ils sont plus forts tôt : jouez safe, wardez contre les ganks et cédez un objectif plutôt que de perdre un combat',
        );
      } else {
        out.push(
          'Vous tenez la comparaison en début de partie : contestez leurs invades et leurs premiers objectifs',
        );
      }
    } else if (l.key === 'late') {
      if (ours.avg('late') + 0.3 < enemy.avg('late')) {
        out.push(`Ils scalent mieux (${F(theirFmt, 'carry')}) : prenez l'avance tôt et finissez avant leurs objets`);
      } else {
        out.push('Vous scalez au moins aussi bien : pas de précipitation, gagnez les combats de fin de partie');
      }
    }
  }
  if (ours.avg('early') >= enemy.avg('early') + 0.4 && !out.some((t) => t.includes('finissez'))) {
    out.push('Vous êtes plus forts tôt : forcez les combats et les objectifs avant 20 minutes');
  } else if (ours.avg('late') >= enemy.avg('late') + 0.4 && !out.some((t) => t.includes('scalez'))) {
    out.push(
      'Vous êtes plus forts en fin de partie : limitez la casse au début et jouez les gros objectifs plus tard',
    );
  }
  return out.slice(0, 6);
}

function threatValue(c: Champ, ours: Team): number {
  let v = (c.t.late + c.t.early) / 2 + (DAMAGE_ARCHETYPES.has(c.archetype) ? 2.0 : 0.0);
  v += 0.5 * c.t.pick + (c.t.engage >= 3 ? 0.8 : 0.0);
  const ourPeel = ours.total('peel') + 0.5 * ours.total('frontline');
  const n = Math.max(1, ours.n);
  if (DIVE_ARCHES.has(c.archetype) && ourPeel / n < 1.5) v += 1.5;
  if (c.t.poke >= 3 && ours.avg('engage') < 1.4) v += 1.0;
  if (c.t.engage >= 3 && ours.avg('peel') < 1.2) v += 1.0;
  if (c.t.splitpush >= 3 && ours.avg('waveclear') < 1.6) v += 1.0;
  if (c.t.pick >= 3 && ours.avg('mobility') < 1.2) v += 0.8;
  return v;
}

function threatWhy(c: Champ, ours: Team): string {
  const parts: string[] = [];
  const squishy = ours.champs.filter((x) => SQUISHY_CARRY_ARCHES.has(x.archetype));
  const carry = ours.carry;
  const target = squishy.length ? squishy[0].name : carry ? carry.name : 'vos carries';
  if (c.archetype === 'assassin') {
    parts.push(`assassin capable de tuer ${target} en un seul combo`);
  } else if ((c.archetype === 'diver' || c.archetype === 'skirmisher') && c.t.mobility >= 2) {
    parts.push(`plonge facilement sur ${target}`);
  }
  if (c.t.engage >= 3) parts.push("peut lancer un engage sur plusieurs d'entre vous");
  if (c.t.poke >= 3) parts.push('sa poke va vous user avant chaque combat');
  if (c.t.splitpush >= 3) parts.push('gagne les duels et met la pression en split push');
  if (c.t.pick >= 3 && c.archetype !== 'assassin') parts.push('peut attraper un joueur isolé');
  if (c.t.late >= 3 && DAMAGE_ARCHETYPES.has(c.archetype)) {
    parts.push('devient la principale source de dégâts en fin de partie');
  } else if (c.t.early >= 3) {
    parts.push('très fort en début de partie');
  }
  if (!parts.length) parts.push(`${archetypeLabel(c.archetype).toLowerCase()} qui apporte beaucoup à son équipe`);
  const text = `${c.name} : ${parts.slice(0, 2).join(', ')}`;
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function stripDots(s: string): string {
  return s.replace(/\.+$/, '');
}

function threatHandle(c: Champ, ours: Team, catalog: Catalog): string {
  const parts: string[] = [];
  const tips = catalog.meta(c.id).counter_tips;
  if (tips) parts.push(`${stripDots(tips.trim())}.`);
  const cc = ours.ccHolder;
  if (DIVE_ARCHES.has(c.archetype) && cc) {
    parts.push(`Gardez les contrôles de ${cc.name} pour sa plongée.`);
  } else if (['marksman', 'artillery', 'burst_mage', 'battlemage'].includes(c.archetype)) {
    const diver = best(
      ours.champs.filter((x) => DIVE_ARCHES.has(x.archetype) || x.t.engage >= 3),
      (x) => x.t.mobility + x.t.engage,
      0,
    );
    if (diver) parts.push(`${diver.name} doit l'atteindre en priorité dans les combats.`);
    else parts.push("Forcez-le à se rapprocher : attendez qu'il gaspille ses sorts avant d'engager.");
  } else if (c.t.splitpush >= 3) {
    const ans = ours.splitter ?? ours.frontliner;
    if (ans) parts.push(`${ans.name} peut le contenir en lane latérale ; sinon prenez un objectif à 5 contre 4.`);
  } else if (c.t.engage >= 3) {
    parts.push('Ne restez pas groupés en ligne droite et punissez-le quand son engage est en recharge.');
  }
  if (!parts.length) parts.push('Wardez sa position et ne lui donnez pas de kill gratuit.');
  return parts.slice(0, 2).join(' ');
}

function category(c: Champ): string {
  const a = c.archetype;
  if (a === 'vanguard' || a === 'warden') return 'tank';
  if (a === 'juggernaut' || a === 'diver' || a === 'skirmisher') return 'fighter';
  if (a === 'assassin') return 'assassin';
  if (a === 'burst_mage' || a === 'battlemage' || a === 'artillery') return 'mage';
  if (a === 'marksman') return 'marksman';
  if (a === 'enchanter' || a === 'catcher') return a;
  return 'other';
}

function laneAdvice(a: Champ, e: Champ, catalog: Catalog): string {
  const parts: string[] = [];
  const rule = LANE_RULES[`${category(a)}|${category(e)}`];
  if (rule) parts.push(rule);
  const diff = a.t.early - e.t.early;
  if (diff >= 1) {
    parts.push(`Avantage ${a.name} en début de partie : joue agressif avant le niveau 6.`);
  } else if (diff <= -1) {
    parts.push(
      `Avantage ${e.name} en début de partie : évite les échanges longs${
        a.t.late > e.t.late ? ' et attends ton scaling.' : " et attends l'aide de ton jungler."
      }`,
    );
  }
  if (e.t.poke >= 3 && a.t.poke <= 1) {
    parts.push(`${e.name} harcèle à distance : reste derrière les sbires et engage quand ses sorts sont en recharge.`);
  }
  if (e.t.mobility >= 3 && a.t.cc >= 2) {
    parts.push(`${e.name} est très mobile : garde tes contrôles pour son entrée en combat.`);
  }
  if (e.t.splitpush >= 3 && a.t.splitpush < 2) {
    parts.push(`Ne laisse pas ${e.name} split sans réponse : signale ses déplacements à ton équipe.`);
  }
  const tips = catalog.meta(e.id).counter_tips;
  if (tips) {
    const first = stripDots(tips.split('. ')[0].trim());
    parts.push(`${first}.`);
  }
  if (!parts.length) parts.push('Matchup équilibré : farme proprement et joue autour de ton jungler.');
  return parts.slice(0, 3).join(' ');
}

function suggestedBans(ours: Team, enemy: Team, catalog: Catalog, limit = 3): string[] {
  if (!ours.n) return [];
  const taken = new Set([...ours.champs.map((c) => c.id), ...enemy.champs.map((c) => c.id)]);
  const n = ours.n;
  const ourPeel = (ours.total('peel') + 0.5 * ours.total('frontline')) / n;
  const ourEngage = ours.avg('engage');
  const ourMob = ours.avg('mobility');
  const ourWc = ours.avg('waveclear');
  const ourEarly = ours.avg('early');
  const ourLate = ours.avg('late');
  const ourPeelAvg = ours.avg('peel');
  const hasSquishyCarry = ours.champs.some((c) => SQUISHY_CARRY_ARCHES.has(c.archetype));
  const scored: [number, string][] = [];
  for (const c of catalog.allData()) {
    if (taken.has(c.id) || !c.roles.length) continue;
    let s = 0.0;
    if (DIVE_ARCHES.has(c.archetype) && hasSquishyCarry) s += (c.t.mobility + c.t.pick) * (ourPeel < 1.5 ? 1.3 : 0.6);
    if (c.t.poke >= 3) s += c.t.poke * (ourEngage < 1.4 ? 1.2 : 0.4);
    if (c.t.pick >= 3) s += c.t.pick * (ourMob < 1.3 ? 1.0 : 0.4);
    if (c.t.engage >= 3) s += c.t.engage * (ourPeelAvg < 1.2 ? 1.0 : 0.4);
    if (c.t.splitpush >= 3) s += c.t.splitpush * (ourWc < 1.6 ? 1.0 : 0.3);
    if (ourLate > ourEarly + 0.4) s += c.t.early * 0.8;
    else if (ourEarly > ourLate + 0.4) s += c.t.late * 0.8;
    let sumTraits = 0;
    for (const v of c.traits) sumTraits += v;
    s += sumTraits * 0.05;
    scored.push([s, c.id]);
  }
  scored.sort((a, b) => cmpNum(b[0], a[0]) || cmpStr(a[1], b[1]));
  return scored.slice(0, limit).map(([, cid]) => cid);
}

function objectivesVs(ours: Team, enemy: Team, theirStrat: ThemeDef | null, theirFmt: Fmt): string[] {
  const out: string[] = [];
  const oe = ours.avg('early');
  const ee = enemy.avg('early');
  const ol = ours.avg('late');
  const el = enemy.avg('late');
  if (oe >= ee + 0.3) {
    out.push('Larves du Néant et premiers drakes : contestez-les, vous êtes plus forts tôt');
  } else if (oe + 0.3 <= ee) {
    out.push(
      "Premiers objectifs : cédez-les s'ils sont mieux placés et prenez l'objectif de l'autre côté de la carte",
    );
  } else {
    out.push(
      'Premiers objectifs : celui qui a la priorité en mid et bot doit les prendre, suivez la priorité de lane',
    );
  }
  if (theirStrat && theirStrat.key === 'poke_siege') {
    out.push(
      'Ne défendez pas une tour sous leur poke : engagez avant le siège ou laissez-la et prenez un objectif ailleurs',
    );
  }
  if ((theirStrat && theirStrat.key === 'split_push') || enemy.splitter) {
    out.push(`Gardez vos tours latérales sous vision face à ${F(theirFmt, 'splitter')}`);
  }
  if (ol >= el + 0.3) {
    out.push('Nashor et Âme du dragon : le temps joue pour vous, ne les forcez pas trop tôt');
  } else if (ol + 0.3 <= el) {
    out.push(`Nashor : prenez-le dès qu'un carry adverse (${F(theirFmt, 'carry')}) meurt, avant qu'ils ne scalent`);
  } else {
    out.push('Nashor : à jouer après un pick ou un combat gagné');
  }
  const splitter = ours.splitter;
  if (splitter) out.push(`${splitter.name} peut forcer des tours latérales pendant qu'ils regardent le drake`);
  return out;
}

/** Unelided matchup plan (the public wrapper applies French elision). */
export function buildMatchupPlanRaw(ally: Pick[], enemy: Pick[], catalog: Catalog): MatchupPlan {
  const ours = makeTeam(ally, catalog);
  const theirs = makeTeam(enemy, catalog);
  const theirThemes = detectThemes(theirs.champs);
  const theirStrat = theirs.n ? strategyTheme(theirThemes, theirs) : null;
  const ourThemes = detectThemes(ours.champs);
  const ourStrat = ours.n ? strategyTheme(ourThemes, ours) : null;
  const theirFmt = theirs.fmt();

  if (!theirs.n) {
    const fmt = ours.fmt();
    return {
      enemy_identity: 'Aucun champion adverse renseigné.',
      enemy_themes: [],
      enemy_win_conditions: [],
      how_to_win: ourStrat ? (WIN[ourStrat.key] ?? []).map((t) => fill(t, fmt)) : [],
      threats: [],
      lane_matchups: [],
      objectives: [],
      suggested_bans: suggestedBans(ours, theirs, catalog),
    };
  }

  const enemyWin: string[] = [];
  if (theirStrat) enemyWin.push(fill(ENEMY_WIN[theirStrat.key], theirFmt));
  for (const [t] of theirThemes.slice(1)) {
    if (!t.thematic && t !== theirStrat && t.key in ENEMY_WIN) enemyWin.push(fill(ENEMY_WIN[t.key], theirFmt));
  }
  if (theirs.avg('late') >= 2.4 && !enemyWin.some((w) => w.includes('fin de partie'))) {
    enemyWin.push(`Atteindre la fin de partie, où ${F(theirFmt, 'carry')} fait des dégâts énormes`);
  }
  if (theirs.avg('early') >= 2.2 && !enemyWin.some((w) => w.includes('tôt'))) {
    enemyWin.push("Prendre l'avance en début de partie et ne jamais la rendre");
  }

  const values = new Map<Champ, number>();
  for (const c of theirs.champs) values.set(c, threatValue(c, ours));
  const ranked = [...theirs.champs].sort((a, b) => cmpNum(values.get(b)!, values.get(a)!) || cmpStr(a.name, b.name));
  const threats: ThreatInfo[] = [];
  const count = Math.max(2, Math.min(4, theirs.n));
  ranked.slice(0, count).forEach((c, rank) => {
    const v = threatValue(c, ours);
    let danger = v >= 6 ? 3 : v >= 4 ? 2 : 1;
    if (rank === 0) danger = Math.max(danger, 2);
    threats.push({
      champion_id: c.id,
      danger,
      why: threatWhy(c, ours),
      how_to_handle: threatHandle(c, ours, catalog),
    });
  });

  const lanes: LaneMatchup[] = [];
  for (const role of ROLE_ORDER) {
    const a = ours.byRole(role);
    const e = theirs.byRole(role);
    if (a && e) {
      lanes.push({ role, ally_champion_id: a.id, enemy_champion_id: e.id, advice: laneAdvice(a, e, catalog) });
    }
  }

  return {
    enemy_identity: identity(theirs, theirThemes, theirStrat, 'Compo adverse'),
    enemy_themes: theirThemes.map(([t]) => t.key),
    enemy_win_conditions: enemyWin,
    how_to_win: ours.n ? howToWin(ours, theirs, ourStrat, theirFmt) : [],
    threats,
    lane_matchups: lanes,
    objectives: objectivesVs(ours, theirs, theirStrat, theirFmt),
    suggested_bans: suggestedBans(ours, theirs, catalog),
  };
}
