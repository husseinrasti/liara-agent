/**
 * collect_evidence — fetches everything about an app in parallel and pre-processes it
 * into a compact EvidencePacket (≤ ~20KB) the diagnosis step reasons over once.
 */
import { z } from 'zod';
import { clusterLogs, extractStackTraces, isErrorLine } from '../../agent/evidence/logs';
import { trimPacket, type EvidencePacket } from '../../agent/evidence/packet';
import { getApp, getApplets, getReleases } from '../../liara/endpoints/apps';
import { getBalance } from '../../liara/endpoints/account';
import { getBuildLogs, getReleaseStatus, isCodeRelease, RELEASE_FAILED } from '../../liara/endpoints/deploy';
import { listDomains } from '../../liara/endpoints/domains';
import { describeError } from '../../liara/errors';
import type { AppEvent } from '../../liara/types';
import { ageMinutes, appNameSchema, appUrlFor, ok } from '../helpers';
import { planInfo } from '../liara/apps';
import { collectMetrics, countByReason, fetchEvents, fetchLogs } from '../liara/observe';
import { httpProbe } from '../local/http-probe';
import { defineTool, type ToolContext } from '../registry';

const LOW_BALANCE_HOURS = 24;

function eventTimeline(events: AppEvent[], max = 40) {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...events]
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.ts.localeCompare(a.ts))
    .slice(0, max)
    .map((e) => ({ ts: e.ts, reason: e.reason ?? null, message: e.message.slice(0, 240), severity: e.severity }));
}

async function buildLogFor(ctx: ToolContext, releaseID: string): Promise<string[]> {
  const logs = await getBuildLogs(ctx.liara, releaseID);
  const lines = (logs.buildOutput ?? []).map((o) => `${o.stream === 'STDERR' ? '[stderr] ' : ''}${o.line.replace(/\s+$/, '')}`);
  const failReason = logs.release?.failReason;
  if (failReason) lines.push(`[failReason] ${typeof failReason === 'string' ? failReason : JSON.stringify(failReason)}`);
  return lines.slice(-60);
}

