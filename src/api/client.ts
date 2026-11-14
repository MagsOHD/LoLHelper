// Page-facing data layer. Pages only use `api` (and the helpers re-exported here).
//
// Production (OVH shared hosting): static site + small PHP API (public/api/index.php) used as a
// document store and Riot API proxy; Data Dragon is fetched by the browser and the composition
// engine runs locally (src/engine). See service.ts.
// VITE_MOCK=1: in-memory demo backend (mock.ts), never bundled in production builds.
import type {
  MetaStats,
  ArchetypeInfo,
  DraftAdvice,
  DraftInput,
  DraftState,
  EnemyPlayerProfile,
  PlayerInput,
  ChampionInfo,
  CompositionSuggestion,
  CreatePlayerBody,
  GamePlan,
  GenerateBody,
  ManualPoolEntry,
  MetaTier,
  Rank,
  MatchupBody,
  MatchupPlan,
  Meta,
  Pick,
  Player,
  PlayerPreferences,
  SaveCompositionBody,
  SavedComposition,
  Team,
  TeamBody,
  ThemeInfo,
} from './types';
import { localApi, resetPhpMeta } from './service';
import { recommendDraft, type ChampionCatalog } from '../engine';
import { fetchLiveDraft, loadDraft, saveDraft, type LiveDraft } from './draft';
import { getCatalog } from './ddragon';
import {
  collectMetaOnce,
  fetchMetaStatus,
  getAdviceMeta,
  getMetaStatsForPatch,
  invalidateMetaStats,
  type CollectResult,
  type MetaStatus,
} from './meta';
import { detectActiveGame, type DetectedGame, type DetectFriend, type DetectOptions } from './spectator';
import { buildEnemyProfile, type ProfileProgress, type ProfileRequest } from './enemyProfile';
import { riotClashFetcher, type ClashFetcher } from './clash';
import { fetchRiotLimits, type RiotKeyLimits } from './riotLimits';

export { ApiError, AUTH_REQUIRED_EVENT, getPassword, setPassword } from './backend';

export const MOCK_MODE = import.meta.env.VITE_MOCK === '1';

/** Champion catalog + draft advisor (engine with meta stats; fake advice in mock mode). */
export interface DraftEngine {
  catalog: ChampionCatalog;
  advise(players: PlayerInput[], draft: DraftInput): DraftAdvice;
}

/** `ranks`: the draft's friends, picking the meta tier (median solo rank, override, fallback). */
async function realDraftEngine(ranks: readonly (Rank | null | undefined)[]): Promise<DraftEngine> {
  const [{ catalog }, meta] = await Promise.all([getCatalog(), getAdviceMeta(ranks)]);
  return { catalog, advise: (players, draft) => recommendDraft(players, draft, catalog, { meta }) };
}

async function mockDraftEngine(): Promise<DraftEngine> {
  const m = await import('./mock');
  return { catalog: m.mockCatalog(), advise: m.mockDraftAdvice };
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function mock<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const { mockRequest } = await import('./mock');
  return (await mockRequest(method, path, body)) as T;
}

const enc = encodeURIComponent;

