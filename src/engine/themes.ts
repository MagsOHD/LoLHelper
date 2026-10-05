// Theme definitions (data/themes.json) and how a lineup is scored against a theme.
import type { ThemeInfo, ThemeKind } from '../api/types';
import { teamSums, viability } from './analysis';
import { TRAIT_INDEX, type ChampData } from './catalog';
import themesJson from './data/themes.json';
import { cmpNum, cmpStr, pyRound } from './pycompat';
import type { TraitName } from './traits';

export { teamSums };

export class Requirement {
  constructor(
    readonly trait: TraitName | null,
    readonly min: number,
    readonly archetypes: ReadonlySet<string>,
    readonly count: number,
  ) {}

  ok(c: ChampData): boolean {
    if (this.archetypes.size && !this.archetypes.has(c.archetype)) return false;
    if (this.trait && (c.t[this.trait] ?? 0) < this.min) return false;
    return true;
  }
}

export interface ThemeDefInit {
  key: string;
  label: string;
  kind: string;
  description: string;
  weights: [number, number][];
  penalties: [number, number][];
  target: number;
  requires: Requirement[];
  regions: ReadonlySet<string>;
  groups: ReadonlySet<string>;
  archetypes: ReadonlySet<string>;
  damage: ReadonlySet<string>;
  champions: ReadonlySet<string>;
  minMembers: number;
  pairsTheme: boolean;
  ignoreDamageMix: boolean;
}

export class ThemeDef implements ThemeDefInit {
  key!: string;
  label!: string;
  kind!: string;
  description!: string;
  weights!: [number, number][]; // (trait index, weight)
  penalties!: [number, number][];
  target!: number; // wanted average per champion for weighted traits
  requires!: Requirement[];
  regions!: ReadonlySet<string>;
  groups!: ReadonlySet<string>;
  archetypes!: ReadonlySet<string>;
  damage!: ReadonlySet<string>;
  champions!: ReadonlySet<string>;
  minMembers!: number;
  pairsTheme!: boolean;
  ignoreDamageMix!: boolean;
  private readonly memberCache = new WeakMap<ChampData, boolean>();

  constructor(init: ThemeDefInit) {
    Object.assign(this, init);
  }

  get thematic(): boolean {
    return this.kind === 'thematic';
  }

  info(): ThemeInfo {
    return { key: this.key, label: this.label, kind: this.kind as ThemeKind, description: this.description };
  }

  // ---------------------------------------------------------------- membership
  /** Static membership (not used for the pair-based lore theme). */
  isMember(c: ChampData): boolean {
    if (!this.thematic || this.pairsTheme) return false;
    let hit = this.memberCache.get(c);
    if (hit === undefined) {
      hit =
        this.regions.has(c.region) ||
        [...this.groups].some((g) => c.groups.has(g)) ||
        this.archetypes.has(c.archetype) ||
        this.damage.has(c.damage) ||
        this.champions.has(c.id);
      this.memberCache.set(c, hit);
    }
    return hit;
  }

  membersIn(champs: readonly ChampData[]): ChampData[] {
    if (this.pairsTheme) {
      const ids = new Set(champs.map((c) => c.id));
      const linked = new Set<string>();
      for (const [a, b] of lorePairs()) {
        if (ids.has(a) && ids.has(b)) {
          linked.add(a);
          linked.add(b);
        }
      }
      return champs.filter((c) => linked.has(c.id));
    }
    return champs.filter((c) => this.isMember(c));
  }

  requiredMembers(n: number): number {
    if (!this.thematic || n === 0) return 0;
    if (this.pairsTheme) return n < 5 ? 2 : this.minMembers;
    return Math.min(n, Math.max(1, Math.ceil((this.minMembers * n) / 5)));
  }

  /** 0..1 how much a single champion contributes to this theme. */
  affinity(c: ChampData): number {
    if (this.thematic) {
      if (this.pairsTheme) return loreChampions().has(c.id) ? 1.0 : 0.0;
      return this.isMember(c) ? 1.0 : 0.0;
    }
    if (!this.weights.length) return 0.0;
    let tot = 0;
    for (const [, w] of this.weights) tot += w;
    let acc = 0;
    for (const [i, w] of this.weights) acc += w * c.traits[i];
    let val = acc / (3 * tot);
    if (this.requires.length && this.requires.some((r) => r.ok(c))) val = Math.min(1.0, val + 0.25);
    return val;
  }

  // ---------------------------------------------------------------- scoring
  traitScore(sums: readonly number[], n: number): number {
    if (!this.weights.length || n === 0) return 0.0;
    let tot = 0.0;
    let acc = 0.0;
    const goal = this.target * n;
    for (const [i, w] of this.weights) {
      acc += w * Math.min(1.0, sums[i] / goal);
      tot += w;
    }
    let score = acc / tot;
    for (const [i, w] of this.penalties) score -= w * Math.min(1.0, sums[i] / (3 * n));
    return Math.max(0.0, score);
  }

  requirementScore(champs: readonly ChampData[]): number {
    if (!this.requires.length) return 1.0;
    const n = champs.length;
    let acc = 0;
    for (const r of this.requires) {
      const need = r.count > 1 ? Math.max(1, pyRound((r.count * n) / 5)) : 1;
      let have = 0;
      for (const c of champs) if (r.ok(c)) have += 1;
      acc += Math.min(1.0, have / need);
    }
    return acc / this.requires.length;
  }

