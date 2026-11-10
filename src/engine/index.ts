// Public API of the composition engine (ported from the former Python engine, see git history).
// Pure functions, no I/O: the curated data (champions_meta / archetypes / themes) is bundled as JSON.
import type {
  ArchetypeInfo,
  CompositionSuggestion,
  DraftAdvice,
  DraftInput,
  EngineContext,
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
import { recommendDraftRaw } from './draft';
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
export { computeForm } from './pool';
export { DRAFT_KNOWN_COMFORT, DRAFT_W_COUNTER, DRAFT_W_LANE, ONE_TRICK_POINTS } from './draft';
export { guessEnemyRoles, metaMatchup, metaPickValue, metaUsable, META_MIN_GAMES } from './meta';

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

/** `nowMs` defaults to the most recent mastery play time / recent `last_played` (deterministic). */
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

/**
 * Throws Error('Une composition compte au plus 5 joueurs') above 5 players.
 * `context.meta` (high-elo stats) and the players' `pool[].form`, `lane_history`, `allies` add small
 * terms to the score; without them the output is exactly the same as before.
 */
export function generateCompositions(
  players: PlayerInput[],
  options: GenerationOptions,
  catalog: ChampionCatalog,
  context: EngineContext = {},
): CompositionSuggestion[] {
  return elideAll(generateCompositionsRaw(players, options, asCatalog(catalog), context));
}

export function buildGamePlan(picks: Pick[], catalog: ChampionCatalog): GamePlan {
  return elideAll(buildGamePlanRaw(picks, asCatalog(catalog)));
}

/**
 * Enemy picks always carry a role (callers guess missing ones with `guessEnemyRoles`).
 * `context.meta` may add a meta duel sentence to lane advice; meta duels and the ally players'
 * `lane_history` (`context.players`, matched by `Pick.player_id`) may adjust threat danger.
 */
export function buildMatchupPlan(
  ally: Pick[],
  enemy: Pick[],
  catalog: ChampionCatalog,
  context: EngineContext = {},
): MatchupPlan {
  return elideAll(buildMatchupPlanRaw(ally, enemy, asCatalog(catalog), context));
}

/**
 * Live draft: per-friend pick advice (3–5 champions for every friend slot not locked, slot order; locked
 * friends get `locked_champion_id` and no picks), up to 3 ban suggestions (never banned / picked / hovered)
 * and a read of the enemy team from the picks known so far (null without enemy pick).
 * Friends = ally slots whose `player_id` matches one of `players`; other slots are unknown teammates (their
 * locked champions count for balance, synergy and counters). Roles: slot role, else guessed (locked
 * champions) or assigned from preferences / role games (friends still to pick). Enemy roles are guessed
 * with `guessEnemyRoles` when missing. `draft.enemy_accounts` (game started) adjust the threats with the
 * enemy players' mastery and rank. `context.meta` adds meta values, lane duels and ban presence.
 * Deterministic; every sentence goes through French elision.
 */
export function recommendDraft(
  players: PlayerInput[],
  draft: DraftInput,
  catalog: ChampionCatalog,
  context: EngineContext = {},
): DraftAdvice {
  return elideAll(recommendDraftRaw(players, draft, asCatalog(catalog), context ?? {}));
}
