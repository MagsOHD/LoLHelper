import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type DraftEngine } from './client';
import { mapCompanionPayload, playerToInput, toDraftInput } from './draft';
import { DraftSession, type DraftSnapshot } from './draftSession';
import type { DraftAdvice, DraftState, Player } from './types';

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
