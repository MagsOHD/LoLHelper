// Riot IDs shown by the client -> Riot API puuids: validation, cache, budget, failures.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RIOT_ID_LOOKUPS, RIOT_ID_RETRY_MS, RiotIdResolver, riotIdOf } from './riotIdResolver';
import { buildEnemyProfile } from './enemyProfile';
import { ApiError } from './backend';
import { getAccount, RateLimiter, type RiotTransport } from './riot';
import type { EnemyPlayerProfile } from './types';
import { FIXTURES, fakeCatalog, installWindow, json } from './__fixtures__/fakes';

const API_PUUID = 'kX9v2bQx3Lr7nT0pWq8sYz1aB4cD5eF6gH7iJ8kL9mN0oP1qR2sT3uV4wX5yZ6aB7cD8eF9gH0iJ1k';
const ZED = { game_name: 'Zed Main', tag_line: 'EUW' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('riotIdOf', () => {
  it('keeps visible, well-formed Riot IDs only', () => {
    expect(riotIdOf({ game_name: ' Zed Main ', tag_line: '#EUW' })).toEqual(ZED);
    expect(riotIdOf({ game_name: 'Gâchette', tag_line: 'ZAU' })).toEqual({ game_name: 'Gâchette', tag_line: 'ZAU' });
    for (const bad of [null, 'Zed#EUW', [], {}, { game_name: '', tag_line: 'EUW' }, { game_name: 'Zed', tag_line: '' },
      { game_name: 'x'.repeat(33), tag_line: 'EUW' }, { game_name: 'Zed', tag_line: 'TOOLONGTAG' }, { game_name: 'Ze\u0000d', tag_line: 'EUW' },
      { game_name: 'Zed', tag_line: 'E#W' }, { game_name: 42, tag_line: 'EUW' }]) {
      expect(riotIdOf(bad)).toBeNull();
    }
  });
});

describe('RiotIdResolver', () => {
  it('resolves a Riot ID once (concurrent and later requests, any case) and remembers Riot’s spelling', async () => {
    const lookup = vi.fn(async () => ({ puuid: API_PUUID, gameName: 'Zed Main', tagLine: 'EUW' }));
    const r = new RiotIdResolver(lookup);
    const seen = vi.fn();
    r.subscribe(seen);
    expect(r.peek(ZED)).toBeNull();
    const [a, b] = await Promise.all([r.resolve(ZED, 'euw1'), r.resolve({ game_name: 'zed main', tag_line: 'euw' }, 'euw1')]);
    expect([a, b]).toEqual([API_PUUID, API_PUUID]);
    expect(await r.resolve(ZED, 'euw1')).toBe(API_PUUID);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('Zed Main', 'EUW', 'euw1');
    expect(r.lookups).toBe(1);
    expect(r.peek({ game_name: 'ZED MAIN', tag_line: 'Euw' })).toBe(API_PUUID);
    expect(r.riotIdFor(API_PUUID)).toBe('Zed Main#EUW');
    expect(r.notesFor([ZED])).toEqual([]);
    expect(seen).toHaveBeenCalled();
  });

  it('unknown Riot ID (404): stays anonymous, French note, never asked again', async () => {
    const lookup = vi.fn(async () => {
      throw new ApiError('Riot ID introuvable : Ghost#EUW.', 404);
    });
    const r = new RiotIdResolver(lookup);
    const ghost = { game_name: 'Ghost', tag_line: 'EUW' };
    expect(await r.resolve(ghost, 'euw1')).toBeNull();
    expect(await r.resolve(ghost, 'euw1')).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(r.peek(ghost)).toBeNull();
    expect(r.status(ghost)?.state).toBe('missing');
    expect(r.notesFor([ghost, ghost, ZED])).toEqual(['Riot ID introuvable : Ghost#EUW. Cet adversaire reste anonyme.']);
  });

  it('other failures are retried once the delay is over; junk answers count as not found', async () => {
    let now = 1_000_000;
    const lookup = vi.fn()
      .mockRejectedValueOnce(new ApiError('Limite de requêtes Riot atteinte, réessaie dans quelques secondes.', 429))
      .mockResolvedValueOnce({ puuid: API_PUUID });
    const r = new RiotIdResolver(lookup, { now: () => now });
    expect(await r.resolve(ZED, 'euw1')).toBeNull();
    expect(r.notesFor([ZED])[0]).toMatch(/^Impossible d’identifier Zed Main#EUW pour l’instant .*nouvel essai dans une minute\.$/);
    expect(await r.resolve(ZED, 'euw1')).toBeNull(); // too early
    expect(lookup).toHaveBeenCalledTimes(1);
    now += RIOT_ID_RETRY_MS;
    expect(await r.resolve(ZED, 'euw1')).toBe(API_PUUID);
    expect(r.riotIdFor(API_PUUID)).toBe('Zed Main#EUW'); // spelling from the request when Riot gives none

    const junk = new RiotIdResolver(vi.fn(async () => ({ puuid: '<script>' })));
    expect(await junk.resolve(ZED, 'euw1')).toBeNull();
    expect(junk.status(ZED)?.state).toBe('missing');
  });

  it('caps the riot/account calls per session', async () => {
    const lookup = vi.fn(async (name: string) => ({ puuid: `p${name}`.padEnd(40, 'x') }));
    const r = new RiotIdResolver(lookup, { maxLookups: 2 });
    const ids = ['A', 'B', 'C'].map((n) => ({ game_name: n, tag_line: 'EUW' }));
    const out = await Promise.all(ids.map((id) => r.resolve(id, 'euw1')));
    expect(out.map((x) => x !== null)).toEqual([true, true, false]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r.notesFor(ids)).toEqual(['Trop de Riot ID à identifier pendant cette session : C#EUW reste anonyme (rechargez la page pour réessayer).']);
    expect(MAX_RIOT_ID_LOOKUPS).toBeGreaterThanOrEqual(10); // two full enemy teams
  });

  it('profiles already in the shared document resolve without any call', async () => {
    const lookup = vi.fn();
    const r = new RiotIdResolver(lookup);
    const stored = { puuid: API_PUUID, riot_id: 'Zed Main#EUW', source: 'client' } as EnemyPlayerProfile;
    r.seed([stored, { puuid: 'other', riot_id: null } as EnemyPlayerProfile]);
    expect(await r.resolve({ game_name: 'zed main', tag_line: 'EUW' }, 'euw1')).toBe(API_PUUID);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('real lookup: riot/account through the shared limiter with the draft platform, then the client profile by puuid', async () => {
    installWindow('');
    const routes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://site.test');
      const route = url.searchParams.get('r') ?? '';
      routes.push(route);
      if (route === 'riot/account') {
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ platform: 'euw1', gameName: 'Zed Main', tagLine: 'EUW' });
        return json({ puuid: API_PUUID, gameName: 'Zed Main', tagLine: 'EUW' });
      }
      if (route === 'riot/summoner') return json({ summonerLevel: 30 });
      if (route === 'riot/league') return json(FIXTURES.leagueEntries);
      if (route === 'riot/masteries' || route === 'riot/match-ids') return json([]);
      return json({ detail: 'Introuvable.' }, 404);
    }));
    const limiter = new RateLimiter([]);
    const acquire = vi.spyOn(limiter, 'acquire');
    const t: RiotTransport = { limiter, sleep: vi.fn(async () => undefined), maxRetries: 3 };
    const r = new RiotIdResolver((g, tag, platform) => getAccount(g, tag, platform, t));
    const puuid = await r.resolve(ZED, 'euw1');
    expect(puuid).toBe(API_PUUID);
    expect(acquire).toHaveBeenCalledTimes(1);
    const built = await buildEnemyProfile({ source: 'client', platform: 'euw1', puuid, riot_id: r.riotIdFor(puuid) }, fakeCatalog(), { transport: t });
    expect(built.profile).toMatchObject({ puuid: API_PUUID, riot_id: 'Zed Main#EUW', source: 'client' });
    expect(routes.filter((x) => x === 'riot/account')).toHaveLength(1); // not resolved again by the builder
    expect(acquire).toHaveBeenCalledTimes(1 + built.calls);

    // 404 from the proxy: anonymous, French note.
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Introuvable.' }, 404)));
    const ghost = { game_name: 'Ghost', tag_line: 'EUW' };
    expect(await r.resolve(ghost, 'euw1')).toBeNull();
    expect(r.notesFor([ghost])).toEqual(['Riot ID introuvable : Ghost#EUW. Cet adversaire reste anonyme.']);
  });
});
