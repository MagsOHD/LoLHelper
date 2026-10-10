import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../engine', async () => {
  const { fakeEngine } = await import('./__fixtures__/fakes');
  return fakeEngine();
});

import { resetDDragonForTests } from './ddragon';
import { getMetaStats, mapMetaStats, META_RETRY_MS, resetMetaForTests, type RawMetaStats } from './meta';
import { fakeCatalog, fakeServer, installWindow } from './__fixtures__/fakes';

const RAW: RawMetaStats = {
  available: true,
  patch: '16.19',
  platform: 'euw1',
  games: 1234,
  updated_at: '2026-10-10T12:00:00Z',
  champions: {
    '103': { MID: [120, 63], TOP: [0, 0] },
    '412': { SUPPORT: [80, 41], UTILITY: 'nope' },
    '99999': { MID: [10, 5] }, // unknown champion
    abc: { MID: [10, 5] },
  },
  bans: { '103': 45, '238': 12, '86': 0 },
  matchups: {
    MID: { '103': { '99': [12, 7], '99999': [3, 1] }, '99999': { '103': [3, 2] } },
    ADC: { '222': { '51': [5, 2] } },
  },
};

beforeEach(() => {
  resetDDragonForTests();
  resetMetaForTests();
  installWindow('');
});
afterEach(() => vi.unstubAllGlobals());

describe('mapMetaStats', () => {
  it('maps numeric keys to Data Dragon ids and drops unknown or malformed entries', () => {
    expect(mapMetaStats(RAW, fakeCatalog())).toEqual({
      patch: '16.19',
      platform: 'euw1',
      games: 1234,
      updated_at: '2026-10-10T12:00:00Z',
      champions: { Ahri: { MID: [120, 63] }, Thresh: { SUPPORT: [80, 41] } },
      bans: { Ahri: 45 },
      matchups: { MID: { Ahri: { Lux: [12, 7] } } },
    });
  });

  it('is null when nothing has been collected', () => {
    expect(mapMetaStats({ available: false, games: 0 }, fakeCatalog())).toBeNull();
    expect(mapMetaStats({ ...RAW, games: 0 }, fakeCatalog())).toBeNull();
    expect(mapMetaStats(null, fakeCatalog())).toBeNull();
    expect(mapMetaStats('oops' as never, fakeCatalog())).toBeNull();
  });
});

describe('getMetaStats', () => {
  it('fetches r=meta-stats once per session', async () => {
    const { metaStatsCalls } = fakeServer({ metaStats: RAW as Record<string, unknown> });
    const [a, b] = await Promise.all([getMetaStats(), getMetaStats()]);
    expect(a?.champions.Ahri?.MID).toEqual([120, 63]);
    expect(b).toBe(a);
    expect(await getMetaStats()).toBe(a);
    expect(metaStatsCalls).toHaveLength(1);
  });

  it('resolves to null when unavailable', async () => {
    const { metaStatsCalls } = fakeServer({ metaStats: { available: false, games: 0 } });
    expect(await getMetaStats()).toBeNull();
    expect(await getMetaStats()).toBeNull();
    expect(metaStatsCalls).toHaveLength(1);
  });

  it('resolves to null on errors and retries later', async () => {
    const { metaStatsCalls } = fakeServer({ metaStats: 500 });
    const t0 = 1_000_000;
    expect(await getMetaStats(t0)).toBeNull();
    expect(await getMetaStats(t0 + 1000)).toBeNull();
    expect(metaStatsCalls).toHaveLength(1);
    expect(await getMetaStats(t0 + META_RETRY_MS)).toBeNull();
    expect(metaStatsCalls).toHaveLength(2);
  });

  it('resolves to null when the route does not exist (old PHP API) or the network fails', async () => {
    fakeServer(); // r=meta-stats -> 404 "Route inconnue"
    expect(await getMetaStats()).toBeNull();
    resetMetaForTests();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    expect(await getMetaStats()).toBeNull();
  });
});
