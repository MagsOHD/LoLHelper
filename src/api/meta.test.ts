import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../engine', async () => {
  const { fakeEngine } = await import('./__fixtures__/fakes');
  return fakeEngine();
});

import { resetDDragonForTests } from './ddragon';
import {
  collectMetaOnce,
  fetchMetaStatus,
  getAdviceMeta,
  getMetaStats,
  getMetaStatsForPatch,
  invalidateMetaStats,
  mapMetaStats,
  META_RETRY_MS,
  normalizeCollectResult,
  normalizePatches,
  resetMetaForTests,
  type RawMetaStats,
} from './meta';
import { ApiError } from './backend';
import { saveTierOverride } from './metaRank';
import { failure, fakeCatalog, fakeServer, installWindow, json } from './__fixtures__/fakes';

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

type Call = [string, RequestInit];
const calls = (m: ReturnType<typeof vi.fn>) => m.mock.calls as unknown as Call[];

describe('meta stats by patch', () => {
  it('reads a kept patch with r=meta-stats&patch=, bypassing the HTTP cache, cached per patch', async () => {
    installWindow('');
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('ddragon') ? json({}, 503) : json({ ...RAW, patch: '16.18', games: 99 }));
    vi.stubGlobal('fetch', fetchMock);
    const s = await getMetaStatsForPatch('16.18');
    expect(s).toMatchObject({ patch: '16.18', games: 99 });
    expect(await getMetaStatsForPatch('16.18')).toBe(s);
    const api = calls(fetchMock).filter(([u]) => u.includes('meta-stats'));
    expect(api).toHaveLength(1);
    expect(api[0][0]).toBe('api/index.php?r=meta-stats&patch=16.18');
    expect(api[0][1].cache).toBe('no-store');
  });

  it('empty patch = served snapshot; invalid or unknown patch = null; other errors reject', async () => {
    const { metaStatsCalls } = fakeServer({ metaStats: RAW as Record<string, unknown> });
    expect(await getMetaStatsForPatch(null)).toBe(await getMetaStats());
    expect(metaStatsCalls).toHaveLength(1);
    expect(await getMetaStatsForPatch('../x')).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Patch non conservé.' }, 404)));
    expect(await getMetaStatsForPatch('15.1')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Erreur.' }, 500)));
    const err = await failure(getMetaStatsForPatch('15.2'));
    expect(err.status).toBe(500);
  });

  it('invalidateMetaStats makes generation/draft refetch the served snapshot', async () => {
    const { metaStatsCalls } = fakeServer({ metaStats: RAW as Record<string, unknown> });
    await getMetaStats();
    await getMetaStats();
    expect(metaStatsCalls).toHaveLength(1);
    invalidateMetaStats();
    await getMetaStats();
    expect(metaStatsCalls).toHaveLength(2);
  });
});

describe('meta stats by tier', () => {
  it('sends &tier= (and &patch=), maps the response tier (old apex names -> Master+), caches per tier', async () => {
    installWindow('');
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('ddragon')) return json({}, 503);
      const tier = /tier=([A-Z_]+)/.exec(u)?.[1];
      return json({ ...RAW, tier: tier === 'MASTER_PLUS' ? 'CHALLENGER' : tier });
    });
    vi.stubGlobal('fetch', fetchMock);
    const gold = await getMetaStats(Date.now(), 'GOLD');
    expect(gold?.tier).toBe('GOLD');
    expect(await getMetaStats(Date.now(), 'GOLD')).toBe(gold);
    expect((await getMetaStatsForPatch(null, 'MASTER_PLUS'))?.tier).toBe('MASTER_PLUS');
    expect((await getMetaStatsForPatch('16.18', 'IRON'))?.tier).toBe('IRON');
    expect(mapMetaStats(RAW, fakeCatalog())?.tier).toBeUndefined();
    const urls = calls(fetchMock).map(([u]) => u).filter((u) => u.includes('meta-stats'));
    expect(urls).toEqual([
      'api/index.php?r=meta-stats&tier=GOLD',
      'api/index.php?r=meta-stats&tier=MASTER_PLUS',
      'api/index.php?r=meta-stats&tier=IRON&patch=16.18',
    ]);
  });

  it('normalizes the per-tier progress and window of r=meta-status', async () => {
    installWindow('');
    vi.stubGlobal('fetch', vi.fn(async () => json({
      tiers: [
        { tier: 'GOLD', patch: '16.22', games: 412, target: 500, oldest: '2026-11-10T08:00:00Z', newest: '2026-11-13T09:00:00Z' },
        { tier: 'MASTER_PLUS', patch: '16.22', games: 500, target: 500 },
      ],
      window: { start: 4, end: 15, open: true },
    })));
    const st = await fetchMetaStatus();
    expect(st.tiers.map((t) => [t.tier, t.games, t.target])).toEqual([['GOLD', 412, 500], ['MASTER_PLUS', 500, 500]]);
    expect(st.window).toEqual({ start: 4, end: 15, open: true });
  });

  it('getAdviceMeta: tier of the median rank, override, fallback; server default without progress', async () => {
    const queries: string[] = [];
    let tiers: unknown[] = [{ tier: 'SILVER', games: 300 }, { tier: 'GOLD', games: 60 }, { tier: 'MASTER_PLUS', games: 500 }];
    installWindow('');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(String(url), 'http://x.test');
      if (u.hostname.includes('ddragon')) return json({}, 503);
      if (u.searchParams.get('r') === 'meta-status') return json({ tiers });
      queries.push(u.searchParams.toString());
      return json({ ...RAW, tier: u.searchParams.get('tier') ?? undefined });
    }));
    const gold = { queue: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'I', lp: 0, wins: 0, losses: 0 };
    expect((await getAdviceMeta([gold, null]))?.tier).toBe('SILVER'); // Gold has 60 games
    saveTierOverride('MASTER_PLUS');
    expect((await getAdviceMeta([gold]))?.tier).toBe('MASTER_PLUS');
    saveTierOverride(null);
    invalidateMetaStats();
    tiers = [];
    await getAdviceMeta([]);
    expect(queries).toEqual(['r=meta-stats&tier=SILVER', 'r=meta-stats&tier=MASTER_PLUS', 'r=meta-stats']);
  });
});

