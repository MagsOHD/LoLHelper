import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './backend';
import {
  aggregateRecent,
  fetchPlayerData,
  getAccount,
  mapMasteries,
  mapPosition,
  pickRank,
  RateLimiter,
  realSleep,
  riotGet,
  summarizeMatch,
  type RawLeagueEntry,
  type RawMatch,
  type RiotTransport,
} from './riot';
import { FIXTURES, fakeCatalog, fakeServer, installWindow, json } from './__fixtures__/fakes';
import { failure } from './__fixtures__/fakes';

const PUUID = FIXTURES.account.puuid;
const noLimit = (sleep = vi.fn(async () => undefined)): RiotTransport => ({
  limiter: new RateLimiter([]),
  sleep,
  maxRetries: 3,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('aggregation', () => {
  it('maps positions', () => {
    expect(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'support', '', null].map(mapPosition)).toEqual([
      'TOP', 'JUNGLE', 'MID', 'BOTTOM', 'SUPPORT', 'SUPPORT', null, null,
    ]);
  });

  it('maps masteries via numeric key and skips unknown', () => {
    const m = mapMasteries(FIXTURES.masteries, fakeCatalog());
    expect(m.map((x) => x.champion_id)).toEqual(['Ahri', 'Thresh', 'MonkeyKing']);
    expect(m[0]).toEqual({ champion_id: 'Ahri', level: 12, points: 154321, last_play_time: 1759600000000 });
  });

  it('prefers solo queue, then flex', () => {
    const entries = FIXTURES.leagueEntries as RawLeagueEntry[];
    expect(pickRank(entries)).toEqual({ queue: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', lp: 54, wins: 30, losses: 25 });
    expect(pickRank(entries.filter((e) => e.queueType === 'RANKED_FLEX_SR'))?.queue).toBe('RANKED_FLEX_SR');
    expect(pickRank([])).toBeNull();
  });

  it('aggregates positions, wins, KDA and filters non Summoner’s Rift queues', () => {
    const summaries = FIXTURES.matchIds.map((id) => summarizeMatch(FIXTURES.matches[id] as RawMatch));
    const recent = aggregateRecent(summaries, PUUID, fakeCatalog());
    expect(recent.games).toBe(5); // ARAM (450) excluded
    expect(recent.roles).toEqual({ TOP: 0, JUNGLE: 2, MID: 2, BOTTOM: 0, SUPPORT: 1 });
    const byId = Object.fromEntries(recent.champions.map((c) => [c.champion_id, c]));
    expect(byId.Lux).toBeUndefined();
    expect(recent.champions[0].champion_id).toBe('Ahri');
    const ahri = byId.Ahri;
    expect([ahri.games, ahri.wins, ahri.role]).toEqual([2, 1, 'MID']);
    expect([ahri.kills, ahri.deaths, ahri.assists]).toEqual([5.5, 3.5, 5.0]);
    expect(byId.Thresh.role).toBe('SUPPORT');
    expect(byId.MonkeyKing.wins).toBe(1);
    // championName "FiddleSticks" resolved through championId 9.
    expect([byId.Fiddlesticks.games, byId.Fiddlesticks.wins]).toEqual([1, 0]);
  });
});

describe('sync through the PHP proxy', () => {
  it('fetches everything (count 30 masteries, 20 match ids) and aggregates', async () => {
    installWindow('');
    const { riotCalls } = fakeServer({ riotConfigured: true });
    const data = await fetchPlayerData(PUUID, 'euw1', fakeCatalog(), noLimit());
    expect(data.profile_icon_id).toBe(5367);
    expect(data.summoner_level).toBe(287);
    expect(data.rank?.tier).toBe('GOLD');
    expect(data.masteries[0].champion_id).toBe('Ahri');
    expect(data.recent.games).toBe(5);
    expect(riotCalls.find((c) => c.startsWith('riot/masteries'))).toContain('count=30');
    expect(riotCalls.find((c) => c.startsWith('riot/match-ids'))).toContain('count=20');
    expect(riotCalls.filter((c) => c.startsWith('riot/match?'))).toHaveLength(6);
  });

  it('limits match detail concurrency to 3', async () => {
    installWindow('');
    const { fetchMock } = fakeServer({ riotConfigured: true });
    const inner = fetchMock.getMockImplementation()!;
    let inFlight = 0;
    let max = 0;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const isMatch = String(input).includes('r=riot%2Fmatch&');
      if (isMatch) max = Math.max(max, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      if (isMatch) inFlight--;
      return inner(input, init);
    });
    await fetchPlayerData(PUUID, 'euw1', fakeCatalog(), noLimit());
    expect(max).toBe(3);
  });

  it('maps account 404 to a French "Riot ID introuvable"', async () => {
    installWindow('');
    fakeServer({ riotConfigured: true });
    const err = await failure(getAccount('Ghost', '0000', 'euw1', noLimit()));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toContain('Ghost#0000');
  });
});

describe('rate limiting', () => {
  it('honours Retry-After on 429 then succeeds', async () => {
    installWindow('');
    const responses = [
      json({ detail: 'Limite' }, 429, { 'Retry-After': '3' }),
      json({ detail: 'Limite' }, 429, { 'Retry-After': '1' }),
      json(FIXTURES.account),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    const t: RiotTransport = { limiter: new RateLimiter([]), sleep: realSleep, maxRetries: 3 };
    let done = false;
    const p = riotGet<{ puuid: string }>('account', { platform: 'euw1' }, t).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).puuid).toBe(PUUID);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after 3 retries with a 429 ApiError', async () => {
    installWindow('');
    const fetchMock = vi.fn(async () => json({ detail: 'Limite de requêtes Riot atteinte.' }, 429, { 'Retry-After': '2' }));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = vi.fn(async () => undefined);
    const err = await failure(riotGet('summoner', {}, noLimit(sleep)));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[2000], [2000], [2000]]);
  });

  it('sliding windows delay requests (fake timers)', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const limiter = new RateLimiter([
      [2, 1000],
      [3, 10_000],
    ]);
    const times: number[] = [];
    const all = Promise.all(
      [0, 1, 2, 3].map(() => limiter.acquire().then(() => times.push(Date.now() - start))),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await all;
    // 2 immediate, 3rd after the 1 s window, 4th once the 10 s window frees up.
    expect(times).toEqual([0, 0, 1000, 10_000]);
  });

  it('default dev-key limits allow 20 requests per second', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter();
    const start = Date.now();
    const times: number[] = [];
    const all = Promise.all(Array.from({ length: 21 }, () => limiter.acquire().then(() => times.push(Date.now() - start))));
    await vi.advanceTimersByTimeAsync(2000);
    await all;
    expect(times.filter((t) => t === 0)).toHaveLength(20);
    expect(times[20]).toBe(1000);
  });
});
