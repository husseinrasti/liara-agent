/** Compact per-app status for the side panel and app list (cached briefly). */
import { activeAlerts, type AlertRow } from '../agent/alerts';
import { getMemory, type ActionRecord } from '../agent/memory';
import { toolContextFor, type AgentRuntime } from '../agent/runtime';
import { getApp, getReleases, listApps } from '../liara/endpoints/apps';
import { getPlans } from '../liara/endpoints/account';
import { isDomainVerified, isSslActive, listDomains } from '../liara/endpoints/domains';
import { describeError } from '../liara/errors';
import { ageMinutes, appUrlFor } from '../tools/helpers';
import { releaseStateFa } from '../tools/liara/deploy';
import { collectMetrics } from '../tools/liara/observe';
import { httpProbe } from '../tools/local/http-probe';

export interface AppStatus {
  appName: string;
  url: string;
  level: 'ok' | 'degraded' | 'down' | 'off' | 'unknown';
  health: { status: number; ok: boolean; latencyMs: number | null } | null;
  plan: { id: string; ramMB: number; cpu: number; monthlyEstimateIRT: number | null } | null;
  memory: { pct: number | null; lastMB: number; limitMB: number | null } | null;
  cpu: { value: number; unit: string } | null;
  release: { tag: string | null; state: string; stateFa: string; ageMinutes: number | null } | null;
  scale: number | null;
  domains: { name: string; verified: boolean; sslActive: boolean }[];
  alerts: AlertRow[];
  watch: boolean;
  lastActions: ActionRecord[];
  error?: string;
}

const cache = new Map<string, { at: number; value: AppStatus }>();
const STATUS_TTL_MS = 10_000;

export async function appStatus(rt: AgentRuntime, appName: string, fresh = false): Promise<AppStatus> {
  const hit = cache.get(appName);
  if (hit && !fresh && Date.now() - hit.at < STATUS_TTL_MS) return { ...hit.value, alerts: activeAlerts(rt, appName) };
  const ctx = toolContextFor(rt);
  const [app, health, metrics, releases, domains, plans] = await Promise.allSettled([
    getApp(ctx.liara, appName),
    httpProbe(appUrlFor(ctx, appName), { samples: 1, timeoutMs: 8000, fetchImpl: ctx.httpFetch }),
    collectMetrics(ctx, appName, 15),
    getReleases(ctx.liara, appName, 1, 1),
    listDomains(ctx.liara, appName),
    getPlans(ctx.liara),
  ]);
  const v = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null);
  const a = v(app);
  const h = v(health);
  const m = v(metrics)?.digest;
  const r = v(releases)?.releases[0];
  const p = a ? v(plans)?.find((x) => x.id === a.planID) : null;
  const memory = getMemory(rt.deps.db, appName);
  const alerts = activeAlerts(rt, appName);
  const level: AppStatus['level'] = !a
    ? 'unknown'
    : a.scale === 0
      ? 'off'
      : !h || h.status === 0 || h.status >= 500
        ? 'down'
        : alerts.some((x) => x.severity !== 'info') || (m?.memory?.pctOfLimit ?? 0) >= 90 || (h.latencyMs?.avg ?? 0) > 2000
          ? 'degraded'
          : 'ok';
  const value: AppStatus = {
    appName,
    url: appUrlFor(ctx, appName),
    level,
    health: h ? { status: h.status, ok: h.ok, latencyMs: h.latencyMs?.avg ?? null } : null,
    plan: p ? { id: p.id, ramMB: p.ramMB, cpu: p.cpu, monthlyEstimateIRT: p.monthlyEstimateIRT } : a?.planID ? { id: a.planID, ramMB: 0, cpu: 0, monthlyEstimateIRT: null } : null,
    memory: m?.memory ? { pct: m.memory.lastPctOfLimit ?? m.memory.pctOfLimit, lastMB: m.memory.lastMB, limitMB: m.memory.limitMB } : null,
    cpu: m?.cpu ? { value: m.cpu.last, unit: m.cpu.unit } : null,
    release: r ? { tag: r.tag ?? null, state: r.state, stateFa: releaseStateFa(r.state), ageMinutes: ageMinutes(ctx, r.createdAt) } : null,
    scale: a?.scale ?? null,
    domains: (v(domains) ?? []).map((d) => ({ name: d.name, verified: isDomainVerified(d), sslActive: isSslActive(d) })),
    alerts,
    watch: memory.watch,
    lastActions: memory.lastActions.slice(0, 3),
    ...(app.status === 'rejected' ? { error: describeError(app.reason).userMessageFa } : {}),
  };
  cache.set(appName, { at: Date.now(), value });
  return value;
}

let appsCache: { at: number; value: unknown } | null = null;

export async function cachedApps(rt: AgentRuntime, fresh = false) {
  if (appsCache && !fresh && Date.now() - appsCache.at < 30_000) return appsCache.value as Awaited<ReturnType<typeof listApps>>;
  const value = await listApps(rt.deps.liara);
  appsCache = { at: Date.now(), value };
  return value;
}

export function invalidateStatus(appName?: string): void {
  if (appName) cache.delete(appName);
  else cache.clear();
  appsCache = null;
}
