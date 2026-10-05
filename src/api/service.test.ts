import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES, fakeServer, installWindow } from './__fixtures__/fakes';
import { failure } from './__fixtures__/fakes';

const engine = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof fakeEngine> }));
vi.mock('../engine', async () => {
  const { fakeEngine } = await import('./__fixtures__/fakes');
  const e = fakeEngine();
  engine.current = e;
  return e;
});

import { ApiError } from './backend';
import { resetDDragonForTests } from './ddragon';
import { RateLimiter, setTransportForTests } from './riot';
import { assignEnemyRoles, localApi as api, resetServiceForTests } from './service';
import { fakeCatalog, type fakeEngine } from './__fixtures__/fakes';

let server: ReturnType<typeof fakeServer>;

function lastCall(fn: { mock: { calls: unknown[][] } }): unknown[] {
  return fn.mock.calls[fn.mock.calls.length - 1];
}

function setup(opts: Parameters<typeof fakeServer>[0] = {}) {
  installWindow('');
  server = fakeServer(opts);
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    if (err instanceof ApiError) return err.status;
    throw err;
  }
}

const add = (name = 'Alice', tag = 'EUW') => api.createPlayer({ game_name: name, tag_line: tag });

beforeEach(() => {
  resetDDragonForTests();
  resetServiceForTests();
  setTransportForTests({ limiter: new RateLimiter([]), sleep: async () => undefined, maxRetries: 3 });
  vi.clearAllMocks();
  setup();
});
afterEach(() => {
  setTransportForTests(null);
  vi.unstubAllGlobals();
});

describe('meta and static data', () => {
  it('merges the PHP meta with the Data Dragon version', async () => {
    const meta = await api.meta();
    expect(meta).toMatchObject({ riot_configured: false, platform: 'euw1', region: 'europe', ddragon_version: 'offline' });
    expect(engine.current.buildCatalog).toHaveBeenCalledWith([], 'offline');
  });

  it('sorts champions by name', async () => {
    const names = (await api.champions()).map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'fr')));
    expect(names).toContain('Wukong');
  });
});

