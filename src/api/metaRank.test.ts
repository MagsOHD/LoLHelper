import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseAdviceTier,
  describeAdviceTier,
  fallbackTier,
  formatWindow,
  loadTierOverride,
  medianTier,
  normalizeTierProgress,
  normalizeWindow,
  saveTierOverride,
  soloRankScore,
  subscribeTierOverride,
  tierLabel,
  toMetaTier,
  type MetaTierProgress,
} from './metaRank';
import type { MetaTier, Rank } from './types';
import { META_TIERS } from './types';
import { installWindow } from './__fixtures__/fakes';

const solo = (tier: string, division = 'II'): Rank => ({ queue: 'RANKED_SOLO_5x5', tier, division, lp: 10, wins: 5, losses: 5 });
const flex = (tier: string): Rank => ({ queue: 'RANKED_FLEX_SR', tier, division: 'I', lp: 10, wins: 5, losses: 5 });
const progress = (games: Partial<Record<MetaTier, number>>): MetaTierProgress[] =>
  META_TIERS.map((tier) => ({ tier, patch: '16.22', games: games[tier] ?? 0, target: 500, oldest: '', newest: '' }));

afterEach(() => {
  saveTierOverride(null);
  vi.unstubAllGlobals();
});

describe('tier values and labels', () => {
  it('maps tiers, old apex names and garbage', () => {
    expect(toMetaTier('GOLD')).toBe('GOLD');
    expect(toMetaTier('emerald')).toBe('EMERALD');
    for (const apex of ['MASTER', 'GRANDMASTER', 'CHALLENGER', 'master_plus']) expect(toMetaTier(apex)).toBe('MASTER_PLUS');
    expect(toMetaTier('UNRANKED')).toBeNull();
    expect(toMetaTier(3)).toBeNull();
    expect(META_TIERS.map(tierLabel)).toEqual(['Fer', 'Bronze', 'Argent', 'Or', 'Platine', 'Émeraude', 'Diamant', 'Master+']);
  });

  it('normalizes r=meta-status tiers (one per tier, latest patch, META_TIERS order) and the window', () => {
    const list = normalizeTierProgress([
      { tier: 'MASTER_PLUS', patch: '16.22', games: 500, target: 500, oldest: 1_760_000_000_000, newest: '2026-11-13T10:00:00Z' },
      { tier: 'GOLD', patch: '16.21', games: 500, target: 500 },
      { tier: 'GOLD', patch: '16.22', games: 412, target: 500, newest: 1_763_000_000 },
      { tier: 'NOPE', games: 3 },
      'x',
    ]);
    expect(list.map((t) => [t.tier, t.patch, t.games])).toEqual([['GOLD', '16.22', 412], ['MASTER_PLUS', '16.22', 500]]);
    expect(list[0].newest).toBe(new Date(1_763_000_000_000).toISOString());
    expect(list[1].oldest).toBe(new Date(1_760_000_000_000).toISOString());
    expect(normalizeTierProgress({ SILVER: { patch: '16.22', games: 7, target: 500 } })).toMatchObject([{ tier: 'SILVER', games: 7 }]);
    expect(normalizeTierProgress(undefined)).toEqual([]);

    const w = normalizeWindow({ start: 4, end: 15, open: false });
    expect(w).toEqual({ start: 4, end: 15, open: false });
    expect(formatWindow(w!)).toBe('Collecte automatique entre 4 h et 15 h');
    expect(normalizeWindow({ start: '4' })).toBeNull();
    expect(normalizeWindow(null)).toBeNull();
  });
});

