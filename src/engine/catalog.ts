// Champion catalog: Data Dragon champions merged with curated meta data.
import type { ArchetypeInfo, ChampionInfo, ChampionTraits, DamageType, Role } from '../api/types';
import archetypesJson from './data/archetypes.json';
import championsMetaJson from './data/champions_meta.json';
import { cmpStr, pyInt, pyStr, truthy } from './pycompat';
import { ARCHETYPE_ROLES, ARCHETYPE_TRAITS, DAMAGE_ARCHETYPES_LIST, DEFAULT_ARCHETYPES, TRAITS } from './tables';
import type { TraitName } from './traits';

export { TRAITS };
export type { TraitName };

export const TRAIT_INDEX: Record<TraitName, number> = Object.fromEntries(TRAITS.map((t, i) => [t, i])) as Record<
  TraitName,
  number
>;

export const ROLE_VALUES: readonly Role[] = ['TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT'];
export const DAMAGE_ARCHETYPES: ReadonlySet<string> = new Set(DAMAGE_ARCHETYPES_LIST);

const DDRAGON_IMG = (version: string, file: string): string =>
  `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${file}`;

/** One value of Data Dragon champion.json "data". */
export interface DDragonChampion {
  id: string;
  key: string;
  name: string;
  title?: string;
  tags?: string[];
  info?: { attack?: number; defense?: number; magic?: number; difficulty?: number };
  image?: { full?: string };
}

/** Raw curated entry of champions_meta.json (loosely typed: values are validated on use). */
export type RawMeta = Record<string, unknown>;

/** Light internal view of a champion used by the engine hot loops. */
export interface ChampData {
  id: string;
  name: string;
  roles: readonly Role[];
  archetype: string;
  damage: string;
  region: string;
  groups: ReadonlySet<string>;
  traits: readonly number[];
  t: Readonly<Record<TraitName, number>>;
}

export interface ChampionExtraMeta {
  power_spikes: string[];
  playstyle: string;
  counter_tips: string;
}

// --------------------------------------------------------------------------- loading

const CURATED: Record<string, RawMeta> = championsMetaJson as unknown as Record<string, RawMeta>;

export function loadMetaFile(): Record<string, RawMeta> {
  return CURATED;
}

let archetypeCache: ArchetypeInfo[] | null = null;

function archetypes(): ArchetypeInfo[] {
  if (archetypeCache) return archetypeCache;
  const data: unknown = archetypesJson;
  const items: unknown[] = Array.isArray(data) && data.length ? data : DEFAULT_ARCHETYPES;
  const out: ArchetypeInfo[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (typeof o.key !== 'string' || typeof o.label !== 'string' || typeof o.description !== 'string') continue;
    out.push({ key: o.key, label: o.label, description: o.description });
  }
  archetypeCache = out;
  return out;
}

export function listArchetypes(): ArchetypeInfo[] {
  return archetypes().map((a) => ({ ...a }));
}

function pyCapitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

export function archetypeLabel(key: string): string {
  for (const a of archetypes()) if (a.key === key) return a.label;
  for (const a of DEFAULT_ARCHETYPES) if (a.key === key) return a.label;
  return key ? pyCapitalize(key.replace(/_/g, ' ')) : 'Polyvalent';
}

// --------------------------------------------------------------------------- fallback

type Info = Record<string, unknown>;

function infoInt(info: Info, key: string, dflt: number): number {
  const v = key in info ? info[key] : dflt;
  if (!truthy(v)) return 0;
  return pyInt(v) ?? 0;
}

function fallbackArchetype(tags: string[], info: Info): string {
  const main = tags.length ? tags[0] : '';
  const has = new Set(tags);
  const defense = infoInt(info, 'defense', 5);
  if (main === 'Marksman') return 'marksman';
  if (main === 'Tank') return has.has('Support') ? 'warden' : 'vanguard';
  if (main === 'Support') {
    if (has.has('Tank')) return 'warden';
    if (has.has('Mage')) return 'enchanter';
    return has.has('Fighter') ? 'catcher' : 'enchanter';
  }
  if (main === 'Assassin') return has.has('Fighter') ? 'skirmisher' : 'assassin';
  if (main === 'Fighter') {
    if (has.has('Tank')) return 'juggernaut';
    if (has.has('Assassin')) return 'skirmisher';
    return defense >= 6 ? 'juggernaut' : 'diver';
  }
  if (main === 'Mage') {
    if (has.has('Support')) return 'enchanter';
    if (has.has('Assassin')) return 'burst_mage';
    if (has.has('Tank') || has.has('Fighter')) return 'battlemage';
    return defense >= 4 ? 'battlemage' : 'burst_mage';
  }
  return 'specialist';
}

