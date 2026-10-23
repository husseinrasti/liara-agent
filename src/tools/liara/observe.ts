import { z } from 'zod';
import { isErrorLine } from '../../agent/evidence/logs';
import { summarizeMetrics, type MetricsDigest } from '../../agent/evidence/metrics';
import { getApp, getApplets, getReleases } from '../../liara/endpoints/apps';
import { getEvents } from '../../liara/endpoints/events';
import { getLogs } from '../../liara/endpoints/logs';
import { getCpu, getMemory, getMetricsSummary, getNetRx, getNetTx } from '../../liara/endpoints/metrics';
import type { AppEvent, Release } from '../../liara/types';
import { appNameSchema, clip, faNum, minutesAgo, ok } from '../helpers';
import { defineTool, type ToolContext } from '../registry';
import { planInfo } from './apps';

export const MAX_LOG_LINES = 300;
export const MAX_EVENTS = 100;

export interface CompactLogLine {
  t: string;
  type?: string;
  msg: string;
}

export async function fetchLogs(ctx: ToolContext, appName: string, sinceMinutes: number): Promise<CompactLogLine[]> {
  const lines = await getLogs(ctx.liara, appName, minutesAgo(ctx, sinceMinutes));
  return lines.map((l) => ({ t: l.datetime, type: l.type ?? undefined, msg: clip(l.message.replace(/\s+$/, ''), 500) }));
}

export const getAppLogsTool = defineTool({
  name: 'get_app_logs',
  title: 'Get app logs',
  description:
    'Container stdout/stderr lines of the app for the last N minutes (max 300 lines, newest kept). filter="errors" keeps only error-looking lines. Liara provides NO HTTP access logs or status-code histograms; use http_health_check for live status.',
  input: z.object({
    appName: appNameSchema,
    sinceMinutes: z.number().int().min(1).max(1440).default(30),
    filter: z.enum(['all', 'errors']).default('all'),
  }),
  risk: 0,
  category: 'read',
  describeFa: (i) => `خواندن لاگ‌های ${i.appName} در ${i.sinceMinutes ?? 30} دقیقه‌ی اخیر`,
  run: async ({ appName, sinceMinutes, filter }, ctx) => {
    const all = await fetchLogs(ctx, appName, sinceMinutes);
    const errors = all.filter((l) => isErrorLine(l.msg));
    const selected = filter === 'errors' ? errors : all;
    const lines = selected.slice(-MAX_LOG_LINES);
    const data = { lines, truncated: selected.length > lines.length, stats: { total: all.length, errors: errors.length } };
    const summary = all.length
      ? `${all.length} خط لاگ در ${sinceMinutes} دقیقه‌ی اخیر؛ ${errors.length} خط شبیه خطا است.`
      : `در ${sinceMinutes} دقیقه‌ی اخیر هیچ لاگی ثبت نشده است.`;
    return ok(data, summary);
  },
});

export function countByReason(events: AppEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    const k = e.reason ?? 'unknown';
    counts[k] = (counts[k] ?? 0) + (e.count && e.count > 1 ? e.count : 1);
  }
  return counts;
}

export async function fetchEvents(ctx: ToolContext, appName: string, sinceMinutes: number): Promise<AppEvent[]> {
  return getEvents(ctx.liara, appName, { start: minutesAgo(ctx, sinceMinutes), end: ctx.now() });
}

export const getAppEventsTool = defineTool({
  name: 'get_app_events',
  title: 'Get app events',
  description:
    'Platform events for the app (Kubernetes-style: OOMKilled, BackOff/CrashLoop, Pulled, Scheduled, Killing…), newest first, max 100, plus counts by reason. Best first signal for crashes and memory kills.',
  input: z.object({ appName: appNameSchema, sinceMinutes: z.number().int().min(1).max(10_080).default(120) }),
  risk: 0,
  category: 'read',
  describeFa: (i) => `بررسی رویدادهای ${i.appName}`,
  run: async ({ appName, sinceMinutes }, ctx) => {
    const events = (await fetchEvents(ctx, appName, sinceMinutes)).reverse();
    const counts = countByReason(events);
    const errors = events.filter((e) => e.severity === 'error').length;
    const data = { events: events.slice(0, MAX_EVENTS), counts, truncated: events.length > MAX_EVENTS };
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, n]) => `${r}×${n}`)
      .join('، ');
    return ok(data, events.length ? `${events.length} رویداد (${errors} مورد مهم)${top ? `: ${top}` : ''}.` : 'رویداد خاصی ثبت نشده است.');
  },
});

export const getAppAppletsTool = defineTool({
  name: 'get_app_applets',
  title: 'Get app instances',
  description: 'Running instances (applets/pods) of the app with state and reason (e.g. Running, CrashLoopBackOff, OOMKilled) and the release tag each runs.',
  input: z.object({ appName: appNameSchema }),
  risk: 0,
  category: 'read',
  describeFa: ({ appName }) => `بررسی نمونه‌های در حال اجرای ${appName}`,
  run: async ({ appName }, ctx) => {
    const applets = await getApplets(ctx.liara, appName);
    const data = applets.map((a) => ({ name: a.name, state: a.state ?? null, reason: a.reason ?? null, releaseTag: a.release?.tag ?? null, ts: a.timestamp ?? null }));
    const running = data.filter((a) => /running|ready/i.test(a.state ?? '')).length;
    return ok(data, data.length ? `${running} از ${data.length} نمونه در حال اجراست.` : 'هیچ نمونه‌ی در حال اجرایی وجود ندارد (سرویس خاموش است یا هنوز منتشر نشده).');
  },
});

