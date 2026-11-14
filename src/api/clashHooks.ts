// React bindings for Clash and the key limits: upcoming tournaments, our Clash team (ally role
// prefill), the key limits line of the Méta page. One ClashDirectory per page load (session cache).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from './client';
import {
  ClashDirectory,
  clashRole,
  prefillAllyRoles,
  TOURNAMENTS_TTL_MS,
  tournamentState,
  upcomingTournaments,
} from './clash';
import type { DraftSession } from './draftSession';
import { limitsRefetchInterval, RIOT_LIMITS_KEY } from './riotLimits';
import type { ClashPosition, ClashTeam, ClashTournament, DraftState, Player, Role } from './types';

/** Shared by the draft (enemy rosters, our team) and the tournaments card. */
export const clashDirectory = new ClashDirectory(api.clashFetcher());

export function useClashTournaments(platform: string, enabled: boolean) {
  return useQuery({
    queryKey: ['clash-tournaments', platform],
    queryFn: () => clashDirectory.tournaments(platform),
    enabled: enabled && !!platform,
    staleTime: TOURNAMENTS_TTL_MS,
    retry: false,
  });
}

/** The tournaments not over yet (soonest first). */
export function useUpcomingClash(platform: string, enabled: boolean): { list: ClashTournament[]; isPending: boolean; error: unknown } {
  const q = useClashTournaments(platform, enabled);
  const list = useMemo(() => upcomingTournaments(q.data ?? [], Date.now()), [q.data]);
  return { list, isPending: enabled && q.isPending, error: q.error };
}

/**
 * Key limits line of the Méta page: re-read every 15 s while `collecting` (this tab's loop or the
 * server's cron), after each pass (useMetaCollectorBridge) and whenever the page gets focus.
 */
export function useRiotLimits(enabled = true, collecting = false) {
  return useQuery({
    queryKey: RIOT_LIMITS_KEY,
    queryFn: api.riotLimits,
    enabled,
    staleTime: 60_000,
    retry: false,
    refetchInterval: limitsRefetchInterval(collecting),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
  });
}

// ---- our Clash team -----------------------------------------------------------------------------

export interface OurClashMember {
  player_id: string;
  position: ClashPosition;
  role: Role | null;
}

export interface OurClashState {
  state: 'idle' | 'loading' | 'done' | 'error';
  /** Our team (null: no friend registered). */
  team: ClashTeam | null;
  /** Friends of the draft found in that team, with their declared positions. */
  members: OurClashMember[];
  /** Slots whose role was pre-filled from the declared positions (French, for the notice). */
  prefilled: { player_id: string; role: Role }[];
  error: string | null;
  run(): void;
}

/** Slots pre-filled once per page load (draft id + player): a role cleared afterwards stays cleared. */
const prefilledOnce = new Set<string>();

/**
 * "Notre équipe Clash": the friends' Clash team (one clash-player call per friend with a puuid, one
 * team call per team id, cached for the session) and their declared positions pre-filling the
 * empty ally roles. Runs by itself while a Clash tournament is open (registration or live),
 * otherwise on demand. Never overwrites a role chosen by the user or the client.
 */
export function useOurClashTeam(
  session: DraftSession | null,
  draft: DraftState | undefined,
  friends: Player[],
  platform: string,
  enabled: boolean,
  /** The shared document was read (before that, editing a slot would override the team's slots). */
  loaded: boolean,
  liveSync: boolean,
): OurClashState {
  const [st, setSt] = useState<Omit<OurClashState, 'run'>>({ state: 'idle', team: null, members: [], prefilled: [], error: null });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const tournaments = useUpcomingClash(platform, enabled);
  const open = tournaments.list.some((t) => {
    const s = tournamentState(t, Date.now());
    return s === 'registration' || s === 'live';
  });
  const withPuuid = useMemo(() => friends.filter((p) => p.puuid), [friends]);
  const key = withPuuid.map((p) => `${p.id}:${p.puuid}`).join(',');

  const run = useCallback(() => {
    if (!enabled || !withPuuid.length) {
      setSt({ state: 'done', team: null, members: [], prefilled: [], error: withPuuid.length ? null : 'Aucun ami synchronisé avec Riot dans cette draft.' });
      return;
    }
    setSt((s) => ({ ...s, state: 'loading', error: null }));
    void (async () => {
      try {
        const looks = await Promise.all(withPuuid.map((p) => clashDirectory.lookup(p.puuid as string, p.platform || platform).then((l) => ({ p, l }))));
        // The team most friends are in (first friend's on ties).
        const counts = new Map<string, { team: ClashTeam; n: number }>();
        for (const { l } of looks) if (l.team) counts.set(l.team.id, { team: l.team, n: (counts.get(l.team.id)?.n ?? 0) + 1 });
        const team = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.team ?? null;
        const members: OurClashMember[] = team
          ? looks.filter(({ l }) => l.team?.id === team.id).map(({ p, l }) => ({ player_id: p.id, position: l.position ?? 'UNSELECTED', role: clashRole(l.position) }))
          : [];
        let prefilled: { player_id: string; role: Role }[] = [];
        const cur = draftRef.current;
        if (team && cur && session && loaded && !liveSync) {
          const positions = Object.fromEntries(members.map((m) => [m.player_id, m.position]));
          const skip = cur.ally.map((s) => s.player_id).filter((id): id is string => !!id && prefilledOnce.has(`${cur.id}:${id}`));
          const changes = prefillAllyRoles(cur, positions, skip);
          if (changes.length) {
            for (const c of changes) prefilledOnce.add(`${cur.id}:${c.player_id}`);
            session.edit(changes.map((c) => `ally.${c.index}`), (d) => {
              // Re-checked on the latest document: only still-empty roles of the same friend.
              const taken = new Set(d.ally.map((s) => s.role).filter(Boolean));
              const ally = d.ally.map((s, i) => {
                const c = changes.find((x) => x.index === i);
                if (!c || s.player_id !== c.player_id || s.role || taken.has(c.role)) return s;
                taken.add(c.role);
                return { ...s, role: c.role };
              });
              return { ...d, ally };
            });
            prefilled = changes.map((c) => ({ player_id: c.player_id, role: c.role }));
          }
        }
        setSt({ state: 'done', team, members, prefilled, error: null });
      } catch (err) {
        setSt((s) => ({ ...s, state: 'error', error: errorMessage(err) }));
      }
    })();
  }, [enabled, withPuuid, platform, session, loaded, liveSync]);

  // Automatic while a tournament is open (once per draft/friends).
  const autoKey = `${draft?.id ?? ''}|${key}`;
  const ran = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !open || !session || !loaded || !draft || !withPuuid.length || ran.current === autoKey) return;
    ran.current = autoKey;
    run();
  }, [enabled, open, session, loaded, draft, withPuuid.length, autoKey, run]);

  return { ...st, run };
}
