// Page-facing data layer. Pages only use `api` (and the helpers re-exported here).
//
// Production (OVH shared hosting): static site + small PHP API (public/api/index.php) used as a
// document store and Riot API proxy; Data Dragon is fetched by the browser and the composition
// engine runs locally (src/engine). See service.ts.
// VITE_MOCK=1: in-memory demo backend (mock.ts), never bundled in production builds.
import type {
  ArchetypeInfo,
  ChampionInfo,
  CompositionSuggestion,
  CreatePlayerBody,
  GamePlan,
  GenerateBody,
  ManualPoolEntry,
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
import { localApi } from './service';

export { ApiError, AUTH_REQUIRED_EVENT, getPassword, setPassword } from './backend';

export const MOCK_MODE = import.meta.env.VITE_MOCK === '1';

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
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Une erreur inattendue est survenue.';
}
