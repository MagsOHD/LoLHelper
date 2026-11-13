import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { metaKeys, refreshAfterPass } from './metaHooks';
import { LIMITS_POLL_MS, limitsRefetchInterval, RIOT_LIMITS_KEY } from './riotLimits';

describe('key limits refresh', () => {
  it('polls every 15 s while a collection runs, not otherwise', () => {
    expect(LIMITS_POLL_MS).toBe(15_000);
    expect(limitsRefetchInterval(true)).toBe(15_000);
    expect(limitsRefetchInterval(false)).toBe(false);
  });

  it('every pass invalidates the key limits and the collector status (refetched by the Méta page)', async () => {
    const qc = new QueryClient();
    let limitsCalls = 0;
    await qc.fetchQuery({ queryKey: RIOT_LIMITS_KEY, queryFn: async () => ++limitsCalls, staleTime: 60_000 });
    await qc.fetchQuery({ queryKey: metaKeys.status, queryFn: async () => 'status', staleTime: 60_000 });
    await qc.fetchQuery({ queryKey: metaKeys.stats(null), queryFn: async () => 'stats', staleTime: 60_000 });
    expect(qc.getQueryState(RIOT_LIMITS_KEY)?.isInvalidated).toBe(false);

    refreshAfterPass(qc);
    expect(qc.getQueryState(RIOT_LIMITS_KEY)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(metaKeys.status)?.isInvalidated).toBe(true);
    // The stats themselves are only refreshed when a pass added matches.
    expect(qc.getQueryState(metaKeys.stats(null))?.isInvalidated).toBe(false);
    // An invalidated query refetches on next use even though its staleTime has not elapsed.
    await qc.fetchQuery({ queryKey: RIOT_LIMITS_KEY, queryFn: async () => ++limitsCalls, staleTime: 60_000 });
    expect(limitsCalls).toBe(2);
  });

  it('stats keys carry the tier', () => {
    expect(metaKeys.stats('16.21', 'GOLD')).toEqual(['meta-stats', '16.21', 'GOLD']);
    expect(metaKeys.stats(null)).toEqual(['meta-stats', 'default', 'default']);
  });
});
