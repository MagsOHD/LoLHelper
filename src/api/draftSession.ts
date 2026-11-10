// Shared draft session: local edits saved to the store (debounced), the shared document polled so
// friends see the same draft (last write wins), companion data polled and merged when fresh.
// Framework-agnostic (the React hook only subscribes), timers injectable through vi fake timers.
import {
  adoptRemote,
  coverageOf,
  draftContentKey,
  inferPhase,
  isLiveFresh,
  mergeCompanion,
  normalizeDraft,
  nowIso,
  type Coverage,
  type DraftPath,
  type LiveDraft,
  type LiveMapping,
} from './draft';
import { ApiError } from './backend';
import type { DraftState } from './types';

export const SAVE_DELAY_MS = 400;
export const REMOTE_POLL_MS = 3000;
export const LIVE_POLL_MS = 2000;
/** After a live-draft error (route missing, server down…), wait this long before asking again. */
export const LIVE_ERROR_BACKOFF_MS = 15_000;
/** Saving failed: retry after this delay. */
export const SAVE_RETRY_MS = 5000;

export interface DraftSessionDeps {
  load(id: string): Promise<DraftState | null>;
  save(doc: DraftState): Promise<DraftState>;
  /** Omitted = no companion polling. */
  fetchLive?(playerIds: string[]): Promise<LiveDraft | null>;
  now?(): number;
}

export interface DraftSessionOptions {
  saveDelayMs?: number;
  remotePollMs?: number;
  livePollMs?: number;
  liveErrorBackoffMs?: number;
  saveRetryMs?: number;
}

export interface DraftSnapshot {
  draft: DraftState;
  loaded: boolean;
  saving: boolean;
  /** Local changes not written yet. */
  pending: boolean;
  saveError: string | null;
  loadError: string | null;
  live: LiveDraft | null;
  liveFresh: boolean;
  /** Slots filled by the companion (null when its data is not fresh). */
  coverage: Coverage | null;
  /** Epoch ms of the last successful exchange with the store. */
  syncedAt: number | null;
}

/** Turns a live document into slots; null while the catalog / players are not loaded. */
export type LiveMapper = (live: LiveDraft) => LiveMapping;

const message = (err: unknown) => (err instanceof Error ? err.message : 'Erreur inattendue.');

export class DraftSession {
  private snap: DraftSnapshot;
  private listeners = new Set<() => void>();
  private readonly o: Required<DraftSessionOptions>;
  private running = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteTimer: ReturnType<typeof setTimeout> | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incremented when a save starts: polls issued before it are stale. */
  private writeSeq = 0;
  private editSeq = 0;
  /** path -> edit sequence not yet written. */
  private dirty = new Map<DraftPath, number>();
  /** Paths the local user is interacting with (picker open): never overwritten by remote/companion data. */
  private held = new Set<DraftPath>();
  private lastStamp: string | null = null;
  private lastSavedKey: string | null = null;
  private mapper: LiveMapper | null = null;
  private liveIds: string[];

  constructor(
    initial: DraftState,
    private readonly deps: DraftSessionDeps,
    options: DraftSessionOptions = {},
  ) {
    this.o = {
      saveDelayMs: options.saveDelayMs ?? SAVE_DELAY_MS,
      remotePollMs: options.remotePollMs ?? REMOTE_POLL_MS,
      livePollMs: options.livePollMs ?? LIVE_POLL_MS,
      liveErrorBackoffMs: options.liveErrorBackoffMs ?? LIVE_ERROR_BACKOFF_MS,
      saveRetryMs: options.saveRetryMs ?? SAVE_RETRY_MS,
    };
    this.liveIds = initial.player_ids;
    this.snap = {
      draft: initial,
      loaded: false,
      saving: false,
      pending: false,
      saveError: null,
      loadError: null,
      live: null,
      liveFresh: false,
      coverage: null,
      syncedAt: null,
    };
  }

