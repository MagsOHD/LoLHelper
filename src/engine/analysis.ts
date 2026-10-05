// Team-level analysis shared by the generator and the plans: balance, counters, notes.
import { TRAIT_INDEX as I, TRAITS, type ChampData } from './catalog';
import { cmpNum, cmpStr } from './pycompat';
import type { TraitName } from './traits';

export const DIVE_ARCHES: ReadonlySet<string> = new Set(['assassin', 'diver', 'skirmisher']);
export const DPS_ARCHES: ReadonlySet<string> = new Set(['marksman', 'juggernaut', 'battlemage', 'skirmisher']);
export const SQUISHY_CARRY_ARCHES: ReadonlySet<string> = new Set(['marksman', 'artillery', 'burst_mage', 'battlemage']);

export function teamSums(champs: readonly ChampData[]): number[] {
  const sums = new Array<number>(TRAITS.length).fill(0);
  for (const c of champs) {
    const tr = c.traits;
    for (let i = 0; i < tr.length; i++) sums[i] += tr[i];
  }
  return sums;
}

export function apShare(champs: readonly ChampData[]): number {
  if (!champs.length) return 0.5;
  let ap = 0;
  for (const c of champs) ap += c.damage === 'AP' ? 1.0 : c.damage === 'MIXED' ? 0.5 : 0.0;
  return ap / champs.length;
}

export function damageMixScore(champs: readonly ChampData[]): number {
  const share = apShare(champs);
  if (share >= 0.25 && share <= 0.75) return 1.0;
  const dist = share < 0.25 ? 0.25 - share : share - 0.75;
  return Math.max(0.2, 1.0 - dist * 3.2);
}

/** 0..1 'can this lineup actually play the game' score (a.k.a. balance). */
export function viability(champs: readonly ChampData[], sums?: readonly number[] | null, ignoreDamage = false): number {
  const n = champs.length;
  if (n === 0) return 0.0;
  const s = sums ?? teamSums(champs);
  const f = n / 5;
  let maxFront = -Infinity;
  for (const c of champs) maxFront = Math.max(maxFront, c.traits[I.frontline]);
  const front = Math.min(1.0, s[I.frontline] / (4 * f)) * (maxFront >= 2 ? 1.0 : 0.6);
  const engagePeel = Math.min(1.0, Math.max(s[I.engage] / (4 * f), s[I.peel] / (4 * f)));
  const cc = Math.min(1.0, s[I.cc] / (6 * f));
  const wc = Math.min(1.0, s[I.waveclear] / (6 * f));
  const parts: [number, number][] = [
    [0.25, front],
    [0.2, engagePeel],
    [0.1, cc],
    [0.15, wc],
  ];
  if (!ignoreDamage && n >= 3) parts.push([0.3, damageMixScore(champs)]);
  let tot = 0;
  for (const [w] of parts) tot += w;
  let acc = 0;
  for (const [w, v] of parts) acc += w * v;
  return acc / tot;
}

// --------------------------------------------------------------------------- counters

export interface CounterLine {
  key: string; // dive, poke, engage, split, pick, frontline, early, late
  threat: number; // 0..1 how much the enemy relies on it
  answer: number; // 0..1 how well we answer it
}

export function counterDetails(ours: readonly ChampData[], enemy: readonly ChampData[]): CounterLine[] {
  if (!ours.length || !enemy.length) return [];
  const o = teamSums(ours);
  const e = teamSums(enemy);
  const no = ours.length;
  const ne = enemy.length;
  const avg = (s: readonly number[], t: TraitName, n: number): number => s[I[t]] / n;

  let diveThreat = 0;
  for (const c of enemy) {
    if (DIVE_ARCHES.has(c.archetype)) diveThreat += (c.traits[I.mobility] + c.traits[I.pick]) / 6;
  }
  let enemyMaxSplit = -Infinity;
  for (const c of enemy) enemyMaxSplit = Math.max(enemyMaxSplit, c.traits[I.splitpush]);
  let ourMaxSplit = -Infinity;
  for (const c of ours) ourMaxSplit = Math.max(ourMaxSplit, c.traits[I.splitpush]);
  let dps = 0;
  for (const c of ours) if (DPS_ARCHES.has(c.archetype) || c.traits[I.late] >= 3) dps += 1;

  return [
    {
      key: 'dive',
      threat: Math.min(1.0, diveThreat / 2),
      answer: Math.min(1.0, (o[I.peel] + 0.5 * o[I.cc] + 0.5 * o[I.frontline]) / (no * 1.8)),
    },
    {
      key: 'poke',
      threat: Math.min(1.0, avg(e, 'poke', ne) / 1.6),
      answer: Math.min(1.0, (o[I.engage] + 0.5 * o[I.sustain] + 0.3 * o[I.mobility]) / (no * 1.4)),
    },
    {
      key: 'engage',
      threat: Math.min(1.0, avg(e, 'engage', ne) / 1.6),
      answer: Math.min(1.0, (o[I.peel] + 0.5 * o[I.cc] + 0.3 * o[I.poke]) / (no * 1.6)),
    },
    {
      key: 'split',
      threat: Math.min(1.0, enemyMaxSplit / 3) * 0.8,
      answer: Math.min(1.0, (0.6 * o[I.waveclear]) / (no * 1.8) + (0.4 * ourMaxSplit) / 3),
    },
    {
      key: 'pick',
      threat: Math.min(1.0, avg(e, 'pick', ne) / 1.6),
      answer: Math.min(1.0, (o[I.peel] + 0.6 * o[I.frontline] + 0.3 * o[I.mobility]) / (no * 1.6)),
    },
    {
      key: 'frontline',
      threat: Math.min(1.0, avg(e, 'frontline', ne) / 1.6),
      answer: Math.min(1.0, dps / 2),
    },
    {
      key: 'early',
      threat: Math.max(0.0, Math.min(1.0, (avg(e, 'early', ne) - 1.2) / 1.3)),
      answer: Math.max(
        0.0,
        Math.min(1.0, 0.5 + (avg(o, 'early', no) - avg(e, 'early', ne)) / 1.5 + (0.2 * avg(o, 'peel', no)) / 3),
      ),
    },
    {
      key: 'late',
      threat: Math.max(0.0, Math.min(1.0, (avg(e, 'late', ne) - 1.2) / 1.3)),
      answer: Math.max(
        0.0,
        Math.min(
          1.0,
          0.5 + (avg(o, 'early', no) - avg(e, 'early', ne)) / 1.5 + (avg(o, 'late', no) - avg(e, 'late', ne)) / 2,
        ),
      ),
    },
  ];
}