describe('players', () => {
  it('creates a manual player without Riot key', async () => {
    const p = await add('Le Fou Élégant', '#EUW');
    expect(p.puuid).toBeNull();
    expect([p.game_name, p.tag_line, p.platform]).toEqual(['Le Fou Élégant', 'EUW', 'euw1']);
    expect(p.recent.roles).toEqual({ TOP: 0, JUNGLE: 0, MID: 0, BOTTOM: 0, SUPPORT: 0 });
    expect(p.pool).toEqual([]);
    expect(p.rank).toBeNull();
    expect(p.profile_icon_url).toBe('');
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    const stored = server.db.players.get(p.id)!;
    expect(stored).not.toHaveProperty('pool');
    expect(stored.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect((await api.getPlayer(p.id)).id).toBe(p.id);
    expect(await api.listPlayers()).toHaveLength(1);
  });

  it('rejects duplicates case-insensitively (409), bad platform / empty name (422)', async () => {
    await add('Alice', 'EUW');
    const err = await failure(add('aLICE', 'euw'));
    expect(err.status).toBe(409);
    expect(err.message).toContain('existe déjà');
    expect(await status(api.createPlayer({ game_name: 'A', tag_line: 'B', platform: 'mars1' }))).toBe(422);
    expect(await status(api.createPlayer({ game_name: ' ', tag_line: 'B' }))).toBe(422);
  });

  it('unknown ids are 404; sync without key is 400', async () => {
    expect(await status(api.getPlayer('ghost'))).toBe(404);
    expect(await status(api.deletePlayer('ghost'))).toBe(404);
    expect(await status(api.syncPlayer('ghost'))).toBe(404);
    const p = await add();
    const err = await failure(api.syncPlayer(p.id));
    expect(err.status).toBe(400);
    expect(err.message).toContain('clé API Riot');
  });

  it('updates preferences and pool with validation; pool computed by the engine', async () => {
    const p = await add();
    const prefs = { roles: ['MID', 'SUPPORT', 'MID'], wanted_archetypes: ['mage'], wanted_champions: ['Ahri'], avoided_champions: ['Garen'] };
    const updated = await api.updatePreferences(p.id, prefs as never);
    expect(updated.preferences.roles).toEqual(['MID', 'SUPPORT']);
    expect(await status(api.updatePreferences(p.id, { ...prefs, wanted_champions: ['Zzz'] } as never))).toBe(422);
    expect(await status(api.updatePreferences(p.id, { ...prefs, wanted_archetypes: ['ninja'] } as never))).toBe(422);
    expect(await status(api.updatePreferences(p.id, { ...prefs, roles: ['ADC'] } as never))).toBe(422);

    const withPool = await api.updatePool(p.id, [
      { champion_id: 'Ahri', comfort: 0.9 },
      { champion_id: 'Lux', comfort: 0.4 },
      { champion_id: 'Ahri', comfort: 0.7 },
    ]);
    expect(withPool.manual_pool).toEqual([
      { champion_id: 'Ahri', comfort: 0.7 },
      { champion_id: 'Lux', comfort: 0.4 },
    ]);
    expect(withPool.pool.map((e) => e.champion_id)).toEqual(['Ahri', 'Lux']);
    const call = lastCall(engine.current.computePool);
    expect((call[3] as { roles: string[] }).roles).toEqual(['MID', 'SUPPORT']);

    const bad = await failure(api.updatePool(p.id, [{ champion_id: 'Nope', comfort: 0.5 }]));
    expect([bad.status, bad.message.includes('Nope')]).toEqual([422, true]);
    expect(await status(api.updatePool(p.id, [{ champion_id: 'Ahri', comfort: 3 }]))).toBe(422);
    expect(await status(api.updatePool('missing', []))).toBe(404);
  });

  it('creates and syncs a player with a Riot key', async () => {
    setup({ riotConfigured: true });
    const p = await add('le fou élégant', 'euw');
    expect(p.game_name).toBe('Le Fou Élégant');
    expect(p.puuid).toBe(FIXTURES.account.puuid);
    expect(p.summoner_level).toBe(287);
    expect(p.rank?.tier).toBe('GOLD');
    expect(p.last_synced_at).toMatch(/Z$/);
    expect(p.recent.games).toBe(5);
    expect(p.recent.roles.MID).toBe(2);
    expect(p.masteries[0].champion_id).toBe('Ahri');
    expect(server.db.players.get(p.id)!.profile_icon_id).toBe(5367);
    expect(await status(add('Le Fou Élégant', 'EUW'))).toBe(409);

    await api.updatePool(p.id, [{ champion_id: 'Lux', comfort: 1 }]);
    const synced = await api.syncPlayer(p.id);
    expect(synced.recent.games).toBe(5);
    expect(synced.manual_pool).toEqual([{ champion_id: 'Lux', comfort: 1 }]); // kept

    const ghost = await failure(add('Ghost', '0000'));
    expect(ghost.status).toBe(404);
    expect(ghost.message).toContain('introuvable');
  });
});

describe('teams and cascades', () => {
  it('CRUD, 5 players limit, unknown players 404', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await add(`P${i}`)).id);
    const team = await api.createTeam({ name: ' Les potes ', player_ids: ids.slice(0, 5) });
    expect(team.name).toBe('Les potes');
    expect(team.player_ids).toEqual(ids.slice(0, 5));
    expect(team.created_at).toBeTruthy();

    const tooMany = await failure(api.createTeam({ name: 'Trop', player_ids: ids }));
    expect([tooMany.status, tooMany.message.includes('5 joueurs')]).toEqual([422, true]);
    expect(await status(api.createTeam({ name: 'X', player_ids: ['ghost'] }))).toBe(404);
    expect(await status(api.createTeam({ name: '  ', player_ids: [] }))).toBe(422);

    const renamed = await api.updateTeam(team.id, { name: 'Renommée', player_ids: ids.slice(0, 2) });
    expect([renamed.name, renamed.player_ids, renamed.created_at]).toEqual(['Renommée', ids.slice(0, 2), team.created_at]);
    expect((await api.getTeam(team.id)).name).toBe('Renommée');
    expect(await status(api.updateTeam('ghost', { name: 'x', player_ids: [] }))).toBe(404);
    await api.deleteTeam(team.id);
    expect(await status(api.getTeam(team.id))).toBe(404);
    expect(await status(api.deleteTeam(team.id))).toBe(404);
  });

  it('deleting a player removes it from teams', async () => {
    const a = (await add('A')).id;
    const b = (await add('B')).id;
    const team = await api.createTeam({ name: 'T', player_ids: [a, b] });
    await api.deletePlayer(a);
    expect(await status(api.getPlayer(a))).toBe(404);
    expect((await api.getTeam(team.id)).player_ids).toEqual([b]);
  });

  it('deleting a team nulls team_id of saved compositions', async () => {
    const a = (await add('A')).id;
    const team = await api.createTeam({ name: 'T', player_ids: [a] });
    const body = { name: 'Ma compo', team_id: team.id, theme: 'engage', picks: [{ role: 'MID' as const, champion_id: 'Ahri', player_id: a }], notes: 'Fun' };
    const saved = await api.saveComposition(body);
    expect({ name: saved.name, team_id: saved.team_id, theme: saved.theme, picks: saved.picks, notes: saved.notes }).toEqual(body);
    await api.deleteTeam(team.id);
    expect((await api.listSaved())[0].team_id).toBeNull();
  });
});

