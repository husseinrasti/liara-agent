/** Layer 5 — dynamic context: Tehran time, selected app summary (cached 60s), app memory, active alerts. */
import { getTool, runTool } from '../../tools/registry';
import { activeAlerts } from '../alerts';
import { memorySummaryFa } from '../memory';
import { toolContextFor, type AgentRuntime } from '../runtime';
import type { AgentSession } from '../session';

const APP_CACHE_MS = 60_000;
const appCache = new Map<string, { at: number; text: string }>();

export function tehranTimeFa(now: Date): string {
  return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' }).format(now);
}

async function appSummary(rt: AgentRuntime, session: AgentSession, appName: string): Promise<string> {
  const hit = appCache.get(appName);
  if (hit && rt.now().getTime() - hit.at < APP_CACHE_MS) return hit.text;
  const def = getTool('get_app');
  const res = def ? await runTool(def, { appName }, toolContextFor(rt, session)) : null;
  const text = res?.ok ? `${res.summaryFa} آدرس: ${(res.data as { url?: string }).url ?? '—'}` : 'اطلاعات این سرویس فعلاً در دسترس نیست.';
  appCache.set(appName, { at: rt.now().getTime(), text });
  return text;
}

/** Drops cached app summaries (after a mutating action). */
export function invalidateAppContext(appName?: string): void {
  if (appName) appCache.delete(appName);
  else appCache.clear();
}

export async function buildContextFa(rt: AgentRuntime, session: AgentSession): Promise<string> {
  const lines = [`زمان فعلی (تهران): ${tehranTimeFa(rt.now())}`];
  if (session.appName) {
    lines.push(`سرویس انتخاب‌شده: ${session.appName} — ${await appSummary(rt, session, session.appName)}`);
    const memory = memorySummaryFa(rt.deps.db, session.appName, rt.now());
    if (memory) lines.push(`حافظه‌ی این سرویس:\n${memory}`);
    const alerts = activeAlerts(rt, session.appName).slice(0, 3);
    if (alerts.length) lines.push(`هشدارهای باز: ${alerts.map((a) => `${a.title} (${a.severity})`).join('؛ ')}`);
  } else {
    lines.push('هنوز سرویس خاصی انتخاب نشده است.');
  }
  if (session.summary) lines.push(`خلاصه‌ی بخش‌های قبلی گفت‌وگو:\n${session.summary}`);
  return `وضعیت فعلی:\n${lines.join('\n')}`;
}
