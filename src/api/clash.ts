// Clash (clash-v1 through the PHP proxy): the Clash team of a player, its roster with declared
// positions, upcoming tournaments. Revealing or scouting one Clash opponent scouts the whole team;
// our own Clash team pre-fills the empty ally roles. Every call goes through the shared rate
// limiter (riotGet); lookups are cached for the session, at most one team lookup per team id.
import type { ClashPlayer, ClashPosition, ClashTeam, ClashTournament, DraftState, EnemyPlayerProfile, Role } from './types';
import { ApiError } from './backend';
import { riotGet, type RiotTransport } from './riot';

export const CLASH_POSITIONS: ClashPosition[] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'FILL', 'UNSELECTED'];
const POSITION_ROLE: Partial<Record<ClashPosition, Role>> = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MID', BOTTOM: 'BOTTOM', UTILITY: 'SUPPORT' };
/** Tournaments are re-read after this (the PHP proxy caches them 10 min as well). */
export const TOURNAMENTS_TTL_MS = 10 * 60 * 1000;
/** A tournament stays "current" this long after its last phase started (a Clash day lasts a few hours). */
export const TOURNAMENT_ACTIVE_MS = 6 * 60 * 60 * 1000;
/** Teams looked at when a player has several Clash entries (one per tournament). */
export const MAX_TEAMS_PER_PLAYER = 2;

/** TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY -> role; FILL/UNSELECTED/unknown -> null. */
export function clashRole(position: ClashPosition | string | null | undefined): Role | null {
  return position ? POSITION_ROLE[position as ClashPosition] ?? null : null;
}

export const isClashPosition = (v: unknown): v is ClashPosition => typeof v === 'string' && (CLASH_POSITIONS as string[]).includes(v);

// ---- raw payloads -> types -------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

/** One entry of clash-v1 players/by-puuid (one per registered team). */
export interface ClashEntry {
  team_id: string | null;
  position: ClashPosition;
  role: string;
}

export function mapClashEntries(raw: unknown): ClashEntry[] {
  return (Array.isArray(raw) ? raw : []).filter(isObj).map((e) => ({
    team_id: str(e.teamId) || null,
    position: isClashPosition(e.position) ? e.position : 'UNSELECTED',
    role: str(e.role) || 'MEMBER',
  }));
}

export function mapClashPlayer(raw: unknown): ClashPlayer | null {
  if (!isObj(raw)) return null;
  return {
    puuid: str(raw.puuid) || null,
    position: isClashPosition(raw.position) ? raw.position : 'UNSELECTED',
    role: str(raw.role) || 'MEMBER',
  };
}

export function mapClashTeam(raw: unknown): ClashTeam | null {
  if (!isObj(raw) || !str(raw.id)) return null;
  return {
    id: str(raw.id),
    tournament_id: int(raw.tournamentId),
    name: str(raw.name) || 'Équipe Clash',
    abbreviation: str(raw.abbreviation),
    tier: int(raw.tier),
    icon_id: int(raw.iconId),
    players: (Array.isArray(raw.players) ? raw.players : []).map(mapClashPlayer).filter((p): p is ClashPlayer => !!p),
  };
}

export function mapClashTournament(raw: unknown): ClashTournament | null {
  if (!isObj(raw) || typeof raw.id !== 'number') return null;
  return {
    id: int(raw.id),
    name: str(raw.nameKey),
    name_secondary: str(raw.nameKeySecondary),
    phases: (Array.isArray(raw.schedule) ? raw.schedule : []).filter(isObj).map((p) => ({
      id: int(p.id),
      registration_time: int(p.registrationTime),
      start_time: int(p.startTime),
      cancelled: p.cancelled === true,
    })).sort((a, b) => a.start_time - b.start_time),
  };
}

export function mapClashTournaments(raw: unknown): ClashTournament[] {
  return (Array.isArray(raw) ? raw : []).map(mapClashTournament).filter((t): t is ClashTournament => !!t);
}

// ---- tournaments -----------------------------------------------------------------------------------

/** Phases not cancelled. */
const livePhases = (t: ClashTournament) => t.phases.filter((p) => !p.cancelled);

/** Last moment the tournament is relevant (last phase start + TOURNAMENT_ACTIVE_MS), null without phases. */
export function tournamentEnd(t: ClashTournament): number | null {
  const ph = livePhases(t);
  return ph.length ? ph[ph.length - 1].start_time + TOURNAMENT_ACTIVE_MS : null;
}

/** Tournaments not over yet, soonest first. */
export function upcomingTournaments(list: ClashTournament[], now: number): ClashTournament[] {
  return list
    .filter((t) => (tournamentEnd(t) ?? 0) > now)
    .sort((a, b) => (nextPhase(a, now)?.start_time ?? 0) - (nextPhase(b, now)?.start_time ?? 0) || a.id - b.id);
}

