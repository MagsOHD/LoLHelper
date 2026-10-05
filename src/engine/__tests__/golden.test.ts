// Golden tests: the TypeScript engine must reproduce the Python reference outputs exactly
// (numbers within 1e-6, every string identical). Fixtures: src/engine/__golden__/*.json.
import { describe, expect, it } from 'vitest';
import type {
  ChampionInfo,
  GenerationOptions,
  ManualPoolEntry,
  MasteryEntry,
  Pick,
  PlayerInput,
  PlayerPreferences,
  RecentChampionStat,
} from '../../api/types';
import {
  buildCatalog,
  buildGamePlan,
  buildMatchupPlan,
  computePool,
  elide,
  generateCompositions,
  listArchetypes,
  listThemes,
  type DDragonChampion,
} from '../index';
import { expectMatches, golden } from './helpers';

const catalog = buildCatalog([], 'offline');

interface CatalogEntry {
  info: ChampionInfo;
  meta: unknown;
}

describe('golden: catalog', () => {
  const g = golden<{ archetypes: unknown; themes: unknown; offline: CatalogEntry[] }>('catalog');

  it('lists archetypes and themes', () => {
    expectMatches(listArchetypes(), g.archetypes);
    expectMatches(listThemes(), g.themes);
  });

  it('builds the offline catalog (order, infos, extra meta)', () => {
    const out = catalog.all().map((c) => ({ info: c, meta: catalog.meta(c.id) }));
    expectMatches(out, g.offline);
  });

  it('merges Data Dragon champions with fallbacks for unknown ones', () => {
    const d = golden<{ ddragon: DDragonChampion[]; version: string; out: CatalogEntry[] }>('ddragon');
    const cat = buildCatalog(d.ddragon, d.version);
    const out = cat.all().map((c) => ({ info: c, meta: cat.meta(c.id) }));
    expectMatches(out, d.out);
  });
});

describe('golden: text', () => {
  it('elides like Python', () => {
    for (const t of golden<{ in: string; out: string }[]>('text')) expect(elide(t.in)).toBe(t.out);
  });
});

interface PoolCase {
  name: string;
  masteries: MasteryEntry[];
  recent: RecentChampionStat[];
  manual: ManualPoolEntry[];
  preferences: PlayerPreferences;
  now_ms: number | null;
  out: unknown;
}

describe('golden: computePool', () => {
  for (const c of golden<PoolCase[]>('pool')) {
    it(c.name, () => {
      const out = computePool(c.masteries, c.recent, c.manual, c.preferences, catalog, c.now_ms ?? undefined);
      expectMatches(out, c.out);
    });
  }
});

interface GenCase {
  name: string;
  players: PlayerInput[];
  options: GenerationOptions;
  out: unknown;
}

describe('golden: generateCompositions', () => {
  for (const c of golden<GenCase[]>('generate')) {
    it(c.name, () => {
      expectMatches(generateCompositions(c.players, c.options, catalog), c.out);
    });
  }
});

interface PlanFile {
  game: { name: string; picks: Pick[]; out: unknown }[];
  matchup: { name: string; ally: Pick[]; enemy: Pick[]; out: unknown }[];
}

describe('golden: buildGamePlan', () => {
  for (const c of golden<PlanFile>('plans').game) {
    it(c.name, () => {
      expectMatches(buildGamePlan(c.picks, catalog), c.out);
    });
  }
});

describe('golden: buildMatchupPlan', () => {
  for (const c of golden<PlanFile>('plans').matchup) {
    it(c.name, () => {
      expectMatches(buildMatchupPlan(c.ally, c.enemy, catalog), c.out);
    });
  }
});
