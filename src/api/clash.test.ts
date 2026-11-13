import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClashDirectory,
  clashRole,
  mapClashTeam,
  mapClashTournaments,
  planRoster,
  prefillAllyRoles,
  riotClashFetcher,
  rosterNote,
  teamRef,
  tournamentLabel,
  tournamentState,
  upcomingTournaments,
  type ClashFetcher,
} from './clash';
import { ApiError } from './backend';
import { RateLimiter, type RiotTransport } from './riot';
import { annotateClash, emptyDraft, keptOnReset, normalizeProfile, upsertProfile } from './draft';
import type { ClashTeam, DraftAllySlot, EnemyPlayerProfile } from './types';
import { installWindow, json } from './__fixtures__/fakes';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const H = 3600_000;

const rawTeam = (id: string, tournamentId: number, players: { puuid?: string; position: string; role?: string }[]) => ({
  id, tournamentId, name: `Équipe ${id}`, iconId: 1, tier: 2, captain: 'x', abbreviation: id.slice(0, 3).toUpperCase(),
  players: players.map((p, i) => ({ summonerId: `s${i}`, role: 'MEMBER', ...p })),
});

const OMBRES = rawTeam('omb', 4201, [
  { puuid: 'e-mid', position: 'MIDDLE', role: 'CAPTAIN' },
  { puuid: 'e-top', position: 'TOP' },
  { puuid: 'e-sup', position: 'UTILITY' },
  { puuid: 'e-jgl', position: 'JUNGLE' },
  { position: 'BOTTOM' }, // old payload: no puuid
]);

const TOURNAMENTS = [
  { id: 4100, nameKey: 'ionia', nameKeySecondary: 'day_1', schedule: [{ id: 1, registrationTime: NOW - 200 * H, startTime: NOW - 100 * H, cancelled: false }] },
  { id: 4201, nameKey: 'bilgewater', nameKeySecondary: 'day_2', schedule: [{ id: 2, registrationTime: NOW - 48 * H, startTime: NOW + 30 * H, cancelled: false }] },
  { id: 4300, nameKey: 'zaun', nameKeySecondary: '', schedule: [{ id: 3, registrationTime: NOW + 100 * H, startTime: NOW + 200 * H, cancelled: false }] },
  { id: 4400, nameKey: 'noxus', nameKeySecondary: 'day_1', schedule: [{ id: 4, registrationTime: NOW - 1 * H, startTime: NOW - 2 * H, cancelled: false }] },
];