export async function collectEvidence(ctx: ToolContext, appName: string, windowMinutes = 60): Promise<EvidencePacket> {
  const started = Date.now();
  const limitations = ['Liara API has no HTTP access logs or status-code histograms; site status comes from our own HTTP health check.'];
  const url = appUrlFor(ctx, appName);
  const [app, applets, releases, events, logs, metrics, health, domains, balance] = await Promise.allSettled([
    getApp(ctx.liara, appName),
    getApplets(ctx.liara, appName),
    getReleases(ctx.liara, appName, 1, 5),
    fetchEvents(ctx, appName, Math.max(windowMinutes, 120)),
    fetchLogs(ctx, appName, windowMinutes),
    collectMetrics(ctx, appName, windowMinutes),
    httpProbe(url, { samples: 2, timeoutMs: 8000, now: ctx.now, fetchImpl: ctx.httpFetch }),
    listDomains(ctx.liara, appName),
    getBalance(ctx.liara),
  ]);
  const failed = (name: string, r: PromiseSettledResult<unknown>) => {
    if (r.status === 'rejected') limitations.push(`${name} unavailable: ${describeError(r.reason).error}`);
  };
  for (const [n, r] of Object.entries({ app, applets, releases, events, logs, metrics, health, domains, balance })) failed(n, r);

  const appVal = app.status === 'fulfilled' ? app.value : null;
  const plan = appVal ? await planInfo(ctx, appVal.planID).catch(() => null) : null;
  const page = releases.status === 'fulfilled' ? releases.value : null;
  const currentId = page?.currentRelease ?? null;
  const current = page?.releases.find((r) => r._id === currentId) ?? page?.releases.find((r) => /READY/i.test(r.state)) ?? null;
  // Code deploys only: env changes are ENV_UPDATE releases on top of the same code [probe].
  const latest = page?.releases.find(isCodeRelease) ?? null;
  const newest = page?.releases[0] ?? null;

  let buildLog: string[] | undefined;
  let latestFailReason: string | undefined;
  if (latest && RELEASE_FAILED.test(latest.state)) {
    buildLog = await buildLogFor(ctx, latest._id).catch((err) => {
      limitations.push(`build log unavailable: ${describeError(err).error}`);
      return undefined;
    });
    const status = await getReleaseStatus(ctx.liara, latest._id).catch(() => null);
    if (status?.failReason) latestFailReason = typeof status.failReason === 'string' ? status.failReason : JSON.stringify(status.failReason);
  }

  const logLines = logs.status === 'fulfilled' ? logs.value : [];
  const evs = events.status === 'fulfilled' ? events.value : [];
  const h = health.status === 'fulfilled' ? health.value : null;
  const bal = balance.status === 'fulfilled' && balance.value.known ? balance.value.amountIRT : undefined;
  const hourly = appVal?.hourlyPrice ?? plan?.hourlyPriceIRT ?? null;

  const packet: EvidencePacket = {
    app: appVal
      ? {
          name: appVal.project_id,
          platform: appVal.type ?? null,
          status: appVal.status ?? null,
          scale: appVal.scale ?? null,
          plan: { id: appVal.planID ?? null, ramMB: plan?.ramMB ?? null, cpu: plan?.cpu ?? null },
          isDeployed: appVal.isDeployed ?? null,
          url,
          currentRelease: current
            ? { id: current._id, tag: current.tag ?? null, state: current.state, createdAt: current.createdAt ?? null, ageMinutes: ageMinutes(ctx, current.createdAt) }
            : null,
          lastDeployAgeMinutes: ageMinutes(ctx, latest?.createdAt),
          ...(newest && !isCodeRelease(newest) ? { lastEnvUpdateAgeMinutes: ageMinutes(ctx, newest.createdAt) } : {}),
        }
      : null,
    health: h ? { status: h.status, ok: h.ok, latencyMs: h.latencyMs?.avg ?? null, error: h.error, sampledAt: h.sampledAt } : null,
    applets: applets.status === 'fulfilled' ? applets.value.map((a) => ({ name: a.name, state: a.state ?? null, reason: a.reason ?? null })) : [],
    releases: (page?.releases ?? []).map((r) => ({
      id: r._id,
      kind: r.type ?? null,
      state: r.state,
      tag: r.tag ?? null,
      createdAt: r.createdAt ?? null,
      port: r.port ?? null,
      ...(r._id === latest?._id && latestFailReason ? { failReason: latestFailReason.slice(0, 300) } : {}),
    })),
    events: { windowMinutes: Math.max(windowMinutes, 120), byReason: countByReason(evs), timeline: eventTimeline(evs) },
    logs: {
      windowMinutes,
      totalLines: logLines.length,
      errorLines: logLines.filter((l) => isErrorLine(l.msg)).length,
      clusters: clusterLogs(logLines, 12),
      lastLines: logLines.slice(-30).map((l) => `${l.t.slice(11, 19)} ${l.msg}`.slice(0, 300)),
      stackTraces: extractStackTraces(logLines, 3, 25),
      ...(buildLog ? { buildLog } : {}),
    },
    metrics: metrics.status === 'fulfilled' ? { ...metrics.value.digest, unavailable: metrics.value.unavailable } : null,
    domains: domains.status === 'fulfilled' ? domains.value.map((d) => ({ id: d._id, name: d.name, status: d.status ?? null, certificatesStatus: d.certificatesStatus ?? null })) : [],
    account: bal === undefined ? null : { balanceIRT: bal, lowBalance: hourly ? bal < hourly * LOW_BALANCE_HOURS : bal <= 0 },
    signals: [],
    limitations,
    collectedAt: ctx.now().toISOString(),
    durationMs: Date.now() - started,
  };
  if (metrics.status === 'fulfilled' && metrics.value.unavailable.length) limitations.push(`some metrics unavailable: ${metrics.value.unavailable.join(', ')}`);
  return trimPacket(packet);
}

export function evidenceSummaryFa(p: EvidencePacket): string {
  const health = p.health ? (p.health.status ? `پاسخ سایت ${p.health.status}` : 'سایت پاسخ نداد') : 'سلامت سایت نامشخص';
  const errEvents = p.events.timeline.filter((e) => e.severity === 'error').length;
  const mem = p.metrics?.memory?.pctOfLimit != null ? `، رم ${p.metrics.memory.pctOfLimit}٪ سقف` : '';
  return `شواهد جمع شد: ${health}، ${p.logs.errorLines} خط خطا در لاگ، ${errEvents} رویداد مهم${mem}.`;
}

export const collectEvidenceTool = defineTool({
  name: 'collect_evidence',
  title: 'Collect evidence',
  description:
    'Gather everything needed to diagnose an app in one call (details, instances, releases, events, logs clustered by signature with stack traces, metrics summary, live HTTP health, domains, balance) as a compact evidence packet. Use this instead of calling the read tools one by one when investigating a problem.',
  input: z.object({ appName: appNameSchema, windowMinutes: z.number().int().min(5).max(1440).default(60) }),
  risk: 0,
  category: 'composite',
  describeFa: ({ appName }) => `جمع‌آوری شواهد برای بررسی ${appName}`,
  run: async ({ appName, windowMinutes }, ctx) => {
    const packet = await collectEvidence(ctx, appName, windowMinutes);
    return ok(packet, evidenceSummaryFa(packet));
  },
});