  // ---- subscription ----

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): DraftSnapshot => this.snap;

  private set(patch: Partial<DraftSnapshot>): void {
    this.snap = { ...this.snap, ...patch, pending: this.dirty.size > 0 || this.saveTimer !== null };
    for (const fn of this.listeners) fn();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ---- lifecycle ----

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.initialLoad();
  }

  stop(): void {
    this.running = false;
    for (const t of [this.saveTimer, this.remoteTimer, this.liveTimer]) if (t) clearTimeout(t);
    this.saveTimer = this.remoteTimer = this.liveTimer = null;
    // Unsaved edits: best effort final write.
    if (this.dirty.size) void this.deps.save(this.snap.draft).catch(() => undefined);
  }

  private async initialLoad(): Promise<void> {
    try {
      const doc = await this.deps.load(this.snap.draft.id);
      if (!this.running) return;
      if (doc) {
        const draft = normalizeDraft(doc, this.snap.draft);
        this.lastStamp = draft.updated_at;
        this.lastSavedKey = draftContentKey(draft);
        // Edits made while loading win over the stored document.
        this.set({ draft: adoptRemote(this.snap.draft, draft, this.dirty.keys()), loaded: true, loadError: null, syncedAt: this.now() });
      } else {
        this.set({ loaded: true, loadError: null, syncedAt: this.now() });
      }
    } catch (err) {
      if (!this.running) return;
      this.set({ loaded: true, loadError: message(err) });
    }
    this.scheduleRemote();
    this.scheduleLive(0);
  }

  // ---- inputs ----

  /** Companion mapping (needs the catalog and the players). */
  setMapper(mapper: LiveMapper | null): void {
    this.mapper = mapper;
    if (mapper && this.snap.live) this.applyLive(this.snap.live);
  }

  /** Players whose companion data is looked for (≤ 5). */
  setLivePlayers(ids: string[]): void {
    this.liveIds = ids.slice(0, 5);
  }

  hold(path: DraftPath): void {
    this.held.add(path);
  }

  release(path: DraftPath): void {
    this.held.delete(path);
  }

  /** Local manual edit of the given paths. */
  edit(paths: DraftPath[], fn: (d: DraftState) => DraftState): void {
    const prev = this.snap.draft;
    let next = fn(prev);
    if (next === prev) return;
    const seq = ++this.editSeq;
    for (const p of paths) this.dirty.set(p, seq);
    if (!this.snap.liveFresh && next.source !== 'spectator') next = { ...next, source: 'manual' };
    if (next.source === 'manual') next = { ...next, phase: inferPhase(next) };
    this.set({ draft: { ...next, updated_at: nowIso(this.now()) } });
    this.scheduleSave(this.o.saveDelayMs);
  }

  /** Whole-document replacement (reset, detected game): saved right away. */
  replace(next: DraftState): void {
    const seq = ++this.editSeq;
    for (const p of ['ally_bans', 'enemy_bans', ...[0, 1, 2, 3, 4].flatMap((i) => [`ally.${i}`, `enemy.${i}`])]) this.dirty.set(p, seq);
    this.set({ draft: { ...next, updated_at: nowIso(this.now()) } });
    this.scheduleSave(0);
  }

  // ---- saving ----

  private scheduleSave(delay: number): void {
    if (!this.running) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, delay);
    this.set({});
  }

  private async flush(): Promise<void> {
    if (!this.running) return;
    if (this.snap.saving) {
      this.scheduleSave(this.o.saveDelayMs);
      return;
    }
    const doc = this.snap.draft;
    const key = draftContentKey(doc);
    if (key === this.lastSavedKey && this.dirty.size === 0) {
      this.set({});
      return;
    }
    const written = new Map(this.dirty);
    this.writeSeq += 1;
    this.set({ saving: true });
    try {
      await this.deps.save(doc);
      this.lastStamp = doc.updated_at;
      this.lastSavedKey = key;
      for (const [p, seq] of written) if (this.dirty.get(p) === seq) this.dirty.delete(p);
      this.set({ saving: false, saveError: null, syncedAt: this.now() });
    } catch (err) {
      this.set({ saving: false, saveError: message(err) });
      this.scheduleSave(this.o.saveRetryMs);
    }
  }

  // ---- remote polling ----

  private scheduleRemote(): void {
    if (!this.running) return;
    this.remoteTimer = setTimeout(() => void this.pollRemote(), this.o.remotePollMs);
  }

  private async pollRemote(): Promise<void> {
    this.remoteTimer = null;
    if (!this.running) return;
    const seqAtStart = this.writeSeq;
    try {
      const raw = await this.deps.load(this.snap.draft.id);
      if (!this.running) return;
      // A write started meanwhile (or is about to): this read may predate it. While saves fail,
      // friends' changes are still adopted (our unsaved paths stay protected by `dirty`).
      const stale = this.writeSeq !== seqAtStart || this.snap.saving || (this.saveTimer !== null && !this.snap.saveError);
      if (raw && !stale) {
        const remote = normalizeDraft(raw, this.snap.draft);
        if (remote.updated_at !== this.lastStamp) {
          this.lastStamp = remote.updated_at;
          this.lastSavedKey = draftContentKey(remote);
          let merged = adoptRemote(this.snap.draft, remote, [...this.dirty.keys(), ...this.held]);
          if (this.snap.liveFresh && this.snap.live && this.mapper) merged = mergeCompanion(merged, this.mapper(this.snap.live), this.held);
          this.set({ draft: merged, syncedAt: this.now() });
        } else {
          this.set({ syncedAt: this.now() });
        }
      }
    } catch {
      /* transient: next poll */
    }
    this.scheduleRemote();
  }

  // ---- companion polling ----

  private scheduleLive(delay: number): void {
    if (!this.running || !this.deps.fetchLive) return;
    this.liveTimer = setTimeout(() => void this.pollLive(), delay);
  }

  private async pollLive(): Promise<void> {
    this.liveTimer = null;
    if (!this.running || !this.deps.fetchLive) return;
    let delay = this.o.livePollMs;
    try {
      const live = this.liveIds.length ? await this.deps.fetchLive(this.liveIds) : null;
      if (!this.running) return;
      this.applyLive(live);
    } catch (err) {
      // Route not deployed yet (404) or server error: keep the page usable, ask less often.
      delay = this.o.liveErrorBackoffMs;
      if (!(err instanceof ApiError) || err.status !== 401) this.set({ live: null, liveFresh: false, coverage: null });
    }
    this.scheduleLive(delay);
  }

  private applyLive(live: LiveDraft | null): void {
    const fresh = isLiveFresh(live, this.now());
    if (!fresh || !this.mapper) {
      this.set({ live, liveFresh: fresh && !!this.mapper, coverage: null });
      return;
    }
    const mapping = this.mapper(live);
    const merged = mergeCompanion(this.snap.draft, mapping, this.held);
    const changed = draftContentKey(merged) !== draftContentKey(this.snap.draft);
    this.set({
      live,
      liveFresh: true,
      coverage: coverageOf(mapping),
      ...(changed ? { draft: { ...merged, updated_at: nowIso(this.now()) } } : {}),
    });
    if (changed) this.scheduleSave(this.o.saveDelayMs);
  }
}
