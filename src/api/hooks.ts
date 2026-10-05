import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  ChampionInfo,
  CreatePlayerBody,
  ManualPoolEntry,
  Player,
  PlayerPreferences,
  SaveCompositionBody,
  TeamBody,
} from './types';

export const qk = {
  meta: ['meta'] as const,
  champions: ['champions'] as const,
  archetypes: ['archetypes'] as const,
  themes: ['themes'] as const,
  players: ['players'] as const,
  player: (id: string) => ['players', id] as const,
  teams: ['teams'] as const,
  saved: ['saved'] as const,
};

const STATIC = { staleTime: Infinity, gcTime: Infinity } as const;

export const useMeta = () => useQuery({ queryKey: qk.meta, queryFn: api.meta, ...STATIC });
export const useChampions = () => useQuery({ queryKey: qk.champions, queryFn: api.champions, ...STATIC });
export const useArchetypes = () => useQuery({ queryKey: qk.archetypes, queryFn: api.archetypes, ...STATIC });
export const useThemes = () => useQuery({ queryKey: qk.themes, queryFn: api.themes, ...STATIC });
export const usePlayers = () => useQuery({ queryKey: qk.players, queryFn: api.listPlayers });
export const usePlayer = (id: string) => useQuery({ queryKey: qk.player(id), queryFn: () => api.getPlayer(id) });
export const useTeams = () => useQuery({ queryKey: qk.teams, queryFn: api.listTeams });
export const useSaved = () => useQuery({ queryKey: qk.saved, queryFn: api.listSaved });

/** Map champion id -> ChampionInfo, empty while loading. */
export function useChampionMap(): Map<string, ChampionInfo> {
  const { data } = useChampions();
  return useMemo(() => new Map((data ?? []).map((c) => [c.id, c])), [data]);
}

/** Lookup of theme key -> label. */
export function useThemeLabels(): (key: string) => string {
  const { data } = useThemes();
  return useMemo(() => {
    const m = new Map((data ?? []).map((t) => [t.key, t.label]));
    return (key: string) => m.get(key) ?? key;
  }, [data]);
}

function usePlayerUpdater() {
  const qc = useQueryClient();
  return (p: Player) => {
    qc.setQueryData(qk.player(p.id), p);
    qc.setQueryData<Player[]>(qk.players, (old) => old?.map((x) => (x.id === p.id ? p : x)));
  };
}

export function useCreatePlayer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePlayerBody) => api.createPlayer(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.players }),
  });
}

export function useDeletePlayer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deletePlayer(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.players });
      qc.invalidateQueries({ queryKey: qk.teams });
    },
  });
}

export function useSyncPlayer() {
  const update = usePlayerUpdater();
  return useMutation({ mutationFn: (id: string) => api.syncPlayer(id), onSuccess: update });
}

export function useUpdatePreferences(id: string) {
  const update = usePlayerUpdater();
  return useMutation({ mutationFn: (p: PlayerPreferences) => api.updatePreferences(id, p), onSuccess: update });
}

export function useUpdatePool(id: string) {
  const update = usePlayerUpdater();
  return useMutation({ mutationFn: (c: ManualPoolEntry[]) => api.updatePool(id, c), onSuccess: update });
}

export function useSaveTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: TeamBody }) => (id ? api.updateTeam(id, body) : api.createTeam(body)),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.teams }),
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTeam(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.teams }),
  });
}

export function useSaveComposition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveCompositionBody) => api.saveComposition(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.saved }),
  });
}

export function useDeleteSaved() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSaved(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.saved }),
  });
}
