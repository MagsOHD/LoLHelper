// Thin fetch wrapper around the PHP API (public/api/index.php?r=<route>).
import { loadLocal, saveLocal } from '../lib/storage';

export class ApiError extends Error {
  status: number;
  /** Seconds to wait before retrying (only set on 429 responses carrying Retry-After). */
  retryAfter?: number;
  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

declare global {
  interface Window {
    APP_CONFIG?: { apiBase?: string };
  }
}

const PASSWORD_KEY = 'password';
export const AUTH_REQUIRED_EVENT = 'lolhelper:auth-required';

export function getPassword(): string {
  return loadLocal<string>(PASSWORD_KEY, '');
}

export function setPassword(value: string): void {
  saveLocal(PASSWORD_KEY, value || null);
}

/** Base URL of the site hosting api/index.php ("" = next to the page, works in a sub-folder). Set in public/config.js. */
export function apiBase(): string {
  const base = typeof window !== 'undefined' ? window.APP_CONFIG?.apiBase : undefined;
  return (base || '').trim().replace(/\/+$/, '');
}

export type Params = Record<string, string | number | undefined | null>;

export function apiUrl(route: string, params: Params = {}): string {
  const qs = new URLSearchParams({ r: route });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.append(k, String(v));
  }
  const base = apiBase();
  return `${base ? `${base}/` : ''}api/index.php?${qs.toString()}`;
}

function extractDetail(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const detail = (data as { detail?: unknown }).detail;
  return typeof detail === 'string' && detail ? detail : null;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  params?: Params;
  body?: unknown;
  /** Extra request headers (e.g. X-Admin-Password). */
  headers?: Record<string, string>;
  /** Fetch cache mode ("reload" bypasses a Cache-Control max-age kept by the browser). */
  cache?: RequestCache;
  /**
   * Whether a 401 means "shared app password missing/wrong" (dispatches AUTH_REQUIRED_EVENT, the
   * default). A function receives the French detail and decides (admin password routes).
   */
  authEvent?: boolean | ((detail: string | null) => boolean);
}

/** Calls the PHP API. Resolves with the parsed JSON body (undefined for 204), throws ApiError. */
export async function backendRequest<T>(method: Method, route: string, options: RequestOptions = {}): Promise<T> {
  const { params, body, cache, authEvent = true } = options;
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers ?? {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const password = getPassword();
  if (password) headers['X-App-Password'] = password;

  let res: Response;
  try {
    const init: RequestInit = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    if (cache) init.cache = cache;
    res = await fetch(apiUrl(route, params), init);
  } catch {
    throw new ApiError('Impossible de joindre le serveur. Vérifie ta connexion internet.', 0);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  let invalidJson = false;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      invalidJson = true;
    }
  }
  const appAuthFailed = res.status === 401 && (typeof authEvent === 'function' ? authEvent(extractDetail(data)) : authEvent);
  if (appAuthFailed && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }
  if (!res.ok) {
    const fallback =
      res.status === 401
        ? 'Mot de passe requis ou incorrect.'
        : res.status === 404 && invalidJson
          ? "L'API du site est introuvable (dossier api/ manquant sur l'hébergement ?)."
          : `Erreur ${res.status} du serveur.`;
    throw new ApiError(
      extractDetail(data) ?? fallback,
      res.status,
      res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : undefined,
    );
  }
  if (invalidJson) {
    // 200 with a non-JSON body: typically PHP not executed or an HTML error page.
    throw new ApiError('Réponse inattendue du serveur (PHP est-il actif sur l’hébergement ?).', 502);
  }
  return data as T;
}

// ---- document store -------------------------------------------------------------------------

export type Collection = 'players' | 'teams' | 'saved' | 'drafts';

/** Set once the server answered 405 to GET store/<collection>/<id> (single-document read not deployed). */
let singleGetUnsupported = false;

/** Tests only. */
export function resetStoreForTests(): void {
  singleGetUnsupported = false;
}

export const store = {
  list<T>(collection: Collection): Promise<T[]> {
    return backendRequest<T[]>('GET', `store/${collection}`).then((d) => (Array.isArray(d) ? d : []));
  },
  /**
   * One document, null when it does not exist. Uses GET store/<c>/<id> when the server supports it,
   * else (405) falls back to listing the collection — remembered for the rest of the session.
   */
  async get<T extends { id: string }>(collection: Collection, id: string): Promise<T | null> {
    if (!singleGetUnsupported) {
      try {
        const doc = await backendRequest<T | null>('GET', `store/${collection}/${id}`);
        return doc && typeof doc === 'object' ? doc : null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        if (!(err instanceof ApiError) || err.status !== 405) throw err;
        singleGetUnsupported = true;
      }
    }
    const docs = await store.list<T>(collection);
    return docs.find((d) => d && d.id === id) ?? null;
  },
  put<T extends { id: string }>(collection: Collection, doc: T): Promise<T> {
    return backendRequest<T>('PUT', `store/${collection}/${doc.id}`, { body: doc });
  },
  /** false when the document did not exist. */
  async remove(collection: Collection, id: string): Promise<boolean> {
    try {
      await backendRequest<void>('DELETE', `store/${collection}/${id}`);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return false;
      throw err;
    }
  },
};