describe('meta status / manual collection', () => {
  it('normalizes r=meta-status (patches sorted, defaults when fields are missing)', async () => {
    installWindow('');
    vi.stubGlobal('fetch', vi.fn(async () => json({
      collecting: true,
      admin_enabled: true,
      meta_enabled: true,
      last_run: { stop: 'budget', requests: 27, new_matches: 12, patch: '16.19', games: 900, duration_s: 45.2, at: '2026-10-10T12:00:00Z', source: 'cron' },
      patches: [{ patch: '16.9', games: 10, updated_at: 'a' }, { patch: '16.19', games: 900, updated_at: 'b' }, { patch: 'x', games: 1 }],
    })));
    const st = await fetchMetaStatus();
    expect(st.collecting).toBe(true);
    expect(st.last_run).toMatchObject({ stop: 'budget', new_matches: 12, source: 'cron', duration_s: 45.2 });
    expect(st.patches.map((p) => p.patch)).toEqual(['16.19', '16.9']);

    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    expect(await fetchMetaStatus()).toEqual({ collecting: false, admin_enabled: false, meta_enabled: true, last_run: null, patches: [], tiers: [], window: null });
    expect(normalizePatches({ '16.18': { games: 3, updated_at: 'u' } })).toEqual([{ patch: '16.18', games: 3, updated_at: 'u' }]);
  });

  it('POSTs r=meta-collect with X-Admin-Password and maps the summary', async () => {
    const win = installWindow('');
    const fetchMock = vi.fn(async () => json({
      status: 'ok', stop: 'riot_limit', retry_after: 30, requests: 5, new_matches: 1, patch: '16.19', games: 901,
      patches: [{ patch: '16.19', games: 901, updated_at: 'z' }], duration_s: 3.1,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await collectMetaOnce('s3cret');
    expect(res).toMatchObject({ status: 'ok', stop: 'riot_limit', retry_after: 30, games: 901 });
    const [url, init] = calls(fetchMock)[0];
    expect(url).toBe('api/index.php?r=meta-collect');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Admin-Password']).toBe(`b64:${btoa('s3cret')}`);
    expect(win.dispatchEvent).not.toHaveBeenCalled();
    expect(normalizeCollectResult({ status: 'busy' })).toEqual({ status: 'busy' });
    expect(() => normalizeCollectResult('<html>')).toThrow(ApiError);
  });

  it('a wrong admin password does not lock the app; a wrong app password does', async () => {
    const win = installWindow('');
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Mot de passe administrateur incorrect.' }, 401)));
    const err = await failure(collectMetaOnce('nope'));
    expect([err.status, err.message]).toEqual([401, 'Mot de passe administrateur incorrect.']);
    expect(win.dispatchEvent).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Mot de passe requis ou incorrect.' }, 401)));
    await failure(collectMetaOnce('nope'));
    expect(win.dispatchEvent).toHaveBeenCalledTimes(1);

    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Collecte manuelle désactivée : définissez admin_password dans config.php.' }, 403)));
    expect((await failure(collectMetaOnce('x'))).status).toBe(403);
  });
});