describe('saved compositions', () => {
  it('validates and lists newest first', async () => {
    const pick = { role: 'MID' as const, champion_id: 'Ahri' };
    const s1 = await api.saveComposition({ name: 'Un', picks: [pick] });
    expect(s1.picks).toEqual([{ ...pick, player_id: null }]);
    expect([s1.team_id, s1.theme, s1.notes]).toEqual([null, null, null]);
    const s2 = await api.saveComposition({ name: 'Deux', picks: [pick] });
    expect((await api.listSaved()).map((s) => s.id)).toEqual([s2.id, s1.id]);
    expect(await status(api.saveComposition({ name: 'X', picks: [{ role: 'MID', champion_id: 'Unknown' }] }))).toBe(422);
    expect(await status(api.saveComposition({ name: 'X', picks: [] }))).toBe(422);
    expect(await status(api.saveComposition({ name: 'X', picks: [pick], team_id: 'ghost' }))).toBe(404);
    await api.deleteSaved(s1.id);
    expect(await status(api.deleteSaved(s1.id))).toBe(404);
  });
});

describe('compositions', () => {
  it('generate builds PlayerInput and validates options', async () => {
    const a = await add('A');
    const b = await add('B');
    await api.updatePool(a.id, [{ champion_id: 'Ahri', comfort: 1 }]);
    await api.updatePreferences(a.id, { roles: ['MID'], wanted_archetypes: [], wanted_champions: [], avoided_champions: [] });
    await api.generate({ player_ids: [a.id, b.id], options: { theme: 'engage', role_assignments: { [a.id]: 'MID' }, bans: ['Garen'], count: 3 } });
    const [players, options] = lastCall(engine.current.generateCompositions) as [
      { player_id: string; name: string; preferences: { roles: string[] }; role_games: object; pool: { champion_id: string }[] }[],
      Record<string, unknown>,
    ];
    expect(players.map((p) => p.player_id)).toEqual([a.id, b.id]);
    expect(players[0].name).toBe('A');
    expect(players[0].preferences.roles).toEqual(['MID']);
    expect(players[0].pool.map((e) => e.champion_id)).toEqual(['Ahri']);
    expect(players[0].role_games).toEqual({ TOP: 0, JUNGLE: 0, MID: 0, BOTTOM: 0, SUPPORT: 0 });
    expect(options).toMatchObject({ theme: 'engage', count: 3, bans: ['Garen'], exploration: 0.2, locked_picks: {}, enemy_champions: [] });

    expect(await status(api.generate({ player_ids: [], options: {} }))).toBe(422);
    expect(await status(api.generate({ player_ids: [a.id, 'ghost'], options: {} }))).toBe(404);
    expect(await status(api.generate({ player_ids: [a.id, a.id], options: {} }))).toBe(422);
    const ban = await failure(api.generate({ player_ids: [a.id], options: { bans: ['Zzz'] } }));
    expect([ban.status, ban.message]).toEqual([422, 'Champion inconnu : Zzz.']);
    expect(await status(api.generate({ player_ids: [a.id], options: { theme: 'nope' } }))).toBe(422);
    expect(await status(api.generate({ player_ids: [a.id], options: { locked_picks: { other: 'Ahri' } } }))).toBe(422);
    expect(await status(api.generate({ player_ids: [a.id], options: { count: 50 } }))).toBe(422);
  });

  it('game plan validates picks', async () => {
    const plan = await api.gamePlan([{ role: 'MID', champion_id: 'Ahri' }, { role: 'SUPPORT', champion_id: 'Thresh' }]);
    expect(plan.identity).toBe('Compo test');
    expect(await status(api.gamePlan([{ role: 'MID', champion_id: 'Nope' }]))).toBe(422);
    expect(await status(api.gamePlan([]))).toBe(422);
    expect(await status(api.gamePlan([{ role: 'MID', champion_id: 'Ahri' }, { role: 'MID', champion_id: 'Lux' }]))).toBe(422);
  });

  it('matchup fills enemy roles like the Python route', async () => {
    await api.matchup({
      ally: [{ role: 'MID', champion_id: 'Ahri' }],
      enemy: [
        { champion_id: 'Lux' }, // SUPPORT taken by Leona -> MID
        { champion_id: 'Leona', role: 'SUPPORT' },
        { champion_id: 'Thresh' }, // SUPPORT taken -> first free role: TOP
        { champion_id: 'Jinx' }, // BOTTOM
      ],
    });
    const [ally, enemy] = lastCall(engine.current.buildMatchupPlan) as [{ champion_id: string; role: string }[], { champion_id: string; role: string }[]];
    expect(ally.map((p) => [p.champion_id, p.role])).toEqual([['Ahri', 'MID']]);
    expect(enemy.map((p) => [p.champion_id, p.role])).toEqual([
      ['Lux', 'MID'],
      ['Leona', 'SUPPORT'],
      ['Thresh', 'TOP'],
      ['Jinx', 'BOTTOM'],
    ]);
    const zed = await failure(api.matchup({ ally: [], enemy: [{ champion_id: 'Zed' }] }));
    expect([zed.status, zed.message.includes('Zed')]).toEqual([422, true]);
    expect(await status(api.matchup({ ally: [], enemy: [] }))).toBe(422);
    expect(
      await status(api.matchup({ ally: [], enemy: [{ champion_id: 'Lux', role: 'MID' }, { champion_id: 'Ahri', role: 'MID' }] })),
    ).toBe(422);
  });

  it('assignEnemyRoles falls back to the first free role', () => {
    const roles = assignEnemyRoles(
      [{ champion_id: 'Garen' }, { champion_id: 'Darius' }, { champion_id: 'Unknown' }],
      fakeCatalog(),
    ).map((p) => p.role);
    expect(roles).toEqual(['TOP', 'JUNGLE', 'MID']);
  });
});

describe('password', () => {
  it('sends the stored password to the store', async () => {
    setup({ password: 'pw' });
    expect(await status(api.listTeams())).toBe(401);
    window.localStorage.setItem('lolhelper:password', JSON.stringify('pw'));
    expect(await api.listTeams()).toEqual([]);
  });
});
