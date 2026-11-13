// Enemy information in the shared draft: their_team puuid mapping, profile storage and size caps.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeEnemyProfiles,
  capProfiles,
  emptyDraft,
  mapCompanionPayload,
  MAX_ENEMY_PROFILES,
  mergeCompanion,
  normalizeDraft,
  normalizeProfile,
  removeProfile,
  toDraftInput,
  upsertProfile,
  type LiveDraft,
} from './draft';
import { DraftSession } from './draftSession';
import { mergeDetectedGame } from './spectator';
import type { DraftState, EnemyPlayerProfile, EnemyProfileSource } from './types';
import { fakeCatalog } from './__fixtures__/fakes';

const catalog = fakeCatalog();
const NOW = Date.parse('2026-11-10T20:00:30Z');
const PUUID_A = 'kX9v2bQx3Lr7nT0pWq8sYz1aB4cD5eF6gH7iJ8kL9mN0oP1qR2sT3uV4wX5yZ6aB7cD8eF9gH0iJ1k';

function payload(theirTeam: LiveDraft['their_team']): LiveDraft {
  return {
    version: 1, puuid: 'puuid-1', phase: 'ban_pick', queue_id: 700, local_cell: 0,
    my_team: [{ cell: 0, puuid: 'puuid-1', champion_key: 103, position: 'middle' }],
    their_team: theirTeam,
    bans: { mine: [], theirs: [] },
    actions: [
      { type: 'pick', champion_key: 122, completed: true, ally: false, cell: 5, in_progress: false },
      { type: 'pick', champion_key: 99, completed: false, ally: false, cell: 6, in_progress: true },
    ],
    player_id: 'p1', received_at: '2026-11-10T20:00:01Z', sent_at: '2026-11-10T20:00:00Z',
  };
}

