/**
 * Background watcher: every interval, cheap checks for apps with watch=true
 * (health, metrics, recent events, scale), metric snapshots + baseline, pending
 * domain polls and a low-balance check. Raises deduplicated alerts; never fixes
 * anything by itself (optionally runs a diagnosis on critical alerts).
 */
import { getBalance } from '../liara/endpoints/account';
import { getApp } from '../liara/endpoints/apps';
import { appUrlFor, faNum, formatIRT } from '../tools/helpers';
import { collectMetrics, fetchEvents } from '../tools/liara/observe';
import { healthLineFa, httpProbe, type HealthResult } from '../tools/local/http-probe';
import { getTool, runTool } from '../tools/registry';
import { raiseAlert, resolveAlerts, type AlertInput, type AlertRow } from './alerts';
import { pollPendingDomains } from './domain/flow';
import { computeBaseline, getMemoryKey, setMemoryKey, watchedApps } from './memory';
import { toolContextFor, type AgentRuntime } from './runtime';
import { eventNameFa } from './verify';

const CRASH = /OOMKill|BackOff|CrashLoop|Exited/i;
const BASELINE_TTL_MS = 60 * 60_000;
const BALANCE_CHECK_MS = 30 * 60_000;

interface AppState {
  healthFails: number;
  latencyHigh: number;
  memHigh: number;
  /** consecutive checks with HTTP ok, no new crash events and RAM under 90% */
  healthyTicks: number;
  lastEventsAt?: number;
}

/** Healthy checks in a row before the app's earlier alerts are closed. */
const RESOLVE_AFTER_HEALTHY = 3;

export interface WatchReport {
  appName: string;
  healthStatus: number | null;
  alerts: AlertRow[];
}

export function hhmmTehran(d: Date): string {
  return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(d);
}

export class Watcher {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly state = new Map<string, AppState>();
  private lastBalanceCheck = 0;

