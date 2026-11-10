import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptRemote,
  coverageOf,
  draftContentKey,
  emptyDraft,
  fetchLiveDraft,
  inferPhase,
  isLiveFresh,
  LIVE_MAX_AGE_MS,
  loadDraft,
  mapCompanionPayload,
  mergeCompanion,
  normalizeDraft,
  positionToRole,
  saveDraft,
  toDraftInput,
  usedChampions,
  type LiveDraft,
} from './draft';
import { resetStoreForTests } from './backend';
import { fakeCatalog, installWindow, json } from './__fixtures__/fakes';

const catalog = fakeCatalog();
const FRIENDS = [
  { id: 'p1', puuid: 'puuid-1' },
  { id: 'p2', puuid: 'puuid-2' },
  { id: 'p3', puuid: null },
];
const NOW = Date.parse('2026-11-10T20:00:30Z');

function payload(over: Partial<LiveDraft> = {}): LiveDraft {
  return {
    version: 1,
    puuid: 'puuid-1',
    phase: 'ban_pick',
    queue_id: 420,
    local_cell: 2,
    my_team: [
      { cell: 2, puuid: '', champion_key: 103, intent_key: 0, position: 'middle' }, // local player (puuid from payload)
      { cell: 0, puuid: 'puuid-2', champion_key: 86, intent_key: 0, position: 'top' },
      { cell: 1, puuid: 'stranger', champion_key: 0, intent_key: 64, position: 'jungle' },
      { cell: 3, puuid: '', champion_key: 0, intent_key: 0, position: 'bottom' },
      { cell: 4, puuid: '', champion_key: 412, intent_key: 0, position: 'utility' },
    ],
    their_team: [{ cell: 6, champion_key: 122 }, { cell: 5, champion_key: 99 }, { cell: 7, champion_key: 0 }],
    bans: { mine: [9, 0], theirs: [222] },
    actions: [
      { type: 'ban', champion_key: 9, completed: true, ally: true, cell: 0, in_progress: false },
      { type: 'pick', champion_key: 86, completed: true, ally: true, cell: 0, in_progress: false },
      { type: 'pick', champion_key: 99, completed: true, ally: false, cell: 5, in_progress: false },
      { type: 'pick', champion_key: 122, completed: true, ally: false, cell: 6, in_progress: false },
      { type: 'pick', champion_key: 103, completed: false, ally: true, cell: 2, in_progress: true },
      { type: 'pick', champion_key: 412, completed: true, ally: true, cell: 4, in_progress: false },
    ],
    timer_remaining_ms: 21000,
    sent_at: '2026-11-10T20:00:00Z',
    player_id: 'p1',
    received_at: '2026-11-10T20:00:01Z',
    ...over,
  };
}

