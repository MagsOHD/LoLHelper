// Public API of the composition engine (ported from the former Python engine, see git history).
// Pure functions, no I/O: the curated data (champions_meta / archetypes / themes) is bundled as JSON.
import type {
  ArchetypeInfo,
  CompositionSuggestion,
  GamePlan,
  GenerationOptions,
  ManualPoolEntry,
  MasteryEntry,
  MatchupPlan,
  Pick,
  PlayerInput,
  PlayerPreferences,
  PoolEntry,
  RecentChampionStat,
  ThemeInfo,
} from '../api/types';
import {
  buildCatalog as buildCatalogImpl,
  Catalog,
  type ChampionCatalog,
  listArchetypes as listArchetypesImpl,
  type DDragonChampion,
  type RawMeta,
} from './catalog';
import { generateCompositionsRaw } from './generator';
import { buildGamePlanRaw, buildMatchupPlanRaw } from './plans';
import { computePool as computePoolImpl } from './pool';
import { elide, elideAll } from './text';
import { listThemes as listThemesImpl } from './themes';

export { Catalog, elide };
export type { ChampionCatalog, DDragonChampion, RawMeta };
export type { ChampData, ChampionExtraMeta } from './catalog';
export { archetypeLabel, placeholderData } from './catalog';
export { detectThemes, getTheme, themeLabel } from './themes';
export { ROLE_ORDER } from './generator';

const adapted = new WeakMap<ChampionCatalog, Catalog>();

/** The engine needs a full `Catalog`; any other object implementing the contract is adapted once. */
export function asCatalog(catalog: ChampionCatalog): Catalog {
  if (catalog instanceof Catalog) return catalog;
  let c = adapted.get(catalog);
  if (!c) {
    c = new Catalog(catalog.all());
    adapted.set(catalog, c);
  }
  return c;
}

export function listArchetypes(): ArchetypeInfo[] {
  return listArchetypesImpl();
}

export function listThemes(): ThemeInfo[] {
  return listThemesImpl();
}

/**
 * Empty list = offline: catalog built from curated data only (image_url "").
 * `meta` overrides the bundled curated data (tests).
 */
export function buildCatalog(
  ddragonChampions: DDragonChampion[],
  version: string,
  meta?: Record<string, RawMeta>,
): Catalog {
  return buildCatalogImpl(ddragonChampions, version, meta);
}

/** `nowMs` defaults to the most recent mastery play time (deterministic). */
export function computePool(
  masteries: MasteryEntry[],
  recent: RecentChampionStat[],
  manual: ManualPoolEntry[],
  preferences: PlayerPreferences,
  catalog: ChampionCatalog,
  nowMs?: number,
): PoolEntry[] {
  return computePoolImpl(masteries, recent, manual, preferences, asCatalog(catalog), nowMs);
}

/** Throws Error('Une composition compte au plus 5 joueurs') above 5 players. */
export function generateCompositions(
  players: PlayerInput[],
  options: GenerationOptions,
  catalog: ChampionCatalog,
): CompositionSuggestion[] {
  return elideAll(generateCompositionsRaw(players, options, asCatalog(catalog)));
}

export function buildGamePlan(picks: Pick[], catalog: ChampionCatalog): GamePlan {
  return elideAll(buildGamePlanRaw(picks, asCatalog(catalog)));
}

/** Enemy picks always carry a role (callers guess missing ones before calling). */
export function buildMatchupPlan(ally: Pick[], enemy: Pick[], catalog: ChampionCatalog): MatchupPlan {
  return elideAll(buildMatchupPlanRaw(ally, enemy, asCatalog(catalog)));
}
