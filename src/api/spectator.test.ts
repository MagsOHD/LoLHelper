import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './backend';
import { emptyDraft } from './draft';
import { RateLimiter, setTransportForTests } from './riot';
import {
  detectActiveGame,
  ENEMY_MASTERY_COUNT,
  MAX_ACTIVE_GAME_CHECKS,
  mergeDetectedGame,
  resetSpectatorForTests,
  RIOT_CALL_BUDGET,
  type RawActiveGame,
} from './spectator';
import { fakeCatalog, installWindow, json } from './__fixtures__/fakes';

const catalog = fakeCatalog();

const GAME: RawActiveGame = {
  gameId: 7123456789,
  gameQueueConfigId: 420,
  platformId: 'EUW1',
  bannedChampions: [
    { championId: 9, teamId: 100, pickTurn: 1 },
    { championId: 222, teamId: 200, pickTurn: 2 },
  ],
  participants: [
    { puuid: 'puuid-1', teamId: 100, championId: 103, riotId: 'Lucas#EUW' },
    { puuid: 'puuid-2', teamId: 100, championId: 86, riotId: 'Tank#1234' },
    { puuid: 'ally-x', teamId: 100, championId: 412, riotId: 'Inconnu#EUW' },
    { puuid: 'ally-y', teamId: 100, championId: 64, riotId: 'Jungle#EUW' },
    { puuid: 'ally-z', teamId: 100, championId: 89, riotId: 'Supp#EUW' },
    ...[122, 99, 62, 9, 222].map((championId, i) => ({ puuid: `enemy-${i}`, teamId: 200, championId, riotId: `Adversaire${i}#EUW` })),
  ].map((p) => (p.championId === 9 && p.teamId === 200 ? { ...p, championId: 1 } : p)),
};

interface Riot {
  calls: string[];
}

/** Fake PHP riot proxy: active-game 200 for `inGame` puuids, 404 otherwise. */
function riotServer(inGame: Set<string>, opts: { leagueStatus?: number } = {}): Riot {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(String(input), 'http://site.test');
    const route = url.searchParams.get('r') ?? '';
    const puuid = url.searchParams.get('puuid') ?? '';
    calls.push(`${route}:${puuid}${url.searchParams.get('count') ? `:${url.searchParams.get('count')}` : ''}`);
    switch (route) {
      case 'riot/active-game':
        return inGame.has(puuid) ? json(GAME) : json({ detail: 'Aucune partie en cours pour ce joueur.' }, 404);
      case 'riot/league':
        if (opts.leagueStatus) return json({ detail: 'Erreur.' }, opts.leagueStatus);
        return json([{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 40, wins: 10, losses: 9 }]);
      case 'riot/masteries':
        return json([
          { championId: 122, championLevel: 7, championPoints: 612000 },
          { championId: 99, championLevel: 5, championPoints: 30000 },
        ]);
    }
    return json({ detail: 'Route inconnue.' }, 404);
  }));
  return { calls };
}

const FRIENDS = [
  { player_id: 'p1', puuid: 'puuid-1', platform: 'euw1' },
  { player_id: 'p2', puuid: 'puuid-2', platform: 'euw1' },
  { player_id: 'p3', puuid: 'puuid-3', platform: 'euw1' },
];

beforeEach(() => {
  installWindow('');
  resetSpectatorForTests();
  setTransportForTests({ limiter: new RateLimiter([]), sleep: async () => undefined, maxRetries: 0 });
});
afterEach(() => {
  setTransportForTests(null);
  vi.unstubAllGlobals();
});

