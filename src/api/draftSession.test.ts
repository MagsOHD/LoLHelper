import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDraft, mapCompanionPayload, type LiveDraft } from './draft';
import { ApiError } from './backend';
import { DraftSession, LIVE_ERROR_BACKOFF_MS, LIVE_POLL_MS, REMOTE_POLL_MS, SAVE_DELAY_MS } from './draftSession';
import type { DraftState } from './types';
import { fakeCatalog } from './__fixtures__/fakes';

const catalog = fakeCatalog();
const FRIENDS = [{ id: 'p1', puuid: 'puuid-1' }, { id: 'p2', puuid: 'puuid-2' }];
const T0 = Date.parse('2026-11-10T20:00:00Z');

function live(over: Partial<LiveDraft> = {}): LiveDraft {
  return {
    version: 1, puuid: 'puuid-1', phase: 'ban_pick', local_cell: 0,
    my_team: [{ cell: 0, puuid: 'puuid-1', champion_key: 103, position: 'middle' }],
    their_team: [{ cell: 5, champion_key: 122 }],
    bans: { mine: [9], theirs: [] },
    actions: [{ type: 'pick', champion_key: 103, completed: true, ally: true, cell: 0, in_progress: false }],
    player_id: 'p1',
    received_at: new Date(Date.now()).toISOString(),
    ...over,
  };
}

/** In-memory store standing for PHP, with call logs and controllable latency. */
function fakeStore(initial: DraftState | null = null) {
  let doc: DraftState | null = initial ? structuredClone(initial) : null;
  const saves: DraftState[] = [];
  let loadDelay = 0;
  return {
    get doc() {
      return doc;
    },
    set doc(d: DraftState | null) {
      doc = d ? structuredClone(d) : null;
    },
    saves,
    setLoadDelay(ms: number) {
      loadDelay = ms;
    },
    load: vi.fn(async (): Promise<DraftState | null> => {
      const snapshot = doc ? structuredClone(doc) : null;
      if (loadDelay) await new Promise((r) => setTimeout(r, loadDelay));
      return snapshot;
    }),
    save: vi.fn(async (d: DraftState): Promise<DraftState> => {
      doc = structuredClone(d);
      saves.push(structuredClone(d));
      return d;
    }),
  };
}

const base = () => emptyDraft('team-t1', ['p1', 'p2'], 't1', T0);
const champ = (d: DraftState, i: number, c: string | null) => ({ ...d, ally: d.ally.map((s, j) => (j === i ? { ...s, champion_id: c } : s)) });

let session: DraftSession | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  session?.stop();
  session = null;
  vi.useRealTimers();
});

function start(store: ReturnType<typeof fakeStore>, fetchLive?: (ids: string[]) => Promise<LiveDraft | null>) {
  session = new DraftSession(base(), { load: store.load, save: store.save, fetchLive, now: () => Date.now() });
  session.start();
  return session;
}