function fallbackDamage(info: Info, archetype: string): string {
  const atk = infoInt(info, 'attack', 0);
  const mag = infoInt(info, 'magic', 0);
  if (Math.abs(atk - mag) <= 1 && Math.min(atk, mag) >= 5) return 'MIXED';
  if (mag > atk) return 'AP';
  if (atk > mag) return 'AD';
  return ['burst_mage', 'battlemage', 'artillery', 'enchanter'].includes(archetype) ? 'AP' : 'AD';
}

function fallbackTraits(archetype: string, info: Info): Partial<Record<TraitName, number>> {
  const traits = { ...(ARCHETYPE_TRAITS[archetype] ?? ARCHETYPE_TRAITS.specialist) };
  const defense = infoInt(info, 'defense', 0);
  if (defense >= 8) traits.frontline = Math.min(3, (traits.frontline ?? 0) + 1);
  return traits;
}

export function fallbackMeta(tags: string[], info: Info): RawMeta {
  const arch = fallbackArchetype(tags, info);
  return {
    roles: [...(ARCHETYPE_ROLES[arch] ?? ['MID'])],
    archetype: arch,
    damage_type: fallbackDamage(info, arch),
    region: '',
    groups: [],
    traits: fallbackTraits(arch, info),
    power_spikes: [],
    playstyle: '',
    counter_tips: '',
  };
}

// --------------------------------------------------------------------------- catalog

function clampTrait(v: unknown): number {
  const n = pyInt(v);
  return n === null ? 0 : Math.max(0, Math.min(3, n));
}

function parseRoles(values: unknown): Role[] {
  const out: Role[] = [];
  const list = Array.isArray(values) ? values : [];
  for (const v of list) {
    const r = pyStr(v).toUpperCase();
    if (!(ROLE_VALUES as readonly string[]).includes(r)) continue;
    if (!out.includes(r as Role)) out.push(r as Role);
  }
  return out;
}

function listOf(v: unknown): unknown[] {
  return truthy(v) && Array.isArray(v) ? v : [];
}

/** Public contract of a catalog (what src/api relies on). */
export interface ChampionCatalog {
  get(championId: string): ChampionInfo | undefined;
  byKey(key: number): ChampionInfo | undefined;
  all(): ChampionInfo[];
}

/** Immutable set of champions with lookup helpers. */
export class Catalog implements ChampionCatalog {
  private readonly champs = new Map<string, ChampionInfo>();
  private readonly extras = new Map<string, RawMeta>();
  private readonly dataMap = new Map<string, ChampData>();
  private readonly byKeyMap = new Map<number, ChampionInfo>();
  private readonly lower = new Map<string, string>();

  constructor(champions: ChampionInfo[], extras?: Record<string, RawMeta>) {
    const sorted = champions
      .map((c, i) => ({ c, k: c.name.toLowerCase(), i }))
      .sort((a, b) => cmpStr(a.k, b.k) || a.i - b.i);
    for (const { c } of sorted) {
      this.champs.set(c.id, c);
      this.extras.set(c.id, { ...((extras ?? {})[c.id] ?? {}) });
      const td = {} as Record<TraitName, number>;
      for (const t of TRAITS) td[t] = c.traits[t];
      this.dataMap.set(c.id, {
        id: c.id,
        name: c.name,
        roles: [...c.roles],
        archetype: c.archetype,
        damage: c.damage_type,
        region: c.region,
        groups: new Set(c.groups),
        traits: TRAITS.map((t) => td[t]),
        t: td,
      });
    }
    for (const c of this.champs.values()) this.byKeyMap.set(c.key, c);
    for (const k of this.champs.keys()) this.lower.set(k.toLowerCase(), k);
    for (const c of this.champs.values()) {
      const k = c.name.toLowerCase();
      if (!this.lower.has(k)) this.lower.set(k, c.id);
    }
  }

  get size(): number {
    return this.champs.size;
  }

  has(championId: string): boolean {
    return this.resolve(championId) !== null;
  }

  /** Canonical id for an id/name given with any casing. */
  resolve(championId: string): string | null {
    if (this.champs.has(championId)) return championId;
    return this.lower.get(String(championId).toLowerCase()) ?? null;
  }

  get(championId: string): ChampionInfo | undefined {
    const cid = this.resolve(championId);
    return cid ? this.champs.get(cid) : undefined;
  }

  byKey(key: number | string): ChampionInfo | undefined {
    const k = pyInt(key);
    return k === null ? undefined : this.byKeyMap.get(k);
  }

  all(): ChampionInfo[] {
    return [...this.champs.values()];
  }