describe('CompanionPayload -> slots', () => {
  it('maps keys to ids, positions to roles, friends by puuid, hover vs lock', () => {
    const m = mapCompanionPayload(payload(), catalog, FRIENDS);
    expect(m.phase).toBe('pick');
    expect(m.side).toBe('blue');
    expect(m.owner_player_id).toBe('p1');
    expect(m.ally).toEqual([
      { player_id: 'p2', champion_id: 'Garen', role: 'TOP', locked: true },
      { player_id: null, champion_id: 'LeeSin', role: 'JUNGLE', locked: false }, // intent = hover
      { player_id: 'p1', champion_id: 'Ahri', role: 'MID', locked: false }, // pick in progress = hover
      { player_id: null, champion_id: null, role: 'BOTTOM', locked: false },
      { player_id: null, champion_id: 'Thresh', role: 'SUPPORT', locked: true },
    ]);
    expect(m.enemy).toEqual([
      { champion_id: 'Lux', role: null, locked: true },
      { champion_id: 'Darius', role: null, locked: true },
      { champion_id: null, role: null, locked: false },
    ]);
    expect(m.ally_bans).toEqual(['Fiddlesticks']);
    expect(m.enemy_bans).toEqual(['Jinx']);
  });

  it('derives phase and side; locks every picked champion without actions once the draft is over', () => {
    expect(mapCompanionPayload(payload({ phase: 'planning' }), catalog, FRIENDS).phase).toBe('planning');
    const banning = payload({ actions: [{ type: 'ban', champion_key: 0, completed: false, ally: true, cell: 2, in_progress: true }] });
    expect(mapCompanionPayload(banning, catalog, FRIENDS).phase).toBe('ban');
    const final = mapCompanionPayload(payload({ phase: 'finalization', actions: [] }), catalog, FRIENDS);
    expect(final.phase).toBe('finalization');
    expect(final.ally.filter((s) => s.champion_id && s.locked).map((s) => s.champion_id)).toEqual(['Garen', 'Ahri', 'Thresh']);
    expect(final.ally[1]).toMatchObject({ champion_id: 'LeeSin', locked: false }); // intent never locked
    expect(mapCompanionPayload(payload({ phase: 'game_starting' }), catalog, FRIENDS).phase).toBe('finalization');
    expect(mapCompanionPayload(payload({ phase: 'none' }), catalog, FRIENDS).phase).toBe('ended');
    const red = payload({ my_team: [{ cell: 7, puuid: 'puuid-1', champion_key: 0, position: '' }] });
    const r = mapCompanionPayload(red, catalog, FRIENDS);
    expect(r.side).toBe('red');
    expect(r.ally[0]).toEqual({ player_id: 'p1', champion_id: null, role: null, locked: false });
  });

  it('ignores unknown keys, junk entries and duplicate puuids; caps at 5', () => {
    const p = payload({
      my_team: [
        { cell: 0, puuid: 'puuid-1', champion_key: 99999, position: 'nowhere' },
        { cell: 1, puuid: 'puuid-1', champion_key: 0 },
        null as never,
        ...[2, 3, 4, 5].map((cell) => ({ cell, champion_key: 0 })),
      ],
      bans: { mine: [9, 9, 99999], theirs: [] },
    });
    const m = mapCompanionPayload(p, catalog, FRIENDS);
    expect(m.ally).toHaveLength(5);
    expect(m.ally[0]).toEqual({ player_id: 'p1', champion_id: null, role: null, locked: false });
    expect(m.ally[1].player_id).toBeNull();
    expect(m.ally_bans).toEqual(['Fiddlesticks']);
    expect(positionToRole('utility')).toBe('SUPPORT');
    expect(positionToRole('bottom')).toBe('BOTTOM');
    expect(positionToRole('')).toBeNull();
  });

  it('coverage marks the slots the companion fills', () => {
    const cov = coverageOf(mapCompanionPayload(payload(), catalog, FRIENDS))!;
    expect(cov.ally).toEqual([true, true, true, true, true]);
    expect(cov.enemy).toEqual([true, true, true, false, false]);
    expect(coverageOf(null)).toBeNull();
  });
});

describe('freshness', () => {
  it('is fresh only for a recent payload still in champion select', () => {
    expect(isLiveFresh(payload(), NOW)).toBe(true);
    expect(isLiveFresh(payload({ phase: 'none' }), NOW)).toBe(false);
    expect(isLiveFresh(null, NOW)).toBe(false);
    expect(isLiveFresh(payload({ received_at: 'hier' }), NOW)).toBe(false);
    const old = new Date(NOW - LIVE_MAX_AGE_MS - 1000).toISOString();
    expect(isLiveFresh(payload({ received_at: old }), NOW)).toBe(false);
  });
});

