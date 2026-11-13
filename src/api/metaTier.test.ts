import { describe, expect, it } from 'vitest';
import type { MetaStats } from './types';
import {
  bestWorstMatchups,
  buildTierRows,
  championDetail,
  comparePatchDesc,
  filterRows,
  laneMatchups,
  patchOptions,
  resolvePatch,
  smoothed,
  sortRows,
  tierOf,
  TIER_PRIOR,
} from './metaTier';

const META: MetaStats = {
  patch: '16.19',
  platform: 'euw1',
  games: 1000,
  updated_at: '2026-10-10T12:00:00Z',
  champions: {
    Ahri: { MID: [200, 112], SUPPORT: [10, 4] },
    Zed: { MID: [300, 141] },
    Veigar: { MID: [12, 10] }, // 83 % on a tiny sample
    Orianna: { MID: [60, 30] },
    Thresh: { SUPPORT: [150, 78] },
    Bad: { MID: [0, 0] },
  },
  bans: { Zed: 250, Ahri: 40 },
  matchups: {
    MID: {
      Ahri: { Zed: [40, 26], Orianna: [12, 4], Veigar: [5, 5] },
      Zed: { Ahri: [40, 14] },
      // only the reverse entry exists for Ahri vs Lux
      Lux: { Ahri: [20, 15] },
    },
  },
};
const names: Record<string, string> = { Ahri: 'Ahri', Zed: 'Zed', Veigar: 'Veigar', Orianna: 'Orianna', Thresh: 'Thresh' };
const nameOf = (id: string) => names[id] ?? id;

describe('tier rows', () => {
  const rows = buildTierRows(META, 'MID', nameOf);
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it('computes raw/smoothed winrate, pick and ban rates, small-sample flag', () => {
    expect(rows.map((r) => r.id).sort()).toEqual(['Ahri', 'Orianna', 'Veigar', 'Zed']); // 0-game cell dropped
    expect(row('Ahri')).toMatchObject({ games: 200, wins: 112, winrate: 0.56, pickRate: 0.2, bans: 40, banRate: 0.04, lowSample: false });
    expect(row('Ahri').score).toBeCloseTo(smoothed(112, 200, TIER_PRIOR));
    expect(row('Zed').banRate).toBe(0.25);
    expect(row('Veigar')).toMatchObject({ winrate: 10 / 12, lowSample: true });
    expect(row('Orianna').bans).toBe(0);
  });

  it('smoothing keeps lucky small samples out of the top tier', () => {
    expect(row('Veigar').winrate).toBeGreaterThan(row('Ahri').winrate);
    expect(row('Veigar').score).toBeLessThan(row('Ahri').score);
    expect(row('Ahri').tier).toBe('S');
    expect(row('Veigar').tier).toBeNull(); // 12 games: not ranked
    expect(row('Orianna').tier).toBe('B');
    expect(row('Zed').tier).toBe('D');
    expect(tierOf(0.5)).toBe('B');
    expect(tierOf(0.47)).toBe('D');
  });

  it('sorts by any column with stable tie-breaks', () => {
    expect(sortRows(rows, 'tier').map((r) => r.id)).toEqual(['Ahri', 'Veigar', 'Orianna', 'Zed']);
    expect(sortRows(rows, 'winrate').map((r) => r.id)).toEqual(['Veigar', 'Ahri', 'Orianna', 'Zed']);
    expect(sortRows(rows, 'winrate', 'asc')[0].id).toBe('Zed');
    expect(sortRows(rows, 'games').map((r) => r.id)).toEqual(['Zed', 'Ahri', 'Orianna', 'Veigar']);
    expect(sortRows(rows, 'banRate').map((r) => r.id)).toEqual(['Zed', 'Ahri', 'Orianna', 'Veigar']); // 0-ban tie: more games first
    expect(sortRows(rows, 'name').map((r) => r.id)).toEqual(['Ahri', 'Orianna', 'Veigar', 'Zed']);
    expect(sortRows(rows, 'pickRate')[0].id).toBe('Zed');
    expect(rows.map((r) => r.id)).toEqual(buildTierRows(META, 'MID', nameOf).map((r) => r.id)); // not mutated
  });

  it('filters on minimum games and an accent-insensitive search', () => {
    expect(filterRows(rows, { minGames: 20 }).map((r) => r.id).sort()).toEqual(['Ahri', 'Orianna', 'Zed']);
    expect(filterRows(rows, { minGames: 0 })).toHaveLength(4);
    expect(filterRows(rows, { query: 'ORI' }).map((r) => r.id)).toEqual(['Orianna']);
    const accent = buildTierRows(META, 'MID', (id) => (id === 'Zed' ? 'Zéd' : id));
    expect(filterRows(accent, { query: 'zed' }).map((r) => r.id)).toEqual(['Zed']);
    expect(filterRows(rows, { minGames: 20, query: 'veig' })).toEqual([]);
  });
});