function fakeFetcher(players: Record<string, unknown>, teams: Record<string, unknown>) {
  const calls: string[] = [];
  const f: ClashFetcher = {
    player: vi.fn(async (puuid: string) => {
      calls.push(`player:${puuid}`);
      return players[puuid] ?? [];
    }),
    team: vi.fn(async (id: string) => {
      calls.push(`team:${id}`);
      if (!teams[id]) throw new ApiError('Équipe Clash introuvable.', 404);
      return teams[id];
    }),
    tournaments: vi.fn(async () => {
      calls.push('tournaments');
      return TOURNAMENTS;
    }),
  };
  return { f, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('Clash payloads', () => {
  it('maps positions to roles (FILL / UNSELECTED unknown)', () => {
    expect(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'FILL', 'UNSELECTED', null].map(clashRole)).toEqual([
      'TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT', null, null, null,
    ]);
  });

  it('maps teams (members without puuid kept as null) and tournaments', () => {
    const t = mapClashTeam(OMBRES)!;
    expect(t).toMatchObject({ id: 'omb', tournament_id: 4201, name: 'Équipe omb', abbreviation: 'OMB', tier: 2 });
    expect(t.players.map((p) => p.puuid)).toEqual(['e-mid', 'e-top', 'e-sup', 'e-jgl', null]);
    expect(mapClashTeam({ name: 'sans id' })).toBeNull();
    const list = mapClashTournaments(TOURNAMENTS);
    expect(list[1]).toEqual({ id: 4201, name: 'bilgewater', name_secondary: 'day_2', phases: [{ id: 2, registration_time: NOW - 48 * H, start_time: NOW + 30 * H, cancelled: false }] });
    expect(tournamentLabel(list[1])).toBe('Bilgewater · Jour 2');
    expect(tournamentLabel(list[2])).toBe('Zaun');
  });

  it('upcoming tournaments: past ones dropped, live / registration / soon states', () => {
    const list = upcomingTournaments(mapClashTournaments(TOURNAMENTS), NOW);
    expect(list.map((t) => t.id)).toEqual([4400, 4201, 4300]);
    expect(list.map((t) => tournamentState(t, NOW))).toEqual(['live', 'registration', 'soon']);
  });
});

describe('Clash directory (session cache, call budget)', () => {
  it('one player call per puuid, one team call per team id, roster members need no player call', async () => {
    const { f, calls } = fakeFetcher({ 'e-mid': [{ teamId: 'omb', position: 'MIDDLE', role: 'CAPTAIN' }] }, { omb: OMBRES });
    const dir = new ClashDirectory(f, () => NOW);
    const [a, b] = await Promise.all([dir.lookup('e-mid', 'euw1'), dir.lookup('e-mid', 'euw1')]);
    expect(a).toBe(b);
    expect(a.team?.name).toBe('Équipe omb');
    expect(a.position).toBe('MIDDLE');
    const top = await dir.lookup('e-top', 'euw1'); // learnt from the roster
    expect(top.position).toBe('TOP');
    await dir.team('omb', 'euw1');
    expect(calls).toEqual(['player:e-mid', 'team:omb']);
    expect(dir.calls).toBe(2);
    expect(await dir.lookup('nobody', 'euw1')).toEqual({ team: null, position: null });
    expect(dir.calls).toBe(3);
  });

  it('several teams: the one of the current/upcoming tournament wins', async () => {
    const old = rawTeam('old', 4100, [{ puuid: 'p', position: 'TOP' }]);
    const next = rawTeam('nxt', 4201, [{ puuid: 'p', position: 'JUNGLE' }]);
    const { f, calls } = fakeFetcher({ p: [{ teamId: 'old', position: 'TOP' }, { teamId: 'nxt', position: 'JUNGLE' }] }, { old, nxt: next });
    const dir = new ClashDirectory(f, () => NOW);
    const look = await dir.lookup('p', 'euw1');
    expect(look.team?.id).toBe('nxt');
    expect(look.position).toBe('JUNGLE');
    expect(calls.sort()).toEqual(['player:p', 'team:nxt', 'team:old', 'tournaments']);
    // Tournaments are cached 10 minutes.
    await dir.tournaments('euw1');
    expect(calls.filter((c) => c === 'tournaments')).toHaveLength(1);
  });

  it('Riot 404 = no team (cached); "Route inconnue" or server errors are not cached', async () => {
    let fail = true;
    const f: ClashFetcher = {
      player: vi.fn(async () => {
        if (fail) throw new ApiError('Route inconnue.', 404);
        throw new ApiError('Introuvable chez Riot.', 404);
      }),
      team: vi.fn(async () => null),
      tournaments: vi.fn(async () => []),
    };
    const dir = new ClashDirectory(f, () => NOW);
    await expect(dir.lookup('p', 'euw1')).rejects.toMatchObject({ status: 404 });
    fail = false;
    expect(await dir.lookup('p', 'euw1')).toEqual({ team: null, position: null });
    await dir.lookup('p', 'euw1');
    expect(f.player).toHaveBeenCalledTimes(2);
  });

  it('real fetcher: the four proxy routes through the limiter', async () => {
    installWindow('');
    const routes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://site.test');
      routes.push(`${url.searchParams.get('r')}?${[...url.searchParams.entries()].filter(([k]) => k !== 'r').map(([k, v]) => `${k}=${v}`).join('&')}`);
      return json(url.searchParams.get('r') === 'riot/clash-team' ? OMBRES : url.searchParams.get('r') === 'riot/clash-tournaments' ? TOURNAMENTS : [{ teamId: 'omb', position: 'MIDDLE' }]);
    }));
    const limiter = new RateLimiter([]);
    const acquire = vi.spyOn(limiter, 'acquire');
    const t: RiotTransport = { limiter, sleep: vi.fn(async () => undefined), maxRetries: 3 };
    const dir = new ClashDirectory(riotClashFetcher(t), () => NOW);
    await dir.lookup('e-mid', 'euw1');
    await dir.tournaments('euw1');
    expect(routes).toEqual(['riot/clash-player?platform=euw1&puuid=e-mid', 'riot/clash-team?platform=euw1&teamId=omb', 'riot/clash-tournaments?platform=euw1']);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(await dir.team('bad/id', 'euw1')).toBeNull(); // invalid id: no call
    expect(routes).toHaveLength(3);
  });
});