describe('merge rules', () => {
  const manual = () => {
    const d = emptyDraft('team-t1', ['p1', 'p2', 'p3'], 't1', NOW);
    d.ally[3] = { player_id: null, champion_id: 'Jinx', role: 'BOTTOM', locked: true };
    d.ally[0].role = 'MID';
    d.enemy[0] = { champion_id: 'Lux', role: 'SUPPORT', locked: true };
    d.enemy[4] = { champion_id: 'Leona', role: null, locked: true };
    d.ally_bans = ['Garen'];
    d.enemy_accounts = [{ puuid: 'x', champion_id: 'Lux' }];
    d.game_id = 42;
    return d;
  };

  it('companion overrides the slots it covers and keeps what it does not know', () => {
    const m = mapCompanionPayload(payload(), catalog, FRIENDS);
    const merged = mergeCompanion(manual(), m);
    expect(merged.source).toBe('companion');
    expect(merged.phase).toBe('pick');
    // p2 matched at cell 0; manual p1 was on slot 0 but is matched at slot 2 -> moved.
    expect(merged.ally.map((s) => s.player_id)).toEqual(['p2', null, 'p1', null, null]);
    expect(merged.ally[3]).toEqual({ player_id: null, champion_id: null, role: 'BOTTOM', locked: false });
    // p3 (no puuid) was on slot 2 by hand: slot taken by p1 now. A hand-assigned friend on an
    // unmatched slot stays:
    const base = manual();
    base.ally[1].player_id = 'p3';
    expect(mergeCompanion(base, m).ally[1].player_id).toBe('p3');
    // Enemy: role kept only when the champion did not change; uncovered slots untouched.
    expect(merged.enemy[0]).toEqual({ champion_id: 'Lux', role: 'SUPPORT', locked: true });
    expect(merged.enemy[1]).toEqual({ champion_id: 'Darius', role: null, locked: true });
    expect(merged.enemy[4]).toEqual({ champion_id: 'Leona', role: null, locked: true });
    expect(merged.ally_bans).toEqual(['Fiddlesticks']);
    expect(merged.enemy_accounts).toEqual([]);
    expect(merged.game_id).toBeNull();
  });

  it('companion keeps a manual role when it has no position, and never touches held paths', () => {
    const p = payload({ my_team: payload().my_team.map((t) => ({ ...t, position: '' })) });
    const base = manual();
    base.ally[1].role = 'JUNGLE';
    const merged = mergeCompanion(base, mapCompanionPayload(p, catalog, FRIENDS), ['ally.3', 'ally_bans']);
    expect(merged.ally[1].role).toBe('JUNGLE');
    expect(merged.ally[3]).toEqual(base.ally[3]);
    expect(merged.ally_bans).toEqual(['Garen']);
  });

  it('a phase "none" mapping keeps the previous phase', () => {
    const base = { ...manual(), phase: 'finalization' as const };
    expect(mergeCompanion(base, mapCompanionPayload(payload({ phase: 'none' }), catalog, FRIENDS)).phase).toBe('finalization');
  });

  it('remote adoption keeps protected local paths', () => {
    const local = manual();
    const remote = { ...emptyDraft('team-t1', ['p1'], 't1', NOW), updated_at: 'later' };
    remote.ally[2].champion_id = 'Ahri';
    const out = adoptRemote(local, remote, ['ally.3', 'enemy.0', 'ally_bans', 'bogus', 'ally.9']);
    expect(out.ally[2].champion_id).toBe('Ahri');
    expect(out.ally[3]).toEqual(local.ally[3]);
    expect(out.enemy[0]).toEqual(local.enemy[0]);
    expect(out.ally_bans).toEqual(['Garen']);
    expect(out.updated_at).toBe('later');
  });
});