describe('shared draft: save and poll', () => {
  it('loads the stored draft, debounces edits (400 ms) into one save', async () => {
    const stored = { ...base(), ally_bans: ['Garen'], updated_at: '2026-11-10T19:59:00.000Z' };
    const store = fakeStore(stored);
    const s = start(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getSnapshot().loaded).toBe(true);
    expect(s.getSnapshot().draft.ally_bans).toEqual(['Garen']);

    s.edit(['ally.0'], (d) => champ(d, 0, 'Ahri'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 50);
    s.edit(['ally.1'], (d) => champ(d, 1, 'Thresh'));
    expect(s.getSnapshot().pending).toBe(true);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 50);
    expect(store.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.saves[0].ally.slice(0, 2).map((x) => x.champion_id)).toEqual(['Ahri', 'Thresh']);
    expect(store.saves[0].source).toBe('manual');
    expect(store.saves[0].phase).toBe('pick'); // inferred
    expect(s.getSnapshot().pending).toBe(false);
  });

  it('does not create a document just by opening the page', async () => {
    const store = fakeStore(null);
    start(store);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 3);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('polls every 3 s and adopts a friend’s newer document', async () => {
    const store = fakeStore({ ...base(), updated_at: 'v1' });
    const s = start(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.load).toHaveBeenCalledTimes(1);
    store.doc = { ...champ(base(), 2, 'Lux'), updated_at: 'v2' }; // written by a friend
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    expect(store.load).toHaveBeenCalledTimes(2);
    expect(s.getSnapshot().draft.ally[2].champion_id).toBe('Lux');
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 2);
    expect(store.load).toHaveBeenCalledTimes(4);
    expect(store.save).not.toHaveBeenCalled(); // adopting never writes back
  });

  it('never clobbers a pending local edit, nor a field being edited (held)', async () => {
    const store = fakeStore({ ...base(), updated_at: 'v1' });
    const s = start(store);
    await vi.advanceTimersByTimeAsync(0);
    // Slow poll in flight while the user edits: its (older) result is discarded.
    store.setLoadDelay(1000);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS); // poll issued at 3 s, resolves at 4 s
    s.edit(['ally.0'], (d) => champ(d, 0, 'Ahri'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.getSnapshot().draft.ally[0].champion_id).toBe('Ahri');
    expect(store.doc?.ally[0].champion_id).toBe('Ahri');
    store.setLoadDelay(0);

    // A friend changes slot 0 and 1 while slot 1 is held (picker open) here.
    s.hold('ally.1');
    store.doc = { ...champ(champ(base(), 0, 'Garen'), 1, 'Jinx'), updated_at: 'v9' };
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    expect(s.getSnapshot().draft.ally[0].champion_id).toBe('Garen'); // last write wins
    expect(s.getSnapshot().draft.ally[1].champion_id).toBeNull(); // held: kept
    s.release('ally.1');
  });

  it('keeps dirty paths when saving fails and retries', async () => {
    const store = fakeStore({ ...base(), updated_at: 'v1' });
    store.save.mockRejectedValueOnce(new ApiError('Serveur indisponible.', 500));
    const s = start(store);
    await vi.advanceTimersByTimeAsync(0);
    s.edit(['ally.0'], (d) => champ(d, 0, 'Ahri'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(s.getSnapshot().saveError).toBe('Serveur indisponible.');
    // A friend writes meanwhile: their other fields are adopted, our slot 0 stays.
    store.doc = { ...champ(base(), 3, 'Jinx'), updated_at: 'v2' };
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    expect(s.getSnapshot().draft.ally.map((x) => x.champion_id).slice(0, 4)).toEqual(['Ahri', null, null, 'Jinx']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.getSnapshot().saveError).toBeNull();
    expect(store.doc?.ally[0].champion_id).toBe('Ahri');
    expect(store.doc?.ally[3].champion_id).toBe('Jinx');
  });
});

describe('companion live data', () => {
  const mapper = (l: LiveDraft) => mapCompanionPayload(l, catalog, FRIENDS);

  it('polls every 2 s, overrides covered slots when fresh, saves the merged draft once', async () => {
    const store = fakeStore({ ...champ(base(), 0, 'Thresh'), updated_at: 'v1' });
    const fetchLive = vi.fn(async () => live());
    const s = start(store, fetchLive);
    s.setMapper(mapper);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLive).toHaveBeenCalledWith(['p1', 'p2']);
    const snap = s.getSnapshot();
    expect(snap.liveFresh).toBe(true);
    expect(snap.coverage?.ally).toEqual([true, false, false, false, false]);
    expect(snap.draft.ally[0]).toMatchObject({ player_id: 'p1', champion_id: 'Ahri', role: 'MID', locked: true });
    expect(snap.draft.enemy[0].champion_id).toBe('Darius');
    expect(snap.draft.source).toBe('companion');
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3);
    expect(fetchLive).toHaveBeenCalledTimes(4);
    expect(store.save).toHaveBeenCalledTimes(1); // same content: no more writes
    expect(store.doc?.ally[0].champion_id).toBe('Ahri');
  });

  it('a manual edit of a covered slot is replaced at the next companion update; held slots are not', async () => {
    const store = fakeStore(null);
    const s = start(store, async () => live());
    s.setMapper(mapper);
    await vi.advanceTimersByTimeAsync(0);
    s.edit(['ally.0'], (d) => champ(d, 0, 'Lux'));
    expect(s.getSnapshot().draft.source).toBe('companion'); // still synchronised
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(s.getSnapshot().draft.ally[0].champion_id).toBe('Ahri');
    s.hold('ally.0');
    s.edit(['ally.0'], (d) => champ(d, 0, 'Lux'));
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(s.getSnapshot().draft.ally[0].champion_id).toBe('Lux');
  });

  it('ignores stale or finished companion data and keeps the last merged state', async () => {
    const store = fakeStore(null);
    let current: LiveDraft | null = live();
    const s = start(store, async () => current);
    s.setMapper(mapper);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getSnapshot().liveFresh).toBe(true);
    current = live({ phase: 'none', my_team: [], their_team: [] });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(s.getSnapshot().liveFresh).toBe(false);
    expect(s.getSnapshot().coverage).toBeNull();
    expect(s.getSnapshot().draft.ally[0].champion_id).toBe('Ahri'); // kept
    current = live({ received_at: '2026-11-10T19:00:00Z' }); // too old
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(s.getSnapshot().liveFresh).toBe(false);
    // Manual edit once the companion is gone: back to manual source.
    s.edit(['ally.1'], (d) => champ(d, 1, 'LeeSin'));
    expect(s.getSnapshot().draft.source).toBe('manual');
  });

  it('waits for the mapper (catalog) and backs off after errors', async () => {
    const store = fakeStore(null);
    const fetchLive = vi.fn(async (): Promise<LiveDraft | null> => {
      throw new ApiError('Route inconnue.', 404);
    });
    const s = start(store, fetchLive);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 2);
    expect(fetchLive).toHaveBeenCalledTimes(1); // backing off
    await vi.advanceTimersByTimeAsync(LIVE_ERROR_BACKOFF_MS);
    expect(fetchLive).toHaveBeenCalledTimes(2);

    fetchLive.mockImplementation(async () => live({ received_at: new Date(Date.now()).toISOString() }));
    await vi.advanceTimersByTimeAsync(LIVE_ERROR_BACKOFF_MS);
    expect(s.getSnapshot().live).not.toBeNull();
    expect(s.getSnapshot().liveFresh).toBe(false); // no catalog yet
    s.setMapper(mapper);
    expect(s.getSnapshot().liveFresh).toBe(true);
    expect(s.getSnapshot().draft.ally[0].champion_id).toBe('Ahri');
  });

  it('stops every timer on stop()', async () => {
    const store = fakeStore(null);
    const fetchLive = vi.fn(async () => null);
    const s = start(store, fetchLive);
    await vi.advanceTimersByTimeAsync(0);
    s.stop();
    session = null;
    const loads = store.load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.load.mock.calls.length).toBe(loads);
    expect(fetchLive).toHaveBeenCalledTimes(1);
  });
});
