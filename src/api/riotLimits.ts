// Application limits of the site's Riot key as recorded by the PHP gate (GET r=riot-limits), shown
// on the Méta page; also seeds the browser limiter before any proxied response was seen.
import { ApiError, backendRequest } from './backend';
import { BROWSER_SHARE, getTransport, type Limits } from './riot';

export interface RiotKeyWindow {
  limit: number;
  /** Seconds. */
  window: number;
  /** Requests counted in the window when recorded. */
  count: number;
  /** ISO date of the record, null = assumed (no Riot answer seen yet). */
  at: string | null;
}

export interface RiotKeyLimits {
  app: RiotKeyWindow[];
  /** Share of each window the meta collector may use (0.6). */
  collector_share: number;
  /** Share of each window user-facing calls may use before a local 429 (0.95). */
  user_share: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const share = (v: unknown, d: number) => (typeof v === 'number' && v > 0 && v <= 1 ? v : d);

export function normalizeRiotLimits(raw: unknown): RiotKeyLimits | null {
  if (!isObj(raw) || !Array.isArray(raw.app)) return null;
  const app: RiotKeyWindow[] = [];
  for (const w of raw.app) {
    if (!isObj(w)) continue;
    const limit = pos(w.limit);
    const window = pos(w.window);
    if (!limit || !window) continue;
    app.push({
      limit: Math.trunc(limit),
      window: Math.trunc(window),
      count: Math.max(0, Math.trunc(typeof w.count === 'number' && Number.isFinite(w.count) ? w.count : 0)),
      at: typeof w.at === 'string' && w.at ? w.at : null,
    });
  }
  if (!app.length) return null;
  app.sort((a, b) => a.window - b.window);
  return { app, collector_share: share(raw.collector_share, 0.6), user_share: share(raw.user_share, 0.95) };
}

/** "s", "10 s", "2 min", "1 h". */
export function windowLabel(seconds: number): string {
  if (seconds === 1) return 's';
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

const nf = (n: number) => n.toLocaleString('fr-FR');
const pct = (x: number) => `${Math.round(x * 100)} %`;

/** "Limite de la clé : 20 requêtes / s · 100 requêtes / 2 min · collecte automatique à 60 % de la limite". */
export function formatKeyLimits(l: RiotKeyLimits): string {
  const windows = l.app.map((w) => `${nf(w.limit)} requêtes / ${windowLabel(w.window)}`).join(' · ');
  return `Limite de la clé : ${windows} · collecte automatique à ${pct(l.collector_share)} de la limite`;
}

/** Secondary line: how the key is shared, whether the values are measured. */
export function formatKeyUsage(l: RiotKeyLimits, browserShare: number = BROWSER_SHARE): string {
  const longest = l.app[l.app.length - 1];
  const measured = l.app.some((w) => w.at);
  const usage = measured ? `Dernier relevé : ${nf(longest.count)}/${nf(longest.limit)} sur ${windowLabel(longest.window)}. ` : 'Valeurs par défaut (aucune réponse Riot reçue pour l’instant). ';
  return `${usage}Le site répond « limite atteinte » au-delà de ${pct(l.user_share)} ; chaque navigateur vise ${pct(browserShare)} au plus.`;
}

/** React Query key of r=riot-limits (refreshed after each collection pass). */
export const RIOT_LIMITS_KEY = ['riot-limits'] as const;
/** Poll of the key limits while a collection runs (this tab's loop or the server's cron). */
export const LIMITS_POLL_MS = 15_000;

export function limitsRefetchInterval(collecting: boolean): number | false {
  return collecting ? LIMITS_POLL_MS : false;
}

/** Limits -> limiter format. */
export const toLimits = (l: RiotKeyLimits): Limits => l.app.map((w) => [w.limit, w.window * 1000] as const);

/** r=riot-limits; null when the route is not deployed. Seeds the shared limiter with the measured limits. */
export async function fetchRiotLimits(): Promise<RiotKeyLimits | null> {
  try {
    const raw = await backendRequest<unknown>('GET', 'riot-limits', { cache: 'no-store' });
    const limits = normalizeRiotLimits(raw);
    if (limits && limits.app.some((w) => w.at)) getTransport().limiter.observe(toLimits(limits), []);
    return limits;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return null;
    throw err;
  }
}
