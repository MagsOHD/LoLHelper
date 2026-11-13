// Manual meta collection from the browser: a loop of bounded server passes (POST r=meta-collect).
// The loop is pure (injected collect/sleep) so its stop rules are tested with fake timers; one
// module-level controller makes sure a tab never runs two loops, even across page changes.
import type { CollectResult, MetaPatchInfo } from './meta';
import { ApiError } from './backend';

/** Wait before retrying when the collector lock is held (hourly cron or another click). */
export const BUSY_RETRY_MS = 20_000;
/** Give up after this many busy answers in a row (~30 min, longer than a cron run). */
export const MAX_BUSY_RETRIES = 90;
/** Consecutive "tour complet" passes that end the loop (every seed visited, nothing left to read). */
export const FULL_ROUNDS_TO_STOP = 2;
/** Wait after a "riot_limit" stop when the server gives no Retry-After. */
export const RIOT_LIMIT_DEFAULT_WAIT_S = 5;
/** Longest wait honoured after a "riot_limit" stop. */
export const RIOT_LIMIT_MAX_WAIT_S = 120;
/** Give up after this many "riot_limit" passes in a row (the key is saturated by something else). */
export const MAX_RIOT_LIMIT_WAITS = 30;

export type StopKind = 'budget' | 'complete' | 'riot_limit' | 'riot_key' | 'disabled' | 'no_seeds' | 'riot_down' | 'other';

/** Collector stop value (code or the collector's French reason) -> kind. */
export function classifyStop(stop: string): StopKind {
  const s = stop.trim().toLowerCase();
  if (s.startsWith('budget')) return 'budget';
  if (s === 'complete' || s === 'full_round' || s.includes('tour complet')) return 'complete';
  if (s === 'riot_limit' || s.includes('429') || s.includes('limite riot') || s.includes('pause demand')) return 'riot_limit';
  if (s === 'riot_key' || s.includes('clé api') || s.includes('cle api')) return 'riot_key';
  if (s === 'disabled' || s.includes('désactiv')) return 'disabled';
  if (s === 'no_seeds' || s.includes('aucun joueur')) return 'no_seeds';
  if (s === 'riot_down' || s.includes('indisponible')) return 'riot_down';
  return 'other';
}

/** French label of a stop value. */
export function stopLabel(stop: string, retryAfter?: number): string {
  switch (classifyStop(stop)) {
    case 'budget': return 'temps de la passe écoulé (normal, on enchaîne)';
    case 'complete': return 'tour complet des joueurs suivis';
    case 'riot_limit': {
      const wait = retryAfter ? ` — réessaie dans ${formatWait(retryAfter)}` : '';
      return `limite de requêtes Riot atteinte${wait}`;
    }
    case 'riot_key': return 'clé API Riot refusée ou absente : renouvelle-la dans config.php';
    case 'disabled': return 'collecte désactivée sur le serveur';
    case 'no_seeds': return 'aucun joueur trouvé (ligues indisponibles ?)';
    case 'riot_down': return 'serveurs Riot indisponibles, réessaie plus tard';
    default: return stop || 'raison inconnue';
  }
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  return `${Math.round(seconds / 60)} min`;
}

export type CollectPhase = 'idle' | 'running' | 'waiting' | 'stopping' | 'done' | 'stopped' | 'error';

export interface CollectProgress {
  phase: CollectPhase;
  /** Completed server passes. */
  passes: number;
  requests: number;
  new_matches: number;
  /** Patch and games on it after the last pass. */
  patch: string | null;
  games: number | null;
  patches: MetaPatchInfo[];
  /** Raw stop value of the last pass. */
  last_stop: string | null;
  full_rounds: number;
  busy_retries: number;
  /** Epoch ms of the next attempt while waiting (lock held or Riot pause). */
  retry_at: number | null;
  /** Why the loop is waiting: collector lock held ('busy') or Riot asked for a pause ('riot_limit'). */
  wait_reason: 'busy' | 'riot_limit' | null;
  /** Consecutive passes that stopped on the Riot limit. */
  riot_waits: number;
  /** French status line. */
  message: string;
  /** Set when the loop ended on an error (French). */
  error: string | null;
  /** HTTP status of that error (401 = wrong admin password). */
  error_status: number | null;
}

