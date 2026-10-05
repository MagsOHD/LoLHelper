// Test doubles for the data-layer tests (node environment, no jsdom).
import { vi } from 'vitest';
import type { ChampionCatalog } from '../../engine';
import { ApiError } from '../backend';
import type { ChampionInfo, ChampionTraits, PoolEntry, Role } from '../types';
import account from './account.json';
import leagueEntries from './league_entries.json';
import masteries from './masteries.json';
import matchIds from './match_ids.json';
import summoner from './summoner.json';
import m1 from './match_EUW1_7000000001.json';
import m2 from './match_EUW1_7000000002.json';
import m3 from './match_EUW1_7000000003.json';
import m4 from './match_EUW1_7000000004.json';
import m5 from './match_EUW1_7000000005.json';
import m6 from './match_EUW1_7000000006.json';

export const FIXTURES = {
  account,
  leagueEntries,
  masteries,
  matchIds: matchIds as string[],
  summoner,
  matches: {
    EUW1_7000000001: m1,
    EUW1_7000000002: m2,
    EUW1_7000000003: m3,
    EUW1_7000000004: m4,
    EUW1_7000000005: m5,
    EUW1_7000000006: m6,
  } as Record<string, unknown>,
};

const ZERO: ChampionTraits = {
  engage: 0, peel: 0, poke: 0, waveclear: 0, splitpush: 0, pick: 0, teamfight: 0,
  early: 0, late: 0, mobility: 0, frontline: 0, cc: 0, sustain: 0, objective: 0,
};

const CHAMPS: [string, number, string, Role[]][] = [
  ['Ahri', 103, 'Ahri', ['MID']],
  ['Thresh', 412, 'Thresh', ['SUPPORT']],
  ['MonkeyKing', 62, 'Wukong', ['JUNGLE', 'TOP']],
  ['Fiddlesticks', 9, 'Fiddlesticks', ['JUNGLE']],
  ['Lux', 99, 'Lux', ['SUPPORT', 'MID']],
  ['Garen', 86, 'Garen', ['TOP']],
  ['Jinx', 222, 'Jinx', ['BOTTOM']],
  ['Leona', 89, 'Leona', ['SUPPORT']],
  ['Darius', 122, 'Darius', ['TOP']],
  ['LeeSin', 64, 'Lee Sin', ['JUNGLE']],
];

export function fakeCatalog(): ChampionCatalog {
  const all: ChampionInfo[] = CHAMPS.map(([id, key, name, roles]) => ({
    id, key, name, roles, title: '', image_url: '', tags: [], archetype: '', damage_type: 'AD',
    region: '', groups: [], traits: { ...ZERO },
  }));
  return {
    get: (id) => all.find((c) => c.id === id),
    byKey: (key) => all.find((c) => c.key === key),
    all: () => all,
  };
}

/** Engine double: records calls (vi.fn) with simple deterministic results. */
export function fakeEngine() {
  return {
    buildCatalog: vi.fn(() => fakeCatalog()),
    listArchetypes: vi.fn(() => [
      { key: 'mage', label: 'Mage', description: 'Dégâts magiques' },
      { key: 'tank', label: 'Tank', description: 'Encaisse' },
    ]),
    listThemes: vi.fn(() => [{ key: 'engage', label: 'Engage', kind: 'playstyle', description: 'Fonce' }]),
    computePool: vi.fn((m: { champion_id: string }[], _r: unknown, manual: { champion_id: string; comfort: number }[]) => {
      const out = new Map<string, PoolEntry>();
      for (const e of manual) out.set(e.champion_id, { champion_id: e.champion_id, comfort: e.comfort, desire: 0.5, sources: ['manual'] });
      for (const e of m) if (!out.has(e.champion_id)) out.set(e.champion_id, { champion_id: e.champion_id, comfort: 0.8, desire: 0.5, sources: ['mastery'] });
      return [...out.values()];
    }),
    generateCompositions: vi.fn(() => []),
    buildGamePlan: vi.fn(() => ({ identity: 'Compo test' })),
    buildMatchupPlan: vi.fn(() => ({ enemy_identity: 'Adversaire test' })),
  };
}

export function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

export function installWindow(apiBase = '', storage: Storage = memoryStorage()) {
  const win = {
    APP_CONFIG: { apiBase },
    localStorage: storage,
    dispatchEvent: vi.fn(() => true),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', win);
  return win;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export interface FakeServerOptions {
  riotConfigured?: boolean;
  password?: string;
}

/**
 * In-memory PHP API (store + meta + Riot proxy backed by the fixtures). Data Dragon is offline.
 * Returns the fetch mock plus the stored collections.
 */
export function fakeServer(opts: FakeServerOptions = {}) {
  const db: Record<string, Map<string, Record<string, unknown>>> = {
    players: new Map(),
    teams: new Map(),
    saved: new Map(),
  };
  const riotCalls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://site.test');
    if (url.hostname === 'ddragon.leagueoflegends.com') return json({ detail: 'offline' }, 503);
    const route = url.searchParams.get('r') ?? '';
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (route === 'meta') {
      return json({
        riot_configured: Boolean(opts.riotConfigured),
        platform: 'euw1',
        region: 'europe',
        platforms: ['euw1', 'eun1', 'na1', 'kr'],
        password_required: Boolean(opts.password),
        storage_ok: true,
      });
    }
    if (opts.password && headers['X-App-Password'] !== opts.password) {
      return json({ detail: 'Mot de passe requis ou incorrect.' }, 401);
    }
    const storeMatch = /^store\/(players|teams|saved)(?:\/([A-Za-z0-9-]{1,64}))?$/.exec(route);
    if (storeMatch) {
      const coll = db[storeMatch[1]];
      const id = storeMatch[2];
      if (!id && method === 'GET') return json([...coll.values()]);
      if (id && method === 'PUT') {
        const doc = { ...JSON.parse(String(init?.body)), id };
        coll.set(id, doc);
        return json(doc);
      }
      if (id && method === 'DELETE') {
        if (!coll.delete(id)) return json({ detail: 'Document introuvable.' }, 404);
        return json(null, 204);
      }
    }
    if (route.startsWith('riot/')) {
      riotCalls.push(`${route}?${url.searchParams.toString()}`);
      if (!opts.riotConfigured) return json({ detail: 'Clé API Riot non configurée.' }, 400);
      const p = url.searchParams;
      switch (route) {
        case 'riot/account':
          return p.get('gameName') === 'Ghost' ? json({ detail: 'Introuvable chez Riot.' }, 404) : json(FIXTURES.account);
        case 'riot/summoner':
          return json(FIXTURES.summoner);
        case 'riot/league':
          return json(FIXTURES.leagueEntries);
        case 'riot/masteries':
          return json(FIXTURES.masteries);
        case 'riot/match-ids':
          return json(FIXTURES.matchIds);
        case 'riot/match': {
          const m = FIXTURES.matches[p.get('id') ?? ''];
          return m ? json(m) : json({ detail: 'Introuvable chez Riot.' }, 404);
        }
      }
    }
    return json({ detail: 'Route inconnue.' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, db, riotCalls };
}

/** Awaits a promise expected to reject with an ApiError and returns that error. */
export async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}