/** The phase to show: the one in progress (started < TOURNAMENT_ACTIVE_MS ago) or the next one. */
export function nextPhase(t: ClashTournament, now: number): ClashTournament['phases'][number] | null {
  return livePhases(t).find((p) => p.start_time + TOURNAMENT_ACTIVE_MS > now) ?? null;
}

export type TournamentState = 'soon' | 'registration' | 'live';

export function tournamentState(t: ClashTournament, now: number): TournamentState | null {
  const p = nextPhase(t, now);
  if (!p) return null;
  if (now >= p.start_time) return 'live';
  if (now >= p.registration_time) return 'registration';
  return 'soon';
}

/** "Bilgewater · Jour 2" from the name keys ("bilgewater", "day_2"). */
export function tournamentLabel(t: ClashTournament): string {
  const cap = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const day = /^day_(\d+)$/i.exec(t.name_secondary);
  const second = day ? `Jour ${day[1]}` : t.name_secondary ? cap(t.name_secondary) : '';
  return [cap(t.name) || `Tournoi ${t.id}`, second].filter(Boolean).join(' · ');
}

// ---- session directory -------------------------------------------------------------------------------

/** The four proxy routes (real: riotGet; mock mode and tests: fakes). */
export interface ClashFetcher {
  player(puuid: string, platform: string): Promise<unknown>;
  team(teamId: string, platform: string): Promise<unknown>;
  tournaments(platform: string): Promise<unknown>;
}

export function riotClashFetcher(t?: RiotTransport): ClashFetcher {
  return {
    player: (puuid, platform) => riotGet<unknown>('clash-player', { platform, puuid }, t),
    team: (teamId, platform) => riotGet<unknown>('clash-team', { platform, teamId }, t),
    tournaments: (platform) => riotGet<unknown>('clash-tournaments', { platform }, t),
  };
}

export interface ClashLookup {
  /** The player's team (the one of the current/next tournament when several), null when none. */
  team: ClashTeam | null;
  /** Declared position in that team. */
  position: ClashPosition | null;
}

