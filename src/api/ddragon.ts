// Data Dragon, fetched directly by the browser, cached in localStorage for 6 h.
import { buildCatalog, type ChampionCatalog, type DDragonChampion } from '../engine';

export const DDRAGON_BASE = 'https://ddragon.leagueoflegends.com';
export const OFFLINE_VERSION = 'offline';
export const DDRAGON_LOCALE = 'fr_FR';
export const CACHE_TTL_MS = 6 * 3600 * 1000;
const CACHE_KEY = `lolhelper:ddragon:${DDRAGON_LOCALE}`;
const TIMEOUT_MS = 8000;

export interface DDragonData {
  version: string;
  champions: DDragonChampion[];
}

interface CacheEntry extends DDragonData {
  fetched_at: number;
}

export function profileIconUrl(version: string, iconId: number | null | undefined): string {
  if (iconId === null || iconId === undefined || !version || version === OFFLINE_VERSION) return '';
  return `${DDRAGON_BASE}/cdn/${version}/img/profileicon/${iconId}.png`;
}

// In-memory copy, used when localStorage is unavailable or full.
let memoryCache: CacheEntry | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readCache(): CacheEntry | null {
  try {
    const raw = storage()?.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CacheEntry;
      if (parsed && typeof parsed.version === 'string' && Array.isArray(parsed.champions) && parsed.champions.length) {
        return parsed;
      }
    }
  } catch {
    /* corrupted or inaccessible: ignore */
  }
  return memoryCache;
}

function writeCache(entry: CacheEntry): void {
  memoryCache = entry;
  try {
    storage()?.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Quota exceeded / storage blocked: keep the in-memory copy only.
    try {
      storage()?.removeItem(CACHE_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** Keep only the fields the engine uses (smaller localStorage footprint). */
function slim(c: DDragonChampion): DDragonChampion {
  return { id: c.id, key: c.key, name: c.name, title: c.title, tags: c.tags, info: c.info, image: c.image };
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Latest version + champion.json "data" values. Never rejects: stale cache, then offline. */
export async function loadDDragon(now: number = Date.now()): Promise<DDragonData> {
  const cached = readCache();
  if (cached && now - cached.fetched_at < CACHE_TTL_MS) {
    return { version: cached.version, champions: cached.champions };
  }
  try {
    const versions = await fetchJson(`${DDRAGON_BASE}/api/versions.json`);
    const version = Array.isArray(versions) ? versions[0] : undefined;
    if (typeof version !== 'string' || !version) throw new Error('versions.json invalide');
    if (cached && cached.version === version) {
      writeCache({ ...cached, fetched_at: now });
      return { version, champions: cached.champions };
    }
    const data = (await fetchJson(`${DDRAGON_BASE}/cdn/${version}/data/${DDRAGON_LOCALE}/champion.json`)) as {
      data?: Record<string, DDragonChampion>;
    };
    const champions = data && data.data ? Object.values(data.data).map(slim) : [];
    if (!champions.length) throw new Error('champion.json vide');
    writeCache({ version, champions, fetched_at: now });
    return { version, champions };
  } catch {
    if (cached) return { version: cached.version, champions: cached.champions };
    return { version: OFFLINE_VERSION, champions: [] };
  }
}

export interface LoadedCatalog {
  version: string;
  catalog: ChampionCatalog;
}

let catalogPromise: Promise<LoadedCatalog> | null = null;

/** The champion catalog shared by the whole app (built once per page load). */
export function getCatalog(): Promise<LoadedCatalog> {
  if (!catalogPromise) {
    catalogPromise = loadDDragon()
      .then(({ version, champions }) => ({ version, catalog: buildCatalog(champions, version) }))
      .catch((err) => {
        catalogPromise = null; // allow a retry
        throw err;
      });
  }
  return catalogPromise;
}

/** Tests only. */
export function resetDDragonForTests(): void {
  catalogPromise = null;
  memoryCache = null;
}