export function compactRelease(r: Release) {
  return {
    id: r._id,
    state: r.state,
    tag: r.tag ?? null,
    createdAt: r.createdAt ?? null,
    finishedAt: r.finishedAt ?? null,
    port: r.port ?? null,
    platform: r.type ?? r.projectType ?? null,
    commitMessage: r.gitInfo?.message ?? null,
    sourceAvailable: r.sourceAvailable ?? null,
  };
}

export const getAppReleasesTool = defineTool({
  name: 'get_app_releases',
  title: 'Get releases',
  description: 'Recent releases (deploys) of the app with state (e.g. READY, FAILED), tag and timestamps, and which one is current. Use to correlate problems with a recent deploy or pick a rollback target.',
  input: z.object({ appName: appNameSchema, count: z.number().int().min(1).max(30).default(10) }),
  risk: 0,
  category: 'read',
  describeFa: ({ appName }) => `بررسی نسخه‌های منتشرشده‌ی ${appName}`,
  run: async ({ appName, count }, ctx) => {
    const page = await getReleases(ctx.liara, appName, 1, count);
    const releases = page.releases.map(compactRelease);
    const current = page.currentRelease ?? null;
    const latest = releases[0];
    return ok(
      { current, total: page.total ?? releases.length, releases },
      latest ? `${releases.length} نسخه؛ آخرین نسخه ${latest.tag ?? latest.id} در وضعیت ${latest.state}.` : 'هنوز هیچ نسخه‌ای منتشر نشده است.',
    );
  },
});

export async function collectMetrics(ctx: ToolContext, appName: string, sinceMinutes: number): Promise<{ digest: MetricsDigest; unavailable: string[] }> {
  const since = minutesAgo(ctx, sinceMinutes);
  const app = await getApp(ctx.liara, appName).catch(() => null);
  const [plan, summary, cpu, mem, rx, tx] = await Promise.allSettled([
    planInfo(ctx, app?.planID),
    getMetricsSummary(ctx.liara, appName),
    getCpu(ctx.liara, appName, since),
    getMemory(ctx.liara, appName, since),
    getNetRx(ctx.liara, appName, since),
    getNetTx(ctx.liara, appName, since),
  ]);
  const val = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : undefined);
  const unavailable = (
    [
      ['summary', summary],
      ['cpu', cpu],
      ['memory', mem],
      ['network-receive', rx],
      ['network-transmit', tx],
    ] as const
  )
    .filter(([, r]) => r.status === 'rejected')
    .map(([n]) => n);
  const p = val(plan);
  const digest = summarizeMetrics({
    cpu: val(cpu),
    memory: val(mem),
    rx: val(rx),
    tx: val(tx),
    summary: val(summary),
    plan: p ? { ramMB: p.ramMB, cpu: p.cpu } : null,
  });
  return { digest, unavailable };
}

export function metricsLineFa(d: MetricsDigest): string {
  const parts: string[] = [];
  if (d.memory) parts.push(`رم: حداکثر ${faNum(d.memory.maxMB)} مگابایت${d.memory.pctOfLimit !== null ? ` (${faNum(d.memory.pctOfLimit)}٪ سقف پلن)` : ''}، روند ${trendFa(d.memory.trend)}`);
  if (d.cpu) parts.push(`پردازنده: حداکثر ${faNum(d.cpu.max)}${d.cpu.unit === 'percent_of_plan' ? '٪' : ' هسته'}`);
  return parts.length ? parts.join('؛ ') : 'در این بازه داده‌ای از مصرف منابع موجود نیست.';
}

export function trendFa(t: string): string {
  return t === 'rising' ? 'رو به افزایش' : t === 'falling' ? 'رو به کاهش' : 'ثابت';
}

export const getAppMetricsTool = defineTool({
  name: 'get_app_metrics',
  title: 'Get app metrics',
  description:
    'Summarized CPU, memory (vs plan limit), network and disk usage over the last N minutes: avg/max/last and trend (rising/falling/flat). memory.nearLimit=true means close to an out-of-memory kill.',
  input: z.object({ appName: appNameSchema, sinceMinutes: z.number().int().min(5).max(1440).default(60) }),
  risk: 0,
  category: 'read',
  describeFa: ({ appName }) => `بررسی مصرف منابع ${appName}`,
  run: async ({ appName, sinceMinutes }, ctx) => {
    const { digest, unavailable } = await collectMetrics(ctx, appName, sinceMinutes);
    return ok({ ...digest, unavailable }, metricsLineFa(digest));
  },
});

export const observeTools = [getAppLogsTool, getAppEventsTool, getAppAppletsTool, getAppReleasesTool, getAppMetricsTool];