export const IDLE_PROGRESS: CollectProgress = {
  phase: 'idle', passes: 0, requests: 0, new_matches: 0, patch: null, games: null, patches: [], last_stop: null,
  full_rounds: 0, busy_retries: 0, retry_at: null, wait_reason: null, riot_waits: 0, message: '', error: null, error_status: null,
};

export interface LoopOptions {
  collect: () => Promise<CollectResult>;
  signal: AbortSignal;
  onProgress?: (p: CollectProgress) => void;
  /** Called after each pass that added matches (refresh cached meta). */
  onNewData?: (p: CollectProgress) => void;
  /** Called after every completed pass, whatever its stop (refresh the key limits and the status). */
  onPass?: (p: CollectProgress) => void;
  busyRetryMs?: number;
  maxBusyRetries?: number;
  maxRiotWaits?: number;
  now?: () => number;
}

/** Resolves after `ms`, or early (false) when the signal aborts. Uses setTimeout (fake-timer friendly). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Seconds to wait after a "riot_limit" pass (server's Retry-After, default 5 s, capped). */
export function riotLimitWait(retryAfter: number | undefined): number {
  const s = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : RIOT_LIMIT_DEFAULT_WAIT_S;
  return Math.min(RIOT_LIMIT_MAX_WAIT_S, Math.max(1, Math.ceil(s)));
}

/**
 * Runs passes until the user aborts, FULL_ROUNDS_TO_STOP "tour complet" in a row, a stop other than
 * budget/complete/Riot limit (key, disabled…) or an error. Busy answers wait `busyRetryMs` then
 * retry; a "riot_limit" pass waits its retry_after (countdown in `retry_at`) then continues. An
 * in-flight pass is never cancelled (the server finishes it anyway): abort takes effect when it returns.
 */
export async function runCollectLoop(opts: LoopOptions): Promise<CollectProgress> {
  const busyRetryMs = opts.busyRetryMs ?? BUSY_RETRY_MS;
  const maxBusy = opts.maxBusyRetries ?? MAX_BUSY_RETRIES;
  const now = opts.now ?? Date.now;
  const maxRiotWaits = opts.maxRiotWaits ?? MAX_RIOT_LIMIT_WAITS;
  let p: CollectProgress = { ...IDLE_PROGRESS, phase: 'running', message: 'Passe 1 en cours sur le serveur…' };
  const emit = (patch: Partial<CollectProgress>) => {
    p = { ...p, ...patch };
    opts.onProgress?.(p);
    return p;
  };
  const userStop = () => emit({ phase: 'stopped', retry_at: null, wait_reason: null, message: `Collecte arrêtée après ${p.passes} passe${p.passes > 1 ? 's' : ''}.` });
  emit({});

  for (;;) {
    if (opts.signal.aborted) return userStop();
    let res: CollectResult;
    try {
      res = await opts.collect();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      const msg = err instanceof Error ? err.message : 'Erreur inattendue pendant la collecte.';
      return emit({ phase: 'error', retry_at: null, error: msg, error_status: status, message: 'Collecte interrompue.' });
    }

    if (res.status === 'busy') {
      if (p.busy_retries >= maxBusy) {
        return emit({
          phase: 'error', retry_at: null, error_status: null,
          error: 'Le serveur est toujours occupé par une autre collecte. Réessaie plus tard.',
          message: 'Collecte interrompue.',
        });
      }
      if (opts.signal.aborted) return userStop();
      emit({
        phase: 'waiting', busy_retries: p.busy_retries + 1, retry_at: now() + busyRetryMs, wait_reason: 'busy',
        message: `Une collecte tourne déjà sur le serveur (cron horaire ou autre clic). Nouvel essai dans ${Math.round(busyRetryMs / 1000)} s…`,
      });
      const slept = await abortableSleep(busyRetryMs, opts.signal);
      if (!slept) return userStop();
      emit({ phase: 'running', retry_at: null, wait_reason: null, message: `Passe ${p.passes + 1} en cours sur le serveur…` });
      continue;
    }

    const kind = classifyStop(res.stop);
    // A Riot pause neither confirms nor breaks a run of full rounds.
    const fullRounds = kind === 'complete' ? p.full_rounds + 1 : kind === 'riot_limit' ? p.full_rounds : 0;
    emit({
      passes: p.passes + 1,
      requests: p.requests + res.requests,
      new_matches: p.new_matches + res.new_matches,
      patch: res.patch ?? p.patch,
      games: res.patch ? res.games : p.games,
      patches: res.patches.length ? res.patches : p.patches,
      last_stop: res.stop,
      full_rounds: fullRounds,
      busy_retries: 0,
      riot_waits: kind === 'riot_limit' ? p.riot_waits + 1 : 0,
    });
    opts.onPass?.(p);
    if (res.new_matches > 0) opts.onNewData?.(p);

    if (kind === 'complete' && fullRounds >= FULL_ROUNDS_TO_STOP) {
      return emit({ phase: 'done', message: 'Tour complet deux fois de suite : toutes les parties récentes sont collectées.' });
    }
    if (kind === 'riot_limit') {
      if (p.riot_waits >= maxRiotWaits) {
        return emit({
          phase: 'error', retry_at: null, wait_reason: null, error_status: null,
          error: `Arrêt du collecteur : limite de requêtes Riot atteinte ${p.riot_waits} passes de suite. Réessaie plus tard.`,
          message: 'Collecte interrompue.',
        });
      }
      if (opts.signal.aborted) return userStop();
      const wait = riotLimitWait(res.retry_after);
      emit({
        phase: 'waiting', retry_at: now() + wait * 1000, wait_reason: 'riot_limit',
        message: `Limite de requêtes Riot atteinte : la collecte reprend dans ${wait} s…`,
      });
      const slept = await abortableSleep(wait * 1000, opts.signal);
      if (!slept) return userStop();
      emit({ phase: 'running', retry_at: null, wait_reason: null, message: `Passe ${p.passes + 1} en cours sur le serveur…` });
      continue;
    }
    if (kind !== 'budget' && kind !== 'complete') {
      return emit({
        phase: 'error', error: `Arrêt du collecteur : ${(res.message || stopLabel(res.stop, res.retry_after)).replace(/\.$/, '')}.`,
        error_status: null,
        message: 'Collecte interrompue.',
      });
    }
    if (opts.signal.aborted) return userStop();
    emit({ phase: 'running', message: `Passe ${p.passes + 1} en cours sur le serveur…` });
  }
}