  constructor(
    private readonly rt: AgentRuntime,
    private readonly opts: { intervalSec?: number; autoDiagnose?: boolean } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const ms = (this.opts.intervalSec ?? this.rt.deps.config.watcher.intervalSec) * 1000;
    this.timer = setInterval(() => void this.tick().catch((err) => this.rt.deps.logger.warn({ err: (err as Error).message }, 'watcher tick failed')), ms);
    this.timer.unref?.();
    this.rt.deps.logger.info({ intervalSec: ms / 1000 }, 'watcher started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over watched apps and apps with pending domains. */
  async tick(): Promise<WatchReport[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const db = this.rt.deps.db;
      const watched = watchedApps(db);
      const withDomains = (db.prepare("SELECT appName, value FROM app_memory WHERE key = 'pendingDomains'").all() as { appName: string; value: string }[])
        .filter((r) => (JSON.parse(r.value) as unknown[]).length > 0)
        .map((r) => r.appName);
      const reports: WatchReport[] = [];
      let hourlyTotal = 0;
      for (const appName of new Set([...watched, ...withDomains])) {
        const { report, hourly } = await this.checkApp(appName, watched.includes(appName));
        hourlyTotal += hourly;
        reports.push(report);
      }
      if (watched.length) await this.checkBalance(watched, hourlyTotal, reports);
      return reports;
    } finally {
      this.running = false;
    }
  }

  private async checkApp(appName: string, watched: boolean): Promise<{ report: WatchReport; hourly: number }> {
    const rt = this.rt;
    const ctx = toolContextFor(rt);
    const now = rt.now();
    const alerts: AlertInput[] = [];
    for (const o of await pollPendingDomains(ctx, appName).catch(() => [])) if (o.alert) alerts.push(o.alert);
    let health: HealthResult | null = null;
    let hourly = 0;
    if (watched) {
      const st = this.state.get(appName) ?? { healthFails: 0, latencyHigh: 0, memHigh: 0, healthyTicks: 0 };
      const [h, m, e, a] = await Promise.allSettled([
        httpProbe(appUrlFor(ctx, appName), { samples: 1, timeoutMs: 10_000, fetchImpl: ctx.httpFetch, now: ctx.now }),
        collectMetrics(ctx, appName, 15),
        fetchEvents(ctx, appName, 10),
        getApp(ctx.liara, appName),
      ]);
      health = h.status === 'fulfilled' ? h.value : null;
      const digest = m.status === 'fulfilled' ? m.value.digest : null;
      const app = a.status === 'fulfilled' ? a.value : null;
      hourly = app?.hourlyPrice ?? 0;
      rt.deps.db
        .prepare('INSERT INTO metric_snapshots (appName, ts, cpu, memMB, latencyMs, healthStatus) VALUES (?, ?, ?, ?, ?, ?)')
        .run(appName, now.toISOString(), digest?.cpu?.last ?? null, digest?.memory?.lastMB ?? null, health?.latencyMs?.avg ?? null, health?.status ?? null);
      let baseline = getMemoryKey(rt.deps.db, appName, 'baseline');
      if (!baseline || now.getTime() - Date.parse(baseline.computedAt) > BASELINE_TTL_MS) {
        baseline = computeBaseline(rt.deps.db, appName, now);
        setMemoryKey(rt.deps.db, appName, 'baseline', baseline, now);
      }
      if (health) {
        st.healthFails = health.ok ? 0 : st.healthFails + 1;
        if (st.healthFails >= 2) {
          alerts.push({ appName, severity: 'critical', title: `سایت ${appName} پاسخ نمی‌دهد`, summary: `در دو بررسی پشت‌سرهم: ${healthLineFa(health)}.`, suggestedPrompt: `سایت ${appName} از ساعت ${hhmmTehran(now)} پاسخ نمی‌دهد — بررسی کن` });
        }
        const latency = health.latencyMs?.avg ?? 0;
        const p50 = baseline.p50LatencyMs;
        st.latencyHigh = health.ok && latency > 1500 && p50 && latency > 3 * p50 ? st.latencyHigh + 1 : 0;
        if (st.latencyHigh >= 3) {
          alerts.push({ appName, severity: 'warning', title: `سایت ${appName} کند شده`, summary: `زمان پاسخ ${latency}ms است؛ بیش از سه برابر حالت عادی (${p50}ms).`, suggestedPrompt: `سایت ${appName} کند شده؛ علتش را پیدا کن` });
        }
      }
      const pct = digest?.memory?.lastPctOfLimit ?? null;
      st.memHigh = pct !== null && pct >= 90 ? st.memHigh + 1 : 0;
      if (st.memHigh >= 3) {
        alerts.push({ appName, severity: 'warning', title: `مصرف رم ${appName} نزدیک سقف است`, summary: `در سه بررسی پشت‌سرهم مصرف رم بالای ۹۰٪ سقف پلن بود (${pct}٪).`, suggestedPrompt: `مصرف رم ${appName} بالاست؛ بررسی کن` });
      }
      let crashCount = 0;
      if (e.status === 'fulfilled') {
        const since = st.lastEventsAt ?? now.getTime() - 10 * 60_000;
        const crashes = e.value.filter((ev) => CRASH.test(ev.reason ?? '') && Date.parse(ev.ts) > since);
        crashCount = crashes.length;
        if (crashes.length) {
          const reasons = [...new Set(crashes.map((c) => eventNameFa(c.reason ?? '') ?? c.reason))].join('، ');
          alerts.push({ appName, severity: 'critical', title: `کرش یا کمبود رم در ${appName}`, summary: `رویدادهای تازه: ${reasons} (${faNum(crashes.length)} بار).`, suggestedPrompt: `سرویس ${appName} کرش کرده؛ بررسی کن` });
        }
        st.lastEventsAt = now.getTime();
      }
      if (app?.scale === 0) {
        alerts.push({ appName, severity: 'critical', title: `سرویس ${appName} خاموش است`, summary: 'سرویس خاموش شده و سایت جواب نمی‌دهد.', suggestedPrompt: `سرویس ${appName} را بررسی کن و اگر لازم است روشنش کن` });
      }
      const healthy = Boolean(health?.ok) && crashCount === 0 && (pct === null || pct < 90) && app?.scale !== 0 && !alerts.length;
      st.healthyTicks = healthy ? st.healthyTicks + 1 : 0;
      // Healthy for a few checks in a row: close the app's earlier warning/critical alerts.
      if (st.healthyTicks === RESOLVE_AFTER_HEALTHY) resolveAlerts(rt, appName);
      this.state.set(appName, st);
    }
    const raised = alerts.map((al) => raiseAlert(rt, al)).filter((r): r is AlertRow => Boolean(r));
    if ((this.opts.autoDiagnose ?? rt.deps.config.watcher.autoDiagnose) && raised.some((r) => r.severity === 'critical')) await this.autoDiagnose(appName, raised);
    return { report: { appName, healthStatus: health?.status ?? null, alerts: raised }, hourly };
  }

  private async autoDiagnose(appName: string, raised: AlertRow[]): Promise<void> {
    const def = getTool('diagnose_app');
    if (!def) return;
    const res = await runTool(def, { appName }, toolContextFor(this.rt)).catch(() => null);
    if (!res?.ok) return;
    const summary = (res.data as { diagnosis?: { summaryFa?: string } }).diagnosis?.summaryFa;
    if (!summary) return;
    const update = this.rt.deps.db.prepare('UPDATE alerts SET summary = ? WHERE id = ?');
    for (const r of raised.filter((x) => x.severity === 'critical')) update.run(`${r.summary} تشخیص اولیه: ${summary}`, r.id);
  }

  private async checkBalance(watched: string[], hourlyTotal: number, reports: WatchReport[]): Promise<void> {
    const now = this.rt.now().getTime();
    if (now - this.lastBalanceCheck < BALANCE_CHECK_MS || hourlyTotal <= 0) return;
    this.lastBalanceCheck = now;
    const b = await getBalance(this.rt.deps.liara).catch(() => null);
    if (!b?.known || b.amountIRT >= hourlyTotal * 24) return;
    for (const appName of watched) {
      const row = raiseAlert(this.rt, {
        appName,
        severity: 'warning',
        title: 'موجودی حساب لیارا کم است',
        summary: `موجودی ${formatIRT(b.amountIRT)} برای کمتر از یک روز هزینه‌ی سرویس‌ها کافی است. شارژ حساب کاری است که فقط خودتان از پنل لیارا می‌توانید انجام دهید.`,
        suggestedPrompt: 'موجودی حسابم چقدر است و تا کی کافی است؟',
      });
      if (row) reports.find((r) => r.appName === appName)?.alerts.push(row);
    }
  }
}

/** Starts the watcher when WATCHER_ENABLED (called from the Next.js instrumentation hook). */
export function startWatcher(rt: AgentRuntime, opts: { intervalSec?: number; autoDiagnose?: boolean } = {}): Watcher | null {
  if (!rt.deps.config.watcher.enabled) return null;
  const w = new Watcher(rt, opts);
  w.start();
  return w;
}
