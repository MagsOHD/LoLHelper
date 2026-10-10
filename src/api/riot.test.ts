import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './backend';
import {
  aggregateRecent,
  findLaneOpponent,
  MAX_ALLIES,
  type MatchSummary,
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
import { FIXTURES, FRIEND_PUUID, fakeCatalog, fakeServer, installWindow, json } from './__fixtures__/fakes';
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

describe('history aggregation (last_played, lane_matchups, allies)', () => {
  const all = () => Object.values(FIXTURES.matches).map((m) => summarizeMatch(m as RawMatch));

  it('summarizes teamId and game creation', () => {
    const s = summarizeMatch(FIXTURES.matches.EUW1_7000000007 as RawMatch);
    expect(s.game_creation).toBe(1759700000000);
    expect(s.participants.map((p) => p.teamId)).toEqual([100, 100, 100, 100, 100, 200, 200, 200, 200, 200]);
    expect(summarizeMatch({ info: { participants: [{ puuid: 'x' }] } }).participants[0].teamId).toBeNull();
  });

  it('keeps the most recent game per champion', () => {
    const recent = aggregateRecent(all(), PUUID, fakeCatalog());
    const byId = Object.fromEntries(recent.champions.map((c) => [c.champion_id, c]));
    expect(byId.Ahri.last_played).toBe(1759700000000); // match 7 is the latest
    expect(byId.Ahri.games).toBe(3);
    expect(byId.Thresh.last_played).toBe(1759600000000);
    const noDate = all().map((s) => ({ ...s, game_creation: null }));
    expect(aggregateRecent(noDate, PUUID, fakeCatalog()).champions.every((c) => c.last_played === null)).toBe(true);
  });

  it('records the lane duels against the enemy on the same position', () => {
    const recent = aggregateRecent(all(), PUUID, fakeCatalog());
    expect(recent.lane_matchups).toEqual([
      { champion_id: 'Ahri', opponent_id: 'Syndra', role: 'MID', games: 3, wins: 2 },
      { champion_id: 'MonkeyKing', opponent_id: 'Vi', role: 'JUNGLE', games: 1, wins: 1 },
      { champion_id: 'Thresh', opponent_id: 'Nami', role: 'SUPPORT', games: 1, wins: 1 },
      { champion_id: 'Fiddlesticks', opponent_id: 'Vi', role: 'JUNGLE', games: 1, wins: 0 },
    ]);
  });

  it('skips lane duels when a position or team is missing', () => {
    const base = summarizeMatch(FIXTURES.matches.EUW1_7000000001 as RawMatch);
    const withParticipants = (f: (p: MatchSummary['participants'][number]) => object): MatchSummary => ({
      ...base,
      participants: base.participants.map((p) => ({ ...p, ...f(p) })),
    });
    const noEnemyPos = withParticipants((p) => (p.championName === 'Syndra' ? { teamPosition: '' } : {}));
    expect(aggregateRecent([noEnemyPos], PUUID, fakeCatalog()).lane_matchups).toEqual([]);
    const noMyPos = withParticipants((p) => (p.puuid === PUUID ? { teamPosition: '' } : {}));
    const r = aggregateRecent([noMyPos], PUUID, fakeCatalog());
    expect([r.games, r.lane_matchups]).toEqual([1, []]);
    const noTeams = withParticipants(() => ({ teamId: null }));
    const t = aggregateRecent([noTeams], PUUID, fakeCatalog());
    expect([t.lane_matchups, t.allies]).toEqual([[], []]);
    // Two enemies on the same position: ambiguous, skipped.
    const twoMids = withParticipants((p) => (p.championName === 'Caitlyn' ? { teamPosition: 'MIDDLE' } : {}));
    const me = twoMids.participants.find((p) => p.puuid === PUUID)!;
    expect(findLaneOpponent(me, twoMids.participants)).toBeNull();
  });

  it('counts games and champion pairs with teammates (both tracked players see each other)', () => {
    const recent = aggregateRecent(all(), PUUID, fakeCatalog());
    const allies = recent.allies!;
    expect(allies[0]).toEqual({
      puuid: FRIEND_PUUID,
      games: 2,
      wins: 2,
      pairs: [
        { champion_id: 'Ahri', ally_champion_id: 'Leona', games: 1, wins: 1 },
        { champion_id: 'MonkeyKing', ally_champion_id: 'Lulu', games: 1, wins: 1 },
      ],
    });
    // 6 Summoner's Rift games x 4 teammates, the friend counted once; enemies never listed.
    expect(allies).toHaveLength(23);
    expect(allies.some((a) => a.puuid === 'other-puuid-EUW1_7000000001-4')).toBe(false);
    expect(allies.some((a) => a.puuid === PUUID)).toBe(false);
    expect(allies.slice(1).every((a) => a.games === 1)).toBe(true);
    const loss = allies.find((a) => a.puuid === 'other-puuid-EUW1_7000000002-0')!;
    expect([loss.games, loss.wins, loss.pairs]).toEqual([1, 0, [{ champion_id: 'Ahri', ally_champion_id: 'Garen', games: 1, wins: 0 }]]);

    const friend = aggregateRecent(all(), FRIEND_PUUID, fakeCatalog());
    expect(friend.games).toBe(2);
    expect(friend.allies!.find((a) => a.puuid === PUUID)).toEqual({
      puuid: PUUID,
      games: 2,
      wins: 2,
      pairs: [
        { champion_id: 'Leona', ally_champion_id: 'Ahri', games: 1, wins: 1 },
        { champion_id: 'Lulu', ally_champion_id: 'MonkeyKing', games: 1, wins: 1 },
      ],
    });
    expect(friend.lane_matchups!.map((l) => [l.champion_id, l.opponent_id, l.role])).toEqual([
      ['Leona', 'Nami', 'SUPPORT'],
      ['Lulu', 'Nami', 'SUPPORT'],
    ]);
  });

  it('is deterministic whatever the match order', () => {
    const a = aggregateRecent(all(), PUUID, fakeCatalog());
    const b = aggregateRecent(all().reverse(), PUUID, fakeCatalog());
    expect(b.lane_matchups).toEqual(a.lane_matchups);
    expect(b.allies).toEqual(a.allies);
    expect(b.champions.map((c) => c.champion_id)).toEqual(a.champions.map((c) => c.champion_id));
  });

  it('caps allies at MAX_ALLIES but always keeps tracked players', () => {
    const summaries: MatchSummary[] = Array.from({ length: 20 }, (_, i) => ({
      match_id: `M${i}`,
      queue_id: 420,
      game_creation: 1_000 + i,
      participants: [
        { puuid: PUUID, teamId: 100, championName: 'Ahri', teamPosition: 'MIDDLE', win: true, kills: 0, deaths: 0, assists: 0 },
        ...[0, 1, 2, 3].map((k) => ({
          puuid: `mate-${String(i * 4 + k).padStart(2, '0')}`,
          teamId: 100,
          championName: 'Garen',
          teamPosition: '',
          win: true,
          kills: 0,
          deaths: 0,
          assists: 0,
        })),
      ],
    }));
    const capped = aggregateRecent(summaries, PUUID, fakeCatalog()).allies!;
    expect(capped).toHaveLength(MAX_ALLIES);
    expect(capped[MAX_ALLIES - 1].puuid).toBe('mate-49');
    const kept = aggregateRecent(summaries, PUUID, fakeCatalog(), { keepPuuids: ['mate-77', 'unknown'] }).allies!;
    expect(kept).toHaveLength(MAX_ALLIES + 1);
    expect(kept[MAX_ALLIES].puuid).toBe('mate-77');
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
    expect(data.recent.lane_matchups?.[0]).toEqual({ champion_id: 'Ahri', opponent_id: 'Syndra', role: 'MID', games: 2, wins: 1 });
    expect(data.recent.allies?.[0]).toMatchObject({ puuid: FRIEND_PUUID, games: 1, wins: 1 });
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
