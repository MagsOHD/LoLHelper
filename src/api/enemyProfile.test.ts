import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aggregatePlaystyle,
  buildEnemyProfile,
  EnemyProfileService,
  overallProgress,
  profileCallBudget,
  PROFILE_MASTERY_COUNT,
  QUICK_MATCH_COUNT,
  SCOUT_MATCH_COUNT,
  type ProfileRequest,
} from './enemyProfile';
import { RateLimiter, type RiotTransport } from './riot';
import type { EnemyPlayerProfile } from './types';
import { FIXTURES, fakeCatalog, installWindow, json } from './__fixtures__/fakes';
import m8 from './__fixtures__/match_EUW1_7000000008.json';
import m9 from './__fixtures__/match_EUW1_7000000009.json';
import m10 from './__fixtures__/match_EUW1_7000000010.json';
import m11 from './__fixtures__/match_EUW1_7000000011.json';

const ENEMY = 'enemy-puuid-scouted-0001';
const MATCHES: Record<string, unknown> = {
  EUW1_7000000008: m8,
  EUW1_7000000009: m9,
  EUW1_7000000010: m10,
  EUW1_7000000011: m11,
};
const catalog = fakeCatalog();

/** Transport counting limiter acquisitions (every Riot call must go through it). */
function countingTransport() {
  const limiter = new RateLimiter([]);
  const acquire = vi.spyOn(limiter, 'acquire');
  const t: RiotTransport = { limiter, sleep: vi.fn(async () => undefined), maxRetries: 3 };
  return { t, acquire };
}

/** Fake PHP riot proxy for the enemy account (ids list includes a vanished match). */
function riotServer(opts: { ids?: string[]; accountStatus?: number } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(String(input), 'http://site.test');
    const route = url.searchParams.get('r') ?? '';
    const p = url.searchParams;
    calls.push(`${route}${p.get('count') ? `:${p.get('count')}` : ''}${p.get('id') ? `:${p.get('id')}` : ''}`);
    switch (route) {
      case 'riot/account':
        return opts.accountStatus ? json({ detail: 'Introuvable.' }, opts.accountStatus) : json({ puuid: ENEMY, gameName: 'Lee Fou', tagLine: 'EUW' });
      case 'riot/summoner':
        return json({ summonerLevel: 312, profileIconId: 1 });
      case 'riot/league':
        return json(FIXTURES.leagueEntries);
      case 'riot/masteries':
        return json([{ championId: 64, championLevel: 7, championPoints: 250_000 }, { championId: 103, championLevel: 5, championPoints: 40_000 }]);
      case 'riot/match-ids': {
        const ids = opts.ids ?? ['EUW1_7000000008', 'EUW1_7000000009', 'EUW1_7000000010', 'EUW1_7000000011', 'EUW1_0000000404'];
        return json(ids.slice(0, Number(p.get('count') ?? 20)));
      }
      case 'riot/match': {
        const m = MATCHES[p.get('id') ?? ''];
        return m ? json(m) : json({ detail: 'Introuvable chez Riot.' }, 404);
      }
    }
    return json({ detail: 'Route inconnue.' }, 404);
  }));
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('playstyle aggregation (match-v5 participant fields + challenges)', () => {
  it('averages per game over Summoner’s Rift games, per minute over minutes played', () => {
    const s = aggregatePlaystyle([m8, m9, m10, m11], ENEMY)!;
    expect(s).toEqual({
      games: 3, // ARAM (450) excluded
      wins: 2,
      kills: 8,
      deaths: 4,
      assists: 6.67,
      cs_per_min: 7.07, // (200 + 150 + 180) / (30 + 25 + 20) — minions + neutral monsters
      vision_per_min: 0.93,
      damage_per_min: 800,
      kill_participation: 0.72, // 0.8 and 0.6 from challenges, 15/20 computed from team kills
      solo_kills: 2, // challenges only (match 10 has none)
      first_blood_rate: 0.67, // kill (8) + assist (9)
      early_lead: 0.5, // laningPhaseGoldExpAdvantage 1 and 0
      turret_takedowns: 1,
      avg_game_minutes: 25,
    });
  });

  it('early_lead is null without challenges, null result without games, remakes skipped', () => {
    const fx = FIXTURES.account.puuid;
    const s = aggregatePlaystyle(Object.values(FIXTURES.matches), fx)!;
    expect(s.games).toBe(6);
    expect(s.early_lead).toBeNull();
    expect(s.solo_kills).toBe(0);
    expect(s.kill_participation).toBeGreaterThan(0);
    expect(aggregatePlaystyle([m11], ENEMY)).toBeNull();
    expect(aggregatePlaystyle([], ENEMY)).toBeNull();
    const remake = JSON.parse(JSON.stringify(m8));
    remake.info.participants[0].timePlayed = 200;
    expect(aggregatePlaystyle([remake], ENEMY)).toBeNull();
    expect(aggregatePlaystyle([null, {}, { info: { queueId: 420 } }], ENEMY)).toBeNull();
  });

  it('uses the game duration when timePlayed is missing (milliseconds on old payloads)', () => {
    const old = JSON.parse(JSON.stringify(m10));
    delete old.info.gameEndTimestamp;
    old.info.gameDuration = 1_200_000;
    expect(aggregatePlaystyle([old], ENEMY)?.avg_game_minutes).toBe(20);
  });
});

