'use client';

/** Small polling hooks for the side panels (apps, status, alerts, health). */
import { useCallback, useEffect, useState } from 'react';
import type { AlertRow } from '@/src/agent/alerts';
import type { AppStatus } from '@/src/server/status';

export interface AppSummary {
  name: string;
  platform: string;
  scale: number | null;
  planID: string | null;
  isDeployed: boolean | null;
}

function usePoll<T>(url: string | null, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    async (fresh = false) => {
      if (!url) return;
      setLoading(true);
      try {
        const res = await fetch(fresh ? `${url}${url.includes('?') ? '&' : '?'}fresh=1` : url);
        const j = (await res.json()) as T & { ok?: boolean };
        setData(j);
        setError(res.ok === false || j.ok === false);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url, ...deps],
  );
  useEffect(() => {
    setData(null);
    if (!url) return;
    void load();
    const t = setInterval(() => void load(), intervalMs);
    return () => clearInterval(t);
  }, [url, intervalMs, load]);
  return { data, error, loading, reload: load };
}

export function useApps() {
  return usePoll<{ ok: boolean; apps?: AppSummary[]; mode?: string; demoAppName?: string | null; error?: string }>('/api/apps', 60_000);
}

export function useStatus(appName: string | null) {
  return usePoll<{ ok: boolean; status?: AppStatus }>(appName ? `/api/apps/${encodeURIComponent(appName)}/status` : null, 30_000);
}

export function useAlerts(appName: string | null, bump: number) {
  return usePoll<{ ok: boolean; alerts?: AlertRow[] }>(appName ? `/api/alerts?appName=${encodeURIComponent(appName)}` : '/api/alerts', 60_000, [bump]);
}

export interface HealthInfo {
  ok: boolean;
  mode: 'live' | 'simulated';
  liara: { ok: boolean; status: number };
  llm: { ok: boolean; provider: string; model: string; error?: string };
  watcher: boolean;
}

export function useHealth() {
  return usePoll<HealthInfo>('/api/health', 120_000);
}