function profile(puuid: string, source: EnemyProfileSource = 'scouting', over: Partial<EnemyPlayerProfile> = {}): EnemyPlayerProfile {
  return {
    puuid, source, riot_id: null, summoner_level: 100, rank: null, masteries: [],
    recent: { games: 0, roles: {}, champions: [] }, style: null, fetched_at: '2026-11-10T19:00:00Z', ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('their_team puuid (client-revealed enemies)', () => {
  it('maps a non-empty puuid to the enemy slot, nothing when "" (ranked) or invalid', () => {
    const m = mapCompanionPayload(payload([
      { cell: 5, puuid: PUUID_A, champion_key: 122 },
      { cell: 6, puuid: '', champion_key: 99 },
      { cell: 7, champion_key: 0 },
      { cell: 8, puuid: 'pas un puuid !', champion_key: 0 },
    ]), catalog, []);
    expect(m.enemy).toEqual([
      { champion_id: 'Darius', role: null, locked: true, puuid: PUUID_A },
      { champion_id: 'Lux', role: null, locked: false },
      { champion_id: null, role: null, locked: false },
      { champion_id: null, role: null, locked: false },
    ]);
    expect('puuid' in m.enemy[1]).toBe(false);
  });

  it('mergeCompanion stores the puuid; the next ranked payload clears it', () => {
    const base = emptyDraft('team-t1', ['p1'], 't1', NOW);
    const revealed = mergeCompanion(base, mapCompanionPayload(payload([{ cell: 5, puuid: PUUID_A, champion_key: 122 }]), catalog, []));
    expect(revealed.enemy[0].puuid).toBe(PUUID_A);
    const anon = mergeCompanion(revealed, mapCompanionPayload(payload([{ cell: 5, puuid: '', champion_key: 122 }]), catalog, []));
    expect(anon.enemy[0].puuid).toBeUndefined();
  });

  it('normalizeDraft keeps valid slot puuids only', () => {
    const fallback = emptyDraft('x', [], null, NOW);
    const n = normalizeDraft({ enemy: [{ champion_id: 'Lux', puuid: PUUID_A, locked: true }, { puuid: 42 }, { puuid: '<script>' }] }, fallback);
    expect(n.enemy[0]).toEqual({ champion_id: 'Lux', role: null, locked: true, puuid: PUUID_A });
    expect(n.enemy[1].puuid).toBeUndefined();
    expect(n.enemy[2].puuid).toBeUndefined();
  });

  it('started game: the enemy slots carry the spectator puuids', () => {
    const d = mergeDetectedGame(emptyDraft('x', [], null, NOW), {
      game_id: 1, queue_id: 420, side: 'blue', ally: [], ally_bans: [], enemy_bans: [],
      enemy: [{ champion_id: 'Lux', role: null, locked: true, puuid: 'e-1' }],
      enemy_accounts: [{ puuid: 'e-1', riot_id: 'Lux#EUW', champion_id: 'Lux' }],
    });
    expect(d.enemy[0].puuid).toBe('e-1');
  });
});

describe('profiles in the shared document', () => {
  it('caps masteries (20), recent champions (15) and drops history lists', () => {
    const big = profile(PUUID_A, 'scouting', {
      riot_id: 'x'.repeat(200),
      masteries: Array.from({ length: 40 }, (_, i) => ({ champion_id: `C${i}`, level: 5, points: 1000 * (40 - i) })),
      recent: {
        games: 20,
        roles: { MID: 20, NOPE: 3 } as never,
        champions: Array.from({ length: 30 }, (_, i) => ({ champion_id: `C${i}`, games: 1, wins: 1, kills: 1.234, deaths: 2, assists: 3, role: 'MID' as const })),
        lane_matchups: Array.from({ length: 50 }, () => ({ champion_id: 'A', opponent_id: 'B', role: 'MID' as const, games: 1, wins: 1 })),
        allies: [{ puuid: 'z', games: 1, wins: 1, pairs: [] }],
      },
    });
    const n = normalizeProfile(big)!;
    expect(n.masteries).toHaveLength(20);
    expect(n.recent.champions).toHaveLength(15);
    expect(n.recent.champions[0].kills).toBe(1.23);
    expect(n.recent.roles).toEqual({ MID: 20 });
    expect(n.recent.lane_matchups).toBeUndefined();
    expect(n.recent.allies).toBeUndefined();
    expect(n.riot_id).toHaveLength(64);
    expect(normalizeProfile({ puuid: '' })).toBeNull();
    expect(normalizeProfile('junk')).toBeNull();
  });

  it('keeps at most 10 profiles (scouting first, then the most recent) and a small document', () => {
    const full = (i: number, source: EnemyProfileSource) => profile(`p-${source}-${i}`, source, {
      riot_id: `Joueur numéro ${i}#EUW`,
      fetched_at: `2026-11-10T19:0${i}:00Z`,
      rank: { queue: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', lp: 50, wins: 100, losses: 90 },
      masteries: Array.from({ length: 20 }, (_, k) => ({ champion_id: `Champion${k}`, level: 7, points: 123_456, last_play_time: 1_759_600_000_000 })),
      recent: { games: 10, roles: { MID: 6, TOP: 4 }, champions: Array.from({ length: 15 }, (_, k) => ({ champion_id: `Champion${k}`, games: 3, wins: 2, kills: 5.55, deaths: 4.44, assists: 6.66, role: 'MID' as const, last_played: 1_759_600_000_000 })) },
      style: { games: 10, wins: 6, kills: 7.1, deaths: 4.2, assists: 6.3, cs_per_min: 7.45, vision_per_min: 0.91, damage_per_min: 812.33, kill_participation: 0.61, solo_kills: 1.2, first_blood_rate: 0.3, early_lead: 0.5, turret_takedowns: 1.4, avg_game_minutes: 29.5 },
    });
    const list = [
      ...[0, 1, 2, 3, 4].map((i) => full(i, 'scouting')),
      ...[0, 1, 2, 3, 4].map((i) => full(i, 'client')),
      ...[0, 1, 2, 3, 4].map((i) => full(i, 'game')),
    ];
    const capped = capProfiles(list);
    expect(capped).toHaveLength(MAX_ENEMY_PROFILES);
    expect(capped.filter((p) => p.source === 'scouting')).toHaveLength(5);
    expect(capped.filter((p) => p.source === 'client')).toHaveLength(5); // then client before game
    let docs = emptyDraft('team-t1', ['p1', 'p2', 'p3', 'p4', 'p5'], 't1', NOW);
    for (const p of list) docs = { ...docs, enemy_profiles: upsertProfile(docs.enemy_profiles, p) };
    expect(docs.enemy_profiles).toHaveLength(MAX_ENEMY_PROFILES);
    const size = new TextEncoder().encode(JSON.stringify(docs)).length;
    expect(size).toBeLessThan(48 * 1024); // PHP accepts 256 KB; the document is polled every 3 s
    // Round trip through the store keeps everything.
    expect(normalizeDraft(JSON.parse(JSON.stringify(docs)), docs).enemy_profiles).toEqual(docs.enemy_profiles);
  });

  it('upsert keeps the scouting source and a known Riot ID; remove by puuid', () => {
    let list = upsertProfile([], profile('a', 'scouting', { riot_id: 'Ombre#EUW' }));
    list = upsertProfile(list, profile('a', 'game', { riot_id: 'Autre#EUW', summoner_level: 401, fetched_at: '2026-11-10T21:00:00Z' }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'scouting', riot_id: 'Ombre#EUW', summoner_level: 401 });
    list = upsertProfile(list, profile('b', 'game'));
    list = upsertProfile(list, profile('b', 'client'));
    expect(list[1].source).toBe('client');
    expect(removeProfile(list, 'a').map((p) => p.puuid)).toEqual(['b']);
  });

  it('active profiles: scouting always, client while in a slot, game while in game; champion from the slot/account', () => {
    const d: DraftState = {
      ...emptyDraft('x', [], null, NOW),
      enemy_profiles: [profile('s1', 'scouting', { champion_id: 'Stale' }), profile('c1', 'client'), profile('c-old', 'client'), profile('g1', 'game')],
    };
    d.enemy[0] = { champion_id: 'Darius', role: 'TOP', locked: true, puuid: 'c1' };
    expect(activeEnemyProfiles(d).map((p) => [p.puuid, p.champion_id ?? null, p.role ?? null])).toEqual([
      ['s1', null, null], // a scouted player's champion is never guessed here (the engine infers it)
      ['c1', 'Darius', 'TOP'],
    ]);
    const g: DraftState = { ...d, phase: 'in_game', enemy_accounts: [{ puuid: 'g1', riot_id: 'Gx#EUW', champion_id: 'Jinx' }, { puuid: 's1', champion_id: 'Lux' }] };
    expect(activeEnemyProfiles(g).map((p) => [p.puuid, p.champion_id, p.riot_id ?? null])).toEqual([
      ['s1', 'Lux', null],
      ['c1', 'Darius', null],
      ['g1', 'Jinx', 'Gx#EUW'],
    ]);
  });

  it('toDraftInput passes enemy_profiles, side and phase to the engine', () => {
    const d: DraftState = { ...emptyDraft('x', [], null, NOW), side: 'red', phase: 'pick', enemy_profiles: [profile('s1')] };
    const input = toDraftInput(d);
    expect(input.side).toBe('red');
    expect(input.phase).toBe('pick');
    expect(input.enemy_profiles?.map((p) => p.puuid)).toEqual(['s1']);
    expect(toDraftInput(emptyDraft('x', [], null, NOW)).enemy_profiles).toBeUndefined();
  });

  it('a profile stored by the session keeps the draft source and phase ("data" edit)', () => {
    vi.useFakeTimers();
    const saves: DraftState[] = [];
    const base: DraftState = { ...emptyDraft('team-t1', ['p1'], 't1', NOW), source: 'companion', phase: 'pick' };
    const s = new DraftSession(base, { load: async () => null, save: async (doc) => (saves.push(doc), doc) });
    s.start();
    s.edit(['enemy_profiles'], (doc) => ({ ...doc, enemy_profiles: upsertProfile(doc.enemy_profiles, profile('s1')) }), { data: true });
    const draft = s.getSnapshot().draft;
    expect([draft.source, draft.phase, draft.enemy_profiles?.length]).toEqual(['companion', 'pick', 1]);
    s.stop();
  });
});