// ---- tab-wide controller ---------------------------------------------------------------------

type Listener = () => void;

export class CollectController {
  private progress: CollectProgress = IDLE_PROGRESS;
  private abort: AbortController | null = null;
  private listeners = new Set<Listener>();
  private onNewData: (() => void) | null = null;
  private onPass: (() => void) | null = null;

  constructor(
    private readonly collect: (password: string) => Promise<CollectResult>,
    private readonly loopDefaults: Partial<Pick<LoopOptions, 'busyRetryMs' | 'maxBusyRetries' | 'maxRiotWaits'>> = {},
  ) {}

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): CollectProgress => this.progress;

  get running(): boolean {
    return this.abort !== null;
  }

  /** Callback run after each pass that added matches (cache invalidation). */
  setOnNewData(fn: (() => void) | null): void {
    this.onNewData = fn;
  }

  /** Callback run after every pass (key limits / status refresh). */
  setOnPass(fn: (() => void) | null): void {
    this.onPass = fn;
  }

  /** Starts a loop; false (no-op) when one is already running in this tab. */
  start(password: string): boolean {
    if (this.abort) return false;
    const abort = new AbortController();
    this.abort = abort;
    void runCollectLoop({
      ...this.loopDefaults,
      collect: () => this.collect(password),
      signal: abort.signal,
      onProgress: (p) => this.set(abort.signal.aborted && (p.phase === 'running' || p.phase === 'waiting')
        ? { ...p, phase: 'stopping', message: 'Arrêt demandé : la passe en cours se termine…' }
        : p),
      onNewData: () => this.onNewData?.(),
      onPass: () => this.onPass?.(),
    }).finally(() => {
      this.abort = null;
      this.set({ ...this.progress });
    });
    return true;
  }

  /** Asks the loop to stop (immediately while waiting, after the in-flight pass otherwise). */
  stop(): void {
    if (!this.abort || this.abort.signal.aborted) return;
    this.abort.abort();
    if (this.progress.phase === 'running') {
      this.set({ ...this.progress, phase: 'stopping', message: 'Arrêt demandé : la passe en cours se termine…' });
    }
  }

  /** Clears a finished loop's report. */
  reset(): void {
    if (!this.abort) this.set(IDLE_PROGRESS);
  }

  private set(p: CollectProgress): void {
    this.progress = p;
    for (const l of this.listeners) l();
  }
}
