import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type DraftEngine } from './client';
import {
  mapCompanionPayload,
  MAX_SCOUTED,
  playerToInput,
  removeProfile,
  scoutedProfiles,
  toDraftInput,
  upsertProfile,
} from './draft';
import { DraftSession, type DraftSnapshot } from './draftSession';
import { EnemyProfileService, requestKey, type ProfileRequest, type ProfileStatus } from './enemyProfile';
import type { DraftAdvice, DraftState, EnemyPlayerProfile, Player } from './types';
import { parseRiotId } from '../lib/format';

/** Catalog + advisor, loaded once per page load. */
export function useDraftEngine() {
  return useQuery({ queryKey: ['draft-engine'], queryFn: api.draftEngine, staleTime: Infinity, gcTime: Infinity });
}

/**
 * Shared draft session for `initial.id` (re-created when the id or the friends change).
 * Returns null until the first render effect ran.
 */
export function useDraftSession(initial: DraftState, players: Player[] | undefined, engine: DraftEngine | undefined) {
  const [session, setSession] = useState<DraftSession | null>(null);
  const [snap, setSnap] = useState<DraftSnapshot | null>(null);
  const key = `${initial.id}|${initial.player_ids.join(',')}`;

  useEffect(() => {
    const s = new DraftSession(initial, { load: api.getDraft, save: api.saveDraft, fetchLive: api.liveDraft });
    setSession(s);
    setSnap(s.getSnapshot());
    const unsubscribe = s.subscribe(() => setSnap(s.getSnapshot()));
    s.start();
    return () => {
      unsubscribe();
      s.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Companion data: needs the catalog (numeric keys) and the players' puuids.
  useEffect(() => {
    if (!session) return;
    if (!engine || !players) {
      session.setMapper(null);
      return;
    }
    const friends = players.map((p) => ({ id: p.id, puuid: p.puuid }));
    session.setMapper((live) => mapCompanionPayload(live, engine.catalog, friends));
  }, [session, engine, players]);

  // Companion data is looked for among the friends of the draft (and friends placed in slots).
  const slotIds = snap ? snap.draft.ally.map((s) => s.player_id).filter((x): x is string => !!x) : [];
  const liveKey = Array.from(new Set([...initial.player_ids, ...slotIds])).slice(0, 5).join(',');
  useEffect(() => {
    session?.setLivePlayers(liveKey ? liveKey.split(',') : []);
  }, [session, liveKey]);

  return { session, snap };
}

/** Advice recomputed locally whenever the draft (or the players) change. */
export function useDraftAdvice(
  draft: DraftState | undefined,
  players: Player[] | undefined,
  engine: DraftEngine | undefined,
): { advice: DraftAdvice | null; error: string | null } {
  const inputKey = draft ? JSON.stringify(toDraftInput(draft)) : '';
  const slotIds = draft ? draft.ally.map((s) => s.player_id ?? '').join(',') : '';
  return useMemo(() => {
    if (!draft || !players || !engine) return { advice: null, error: null };
    const ids = new Set(draft.ally.map((s) => s.player_id).filter((x): x is string => !!x));
    const inputs = players.filter((p) => ids.has(p.id)).map(playerToInput);
    try {
      return { advice: engine.advise(inputs, toDraftInput(draft)), error: null };
    } catch (err) {
      return { advice: null, error: err instanceof Error ? err.message : 'Conseils indisponibles.' };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, slotIds, players, engine]);
}

// ---- enemy profiles ----------------------------------------------------------------------------

/** One service per page load: profiles are fetched once per session whatever the draft. */
const profileService = new EnemyProfileService((req, onProgress) => api.enemyProfile(req, onProgress));

/** Delay before an automatic fetch: a friend's browser may store the profile meanwhile. */
const AUTO_FETCH_JITTER_MS = 1200;

export interface EnemyProfilesApi {
  /** Builds in flight / failed, started from this page. */
  statuses: ProfileStatus[];
  /** null when started, else a French error (invalid Riot ID, already scouted, list full). */
  scout(riotId: string, platform: string): string | null;
  removeScouted(puuidOrKey: string): void;
  retry(key: string): void;
}

/**
 * Fetches and stores enemy profiles in the shared draft (path "enemy_profiles"): scouting by Riot
 * ID on demand, client-revealed enemies (slot puuid) and the started game's enemies automatically.
 * Never blocks: everything runs in the background, progress is exposed through `statuses`.
 */
export function useEnemyProfiles(session: DraftSession | null, draft: DraftState | undefined, platform: string, enabled: boolean): EnemyProfilesApi {
  const all = useSyncExternalStore(profileService.subscribe, profileService.getStatuses, profileService.getStatuses);
  const [mine, setMine] = useState<Map<string, ProfileRequest>>(() => new Map());
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    profileService.seed(draft?.enemy_profiles);
  }, [draft?.enemy_profiles]);

  const store = useCallback((profile: EnemyPlayerProfile) => {
    session?.edit(['enemy_profiles'], (d) => {
      const next = upsertProfile(d.enemy_profiles, profile);
      return JSON.stringify(next) === JSON.stringify(d.enemy_profiles ?? []) ? d : { ...d, enemy_profiles: next };
    }, { data: true });
  }, [session]);

  const start = useCallback((req: ProfileRequest) => {
    const key = requestKey(req);
    setMine((m) => (m.has(key) ? m : new Map(m).set(key, req)));
    profileService.request(req).then(store, () => undefined);
  }, [store]);

  const scout = useCallback((text: string, plat: string): string | null => {
    const cur = draftRef.current;
    if (!cur) return 'Draft en cours de chargement.';
    if (!enabled) return 'Clé API Riot non configurée : le repérage est indisponible.';
    const id = parseRiotId(text);
    if (!id) return 'Riot ID invalide : utilisez le format Nom#TAG.';
    const riot_id = `${id.game_name}#${id.tag_line}`;
    const scouted = scoutedProfiles(cur);
    const pending = profileService.getStatuses().filter((s) => s.source === 'scouting' && s.state === 'loading' && mine.has(s.key));
    const same = (x: string | null | undefined) => (x ?? '').toLowerCase() === riot_id.toLowerCase();
    if (scouted.some((p) => same(p.riot_id)) || pending.some((s) => same(s.riot_id))) return `${riot_id} est déjà dans la liste.`;
    if (scouted.length + pending.length >= MAX_SCOUTED) return `Au maximum ${MAX_SCOUTED} adversaires repérés.`;
    start({ source: 'scouting', platform: plat, riot_id });
    return null;
  }, [enabled, mine, start]);

  const removeScouted = useCallback((puuidOrKey: string) => {
    for (const s of profileService.getStatuses()) if (s.key === puuidOrKey || s.puuid === puuidOrKey) profileService.forget(s.key);
    setMine((m) => {
      const next = new Map(m);
      for (const [k, r] of m) if (k === puuidOrKey || r.puuid === puuidOrKey) next.delete(k);
      return next;
    });
    if (draftRef.current?.enemy_profiles?.some((p) => p.puuid === puuidOrKey)) {
      session?.edit(['enemy_profiles'], (d) => ({ ...d, enemy_profiles: removeProfile(d.enemy_profiles, puuidOrKey) }), { data: true });
    }
  }, [session]);

  const retry = useCallback((key: string) => {
    const req = mine.get(key);
    if (!req) return;
    profileService.forget(key);
    start(req);
  }, [mine, start]);

  // Automatic profiles: enemies revealed by the client (Clash/custom) and the started game's enemies.
  const wanted = useMemo((): ProfileRequest[] => {
    if (!draft || !enabled) return [];
    const reqs: ProfileRequest[] = [];
    const inGame = draft.phase === 'in_game';
    // During champion select only the client can reveal a puuid (Clash/custom); once the game has
    // started the slots carry the spectator puuids (source "game").
    for (const s of inGame ? [] : draft.enemy) {
      if (s.puuid) reqs.push({ source: 'client', platform, puuid: s.puuid, champion_id: s.champion_id ?? null, role: s.role ?? null });
    }
    if (inGame) {
      for (const a of draft.enemy_accounts ?? []) {
        if (a.puuid && !reqs.some((r) => r.puuid === a.puuid)) {
          reqs.push({ source: 'game', platform, puuid: a.puuid, riot_id: a.riot_id ?? null, champion_id: a.champion_id || null, role: a.role ?? null });
        }
      }
    }
    const known = new Set((draft.enemy_profiles ?? []).map((p) => p.puuid));
    return reqs.filter((r) => !known.has(r.puuid as string));
  }, [draft, enabled, platform]);
  const wantedKey = wanted.map((r) => `${r.source}:${r.puuid}`).join(',');

  useEffect(() => {
    if (!wanted.length) return;
    const t = setTimeout(() => {
      const known = new Set((draftRef.current?.enemy_profiles ?? []).map((p) => p.puuid));
      for (const req of wanted) {
        const key = requestKey(req);
        const failed = profileService.getStatuses().some((s) => s.key === key && s.state === 'error');
        if (known.has(req.puuid as string) || failed || profileService.isPending(key)) continue;
        start(req);
      }
    }, profileService.cached(wanted[0]) ? 0 : Math.round(Math.random() * AUTO_FETCH_JITTER_MS));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, start]);

  const statuses = useMemo(() => all.filter((s) => mine.has(s.key) && s.state !== 'done'), [all, mine]);
  return { statuses, scout, removeScouted, retry };
}