describe('roster expansion', () => {
  const team = mapClashTeam(OMBRES) as ClashTeam;

  it('adds unknown members, annotates known ones, skips members without puuid', () => {
    const plan = planRoster(team, ['e-mid', 'e-jgl'], 8);
    expect(plan.add).toEqual([{ puuid: 'e-top', position: 'TOP' }, { puuid: 'e-sup', position: 'UTILITY' }]);
    expect(plan.annotate.map((m) => m.puuid)).toEqual(['e-mid', 'e-jgl']);
    expect(plan.skipped).toBe(1);
    expect(rosterNote(teamRef(team), plan)).toBe('Équipe Clash « Équipe omb » [OMB] : 2 membres ajoutés au repérage, 1 sans identifiant Riot (ignoré).');
  });

  it('respects the room left in the shared document', () => {
    const plan = planRoster(team, ['e-mid'], 1);
    expect(plan.add).toHaveLength(1);
    expect(plan.over).toBe(2);
    expect(planRoster(team, [], 0).add).toEqual([]);
    expect(rosterNote(teamRef(team), { add: [], skipped: 0, over: 0 })).toBe('');
  });

  it('profiles keep Clash data through the document (normalize, upsert, annotate, reset)', () => {
    const base: EnemyPlayerProfile = {
      puuid: 'e-top', source: 'clash', masteries: [], recent: { games: 0, roles: {}, champions: [] },
      clash_team: teamRef(team), clash_position: 'TOP', fetched_at: '2026-11-13T10:00:00Z',
    };
    expect(normalizeProfile(base)).toMatchObject({ clash_team: { id: 'omb', name: 'Équipe omb', abbreviation: 'OMB' }, clash_position: 'TOP' });
    expect(normalizeProfile({ ...base, clash_team: null })).toMatchObject({ clash_team: null, clash_position: null });
    const plain = normalizeProfile({ ...base, clash_team: undefined })!;
    expect('clash_team' in plain).toBe(false);
    expect(normalizeProfile({ ...base, clash_team: { id: '../x', name: 'n' } })!.clash_team).toBeUndefined();
    // A rebuilt profile without Clash data keeps the looked-up team.
    const list = upsertProfile([base], { ...plain, source: 'client', fetched_at: '2026-11-13T11:00:00Z' });
    expect(list[0]).toMatchObject({ source: 'clash', clash_position: 'TOP', clash_team: { id: 'omb' } });
    // Annotations: changed list only when something changes; null = looked up, no team.
    const scout = { ...plain, puuid: 'e-mid', source: 'scouting' as const };
    const annotated = annotateClash([scout], [{ puuid: 'e-mid', team: teamRef(team), position: 'MIDDLE' }]);
    expect(annotated[0]).toMatchObject({ clash_position: 'MIDDLE', clash_team: { name: 'Équipe omb' } });
    expect(annotateClash(annotated, [{ puuid: 'e-mid', team: teamRef(team), position: 'MIDDLE' }])).toBe(annotated);
    expect(annotateClash([scout], [{ puuid: 'e-mid', team: null, position: 'TOP' }])[0]).toMatchObject({ clash_team: null, clash_position: null });
    const d = { ...emptyDraft('team-x', []), enemy_profiles: [scout, base, { ...plain, puuid: 'g', source: 'game' as const }] };
    expect(keptOnReset(d).map((p) => p.puuid)).toEqual(['e-mid', 'e-top']);
  });
});

describe('our Clash team: ally role prefill', () => {
  const slot = (player_id: string | null, role: DraftAllySlot['role'] = null): DraftAllySlot => ({ player_id, champion_id: null, role, locked: false });

  it('fills only empty roles of friends, from mapped positions, without duplicates', () => {
    const draft = { ally: [slot('p1'), slot('p2', 'TOP'), slot('p3'), slot(null), slot('p4')] };
    const out = prefillAllyRoles(draft, { p1: 'MIDDLE', p2: 'JUNGLE', p3: 'FILL', p4: 'MIDDLE' });
    // p2 keeps the user's TOP, p3 is FILL, p4 would duplicate MID.
    expect(out).toEqual([{ index: 0, player_id: 'p1', role: 'MID' }]);
  });

  it('never overwrites a role, never re-fills a slot the user cleared, never takes a role already used', () => {
    const draft = { ally: [slot('p1'), slot('p2'), slot(null, 'JUNGLE')] };
    expect(prefillAllyRoles(draft, { p1: 'MIDDLE', p2: 'JUNGLE' }, ['p1'])).toEqual([]);
    expect(prefillAllyRoles({ ally: [slot('p1', 'SUPPORT')] }, { p1: 'MIDDLE' })).toEqual([]);
    expect(prefillAllyRoles({ ally: [slot('p1')] }, { p1: 'UNSELECTED' })).toEqual([]);
    expect(prefillAllyRoles({ ally: [slot('p1'), slot('p2')] }, { p1: 'UTILITY', p2: 'BOTTOM' })).toEqual([
      { index: 0, player_id: 'p1', role: 'SUPPORT' },
      { index: 1, player_id: 'p2', role: 'BOTTOM' },
    ]);
  });
});