describe('champion detail', () => {
  it('lists roles (most played first) and the ban rate', () => {
    const d = championDetail(META, 'Ahri');
    expect(d).toMatchObject({ games: 210, bans: 40, banRate: 0.04 });
    expect(d.roles.map((r) => r.role)).toEqual(['MID', 'SUPPORT']);
    expect(d.roles[0]).toMatchObject({ games: 200, winrate: 0.56, pickRate: 0.2 });
    expect(d.roles[0].share).toBeCloseTo(200 / 210);
    expect(championDetail(META, 'Nobody')).toMatchObject({ games: 0, roles: [] });
  });

  it('keeps duels with at least 10 games, uses reverse entries, splits best and worst', () => {
    const lines = laneMatchups(META, 'MID', 'Ahri');
    expect(lines.map((l) => l.opponent).sort()).toEqual(['Lux', 'Orianna', 'Zed']); // Veigar: 5 games
    const lux = lines.find((l) => l.opponent === 'Lux')!;
    expect([lux.games, lux.wins]).toEqual([20, 5]);
    const { best, worst } = bestWorstMatchups(lines);
    expect(best.map((l) => l.opponent)).toEqual(['Zed']);
    expect(worst.map((l) => l.opponent)).toEqual(['Lux', 'Orianna']);
    expect(laneMatchups(META, 'TOP', 'Ahri')).toEqual([]);
  });
});

describe('patch selection mapping', () => {
  const kept = [
    { patch: '16.19', games: 50, updated_at: 'b' },
    { patch: '16.9', games: 900, updated_at: 'a' },
    { patch: '16.20', games: 0, updated_at: 'c' },
  ];

  it('orders patches numerically and keeps only patches with games', () => {
    expect(['16.9', '16.19', '15.24', '16.2'].sort(comparePatchDesc)).toEqual(['16.19', '16.9', '16.2', '15.24']);
    const opts = patchOptions(kept, { patch: '16.9', games: 900, updated_at: 'a' });
    expect(opts.map((o) => [o.value, o.served])).toEqual([['16.19', false], ['16.9', true]]);
  });

  it('adds the served patch when the status route did not list it', () => {
    expect(patchOptions([], { patch: '16.19', games: 10, updated_at: '' })).toEqual([
      { value: '16.19', games: 10, updated_at: '', served: true },
    ]);
    expect(patchOptions([], null)).toEqual([]);
  });

  it('requests the default snapshot for the served patch or an unknown selection', () => {
    const opts = patchOptions(kept, { patch: '16.9', games: 900, updated_at: 'a' });
    expect(resolvePatch(null, opts)).toBeNull();
    expect(resolvePatch('16.9', opts)).toBeNull();
    expect(resolvePatch('16.19', opts)).toBe('16.19');
    expect(resolvePatch('16.20', opts)).toBeNull();
    expect(resolvePatch('12.1', opts)).toBeNull();
  });
});
