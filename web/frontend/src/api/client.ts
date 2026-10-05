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

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export const MOCK_MODE = import.meta.env.VITE_MOCK === '1';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

function extractDetail(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const detail = (data as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  // FastAPI validation errors: [{loc, msg, type}]
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : ''))
      .filter(Boolean);
    if (msgs.length) return msgs.join(' · ');
  }
  return null;
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (MOCK_MODE) {
    const { mockRequest } = await import('./mock');
    return (await mockRequest(method, path, body)) as T;
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Impossible de joindre le serveur. Vérifie que le backend est lancé.', 0);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    throw new ApiError(extractDetail(data) ?? `Erreur ${res.status} du serveur.`, res.status);
  }
  return data as T;
}

export const api = {
  // Meta
  health: () => request<{ status: string }>('GET', '/health'),
  meta: () => request<Meta>('GET', '/meta'),
  champions: () => request<ChampionInfo[]>('GET', '/champions'),
  archetypes: () => request<ArchetypeInfo[]>('GET', '/archetypes'),
  themes: () => request<ThemeInfo[]>('GET', '/themes'),

  // Players
  listPlayers: () => request<Player[]>('GET', '/players'),
  getPlayer: (id: string) => request<Player>('GET', `/players/${encodeURIComponent(id)}`),
  createPlayer: (body: CreatePlayerBody) => request<Player>('POST', '/players', body),
  deletePlayer: (id: string) => request<void>('DELETE', `/players/${encodeURIComponent(id)}`),
  syncPlayer: (id: string) => request<Player>('POST', `/players/${encodeURIComponent(id)}/sync`),
  updatePreferences: (id: string, prefs: PlayerPreferences) =>
    request<Player>('PUT', `/players/${encodeURIComponent(id)}/preferences`, prefs),
  updatePool: (id: string, champions: ManualPoolEntry[]) =>
    request<Player>('PUT', `/players/${encodeURIComponent(id)}/pool`, { champions }),

  // Teams
  listTeams: () => request<Team[]>('GET', '/teams'),
  getTeam: (id: string) => request<Team>('GET', `/teams/${encodeURIComponent(id)}`),
  createTeam: (body: TeamBody) => request<Team>('POST', '/teams', body),
  updateTeam: (id: string, body: TeamBody) => request<Team>('PUT', `/teams/${encodeURIComponent(id)}`, body),
  deleteTeam: (id: string) => request<void>('DELETE', `/teams/${encodeURIComponent(id)}`),

  // Compositions
  generate: (body: GenerateBody) =>
    request<{ suggestions: CompositionSuggestion[] }>('POST', '/compositions/generate', body),
  gamePlan: (picks: Pick[]) => request<GamePlan>('POST', '/compositions/game-plan', { picks }),
  matchup: (body: MatchupBody) => request<MatchupPlan>('POST', '/compositions/matchup', body),
  listSaved: () => request<SavedComposition[]>('GET', '/compositions/saved'),
  saveComposition: (body: SaveCompositionBody) => request<SavedComposition>('POST', '/compositions/saved', body),
  deleteSaved: (id: string) => request<void>('DELETE', `/compositions/saved/${encodeURIComponent(id)}`),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Une erreur inattendue est survenue.';
}
