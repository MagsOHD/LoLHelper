// Riot IDs shown by the League client (Clash, tournament and custom champion selects) -> Riot API
// puuids. The LCU only gives raw puuids, which are NOT the (per-key encrypted) puuids of the public
// Riot API, so an enemy is identified by the Riot ID the client itself shows, resolved once per page
// load through riot/account (shared rate limiter, at most MAX_RIOT_ID_LOOKUPS calls per session).
// Framework-agnostic (subscribe/getVersion), the React hooks only subscribe.
import { ApiError } from './backend';
import type { EnemyPlayerProfile } from './types';
import type { RiotAccount } from './riot';

/** Riot ID as sent by the companion (payload v2): only when the client shows the name. */
export interface CompanionRiotId {
  game_name: string;
  tag_line: string;
}

export const MAX_GAME_NAME = 32;
export const MAX_TAG_LINE = 8;
/** Riot ID lookups per page load (two full enemy teams plus retries fit well below). */
export const MAX_RIOT_ID_LOOKUPS = 25;
/** A lookup that failed for another reason than "unknown Riot ID" may be retried after this. */
export const RIOT_ID_RETRY_MS = 60_000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PUUID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const len = (s: string) => Array.from(s).length;

/** Valid, visible Riot ID ({game_name, tag_line}, trimmed) or null (hidden, junk, too long). */
export function riotIdOf(v: unknown): CompanionRiotId | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  if (typeof raw.game_name !== 'string' || typeof raw.tag_line !== 'string') return null;
  const game_name = raw.game_name.trim();
  const tag_line = raw.tag_line.trim().replace(/^#+/, '');
  if (!game_name || !tag_line || len(game_name) > MAX_GAME_NAME || len(tag_line) > MAX_TAG_LINE) return null;
  if (CONTROL.test(game_name) || CONTROL.test(tag_line) || tag_line.includes('#')) return null;
  return { game_name, tag_line };
}

/** "Nom#TAG". */
export function riotIdText(id: CompanionRiotId): string {
  return `${id.game_name}#${id.tag_line}`;
}

/** Cache key: Riot IDs are global and case-insensitive. */
export function riotIdKey(id: CompanionRiotId | string): string {
  return (typeof id === 'string' ? id : riotIdText(id)).trim().toLowerCase();
}

export type AccountLookup = (gameName: string, tagLine: string, platform: string) => Promise<RiotAccount>;

export type RiotIdResolution =
  | { state: 'pending'; riot_id: string }
  | { state: 'done'; riot_id: string; puuid: string }
  | { state: 'missing'; riot_id: string; note: string }
  | { state: 'error'; riot_id: string; note: string; at: number; retry: boolean };

export interface RiotIdResolverOptions {
  maxLookups?: number;
  retryMs?: number;
  now?: () => number;
}

const isMissing = (err: unknown) => err instanceof ApiError && (err.status === 404 || err.status === 422);

export class RiotIdResolver {
  private entries = new Map<string, RiotIdResolution>();
  private inflight = new Map<string, Promise<string | null>>();
  /** puuid -> Riot ID with Riot's spelling (display of client-revealed profiles). */
  private names = new Map<string, string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private readonly o: Required<RiotIdResolverOptions>;
  /** riot/account calls made this session. */
  lookups = 0;

  constructor(private readonly lookup: AccountLookup, options: RiotIdResolverOptions = {}) {
    this.o = {
      maxLookups: options.maxLookups ?? MAX_RIOT_ID_LOOKUPS,
      retryMs: options.retryMs ?? RIOT_ID_RETRY_MS,
      now: options.now ?? Date.now,
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Changes on every resolution (useSyncExternalStore snapshot). */
  getVersion = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  private set(key: string, entry: RiotIdResolution): void {
    this.entries.set(key, entry);
    if (entry.state === 'done') this.names.set(entry.puuid, entry.riot_id);
    this.emit();
  }

  status(id: CompanionRiotId | string): RiotIdResolution | null {
    return this.entries.get(riotIdKey(id)) ?? null;
  }

  /** Resolved Riot API puuid, null while unknown / pending / not found. */
  peek(id: CompanionRiotId | string): string | null {
    const e = this.entries.get(riotIdKey(id));
    return e?.state === 'done' ? e.puuid : null;
  }

  /** Riot ID (Riot's spelling) of a puuid resolved or seeded here, null otherwise. */
  riotIdFor(puuid: string | null | undefined): string | null {
    return puuid ? this.names.get(puuid) ?? null : null;
  }

  /** Profiles already known with their Riot ID (shared document): resolved without any call. */
  seed(profiles: EnemyPlayerProfile[] | undefined): void {
    let changed = false;
    for (const p of profiles ?? []) {
      if (!p?.riot_id || !p.puuid || !PUUID_RE.test(p.puuid) || !p.riot_id.includes('#')) continue;
      const key = riotIdKey(p.riot_id);
      if (this.entries.get(key)?.state === 'done') continue;
      this.entries.set(key, { state: 'done', riot_id: p.riot_id, puuid: p.puuid });
      this.names.set(p.puuid, p.riot_id);
      changed = true;
    }
    if (changed) this.emit();
  }

  /**
   * The Riot API puuid of this Riot ID: cached, shared while in flight, else one riot/account call
   * (budget permitting). Never rejects: null = still anonymous (not found, failed, budget spent).
   */
  resolve(id: CompanionRiotId, platform: string): Promise<string | null> {
    const key = riotIdKey(id);
    const text = riotIdText(id);
    const cur = this.entries.get(key);
    if (cur?.state === 'done') return Promise.resolve(cur.puuid);
    if (cur?.state === 'missing') return Promise.resolve(null);
    const running = this.inflight.get(key);
    if (running) return running;
    if (cur?.state === 'error' && (!cur.retry || this.o.now() - cur.at < this.o.retryMs)) return Promise.resolve(null);
    if (this.lookups >= this.o.maxLookups) {
      this.set(key, {
        state: 'error',
        riot_id: text,
        note: `Trop de Riot ID à identifier pendant cette session : ${text} reste anonyme (rechargez la page pour réessayer).`,
        at: this.o.now(),
        retry: false,
      });
      return Promise.resolve(null);
    }
    this.lookups += 1;
    this.set(key, { state: 'pending', riot_id: text });
    const job = (async (): Promise<string | null> => {
      try {
        const account = await this.lookup(id.game_name, id.tag_line, platform);
        const puuid = typeof account?.puuid === 'string' && PUUID_RE.test(account.puuid) ? account.puuid : '';
        if (!puuid) throw new ApiError(`Riot ID introuvable : ${text}.`, 404);
        const riot_id = `${account.gameName || id.game_name}#${account.tagLine || id.tag_line}`;
        this.set(key, { state: 'done', riot_id, puuid });
        return puuid;
      } catch (err) {
        if (isMissing(err)) {
          this.set(key, { state: 'missing', riot_id: text, note: `Riot ID introuvable : ${text}. Cet adversaire reste anonyme.` });
        } else {
          this.set(key, {
            state: 'error',
            riot_id: text,
            note: `Impossible d’identifier ${text} pour l’instant (${err instanceof Error ? err.message : 'erreur inattendue'}) : nouvel essai dans une minute.`,
            at: this.o.now(),
            retry: true,
          });
        }
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }

  /** French notes (not found / failed) about these Riot IDs, one per Riot ID. */
  notesFor(ids: CompanionRiotId[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const key = riotIdKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const e = this.entries.get(key);
      if (e && (e.state === 'missing' || e.state === 'error')) out.push(e.note);
    }
    return out;
  }
}