export const api = {
  // Meta
  health: (): Promise<{ status: string }> => (MOCK_MODE ? mock('GET', '/health') : localApi.health()),
  meta: (): Promise<Meta> => (MOCK_MODE ? mock('GET', '/meta') : localApi.meta()),
  champions: (): Promise<ChampionInfo[]> => (MOCK_MODE ? mock('GET', '/champions') : localApi.champions()),
  archetypes: (): Promise<ArchetypeInfo[]> => (MOCK_MODE ? mock('GET', '/archetypes') : localApi.archetypes()),
  themes: (): Promise<ThemeInfo[]> => (MOCK_MODE ? mock('GET', '/themes') : localApi.themes()),

  // High-elo meta (Meta page)
  /** Collector state: lock held, last run, kept patches, manual collection allowed. */
  metaStatus: (): Promise<MetaStatus> =>
    MOCK_MODE ? import('./mock').then((m) => m.mockMetaStatus()) : fetchMetaStatus(),
  /** One bounded collection pass on the server (header X-Admin-Password). */
  collectMeta: (adminPassword: string): Promise<CollectResult> =>
    MOCK_MODE ? import('./mock').then((m) => m.mockCollectMeta(adminPassword)) : collectMetaOnce(adminPassword),
  /** Stats of a kept patch (or the served one when `patch` is empty) for `tier` (null = server default). */
  metaStats: (patch?: string | null, tier: MetaTier | null = null): Promise<MetaStats | null> =>
    MOCK_MODE ? import('./mock').then((m) => m.mockMetaStats(patch, tier)) : getMetaStatsForPatch(patch, tier),
  /** Drops cached meta (stats + r=meta summary) so generation, draft and pages use fresh data. */
  invalidateMeta: (): void => {
    invalidateMetaStats();
    resetPhpMeta();
  },

  // Players
  listPlayers: (): Promise<Player[]> => (MOCK_MODE ? mock('GET', '/players') : localApi.listPlayers()),
  getPlayer: (id: string): Promise<Player> =>
    MOCK_MODE ? mock('GET', `/players/${enc(id)}`) : localApi.getPlayer(id),
  createPlayer: (body: CreatePlayerBody): Promise<Player> =>
    MOCK_MODE ? mock('POST', '/players', body) : localApi.createPlayer(body),
  deletePlayer: (id: string): Promise<void> =>
    MOCK_MODE ? mock('DELETE', `/players/${enc(id)}`) : localApi.deletePlayer(id),
  syncPlayer: (id: string): Promise<Player> =>
    MOCK_MODE ? mock('POST', `/players/${enc(id)}/sync`) : localApi.syncPlayer(id),
  updatePreferences: (id: string, prefs: PlayerPreferences): Promise<Player> =>
    MOCK_MODE ? mock('PUT', `/players/${enc(id)}/preferences`, prefs) : localApi.updatePreferences(id, prefs),
  updatePool: (id: string, champions: ManualPoolEntry[]): Promise<Player> =>
    MOCK_MODE ? mock('PUT', `/players/${enc(id)}/pool`, { champions }) : localApi.updatePool(id, champions),

  // Teams
  listTeams: (): Promise<Team[]> => (MOCK_MODE ? mock('GET', '/teams') : localApi.listTeams()),
  getTeam: (id: string): Promise<Team> => (MOCK_MODE ? mock('GET', `/teams/${enc(id)}`) : localApi.getTeam(id)),
  createTeam: (body: TeamBody): Promise<Team> => (MOCK_MODE ? mock('POST', '/teams', body) : localApi.createTeam(body)),
  updateTeam: (id: string, body: TeamBody): Promise<Team> =>
    MOCK_MODE ? mock('PUT', `/teams/${enc(id)}`, body) : localApi.updateTeam(id, body),
  deleteTeam: (id: string): Promise<void> =>
    MOCK_MODE ? mock('DELETE', `/teams/${enc(id)}`) : localApi.deleteTeam(id),

  // Compositions
  generate: (body: GenerateBody): Promise<{ suggestions: CompositionSuggestion[] }> =>
    MOCK_MODE ? mock('POST', '/compositions/generate', body) : localApi.generate(body),
  gamePlan: (picks: Pick[]): Promise<GamePlan> =>
    MOCK_MODE ? mock('POST', '/compositions/game-plan', { picks }) : localApi.gamePlan(picks),
  matchup: (body: MatchupBody): Promise<MatchupPlan> =>
    MOCK_MODE ? mock('POST', '/compositions/matchup', body) : localApi.matchup(body),
  listSaved: (): Promise<SavedComposition[]> => (MOCK_MODE ? mock('GET', '/compositions/saved') : localApi.listSaved()),
  saveComposition: (body: SaveCompositionBody): Promise<SavedComposition> =>
    MOCK_MODE ? mock('POST', '/compositions/saved', body) : localApi.saveComposition(body),
  deleteSaved: (id: string): Promise<void> =>
    MOCK_MODE ? mock('DELETE', `/compositions/saved/${enc(id)}`) : localApi.deleteSaved(id),

  // Live draft
  getDraft: (id: string): Promise<DraftState | null> => (MOCK_MODE ? mock('GET', `/drafts/${enc(id)}`) : loadDraft(id)),
  saveDraft: (doc: DraftState): Promise<DraftState> =>
    MOCK_MODE ? mock('PUT', `/drafts/${enc(doc.id)}`, doc) : saveDraft(doc),
  liveDraft: (playerIds: string[]): Promise<LiveDraft | null> =>
    MOCK_MODE ? mock('POST', '/live-draft', { players: playerIds }) : fetchLiveDraft(playerIds),
  detectGame: (friends: DetectFriend[], options: Omit<DetectOptions, 'transport'> = {}): Promise<DetectedGame | null> =>
    MOCK_MODE
      ? mock('POST', '/draft/detect', { friends })
      : getCatalog().then(({ catalog }) => detectActiveGame(friends, catalog, options)).then((r) => r?.game ?? null),
  /** Catalog + advisor using the meta of the tier chosen for these friends' ranks. */
  draftEngine: (ranks: readonly (Rank | null | undefined)[] = []): Promise<DraftEngine> =>
    MOCK_MODE ? mockDraftEngine() : realDraftEngine(ranks),
  /** One enemy profile (Riot calls through the shared limiter); use EnemyProfileService for dedupe/cache. */
  enemyProfile: (req: ProfileRequest, onProgress?: (p: ProfileProgress) => void): Promise<EnemyPlayerProfile> =>
    MOCK_MODE
      ? import('./mock').then((m) => m.mockEnemyProfile(req, onProgress))
      : getCatalog().then(({ catalog }) => buildEnemyProfile(req, catalog, { onProgress })).then((r) => r.profile),
  /** Clash routes (riot/clash-*) behind the shared limiter; wrap in a ClashDirectory for the session cache. */
  clashFetcher: (): ClashFetcher => (MOCK_MODE ? lazyMockClash : riotClashFetcher()),
  /** Key limits recorded by the PHP gate (r=riot-limits); null when the route is not deployed. */
  riotLimits: (): Promise<RiotKeyLimits | null> =>
    MOCK_MODE ? import('./mock').then((m) => m.mockRiotLimits()) : fetchRiotLimits(),
};

/** Mock Clash routes, loaded on first use (mock.ts stays out of production bundles). */
const lazyMockClash: ClashFetcher = {
  player: (puuid, platform) => import('./mock').then((m) => m.mockClashFetcher.player(puuid, platform)),
  team: (teamId, platform) => import('./mock').then((m) => m.mockClashFetcher.team(teamId, platform)),
  tournaments: (platform) => import('./mock').then((m) => m.mockClashFetcher.tournaments(platform)),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Une erreur inattendue est survenue.';
}
