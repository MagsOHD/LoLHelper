import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRiotLimits, formatKeyLimits, formatKeyUsage, normalizeRiotLimits, windowLabel } from './riotLimits';
import { getTransport, setTransportForTests } from './riot';
import { normalizeProfile } from './draft';
import { installWindow, json } from './__fixtures__/fakes';

afterEach(() => {
  vi.unstubAllGlobals();
  setTransportForTests(null);
});

const RAW = {
  app: [
    { limit: 100, window: 120, count: 41, at: '2026-11-13T20:00:00Z' },
    { limit: 20, window: 1, count: 3, at: '2026-11-13T20:00:00Z' },
    { limit: 'x', window: 10 },
  ],
  collector_share: 0.6,
  user_share: 0.95,
};

describe('key limits (r=riot-limits)', () => {
  it('normalizes and formats the Méta page line', () => {
    const l = normalizeRiotLimits(RAW)!;
    expect(l.app.map((w) => [w.limit, w.window])).toEqual([[20, 1], [100, 120]]);
    expect(formatKeyLimits(l)).toBe('Limite de la clé : 20 requêtes / s · 100 requêtes / 2 min · collecte automatique à 60 % de la limite');
    expect(formatKeyUsage(l)).toBe('Dernier relevé : 41/100 sur 2 min. Le site répond « limite atteinte » au-delà de 95 % ; chaque navigateur vise 30 % au plus.');
    const assumed = normalizeRiotLimits({ app: [{ limit: 100, window: 120, count: 0, at: null }] })!;
    expect(assumed.collector_share).toBe(0.6);
    expect(formatKeyUsage(assumed)).toMatch(/^Valeurs par défaut/);
    expect(normalizeRiotLimits({ app: [] })).toBeNull();
    expect(normalizeRiotLimits(null)).toBeNull();
    expect([1, 10, 120, 600, 3600].map(windowLabel)).toEqual(['s', '10 s', '2 min', '10 min', '1 h']);
  });

  it('fetches with the app password, seeds the browser limiter, null when not deployed', async () => {
    installWindow('');
    setTransportForTests(null);
    const fetchMock = vi.fn(async () => json({ ...RAW, app: [{ limit: 500, window: 10, count: 1, at: 'x' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const l = await fetchRiotLimits();
    expect(l?.app[0].limit).toBe(500);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('r=riot-limits');
    expect(getTransport().limiter.limits).toEqual([[150, 10_000]]);
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Route inconnue.' }, 404)));
    expect(await fetchRiotLimits()).toBeNull();
  });
});

describe('timeline facts in the shared document', () => {
  it('normalizeProfile keeps style.timeline (rounded, lanes validated)', () => {
    const p = normalizeProfile({
      puuid: 'abc', source: 'scouting', masteries: [], recent: { games: 3 }, fetched_at: 'x',
      style: {
        games: 3, wins: 2, kills: 5, deaths: 3, assists: 7, cs_per_min: 6, vision_per_min: 1, damage_per_min: 600,
        kill_participation: 0.5, solo_kills: 1, first_blood_rate: 0.3, early_lead: null, turret_takedowns: 1, avg_game_minutes: 28,
        timeline: { games: 2, gold_diff_10: 25.4, cs_10: 76.55, kills_before_10: 1.5, deaths_before_10: 1, first_gank_minute: 3.333,
          first_gank_lane: 'SUPPORT', first_back_minute: null, wards_per_min: 0.26, level6_minute: 6.417, extra: 1 },
      },
    })!;
    expect(p.style?.timeline).toEqual({
      games: 2, gold_diff_10: 25.4, cs_10: 76.55, kills_before_10: 1.5, deaths_before_10: 1, first_gank_minute: 3.33,
      first_gank_lane: null, first_back_minute: null, wards_per_min: 0.26, level6_minute: 6.42,
    });
    const without = normalizeProfile({ puuid: 'abc', source: 'game', masteries: [], recent: {}, style: { games: 1, timeline: { games: 0 } } })!;
    expect(without.style && 'timeline' in without.style).toBe(false);
  });
});