describe('profile builder', () => {
  it('client/game profile: 4 + 5 calls max, through the limiter, compact result', async () => {
    installWindow('');
    const calls = riotServer();
    const { t, acquire } = countingTransport();
    const progress: number[] = [];
    const { profile, calls: n } = await buildEnemyProfile(
      { source: 'game', platform: 'euw1', puuid: ENEMY, riot_id: 'Lee Fou#EUW', champion_id: 'LeeSin' },
      catalog,
      { transport: t, onProgress: (p) => progress.push(p.calls), now: () => Date.parse('2026-11-10T20:00:00Z') },
    );
    expect(n).toBe(calls.length);
    expect(n).toBeLessThanOrEqual(profileCallBudget(QUICK_MATCH_COUNT, false));
    expect(acquire).toHaveBeenCalledTimes(n);
    expect(calls).toContain(`riot/masteries:${PROFILE_MASTERY_COUNT}`);
    expect(calls).toContain(`riot/match-ids:${QUICK_MATCH_COUNT}`);
    expect(calls.filter((c) => c.startsWith('riot/match:'))).toHaveLength(5);
    expect(progress[progress.length - 1]).toBe(n);
    expect(profile).toMatchObject({
      puuid: ENEMY,
      riot_id: 'Lee Fou#EUW',
      source: 'game',
      summoner_level: 312,
      champion_id: 'LeeSin',
      fetched_at: '2026-11-10T20:00:00.000Z',
    });
    expect(profile.rank?.queue).toBe('RANKED_SOLO_5x5');
    expect(profile.masteries[0]).toMatchObject({ champion_id: 'LeeSin', points: 250_000 });
    expect(profile.recent.games).toBe(3);
    expect(profile.recent.champions[0]).toMatchObject({ champion_id: 'LeeSin', games: 2, wins: 1 });
    expect(profile.recent.lane_matchups).toBeUndefined();
    expect(profile.recent.allies).toBeUndefined();
    expect(profile.style?.games).toBe(3);
  });

  it('scouting by Riot ID: 1 account call + 4 + 10 matches max', async () => {
    installWindow('');
    const ids = Array.from({ length: 12 }, (_, i) => (i < 3 ? `EUW1_700000000${8 + i}` : `EUW1_10${i}`));
    const calls = riotServer({ ids });
    const { profile, calls: n } = await buildEnemyProfile({ source: 'scouting', platform: 'euw1', riot_id: ' lee fou#euw ' }, catalog, { transport: countingTransport().t });
    expect(calls[0]).toBe('riot/account');
    expect(calls).toContain(`riot/match-ids:${SCOUT_MATCH_COUNT}`);
    expect(n).toBe(profileCallBudget(SCOUT_MATCH_COUNT, true));
    expect(profile.riot_id).toBe('Lee Fou#EUW'); // Riot's spelling
    expect(profile.puuid).toBe(ENEMY);
  });

  it('invalid or unknown Riot ID fails before any other call', async () => {
    installWindow('');
    const calls = riotServer({ accountStatus: 404 });
    await expect(buildEnemyProfile({ source: 'scouting', platform: 'euw1', riot_id: 'sans tag' }, catalog)).rejects.toMatchObject({ status: 422 });
    await expect(buildEnemyProfile({ source: 'scouting', platform: 'euw1', riot_id: 'Ghost#0000' }, catalog, { transport: countingTransport().t }))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining('Ghost#0000') });
    expect(calls).toEqual(['riot/account']);
  });
});

