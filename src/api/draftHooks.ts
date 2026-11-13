import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type DraftEngine } from './client';
import {
  annotateClash,
  mapCompanionPayload,
  MAX_ENEMY_PROFILES,
  MAX_SCOUTED,
  playerToInput,
  removeProfile,
  scoutedProfiles,
  toDraftInput,
  upsertProfile,
} from './draft';
import { DraftSession, type DraftSnapshot } from './draftSession';
import { EnemyProfileService, requestKey, type ProfileRequest, type ProfileStatus } from './enemyProfile';
import type { DraftAdvice, DraftState, EnemyPlayerProfile, Player, Rank } from './types';
import { useTierOverride } from './metaHooks';
import { medianTier } from './metaRank';
import { parseRiotId } from '../lib/format';
import { planRoster, rosterNote, teamRef, type ClashLookup } from './clash';
import { clashDirectory } from './clashHooks';

/**
 * Catalog + advisor, loaded once per page load and meta tier: the tier closest to the median solo
 * rank of the draft's friends (or the one chosen on the Méta page).
 */
export function useDraftEngine(ranks: readonly (Rank | null | undefined)[] = []) {
  const [override] = useTierOverride();
  const median = medianTier(ranks).tier;
  return useQuery({
    queryKey: ['draft-engine', override ?? 'auto', median ?? 'unranked'],
    queryFn: () => api.draftEngine(ranks),
    staleTime: Infinity,
    gcTime: Infinity,
    placeholderData: keepPreviousData,
  });
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
  /** French notes about enemy Clash rosters (members added / skipped), one per team. */
  clashNotes: string[];
}

/** Enemy puuids whose Clash team was looked up this page load, and teams already expanded. */
const clashChecked = new Set<string>();
const clashExpanded = new Set<string>();

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

  // Clash: every known enemy (scouted, revealed by the client or in the started game) is looked up
  // once (clash-player); a scouted/revealed player's Clash team adds its other members as "clash"
  // profiles. Game profiles are only annotated (in ranked, their Clash team is not the opponent).
  const [clashNotes, setClashNotes] = useState<Map<string, string>>(() => new Map());
  const clashKey = enabled
    ? (draft?.enemy_profiles ?? []).filter((p) => p.source !== 'clash' && p.clash_team === undefined && !clashChecked.has(p.puuid)).map((p) => p.puuid).join(',')
    : '';
  useEffect(() => {
    if (!clashKey) return;
    const t = setTimeout(() => {
      for (const p of draftRef.current?.enemy_profiles ?? []) {
        if (p.source === 'clash' || p.clash_team !== undefined || clashChecked.has(p.puuid)) continue;
        clashChecked.add(p.puuid);
        const source = p.source;
        clashDirectory.lookup(p.puuid, platform).then((look: ClashLookup) => {
          const cur = draftRef.current;
          if (!cur) return;
          const team = look.team ? teamRef(look.team) : null;
          const updates: Parameters<typeof annotateClash>[1] = [{ puuid: p.puuid, team, position: look.position }];
          if (look.team && team) {
            const known = (cur.enemy_profiles ?? []).map((x) => x.puuid);
            const pending = profileService.getStatuses().filter((x) => x.state === 'loading').length;
            const expand = source !== 'game' && !clashExpanded.has(look.team.id);
            const plan = planRoster(look.team, known, expand ? MAX_ENEMY_PROFILES - known.length - pending : 0);
            for (const m of plan.annotate) if (m.puuid !== p.puuid) updates.push({ puuid: m.puuid, team, position: m.position });
            if (expand) {
              clashExpanded.add(look.team.id);
              for (const m of plan.add) start({ source: 'clash', platform, puuid: m.puuid, clash_team: team, clash_position: m.position });
              const note = rosterNote(team, plan);
              if (note) setClashNotes((n) => new Map(n).set(team.id, note));
            }
          }
          session?.edit(['enemy_profiles'], (d) => {
            const next = annotateClash(d.enemy_profiles, updates);
            return next === d.enemy_profiles ? d : { ...d, enemy_profiles: next };
          }, { data: true });
        }, () => {
          // Clash unavailable (route not deployed, rate limit): retried on the next page load.
        });
      }
    }, Math.round(Math.random() * AUTO_FETCH_JITTER_MS));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clashKey, platform, session, start]);

  const statuses = useMemo(() => all.filter((s) => mine.has(s.key) && s.state !== 'done'), [all, mine]);
  const notes = useMemo(() => [...clashNotes.values()], [clashNotes]);
  return { statuses, scout, removeScouted, retry, clashNotes: notes };
}