describe('draft helpers', () => {
  it('emptyDraft puts friends first, normalizeDraft repairs junk', () => {
    const d = emptyDraft('player-p1', ['p1'], null, NOW);
    expect(d.ally.map((s) => s.player_id)).toEqual(['p1', null, null, null, null]);
    expect(d.enemy).toHaveLength(5);
    const n = normalizeDraft(
      { ally: [{ player_id: 'p1', champion_id: 'Ahri', role: 'ADC', locked: 'yes' }], enemy: 'x', ally_bans: ['A', 'A', 3], phase: 'warp', source: 'companion', updated_at: 'T' },
      d,
    );
    expect(n.ally[0]).toEqual({ player_id: 'p1', champion_id: 'Ahri', role: null, locked: false });
    expect(n.ally).toHaveLength(5);
    expect(n.enemy).toHaveLength(5);
    expect(n.ally_bans).toEqual(['A']);
    expect([n.phase, n.source, n.updated_at, n.id]).toEqual(['planning', 'companion', 'T', 'player-p1']);
    expect(normalizeDraft(null, d)).toBe(d);
  });

  it('infers the manual phase, lists used champions, builds the engine input', () => {
    const d = emptyDraft('x', ['p1'], null, NOW);
    expect(inferPhase(d)).toBe('planning');
    d.ally_bans = ['Garen'];
    expect(inferPhase(d)).toBe('ban');
    d.enemy[0].champion_id = 'Lux';
    expect(inferPhase(d)).toBe('pick');
    d.ally = d.ally.map((s, i) => ({ ...s, champion_id: ['Ahri', 'Thresh', 'Jinx', 'Darius', 'LeeSin'][i], locked: true }));
    d.enemy = d.enemy.map((s, i) => ({ ...s, champion_id: ['Lux', 'Garen', 'Leona', 'MonkeyKing', 'Fiddlesticks'][i] }));
    expect(inferPhase(d)).toBe('finalization');
    expect(usedChampions(d)).toContain('Garen');
    expect(new Set(usedChampions(d)).size).toBe(usedChampions(d).length);
    d.enemy_accounts = [{ puuid: 'e', champion_id: 'Lux' }];
    expect(toDraftInput(d).enemy_accounts).toBeUndefined(); // hidden until the game started
    expect(toDraftInput({ ...d, phase: 'in_game' }).enemy_accounts).toHaveLength(1);
    expect(toDraftInput(d).bans).toEqual(['Garen']);
    expect(draftContentKey({ ...d, updated_at: 'a' })).toBe(draftContentKey({ ...d, updated_at: 'b' }));
  });
});

describe('store helpers', () => {
  beforeEach(() => resetStoreForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('reads one draft (single GET, then list fallback on 405) and writes it', async () => {
    installWindow('');
    const doc = emptyDraft('team-t1', ['p1'], 't1', NOW);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://site.test');
      const route = url.searchParams.get('r') ?? '';
      calls.push(`${init?.method} ${route}`);
      if (route === 'store/drafts/team-t1' && init?.method === 'GET') return json({ detail: 'Méthode non autorisée.' }, 405);
      if (route === 'store/drafts' && init?.method === 'GET') return json([{ ...doc, id: 'other' }, doc]);
      if (route === 'store/drafts/team-t1' && init?.method === 'PUT') return json(JSON.parse(String(init.body)));
      return json({ detail: 'Route inconnue.' }, 404);
    }));
    expect((await loadDraft('team-t1'))?.id).toBe('team-t1');
    expect(await loadDraft('team-nope')).toBeNull();
    expect(await loadDraft('bad id!')).toBeNull();
    expect(calls).toEqual(['GET store/drafts/team-t1', 'GET store/drafts', 'GET store/drafts']); // 405 remembered
    expect((await saveDraft(doc)).id).toBe('team-t1');
    expect(calls[calls.length - 1]).toBe('PUT store/drafts/team-t1');
  });

  it('single GET: 200 doc, 404 null', async () => {
    installWindow('');
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const route = new URL(String(input), 'http://site.test').searchParams.get('r');
      return route === 'store/drafts/a' ? json({ id: 'a' }) : json({ detail: 'Document introuvable.' }, 404);
    }));
    expect(await loadDraft('a')).toEqual({ id: 'a' });
    expect(await loadDraft('b')).toBeNull();
  });

  it('fetches live data for ≤ 5 valid player ids', async () => {
    installWindow('');
    const fetchMock = vi.fn(async () => json({ live: payload() }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchLiveDraft(['p1', 'p2', 'bad id', 'p3', 'p4', 'p5', 'p6']))?.player_id).toBe('p1');
    const url = new URL(String((fetchMock.mock.calls[0] as unknown as [string])[0]), 'http://site.test');
    expect(url.searchParams.get('r')).toBe('live-draft');
    expect(url.searchParams.get('players')).toBe('p1,p2,p3,p4,p5');
    vi.stubGlobal('fetch', vi.fn(async () => json({ live: null })));
    expect(await fetchLiveDraft(['p1'])).toBeNull();
    expect(await fetchLiveDraft([])).toBeNull();
  });
});