describe('friends\' rank -> tier', () => {
  it('scores solo ranks only and takes the median (unranked ignored)', () => {
    expect(soloRankScore(solo('IRON', 'IV'))).toBe(0);
    expect(soloRankScore(solo('DIAMOND', 'I'))).toBe(27);
    expect(soloRankScore(solo('CHALLENGER', 'I'))).toBe(30);
    expect(soloRankScore(flex('GOLD'))).toBeNull();
    expect(soloRankScore(null)).toBeNull();

    expect(medianTier([solo('GOLD', 'I'), solo('PLATINUM', 'II'), null, solo('PLATINUM', 'I'), flex('IRON')])).toEqual({ tier: 'PLATINUM', ranked: 3 });
    // Even count: halfway between Gold II (14) and Diamond IV (24) = 19 -> Platinum.
    expect(medianTier([solo('GOLD'), solo('DIAMOND', 'IV')]).tier).toBe('PLATINUM');
    expect(medianTier([solo('MASTER'), solo('GRANDMASTER')]).tier).toBe('MASTER_PLUS');
    expect(medianTier([null, flex('GOLD')])).toEqual({ tier: null, ranked: 0 });
  });

  it('automatic = median tier when it has enough games', () => {
    const c = chooseAdviceTier({ ranks: [solo('GOLD'), solo('GOLD', 'I'), null], tiers: progress({ GOLD: 412, MASTER_PLUS: 500 }) });
    expect(c).toMatchObject({ tier: 'GOLD', auto: 'GOLD', requested: 'GOLD', mode: 'auto', ranked: 2, fallback: false, games: 412 });
    expect(describeAdviceTier(c)).toBe('Rang solo médian de tes amis (2 classés) : Or.');
  });

  it('nobody ranked: Master+, or the tier with most games when Master+ has too few', () => {
    expect(chooseAdviceTier({ ranks: [null], tiers: progress({ GOLD: 300, MASTER_PLUS: 120 }) }).tier).toBe('MASTER_PLUS');
    const c = chooseAdviceTier({ ranks: [], tiers: progress({ GOLD: 300, SILVER: 200, MASTER_PLUS: 20 }) });
    expect(c).toMatchObject({ tier: 'GOLD', auto: 'GOLD', fallback: false });
    expect(describeAdviceTier(c)).toMatch(/^Aucun ami classé en solo : Or par défaut\./);
  });

  it('falls back to the nearest tier with ≥ 100 games (higher on ties), else the most played', () => {
    const games = new Map<MetaTier, number>([['SILVER', 150], ['GOLD', 30], ['PLATINUM', 150], ['DIAMOND', 400]]);
    expect(fallbackTier('GOLD', games)).toBe('PLATINUM');
    expect(fallbackTier('IRON', games)).toBe('SILVER');
    expect(fallbackTier('DIAMOND', games)).toBe('DIAMOND');
    expect(fallbackTier('GOLD', new Map([['GOLD', 30], ['IRON', 60]]))).toBe('IRON');
    expect(fallbackTier('GOLD', new Map())).toBe('GOLD');

    const c = chooseAdviceTier({ ranks: [solo('GOLD')], tiers: progress({ GOLD: 30, PLATINUM: 150, SILVER: 99 }) });
    expect(c).toMatchObject({ tier: 'PLATINUM', requested: 'GOLD', fallback: true, games: 150, requestedGames: 30 });
    expect(describeAdviceTier(c)).toMatch(/Or n’a que 30 parties : les conseils utilisent Platine/);
  });

  it('a manual override wins over the ranks (still with the fallback)', () => {
    const tiers = progress({ GOLD: 500, IRON: 10, BRONZE: 200 });
    expect(chooseAdviceTier({ ranks: [solo('GOLD')], tiers, override: 'BRONZE' })).toMatchObject({ tier: 'BRONZE', auto: 'GOLD', mode: 'override', fallback: false });
    expect(chooseAdviceTier({ ranks: [solo('GOLD')], tiers, override: 'IRON' })).toMatchObject({ tier: 'BRONZE', requested: 'IRON', fallback: true });
  });

  it('per-tier progress unknown (older server): no fallback; server default when nothing points to a tier', () => {
    expect(chooseAdviceTier({ ranks: [], tiers: [] })).toMatchObject({ tier: null, auto: 'MASTER_PLUS', games: null });
    expect(chooseAdviceTier({ ranks: [solo('SILVER')], tiers: [] }).tier).toBe('SILVER');
    expect(chooseAdviceTier({ ranks: [], tiers: [], override: 'IRON' }).tier).toBe('IRON');
  });
});

describe('override storage', () => {
  it('is kept in localStorage and notifies subscribers', () => {
    const win = installWindow('');
    const l = vi.fn();
    const off = subscribeTierOverride(l);
    expect(loadTierOverride()).toBeNull();
    saveTierOverride('EMERALD');
    expect(win.localStorage.getItem('lolhelper:meta-tier')).toBe('EMERALD');
    expect(loadTierOverride()).toBe('EMERALD');
    win.localStorage.setItem('lolhelper:meta-tier', 'garbage');
    expect(loadTierOverride()).toBeNull();
    saveTierOverride(null);
    expect(win.localStorage.getItem('lolhelper:meta-tier')).toBeNull();
    expect(l).toHaveBeenCalledTimes(2);
    off();
  });

  it('works without storage (memory only)', () => {
    vi.stubGlobal('window', undefined);
    saveTierOverride('IRON');
    expect(loadTierOverride()).toBe('IRON');
  });
});
