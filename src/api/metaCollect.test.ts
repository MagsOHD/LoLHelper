import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './backend';
import type { CollectResult } from './meta';
import {
  BUSY_RETRY_MS,
  classifyStop,
  CollectController,
  MAX_RIOT_LIMIT_WAITS,
  RIOT_LIMIT_DEFAULT_WAIT_S,
  riotLimitWait,
  runCollectLoop,
  stopLabel,
  type CollectProgress,
} from './metaCollect';

const ok = (stop: string, extra: Partial<Extract<CollectResult, { status: 'ok' }>> = {}): CollectResult => ({
  status: 'ok', stop, requests: 27, new_matches: 40, patch: '16.19', games: 1000, duration_s: 45, at: '', patches: [], ...extra,
});
const BUSY: CollectResult = { status: 'busy' };

/** collect() answering the given results in order (the last one repeats). */
function script(...results: (CollectResult | Error)[]) {
  let i = 0;
  return vi.fn(async () => {
    const r = results[Math.min(i++, results.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('classifyStop / stopLabel', () => {
  it('maps the collector codes and its French reasons', () => {
    expect(classifyStop('budget')).toBe('budget');
    expect(classifyStop('budget de temps atteint')).toBe('budget');
    expect(classifyStop('tour complet')).toBe('complete');
    expect(classifyStop('riot_limit')).toBe('riot_limit');
    expect(classifyStop('limite Riot atteinte (429), pause de 60 s')).toBe('riot_limit');
    expect(classifyStop('riot_key')).toBe('riot_key');
    expect(classifyStop('riot_down')).toBe('riot_down');
    expect(classifyStop('no_seeds')).toBe('no_seeds');
    expect(classifyStop('disabled')).toBe('disabled');
    expect(classifyStop('???')).toBe('other');
  });

  it('gives French labels, with the Riot wait when known', () => {
    expect(stopLabel('riot_limit', 120)).toBe('limite de requêtes Riot atteinte — réessaie dans 2 min');
    expect(stopLabel('riot_limit', 30)).toMatch(/30 s$/);
    expect(stopLabel('tour complet')).toBe('tour complet des joueurs suivis');
    expect(stopLabel('riot_key')).toMatch(/clé API Riot/);
    expect(stopLabel('quelque chose')).toBe('quelque chose');
  });
});

describe('runCollectLoop', () => {
  it('chains budget passes and stops after two full rounds in a row', async () => {
    const collect = script(ok('budget'), ok('tour complet', { new_matches: 2 }), ok('budget'), ok('tour complet', { new_matches: 0 }), ok('tour complet', { new_matches: 0, games: 1300 }));
    const onNewData = vi.fn();
    const end = await runCollectLoop({ collect, signal: new AbortController().signal, onNewData });
    expect(collect).toHaveBeenCalledTimes(5);
    expect(end.phase).toBe('done');
    expect(end.passes).toBe(5);
    expect(end.requests).toBe(5 * 27);
    expect(end.new_matches).toBe(40 + 2 + 40);
    expect(end.games).toBe(1300);
    expect(end.full_rounds).toBe(2);
    expect(onNewData).toHaveBeenCalledTimes(3); // only passes that added matches
  });

  it('waits 20 s and retries while the server is busy', async () => {
    const collect = script(BUSY, BUSY, ok('tour complet'), ok('tour complet'));
    const seen: CollectProgress[] = [];
    const run = runCollectLoop({ collect, signal: new AbortController().signal, onProgress: (p) => seen.push(p), now: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(seen[seen.length - 1]).toMatchObject({ phase: 'waiting', busy_retries: 1, retry_at: BUSY_RETRY_MS });
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS - 1);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(collect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
    const end = await run;
    expect(collect).toHaveBeenCalledTimes(4);
    expect(end).toMatchObject({ phase: 'done', passes: 2, busy_retries: 0 });
  });

  it('gives up after too many busy answers', async () => {
    const collect = script(BUSY);
    const run = runCollectLoop({ collect, signal: new AbortController().signal, maxBusyRetries: 2, busyRetryMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    const end = await run;
    expect(collect).toHaveBeenCalledTimes(3);
    expect(end.phase).toBe('error');
    expect(end.error).toMatch(/occupé/);
  });

  it('waits retry_after on a Riot limit (countdown) then continues', async () => {
    const t0 = 1_000_000;
    let clock = t0;
    const seen: CollectProgress[] = [];
    const onPass = vi.fn();
    const collect = script(ok('budget'), ok('riot_limit', { retry_after: 30, new_matches: 3 }), ok('budget', { new_matches: 5 }), ok('disabled', { new_matches: 0 }));
    const run = runCollectLoop({ collect, signal: new AbortController().signal, onProgress: (p) => seen.push(p), onPass, now: () => clock });
    await vi.advanceTimersByTimeAsync(0);
    expect(collect).toHaveBeenCalledTimes(2);
    const waiting = seen[seen.length - 1];
    expect(waiting).toMatchObject({ phase: 'waiting', wait_reason: 'riot_limit', retry_at: t0 + 30_000, passes: 2, riot_waits: 1 });
    expect(waiting.message).toMatch(/reprend dans 30 s/);
    clock += 29_000;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(collect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    const end = await run;
    expect(collect).toHaveBeenCalledTimes(4);
    // The loop went on after the pause and stopped only on the "disabled" stop.
    expect(end).toMatchObject({ phase: 'error', passes: 4, new_matches: 48, riot_waits: 0, wait_reason: null });
    expect(end.error).toMatch(/désactivée/);
    expect(onPass).toHaveBeenCalledTimes(4);
  });

  it('waits 5 s when the server gives no retry_after; caps long waits', async () => {
    expect(RIOT_LIMIT_DEFAULT_WAIT_S).toBe(5);
    expect(riotLimitWait(undefined)).toBe(5);
    expect(riotLimitWait(0)).toBe(5);
    expect(riotLimitWait(2.2)).toBe(3);
    expect(riotLimitWait(3600)).toBe(120);

    const collect = script(ok('riot_limit'), ok('tour complet'), ok('tour complet'));
    const run = runCollectLoop({ collect, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const end = await run;
    expect(collect).toHaveBeenCalledTimes(3);
    expect(end.phase).toBe('done');
  });

  it('a Riot pause does not break a run of full rounds', async () => {
    const collect = script(ok('tour complet'), ok('riot_limit', { retry_after: 1 }), ok('tour complet'));
    const run = runCollectLoop({ collect, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(1_000);
    const end = await run;
    expect(collect).toHaveBeenCalledTimes(3);
    expect(end.phase).toBe('done');
  });

  it('gives up after too many Riot limits in a row; user stop is immediate during the pause', async () => {
    const collect = script(ok('riot_limit', { retry_after: 1, new_matches: 0 }));
    const run = runCollectLoop({ collect, signal: new AbortController().signal, maxRiotWaits: 3 });
    await vi.advanceTimersByTimeAsync(5_000);
    const end = await run;
    expect(collect).toHaveBeenCalledTimes(3);
    expect(end.phase).toBe('error');
    expect(end.error).toMatch(/3 passes de suite/);
    expect(MAX_RIOT_LIMIT_WAITS).toBeGreaterThan(3);

    const abort = new AbortController();
    const once = script(ok('riot_limit', { retry_after: 60 }));
    const run2 = runCollectLoop({ collect: once, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    abort.abort();
    expect(await run2).toMatchObject({ phase: 'stopped', passes: 1, retry_at: null });
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('still stops on the key or other non-budget stops', async () => {
    const key = await runCollectLoop({ collect: script(ok('riot_key', { message: 'Clé API Riot refusée (HTTP 403).' })), signal: new AbortController().signal });
    expect(key.error).toBe('Arrêt du collecteur : Clé API Riot refusée (HTTP 403).');
    const down = await runCollectLoop({ collect: script(ok('budget'), ok('riot_down')), signal: new AbortController().signal });
    expect(down).toMatchObject({ phase: 'error', passes: 2 });
  });

  it('a full round followed by a budget pass resets the counter', async () => {
    const collect = script(ok('tour complet'), ok('budget'), ok('tour complet'), ok('disabled'));
    const end = await runCollectLoop({ collect, signal: new AbortController().signal });
    expect(collect).toHaveBeenCalledTimes(4);
    expect(end.phase).toBe('error');
    expect(end.error).toMatch(/désactivée/);
  });

  it('stops on errors and keeps the HTTP status (401 = wrong admin password)', async () => {
    const end = await runCollectLoop({
      collect: script(ok('budget'), new ApiError('Mot de passe administrateur incorrect.', 401)),
      signal: new AbortController().signal,
    });
    expect(end).toMatchObject({ phase: 'error', passes: 1, error: 'Mot de passe administrateur incorrect.', error_status: 401 });
  });

  it('user stop: immediate while waiting, after the in-flight pass otherwise', async () => {
    const abort = new AbortController();
    const collect = script(BUSY);
    const run = runCollectLoop({ collect, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(1000);
    abort.abort();
    const end = await run;
    expect(end.phase).toBe('stopped');
    expect(collect).toHaveBeenCalledTimes(1);

    const abort2 = new AbortController();
    let release: (r: CollectResult) => void = () => {};
    const slow = vi.fn(() => new Promise<CollectResult>((res) => { release = res; }));
    const run2 = runCollectLoop({ collect: slow, signal: abort2.signal });
    abort2.abort();
    release(ok('budget'));
    const end2 = await run2;
    expect(end2).toMatchObject({ phase: 'stopped', passes: 1, new_matches: 40 });
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe('CollectController', () => {
  it('never runs two loops at once and exposes snapshots', async () => {
    let release: (r: CollectResult) => void = () => {};
    const collect = vi.fn(() => new Promise<CollectResult>((res) => { release = res; }));
    const c = new CollectController(collect);
    const listener = vi.fn();
    c.subscribe(listener);
    const onData = vi.fn();
    c.setOnNewData(onData);
    const onPass = vi.fn();
    c.setOnPass(onPass);

    expect(c.start('pw')).toBe(true);
    expect(c.start('pw')).toBe(false);
    expect(c.running).toBe(true);
    expect(c.getSnapshot().phase).toBe('running');
    expect(collect).toHaveBeenCalledWith('pw');

    c.stop();
    expect(c.getSnapshot().phase).toBe('stopping');
    release(ok('budget'));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.running).toBe(false);
    expect(c.getSnapshot()).toMatchObject({ phase: 'stopped', passes: 1 });
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onPass).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalled();
    expect(collect).toHaveBeenCalledTimes(1);

    c.reset();
    expect(c.getSnapshot().phase).toBe('idle');
    expect(c.start('pw')).toBe(true);
  });

  it('calls onPass after every pass, even without new matches (key limits refresh)', async () => {
    const collect = vi.fn()
      .mockResolvedValueOnce(ok('riot_limit', { new_matches: 0, retry_after: 2 }))
      .mockResolvedValueOnce(ok('riot_key', { new_matches: 0 }));
    const c = new CollectController(collect);
    const onPass = vi.fn();
    const onData = vi.fn();
    c.setOnPass(onPass);
    c.setOnNewData(onData);
    c.start('pw');
    await vi.advanceTimersByTimeAsync(0);
    expect(onPass).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({ phase: 'waiting', wait_reason: 'riot_limit' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onPass).toHaveBeenCalledTimes(2);
    expect(onData).not.toHaveBeenCalled();
    expect(c.running).toBe(false);
  });
});