export function counterScore(ours: readonly ChampData[], enemy: readonly ChampData[]): number {
  const lines = counterDetails(ours, enemy);
  if (!lines.length) return 0.5;
  let tot = 0;
  for (const l of lines) tot += l.threat + 0.05;
  let acc = 0;
  for (const l of lines) acc += (l.threat + 0.05) * l.answer;
  return acc / tot;
}

// --------------------------------------------------------------------------- notes

export function joinNames(champs: readonly ChampData[]): string {
  const names = champs.map((c) => c.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
}

export function topBy(champs: readonly ChampData[], trait: TraitName, minimum = 2, limit = 2): ChampData[] {
  const idx = I[trait];
  const good = champs.filter((c) => c.traits[idx] >= minimum);
  good.sort((a, b) => cmpNum(b.traits[idx], a.traits[idx]) || cmpStr(a.name, b.name));
  return good.slice(0, limit);
}

/** French strengths and warnings for a lineup. */
export function teamNotes(champs: readonly ChampData[], ignoreDamage = false): [string[], string[]] {
  const strengths: string[] = [];
  const warnings: string[] = [];
  const n = champs.length;
  if (n === 0) return [strengths, warnings];
  const f = n / 5;
  const s = teamSums(champs);

  const front = topBy(champs, 'frontline');
  if (!front.length) {
    warnings.push('Pas de frontline : personne pour encaisser les dégâts en combat');
  } else if (s[I.frontline] >= 5 * f) {
    strengths.push(`Frontline solide (${joinNames(front)})`);
  }

  const eng = topBy(champs, 'engage', 3);
  if (eng.length) {
    strengths.push(`Engage fiable avec ${joinNames(eng)}`);
  } else if (n >= 3 && s[I.engage] < 3 * f) {
    warnings.push("Peu d'engage : difficile de forcer un combat");
  }

  const peel = topBy(champs, 'peel', 3);
  if (peel.length && champs.some((c) => c.traits[I.late] >= 3)) {
    // max() with key (late, name): first maximum wins on full ties
    let carry = champs[0];
    for (const c of champs.slice(1)) {
      const d = cmpNum(c.traits[I.late], carry.traits[I.late]) || cmpStr(c.name, carry.name);
      if (d > 0) carry = c;
    }
    strengths.push(`${joinNames(peel)} peut protéger ${carry.name}`);
  }

  if (n >= 3) {
    const share = apShare(champs);
    if (share <= 0.05) {
      warnings.push(
        !ignoreDamage
          ? "Dégâts 100% AD : l'armure adverse suffira"
          : "Full AD assumé : l'adversaire va empiler l'armure",
      );
    } else if (share >= 0.95) {
      warnings.push(
        !ignoreDamage
          ? 'Dégâts 100% AP : la résistance magique adverse suffira'
          : "Full AP assumé : l'adversaire va empiler la résistance magique",
      );
    } else if (share < 0.25) {
      warnings.push('Dégâts très majoritairement AD');
    } else if (share > 0.75) {
      warnings.push('Dégâts très majoritairement AP');
    } else {
      strengths.push('Bon mélange de dégâts AD/AP');
    }
  }

  if (s[I.waveclear] < 5 * f && n >= 3) {
    warnings.push('Waveclear faible : difficile de défendre les tours');
  } else if (s[I.waveclear] >= 9 * f) {
    strengths.push('Excellent waveclear pour tenir et assiéger');
  }

  if (s[I.cc] < 4 * f && n >= 3) {
    warnings.push('Peu de contrôles (CC) pour verrouiller une cible');
  } else if (s[I.cc] >= 9 * f) {
    strengths.push('Beaucoup de contrôles pour verrouiller les cibles');
  }

  const poke = topBy(champs, 'poke', 3);
  if (poke.length >= 2) strengths.push(`Poke à longue portée (${joinNames(poke)})`);
  const split = topBy(champs, 'splitpush', 3, 1);
  if (split.length) strengths.push(`${split[0].name} peut tenir une lane seul en split push`);

  const early = s[I.early] / n;
  const late = s[I.late] / n;
  if (n >= 3) {
    if (early >= 2.2 && late < 1.8) {
      warnings.push("Compo très early : il faut prendre l'avance et finir vite");
    } else if (late >= 2.4 && early < 1.4) {
      warnings.push("Début de partie fragile : jouer safe jusqu'aux objets");
    } else if (late >= 2.4) {
      strengths.push('Très forte en fin de partie');
    } else if (early >= 2.2) {
      strengths.push('Fort début de partie');
    }
  }
  return [strengths, warnings];
}