  /** 0..1 fit of a (possibly partial) lineup with this theme. */
  fit(champs: readonly ChampData[], sums?: readonly number[] | null): number {
    const n = champs.length;
    if (n === 0) return 0.0;
    const s = sums ?? teamSums(champs);
    if (!this.thematic) return this.traitScore(s, n) * (0.4 + 0.6 * this.requirementScore(champs));
    const members = this.membersIn(champs).length;
    const need = this.requiredMembers(n);
    const ratio = members / n;
    const memberScore = members >= need ? ratio : 0.45 * ratio;
    const via = viability(champs, s, this.ignoreDamageMix);
    return 0.7 * memberScore + 0.3 * via;
  }

  /** Hard-ish constraint for thematic themes (always true for playstyles). */
  satisfied(champs: readonly ChampData[]): boolean {
    if (!this.thematic) return true;
    return this.membersIn(champs).length >= this.requiredMembers(champs.length);
  }
}

// --------------------------------------------------------------------------- loading

interface RawTheme {
  key: string;
  label: string;
  kind?: string;
  description?: string;
  weights?: Record<string, number>;
  penalties?: Record<string, number>;
  target?: number;
  requires?: { trait?: string | null; min?: number; archetypes?: string[]; count?: number }[];
  members?: { regions?: string[]; groups?: string[]; archetypes?: string[]; damage?: string[]; champions?: string[] };
  min_members?: number;
  pairs_theme?: boolean;
  ignore_damage_mix?: boolean;
}

interface RawThemesFile {
  themes: RawTheme[];
  lore_pairs?: [string, string, string][];
}

const RAW = themesJson as unknown as RawThemesFile;

function traitWeights(d: Record<string, number> | undefined): [number, number][] {
  const out: [number, number][] = [];
  for (const [k, v] of Object.entries(d ?? {})) {
    if (k in TRAIT_INDEX) out.push([TRAIT_INDEX[k as TraitName], Number(v)]);
  }
  return out;
}

function parseTheme(entry: RawTheme): ThemeDef {
  const members = entry.members ?? {};
  const reqs = (entry.requires ?? []).map(
    (r) =>
      new Requirement(
        (r.trait || null) as TraitName | null,
        Math.trunc(r.min ?? 0),
        new Set(r.archetypes ?? []),
        Math.trunc(r.count ?? 1),
      ),
  );
  return new ThemeDef({
    key: entry.key,
    label: entry.label,
    kind: entry.kind ?? 'playstyle',
    description: entry.description ?? '',
    weights: traitWeights(entry.weights),
    penalties: traitWeights(entry.penalties),
    target: Number(entry.target ?? 1.6),
    requires: reqs,
    regions: new Set(members.regions ?? []),
    groups: new Set(members.groups ?? []),
    archetypes: new Set(members.archetypes ?? []),
    damage: new Set(members.damage ?? []),
    champions: new Set(members.champions ?? []),
    minMembers: Math.trunc(entry.min_members ?? 0),
    pairsTheme: Boolean(entry.pairs_theme ?? false),
    ignoreDamageMix: Boolean(entry.ignore_damage_mix ?? false),
  });
}

const ALL_THEMES: readonly ThemeDef[] = RAW.themes.map(parseTheme);
const LORE_PAIRS: readonly [string, string, string][] = (RAW.lore_pairs ?? []).map(
  ([a, b, d]) => [a, b, d] as [string, string, string],
);
const LORE_CHAMPIONS: ReadonlySet<string> = new Set(LORE_PAIRS.flatMap(([a, b]) => [a, b]));

export function allThemes(): readonly ThemeDef[] {
  return ALL_THEMES;
}

export function lorePairs(): readonly [string, string, string][] {
  return LORE_PAIRS;
}

export function loreChampions(): ReadonlySet<string> {
  return LORE_CHAMPIONS;
}

export function getTheme(key: string | null | undefined): ThemeDef | null {
  if (!key) return null;
  return ALL_THEMES.find((t) => t.key === key) ?? null;
}

export function listThemes(): ThemeInfo[] {
  return ALL_THEMES.map((t) => t.info());
}

export function themeLabel(key: string): string {
  const t = getTheme(key);
  return t ? t.label : key;
}

type Scored = [ThemeDef, number];
const byScoreThenKey = (a: Scored, b: Scored): number => cmpNum(b[1], a[1]) || cmpStr(a[0].key, b[0].key);

/** Best matching themes of a lineup, best first (thematic ones only when satisfied). */
export function detectThemes(champs: readonly ChampData[], limit = 3): Scored[] {
  if (!champs.length) return [];
  const sums = teamSums(champs);
  const scored: Scored[] = [];
  for (const t of ALL_THEMES) {
    if (t.thematic) {
      if (!t.satisfied(champs) || champs.length < 3) continue;
      const members = t.membersIn(champs).length;
      if (members < Math.max(3, t.requiredMembers(champs.length))) continue;
    }
    scored.push([t, t.fit(champs, sums)]);
  }
  scored.sort(byScoreThenKey);
  const play = scored.filter((s) => !s[0].thematic);
  const them = scored.filter((s) => s[0].thematic);
  const out = play.slice(0, 1);
  const rest = [...play.slice(1), ...them].sort(byScoreThenKey);
  for (const [t, s] of rest) {
    if (out.length >= limit) break;
    if (t.thematic || s >= 0.75 * out[0][1]) out.push([t, s]);
  }
  return out;
}
