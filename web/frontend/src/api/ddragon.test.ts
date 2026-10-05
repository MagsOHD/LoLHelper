import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWindow, json, memoryStorage } from './__fixtures__/fakes';

const engine = vi.hoisted(() => ({ buildCatalog: vi.fn((champions: unknown[], version: string) => ({ champions, version })) }));
vi.mock('../engine', () => engine);

import { CACHE_TTL_MS, getCatalog, loadDDragon, profileIconUrl, resetDDragonForTests } from './ddragon';

const CHAMPION_JSON = {
  data: {
    Ahri: { id: 'Ahri', key: '103', name: 'Ahri', title: 'Renarde', tags: ['Mage'], blurb: 'long text', image: { full: 'Ahri.png' } },
    MonkeyKing: { id: 'MonkeyKing', key: '62', name: 'Wukong', title: 'Roi singe', tags: ['Fighter'] },
  },
};

function ddragonFetch(version = '15.19.1') {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/versions.json')) return json([version, '15.18.1']);
    if (url.endsWith(`/cdn/${version}/data/fr_FR/champion.json`)) return json(CHAMPION_JSON);
    return json({}, 404);
  });
}

beforeEach(() => {
  resetDDragonForTests();
  engine.buildCatalog.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Data Dragon', () => {
  it('fetches the latest version + fr_FR champions and caches them 6 h', async () => {
    const storage = memoryStorage();
    installWindow('', storage);
    const fetchMock = ddragonFetch();
    vi.stubGlobal('fetch', fetchMock);

    const first = await loadDDragon(1_000);
    expect(first.version).toBe('15.19.1');
    expect(first.champions.map((c) => c.id)).toEqual(['Ahri', 'MonkeyKing']);
    expect(first.champions[0]).not.toHaveProperty('blurb'); // slimmed for storage
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.length).toBe(1);

    // Fresh cache: no network.
    const again = await loadDDragon(1_000 + CACHE_TTL_MS - 1);
    expect(again.version).toBe('15.19.1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Stale cache, same version: only versions.json is fetched.
    await loadDDragon(1_000 + CACHE_TTL_MS + 1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back to the stale cache, then offline', async () => {
    installWindow('');
    vi.stubGlobal('fetch', ddragonFetch());
    await loadDDragon(0);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    expect((await loadDDragon(CACHE_TTL_MS * 2)).version).toBe('15.19.1');

    resetDDragonForTests();
    installWindow('');
    const offline = await loadDDragon(0);
    expect(offline).toEqual({ version: 'offline', champions: [] });
  });

  it('keeps data in memory when localStorage throws (quota)', async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    installWindow('', storage);
    const fetchMock = ddragonFetch();
    vi.stubGlobal('fetch', fetchMock);
    await loadDDragon(0);
    await loadDDragon(10);
    expect(fetchMock).toHaveBeenCalledTimes(2); // second call served from memory
  });

  it('shares one catalog promise and builds the offline catalog with []', async () => {
    installWindow('');
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)));
    const [a, b] = await Promise.all([getCatalog(), getCatalog()]);
    expect(a).toBe(b);
    expect(engine.buildCatalog).toHaveBeenCalledTimes(1);
    expect(engine.buildCatalog).toHaveBeenCalledWith([], 'offline');
    expect(a.version).toBe('offline');
  });

  it('builds profile icon URLs', () => {
    expect(profileIconUrl('15.19.1', 5367)).toBe('https://ddragon.leagueoflegends.com/cdn/15.19.1/img/profileicon/5367.png');
    expect(profileIconUrl('offline', 5367)).toBe('');
    expect(profileIconUrl('15.19.1', null)).toBe('');
  });
});