describe('profile service: dedupe, session cache, budget', () => {
  const profile = (puuid: string, over: Partial<EnemyPlayerProfile> = {}): EnemyPlayerProfile => ({
    puuid, source: 'game', masteries: [], recent: { games: 0, roles: {}, champions: [] }, fetched_at: '2026-11-10T20:00:00Z', ...over,
  });

  it('shares concurrent builds, caches per puuid, seeds from the document', async () => {
    const build = vi.fn(async (req: ProfileRequest) => profile(req.puuid ?? 'resolved', { riot_id: req.riot_id ?? null }));
    const svc = new EnemyProfileService(build);
    const [a, b] = await Promise.all([
      svc.request({ source: 'client', platform: 'euw1', puuid: 'p-1', champion_id: 'Ahri' }),
      svc.request({ source: 'client', platform: 'euw1', puuid: 'p-1' }),
    ]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(a.champion_id).toBe('Ahri');
    expect(b.puuid).toBe('p-1');
    // Later request (game): cached, with the request's source/champion.
    const c = await svc.request({ source: 'game', platform: 'euw1', puuid: 'p-1', champion_id: 'Zed' });
    expect(build).toHaveBeenCalledTimes(1);
    expect(c).toMatchObject({ source: 'game', champion_id: 'Zed' });
    // Scouting wants a deeper history than a 5-game profile: rebuilt once.
    await svc.request({ source: 'scouting', platform: 'euw1', puuid: 'p-1' });
    await svc.request({ source: 'scouting', platform: 'euw1', puuid: 'p-1' });
    expect(build).toHaveBeenCalledTimes(2);
    // A profile stored by a friend in the shared draft is never refetched (by puuid or Riot ID).
    svc.seed([profile('p-2', { riot_id: 'Ami#EUW', source: 'scouting' })]);
    await svc.request({ source: 'game', platform: 'euw1', puuid: 'p-2' });
    await svc.request({ source: 'scouting', platform: 'euw1', riot_id: 'ami#euw' });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('reports progress and errors, builds at most 2 profiles at once', async () => {
    let running = 0;
    let max = 0;
    const svc = new EnemyProfileService(async (req, onProgress) => {
      running += 1;
      max = Math.max(max, running);
      onProgress({ calls: 1, total: 9 });
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      if (req.puuid === 'bad') throw new Error('Limite de requêtes Riot atteinte.');
      return profile(req.puuid as string);
    });
    const reqs = ['e1', 'e2', 'e3', 'bad'].map((puuid) => svc.request({ source: 'game', platform: 'euw1', puuid }).catch(() => null));
    expect(overallProgress(svc.getStatuses()).loading).toBe(4);
    await Promise.all(reqs);
    expect(max).toBe(2);
    const st = svc.getStatuses();
    expect(st.filter((s) => s.state === 'done')).toHaveLength(3);
    expect(st.find((s) => s.key === 'bad')).toMatchObject({ state: 'error', error: 'Limite de requêtes Riot atteinte.' });
    svc.forget('bad');
    expect(svc.getStatuses().some((s) => s.key === 'bad')).toBe(false);
  });

  it('a full 5-enemy game fetch stays within 45 Riot calls; a second one costs nothing', async () => {
    installWindow('');
    const calls = riotServer({ ids: ['EUW1_7000000008', 'EUW1_7000000009', 'EUW1_7000000010', 'EUW1_7000000011', 'EUW1_0000000404', 'EUW1_7000000008'] });
    const { t, acquire } = countingTransport();
    const svc = new EnemyProfileService((req, onProgress) => buildEnemyProfile(req, catalog, { transport: t, onProgress }).then((r) => r.profile));
    const enemies = ['a', 'b', 'c', 'd', 'e'].map((x) => `enemy-${x}`);
    await Promise.all(enemies.map((puuid) => svc.request({ source: 'game', platform: 'euw1', puuid })));
    expect(calls.length).toBe(5 * profileCallBudget(QUICK_MATCH_COUNT, false));
    expect(calls.length).toBeLessThanOrEqual(45);
    expect(acquire).toHaveBeenCalledTimes(calls.length);
    await Promise.all(enemies.map((puuid) => svc.request({ source: 'client', platform: 'euw1', puuid })));
    expect(calls.length).toBe(45);
  });
});