const NONE: ClashLookup = { team: null, position: null };
/** Riot's 404 (no team, no tournament) — not the proxy's "Route inconnue." (route not deployed yet). */
const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404 && !/route inconnue/i.test(err.message);
const TEAM_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Session cache of Clash lookups: one clash-player call per puuid, one clash-team call per team id
 * (a roster also tells every member's team: no player call for them), tournaments every 10 min.
 * Failures other than 404 are not cached (retried on the next request). Counts the calls made.
 */
export class ClashDirectory {
  calls = 0;
  private players = new Map<string, Promise<ClashLookup>>();
  private teams = new Map<string, Promise<ClashTeam | null>>();
  private tournamentsCache = new Map<string, { at: number; list: Promise<ClashTournament[]> }>();

  constructor(private readonly fetcher: ClashFetcher, private readonly now: () => number = () => Date.now()) {}

  private count<T>(p: () => Promise<T>): Promise<T> {
    this.calls += 1;
    return p();
  }

  tournaments(platform: string): Promise<ClashTournament[]> {
    const hit = this.tournamentsCache.get(platform);
    if (hit && this.now() - hit.at < TOURNAMENTS_TTL_MS) return hit.list;
    const list = this.count(() => this.fetcher.tournaments(platform))
      .then(mapClashTournaments)
      .catch((err) => {
        this.tournamentsCache.delete(platform);
        if (isNotFound(err)) return [];
        throw err;
      });
    this.tournamentsCache.set(platform, { at: this.now(), list });
    return list;
  }

  team(teamId: string, platform: string): Promise<ClashTeam | null> {
    if (!TEAM_ID.test(teamId)) return Promise.resolve(null);
    const key = `${platform}:${teamId}`;
    let p = this.teams.get(key);
    if (!p) {
      p = this.count(() => this.fetcher.team(teamId, platform))
        .then((raw) => {
          const team = mapClashTeam(raw);
          if (team) this.learnRoster(team, platform);
          return team;
        })
        .catch((err) => {
          if (isNotFound(err)) return null;
          this.teams.delete(key);
          throw err;
        });
      this.teams.set(key, p);
    }
    return p;
  }

  /** Members of a fetched roster need no clash-player call of their own. */
  private learnRoster(team: ClashTeam, platform: string): void {
    for (const m of team.players) {
      const key = `${platform}:${m.puuid}`;
      if (m.puuid && !this.players.has(key)) this.players.set(key, Promise.resolve({ team, position: m.position }));
    }
  }

  /** Cached lookup without any call (undefined = never looked up). */
  peek(puuid: string, platform: string): Promise<ClashLookup> | undefined {
    return this.players.get(`${platform}:${puuid}`);
  }

  /** The player's Clash team: clash-player, then the team (current/upcoming tournament first). */
  lookup(puuid: string, platform: string): Promise<ClashLookup> {
    const key = `${platform}:${puuid}`;
    let p = this.players.get(key);
    if (!p) {
      p = this.count(() => this.fetcher.player(puuid, platform))
        .then(async (raw) => {
          const entries = mapClashEntries(raw).filter((e) => e.team_id);
          if (!entries.length) return NONE;
          const teams = (await Promise.all(entries.slice(0, MAX_TEAMS_PER_PLAYER).map((e) => this.team(e.team_id as string, platform))))
            .map((team, i) => ({ team, entry: entries[i] }))
            .filter((x): x is { team: ClashTeam; entry: ClashEntry } => !!x.team);
          if (!teams.length) return NONE;
          let best = teams[0];
          if (teams.length > 1) {
            const order = upcomingTournaments(await this.tournaments(platform).catch(() => []), this.now()).map((t) => t.id);
            const rank = (x: { team: ClashTeam }) => (order.includes(x.team.tournament_id) ? order.indexOf(x.team.tournament_id) : order.length);
            best = [...teams].sort((a, b) => rank(a) - rank(b))[0];
          }
          const declared = best.team.players.find((m) => m.puuid === puuid)?.position ?? best.entry.position;
          return { team: best.team, position: declared };
        })
        .catch((err) => {
          if (isNotFound(err)) return NONE;
          this.players.delete(key);
          throw err;
        });
      this.players.set(key, p);
    }
    return p;
  }
}

// ---- roster expansion (pure) ---------------------------------------------------------------------

export interface ClashTeamRef {
  id: string;
  name: string;
  abbreviation: string;
}

export const teamRef = (t: ClashTeam): ClashTeamRef => ({ id: t.id, name: t.name, abbreviation: t.abbreviation });

export interface RosterPlan {
  /** Members to profile (source "clash"), with their declared position. */
  add: { puuid: string; position: ClashPosition }[];
  /** Known profiles to annotate (clash_position / clash_team). */
  annotate: { puuid: string; position: ClashPosition }[];
  /** Members the API gives without a puuid: skipped. */
  skipped: number;
  /** Members left out because the document is full. */
  over: number;
}

/**
 * Who to scout from a Clash roster: every member with a puuid not known yet (up to `room` new
 * profiles), the known ones being annotated. Members without puuid are counted as skipped.
 */
export function planRoster(team: ClashTeam, known: Iterable<string>, room: number): RosterPlan {
  const have = new Set(known);
  const plan: RosterPlan = { add: [], annotate: [], skipped: 0, over: 0 };
  const seen = new Set<string>();
  for (const m of team.players) {
    if (!m.puuid) {
      plan.skipped += 1;
      continue;
    }
    if (seen.has(m.puuid)) continue;
    seen.add(m.puuid);
    if (have.has(m.puuid)) plan.annotate.push({ puuid: m.puuid, position: m.position });
    else if (plan.add.length < Math.max(0, room)) plan.add.push({ puuid: m.puuid, position: m.position });
    else plan.over += 1;
  }
  return plan;
}

/** French note about a roster expansion ("" when nothing to say). */
export function rosterNote(team: ClashTeamRef, plan: Pick<RosterPlan, 'add' | 'skipped' | 'over'>): string {
  const parts: string[] = [];
  if (plan.add.length) parts.push(`${plan.add.length} membre${plan.add.length > 1 ? 's' : ''} ajouté${plan.add.length > 1 ? 's' : ''} au repérage`);
  if (plan.skipped) parts.push(`${plan.skipped} sans identifiant Riot (ignoré${plan.skipped > 1 ? 's' : ''})`);
  if (plan.over) parts.push(`${plan.over} non repéré${plan.over > 1 ? 's' : ''} (liste pleine)`);
  if (!parts.length) return '';
  return `Équipe Clash « ${team.name} »${team.abbreviation ? ` [${team.abbreviation}]` : ''} : ${parts.join(', ')}.`;
}

/** Profile with its Clash data (keeps everything else). */
export function withClash(p: EnemyPlayerProfile, team: ClashTeamRef | null, position: ClashPosition | null): EnemyPlayerProfile {
  return { ...p, clash_team: team, clash_position: team ? position : null };
}

// ---- our team: ally role prefill (pure) -------------------------------------------------------------

/**
 * Ally slots whose role can be filled from the friends' declared Clash positions: only slots of a
 * friend with no role yet, only positions that map to a role (not FILL/UNSELECTED) and are not
 * already taken by another ally slot, never twice the same role, and never a slot listed in `skip`
 * (already pre-filled once: if the user cleared it, that is their choice).
 */
export function prefillAllyRoles(
  draft: Pick<DraftState, 'ally'>,
  positions: Record<string, ClashPosition | null | undefined>,
  skip: Iterable<string> = [],
): { index: number; player_id: string; role: Role }[] {
  const done = new Set(skip);
  const taken = new Set(draft.ally.map((s) => s.role).filter((r): r is Role => !!r));
  const out: { index: number; player_id: string; role: Role }[] = [];
  draft.ally.forEach((s, index) => {
    if (!s.player_id || s.role || done.has(s.player_id)) return;
    const role = clashRole(positions[s.player_id]);
    if (!role || taken.has(role)) return;
    taken.add(role);
    out.push({ index, player_id: s.player_id, role });
  });
  return out;
}
