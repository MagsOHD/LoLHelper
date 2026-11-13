// React bindings of the Meta page: status/stats queries, the tab-wide collection loop and the
// cache refresh that makes generation and the draft use freshly collected meta.
import { useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './client';
import { qk } from './hooks';
import { CollectController } from './metaCollect';

export const metaKeys = {
  status: ['meta-status'] as const,
  stats: (patch: string | null) => ['meta-stats', patch ?? 'default'] as const,
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

/** Mounted once in App: wires the collector to the query cache. */
export function useMetaCollectorBridge(): void {
  const qc = useQueryClient();
  useEffect(() => {
    metaCollector.setOnNewData(() => refreshMetaEverywhere(qc));
    return () => metaCollector.setOnNewData(null);
  }, [qc]);
}

export function useMetaCollection() {
  return useSyncExternalStore(metaCollector.subscribe, metaCollector.getSnapshot, metaCollector.getSnapshot);
}

/** Collector status; polled every 30 s while the server lock is held (cron running). */
export const useMetaStatus = () =>
  useQuery({
    queryKey: metaKeys.status,
    queryFn: api.metaStatus,
    retry: false,
    staleTime: 15_000,
    refetchInterval: (q) => (q.state.data?.collecting ? 30_000 : false),
  });

export const useMetaStats = (patch: string | null) =>
  useQuery({
    queryKey: metaKeys.stats(patch),
    queryFn: () => api.metaStats(patch),
    staleTime: 5 * 60_000,
  });

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
