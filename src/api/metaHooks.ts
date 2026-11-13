// React bindings of the Meta page: status/stats queries, the tab-wide collection loop and the
// cache refresh that makes generation and the draft use freshly collected meta.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './client';
import { qk } from './hooks';
import { CollectController } from './metaCollect';
import { RIOT_LIMITS_KEY } from './riotLimits';
import {
  chooseAdviceTier,
  loadTierOverride,
  saveTierOverride,
  subscribeTierOverride,
  type AdviceTierChoice,
} from './metaRank';
import type { MetaTier, Rank } from './types';

export const metaKeys = {
  status: ['meta-status'] as const,
  stats: (patch: string | null, tier: MetaTier | null = null) => ['meta-stats', patch ?? 'default', tier ?? 'default'] as const,
  allStats: ['meta-stats'] as const,
};

/** Shared by every page of the tab: never two loops at once. */
export const metaCollector = new CollectController((password) => api.collectMeta(password));

/** Drops every cached meta snapshot (module caches + queries using them). */
export function refreshMetaEverywhere(qc: QueryClient): void {
  api.invalidateMeta();
  void qc.invalidateQueries({ queryKey: metaKeys.allStats });
  void qc.invalidateQueries({ queryKey: metaKeys.status });
  void qc.invalidateQueries({ queryKey: qk.meta });
  // The draft advisor captured the meta when it was built.
  void qc.invalidateQueries({ queryKey: ['draft-engine'] });
}

/** After every collection pass: the key limits line and the per-tier progress are re-read. */
export function refreshAfterPass(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: RIOT_LIMITS_KEY });
  void qc.invalidateQueries({ queryKey: metaKeys.status });
}

/** Mounted once in App: wires the collector to the query cache. */
export function useMetaCollectorBridge(): void {
  const qc = useQueryClient();
  useEffect(() => {
    metaCollector.setOnNewData(() => refreshMetaEverywhere(qc));
    metaCollector.setOnPass(() => refreshAfterPass(qc));
    return () => {
      metaCollector.setOnNewData(null);
      metaCollector.setOnPass(null);
    };
  }, [qc]);
}

export function useMetaCollection() {
  return useSyncExternalStore(metaCollector.subscribe, metaCollector.getSnapshot, metaCollector.getSnapshot);
}

/** Collector status; polled every 30 s while the server lock is held (cron running). */
export const useMetaStatus = (enabled = true) =>
  useQuery({
    queryKey: metaKeys.status,
    queryFn: api.metaStatus,
    retry: false,
    staleTime: 15_000,
    enabled,
    refetchInterval: (q) => (q.state.data?.collecting ? 30_000 : false),
  });

export const useMetaStats = (patch: string | null, tier: MetaTier | null = null, enabled = true) =>
  useQuery({
    queryKey: metaKeys.stats(patch, tier),
    queryFn: () => api.metaStats(patch, tier),
    staleTime: 5 * 60_000,
    enabled,
  });

/** Tier chosen on the Méta page for the advice (null = automatic), shared by every component of the tab. */
export function useTierOverride(): [MetaTier | null, (t: MetaTier | null) => void] {
  const value = useSyncExternalStore(subscribeTierOverride, loadTierOverride, loadTierOverride);
  const set = useCallback((t: MetaTier | null) => saveTierOverride(t), []);
  return [value, set];
}

/**
 * Tier used by generation and the draft for these friends' ranks; null while r=meta-status loads
 * (an unavailable status gives the server's default tier).
 */
export function useAdviceTier(ranks: readonly (Rank | null | undefined)[], enabled = true): AdviceTierChoice | null {
  const status = useMetaStatus(enabled);
  const [override] = useTierOverride();
  const key = ranks.map((r) => (r ? `${r.queue}:${r.tier}:${r.division}` : '-')).join(',');
  const tiers = status.data?.tiers;
  return useMemo(() => {
    if (status.isPending && enabled) return null;
    return chooseAdviceTier({ ranks, tiers: tiers ?? [], override });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tiers, override, status.isPending, enabled]);
}

// The admin password never touches localStorage: this tab only, gone when it closes.
const ADMIN_KEY = 'lolhelper:admin-password';

export function loadAdminPassword(): string {
  try {
    return window.sessionStorage.getItem(ADMIN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAdminPassword(value: string): void {
  try {
    if (value) window.sessionStorage.setItem(ADMIN_KEY, value);
    else window.sessionStorage.removeItem(ADMIN_KEY);
  } catch {
    /* storage unavailable: the field keeps it for this page view */
  }
}