  /** Extra curated fields: power_spikes, playstyle, counter_tips. */
  meta(championId: string): ChampionExtraMeta {
    const cid = this.resolve(championId);
    const extra: RawMeta = (cid ? this.extras.get(cid) : undefined) ?? {};
    return {
      power_spikes: listOf(extra.power_spikes).map((s) => s as string),
      playstyle: truthy(extra.playstyle) ? pyStr(extra.playstyle) : '',
      counter_tips: truthy(extra.counter_tips) ? pyStr(extra.counter_tips) : '',
    };
  }

  data(championId: string): ChampData | undefined {
    const cid = this.resolve(championId);
    return cid ? this.dataMap.get(cid) : undefined;
  }

  allData(): ChampData[] {
    return [...this.dataMap.values()];
  }

  name(championId: string): string {
    const c = this.get(championId);
    return c ? c.name : championId;
  }
}

function makeInfo(cid: string, meta: RawMeta, dd: DDragonChampion | null, version: string): ChampionInfo {
  const traitsRaw = (truthy(meta.traits) ? meta.traits : {}) as Record<string, unknown>;
  const traits = {} as ChampionTraits;
  for (const t of TRAITS) traits[t] = clampTrait(t in traitsRaw ? traitsRaw[t] : 0);
  let roles = parseRoles(truthy(meta.roles) ? meta.roles : []);
  const archetype = truthy(meta.archetype) ? pyStr(meta.archetype) : '';
  if (!roles.length) roles = [...(ARCHETYPE_ROLES[archetype] ?? ['MID'])];
  let damage = (truthy(meta.damage_type) ? pyStr(meta.damage_type) : 'AD').toUpperCase();
  if (damage !== 'AD' && damage !== 'AP' && damage !== 'MIXED') damage = 'AD';
  let key: number;
  let name: string;
  let title: string;
  let tags: string[];
  let imageUrl: string;
  const metaKey = (): number => pyInt(truthy(meta.key) ? meta.key : 0) ?? 0;
  if (dd !== null) {
    key = pyInt(dd.key) ?? metaKey();
    name = truthy(dd.name) ? pyStr(dd.name) : truthy(meta.name) ? pyStr(meta.name) : cid;
    title = truthy(dd.title) ? pyStr(dd.title) : '';
    tags = listOf(dd.tags).map((x) => x as string);
    const img = (truthy(dd.image) ? (dd.image as { full?: string }) : {}).full;
    imageUrl = truthy(img) && version ? DDRAGON_IMG(version, img as string) : '';
  } else {
    key = metaKey();
    name = truthy(meta.name) ? pyStr(meta.name) : cid;
    title = truthy(meta.title) ? pyStr(meta.title) : '';
    tags = listOf(meta.tags).map((x) => x as string);
    imageUrl = '';
  }
  return {
    id: cid,
    key,
    name,
    title,
    image_url: imageUrl,
    tags,
    roles,
    archetype,
    damage_type: damage as DamageType,
    region: truthy(meta.region) ? pyStr(meta.region) : '',
    groups: listOf(meta.groups).map((g) => pyStr(g)),
    traits,
  };
}

/**
 * Merge Data Dragon champions (champion.json "data" values) with curated meta.
 * With an empty Data Dragon list, the catalog contains the curated champions only.
 * Champions unknown to the curated meta get a fallback derived from tags/info.
 */
export function buildCatalog(
  ddragonChampions: DDragonChampion[],
  version: string,
  meta?: Record<string, RawMeta>,
): Catalog {
  const curated = meta ?? loadMetaFile();
  const infos: ChampionInfo[] = [];
  const extras: Record<string, RawMeta> = {};
  if (ddragonChampions.length) {
    for (const dd of ddragonChampions) {
      const cid = dd.id;
      if (!cid) continue;
      let m: RawMeta | undefined = Object.prototype.hasOwnProperty.call(curated, cid) ? curated[cid] : undefined;
      const tags = listOf(dd.tags).map((x) => x as string);
      const info = (truthy(dd.info) ? { ...dd.info } : {}) as Info;
      if (m === undefined || m === null) {
        m = fallbackMeta(tags, info);
      } else {
        m = { ...m };
        if (!truthy(m.archetype)) m.archetype = fallbackMeta(tags, info).archetype;
      }
      infos.push(makeInfo(cid, m, dd, version));
      extras[cid] = m;
    }
  } else {
    for (const [cid, m] of Object.entries(curated)) {
      infos.push(makeInfo(cid, m, null, version));
      extras[cid] = m;
    }
  }
  return new Catalog(infos, extras);
}

/** Neutral data for an unknown champion id (keeps plans working). */
export function placeholderData(championId: string): ChampData {
  const t = {} as Record<TraitName, number>;
  for (const k of TRAITS) t[k] = 1;
  return {
    id: championId,
    name: championId,
    roles: [],
    archetype: 'specialist',
    damage: 'MIXED',
    region: '',
    groups: new Set(),
    traits: TRAITS.map((k) => t[k]),
    t,
  };
}