describe('spectator detection', () => {
  it('finds the game, maps both teams, enriches enemies within the budget', async () => {
    const riot = riotServer(new Set(['puuid-1', 'puuid-2']));
    const res = await detectActiveGame(FRIENDS, catalog, { knownPlayers: [{ id: 'p9', puuid: 'ally-x' }] });
    expect(res).not.toBeNull();
    const { game, calls } = res!;
    expect(calls).toBe(11);
    expect(calls).toBeLessThanOrEqual(RIOT_CALL_BUDGET);
    expect(riot.calls.filter((c) => c.startsWith('riot/active-game'))).toEqual(['riot/active-game:puuid-1']);
    expect(riot.calls.filter((c) => c.startsWith('riot/masteries')).every((c) => c.endsWith(`:${ENEMY_MASTERY_COUNT}`))).toBe(true);
    expect(game.game_id).toBe(7123456789);
    expect(game.side).toBe('blue');
    expect(game.ally.map((s) => [s.player_id, s.champion_id])).toEqual([
      ['p1', 'Ahri'], ['p2', 'Garen'], ['p9', 'Thresh'], [null, 'LeeSin'], [null, 'Leona'],
    ]);
    expect(game.enemy.map((s) => s.champion_id)).toEqual(['Darius', 'Lux', 'MonkeyKing', null, 'Jinx']);
    expect(game.ally_bans).toEqual(['Fiddlesticks']);
    expect(game.enemy_bans).toEqual(['Jinx']);
    const darius = game.enemy_accounts[0];
    expect(darius).toMatchObject({ puuid: 'enemy-0', riot_id: 'Adversaire0#EUW', champion_id: 'Darius' });
    expect(darius.rank?.tier).toBe('GOLD');
    expect(darius.champion_mastery).toMatchObject({ champion_id: 'Darius', level: 7, points: 612000 });
    expect(game.enemy_accounts[2].champion_mastery).toBeNull(); // Wukong not in their top masteries
  });

  it('checks at most 2 friends, 404 everywhere = no game (no enrichment calls)', async () => {
    const riot = riotServer(new Set());
    expect(await detectActiveGame(FRIENDS, catalog)).toBeNull();
    expect(riot.calls).toEqual(['riot/active-game:puuid-1', 'riot/active-game:puuid-2']);
    expect(riot.calls).toHaveLength(MAX_ACTIVE_GAME_CHECKS);
  });

  it('skips friends without puuid, worst case stays within the budget', async () => {
    const riot = riotServer(new Set(['puuid-2']));
    const res = await detectActiveGame([{ player_id: 'p0', puuid: null, platform: 'euw1' }, ...FRIENDS], catalog);
    expect(res?.calls).toBe(RIOT_CALL_BUDGET);
    expect(riot.calls.slice(0, 2)).toEqual(['riot/active-game:puuid-1', 'riot/active-game:puuid-2']);
  });

  it('caches the enrichment per game id (and reuses accounts stored in the draft)', async () => {
    const riot = riotServer(new Set(['puuid-1']));
    await detectActiveGame(FRIENDS, catalog);
    const again = await detectActiveGame(FRIENDS, catalog);
    expect(again?.calls).toBe(1);
    expect(riot.calls).toHaveLength(12);
    resetSpectatorForTests();
    const stored = [{ puuid: 'enemy-0', champion_id: 'Darius' }];
    const fromDoc = await detectActiveGame(FRIENDS, catalog, { known: { game_id: 7123456789, accounts: stored } });
    expect(fromDoc?.calls).toBe(1);
    expect(fromDoc?.game.enemy_accounts).toBe(stored);
  });

  it('degrades gracefully when rank lookups fail; other spectator errors are thrown', async () => {
    riotServer(new Set(['puuid-1']), { leagueStatus: 500 });
    const res = await detectActiveGame(FRIENDS, catalog);
    expect(res?.game.enemy_accounts[0].rank).toBeUndefined();
    expect(res?.game.enemy_accounts[0].champion_mastery?.points).toBe(612000);

    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Clé API Riot non configurée.' }, 400)));
    await expect(detectActiveGame(FRIENDS, catalog)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('detected game -> draft', () => {
  it('locks both teams, keeps roles and hand-assigned friends, attaches enemy accounts', async () => {
    riotServer(new Set(['puuid-1']));
    const { game } = (await detectActiveGame(FRIENDS, catalog))!;
    const base = emptyDraft('team-t1', ['p1', 'p2', 'p3'], 't1');
    base.ally[0] = { player_id: 'p3', champion_id: 'LeeSin', role: 'JUNGLE', locked: true };
    base.ally[1] = { player_id: 'p1', champion_id: 'Ahri', role: 'MID', locked: false };
    base.enemy[0] = { champion_id: 'Darius', role: 'TOP', locked: true };
    const d = mergeDetectedGame(base, game);
    expect(d.phase).toBe('in_game');
    expect(d.source).toBe('spectator');
    expect(d.game_id).toBe(7123456789);
    expect(d.ally.every((s) => s.locked)).toBe(true);
    expect(d.ally[0]).toMatchObject({ player_id: 'p1', champion_id: 'Ahri', role: 'MID' });
    expect(d.ally[3]).toMatchObject({ player_id: 'p3', champion_id: 'LeeSin', role: 'JUNGLE' });
    expect(d.enemy[0]).toMatchObject({ champion_id: 'Darius', role: 'TOP' });
    expect(d.enemy_accounts?.[0]).toMatchObject({ champion_id: 'Darius', role: 'TOP' });
  });
});
