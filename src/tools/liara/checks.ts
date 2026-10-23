/** Shared post-action checks used by verify() of mutating tools. Evidence strings are Persian. */
import { getApplets } from '../../liara/endpoints/apps';
import { getEvents } from '../../liara/endpoints/events';
import { healthLineFa, waitForHealthy, type HealthResult } from '../local/http-probe';
import { appUrlFor } from '../helpers';
import { liveReleases, ofRelease } from './observe';
import type { ToolContext, VerifyOutcome } from '../registry';

export const CRASH_REASON = /OOMKill|BackOff|CrashLoop|Exited|Fail|Unhealthy|Evict|Error/i;

export async function appletsState(ctx: ToolContext, appName: string) {
  const applets = await getApplets(ctx.liara, appName);
  const states = applets.map((a) => (a.state ?? 'unknown').toString());
  const running = states.filter((s) => /running|ready|up/i.test(s)).length;
  return { applets, states, running, allRunning: applets.length > 0 && running === applets.length };
}

/** Crash events since `since` from `releaseID`, else from the running release and newer attempts. */
export async function crashEventsSince(ctx: ToolContext, appName: string, since: Date, releaseID?: string) {
  const [events, running] = await Promise.all([
    getEvents(ctx.liara, appName, { start: since, end: ctx.now() }),
    releaseID ? Promise.resolve(releaseID) : liveReleases(ctx, appName).catch(() => null),
  ]);
  return ofRelease(events, running).filter((e) => new Date(e.ts) >= since && CRASH_REASON.test(e.reason ?? ''));
}

export async function healthOf(ctx: ToolContext, appName: string, deadlineMs = 45_000): Promise<HealthResult> {
  return waitForHealthy(appUrlFor(ctx, appName), { deadlineMs, intervalMs: 5000, sleep: ctx.sleep, timeoutMs: 8000, fetchImpl: ctx.httpFetch });
}

/** Standard "is the app up again?" verification: applets running (when the API has them), no new crash events, HTTP healthy. */
export async function verifyAppHealthy(ctx: ToolContext, appName: string, since: Date, releaseID?: string): Promise<VerifyOutcome> {
  const evidence: string[] = [];
  let ok = true;
  const [applets, crashes, health] = await Promise.allSettled([
    appletsState(ctx, appName),
    crashEventsSince(ctx, appName, since, releaseID),
    healthOf(ctx, appName),
  ]);
  if (applets.status === 'fulfilled') {
    const a = applets.value;
    evidence.push(`نمونه‌های در حال اجرا: ${a.running.toLocaleString('fa-IR')} از ${a.applets.length.toLocaleString('fa-IR')}${a.allRunning ? '' : ` (${a.states.join('، ')})`}`);
    if (!a.allRunning) ok = false;
  }
  // else: new-infrastructure apps have no applets API (500) [probe]; crash events and HTTP health decide.
  if (crashes.status === 'fulfilled') {
    const reasons = [...new Set(crashes.value.map((e) => e.reason))].join('، ');
    evidence.push(`رویدادهای خرابی بعد از اقدام: ${crashes.value.length.toLocaleString('fa-IR')} بار${reasons ? ` (${reasons})` : ''}`);
    if (crashes.value.length > 0) ok = false;
  }
  if (health.status === 'fulfilled') {
    evidence.push(healthLineFa(health.value));
    if (!health.value.ok) ok = false;
  } else {
    evidence.push('بررسی سلامت سایت انجام نشد');
    ok = false;
  }
  return { ok, evidence };
}
