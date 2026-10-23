/**
 * act → wait → re-check. Combines the tool's own verify() with the playbook's
 * verify checks (when the action came from a recent diagnosis), emits
 * verify_result, audits it, remembers it, and schedules a +3 min re-check for
 * restart-type fixes (OOM often comes back).
 */
import { recordVerify } from '../db/repo';
import { getReleases } from '../liara/endpoints/apps';
import { RELEASE_READY } from '../liara/endpoints/deploy';
import { appUrlFor, minutesAgo } from '../tools/helpers';
import { crashEventsSince } from '../tools/liara/checks';
import { collectMetrics, fetchEvents, fetchLogs } from '../tools/liara/observe';
import { healthLineFa, httpProbe } from '../tools/local/http-probe';
import type { ToolContext, ToolDef, ToolResult } from '../tools/registry';
import { raiseAlert, resolveAlerts } from './alerts';
import { getMemoryKey, pushAction } from './memory';
import { getPlaybook } from './playbooks/load';
import type { Playbook, VerifyCheck } from './playbooks/schema';
import { toolContextFor, type AgentRuntime } from './runtime';
import type { AgentSession } from './session';

export interface VerifyResult {
  action: string;
  fixed: boolean;
  evidence: string[];
  nextSuggestion?: string;
}

export const FOLLOW_UP_MS = 3 * 60_000;
const RESTART_TYPE = new Set(['restart_app', 'scale_app', 'update_envs', 'resize_app']);
const DIAGNOSIS_FRESH_MS = 60 * 60_000;

const OPS: Record<string, (a: number, b: number) => boolean> = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

const FIELD_FA: Record<string, string> = {
  'memory.pctOfLimit': 'مصرف رم نسبت به سقف پلن',
  'memory.lastPctOfLimit': 'مصرف فعلی رم نسبت به سقف پلن',
  'memory.maxMB': 'بیشینه‌ی رم (مگابایت)',
  'cpu.max': 'بیشینه‌ی پردازنده',
  'cpu.last': 'مصرف فعلی پردازنده',
};
const PCT_FIELDS = /pct|cpu\./i;

/** Plain-Persian names for the event / log patterns the playbooks verify against. */
const MATCH_FA: [RegExp, string][] = [
  [/OOMKill/, 'بسته شدن برنامه به‌خاطر کمبود رم'],
  [/BackOff|CrashLoop/, 'کرش و راه‌اندازی پشت‌سرهم'],
  [/ECONNREFUSED|ETIMEDOUT/, 'خطای اتصال به دیتابیس'],
  [/ENOSPC/, 'پر شدن دیسک'],
  [/is not set/, 'خطای متغیر محیطی تعریف‌نشده'],
];
/** Plain-Persian name for an event reason or verify pattern (undefined when unknown). */
export const eventNameFa = (m: string) => MATCH_FA.find(([re]) => re.test(m))?.[1];
const numFa = (n: number) => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(n);

function pathGet(obj: unknown, p: string): unknown {
  return p.split('.').reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined), obj);
}

/** Runs playbook verify checks; every check is critical except when its data is unavailable. */
export async function runVerifyChecks(ctx: ToolContext, appName: string, checks: VerifyCheck[], since: Date): Promise<{ ok: boolean; evidence: string[] }> {
  const evidence: string[] = [];
  let ok = true;
  for (const c of checks) {
    try {
      if (c.kind === 'no_event') {
        const from = new Date(Math.max(since.getTime(), minutesAgo(ctx, c.withinMinutes).getTime()));
        const re = new RegExp(c.match, 'i');
        const n = (await fetchEvents(ctx, appName, c.withinMinutes + 5)).filter((e) => new Date(e.ts) >= from && re.test(`${e.reason ?? ''} ${e.message}`)).length;
        evidence.push(`${eventNameFa(c.match) ?? `رویداد ${c.match}`} بعد از اقدام: ${numFa(n)} بار`);
        if (n > 0) ok = false;
      } else if (c.kind === 'no_log') {
        const re = new RegExp(c.match, 'i');
        const n = (await fetchLogs(ctx, appName, c.withinMinutes)).filter((l) => new Date(l.t) >= since && re.test(l.msg)).length;
        evidence.push(eventNameFa(c.match) ? `لاگ‌های ${eventNameFa(c.match)} بعد از اقدام: ${numFa(n)} خط` : `خطوط لاگ شبیه «${c.match}» بعد از اقدام: ${numFa(n)}`);
        if (n > 0) ok = false;
      } else if (c.kind === 'health') {
        const h = await httpProbe(appUrlFor(ctx, appName), { samples: 2, timeoutMs: 8000, fetchImpl: ctx.httpFetch, now: ctx.now });
        evidence.push(healthLineFa(h));
        if (h.status !== c.status) ok = false;
      } else if (c.kind === 'metric') {
        const { digest } = await collectMetrics(ctx, appName, 10);
        const v = pathGet(digest, c.field);
        if (typeof v !== 'number') {
          evidence.push(`${FIELD_FA[c.field] ?? c.field}: داده‌ای در دسترس نیست`);
        } else {
          evidence.push(`${FIELD_FA[c.field] ?? c.field}: ${numFa(v)}${PCT_FIELDS.test(c.field) ? '٪' : ''}`);
          if (!OPS[c.op]!(v, c.value)) ok = false;
        }
      } else if (c.kind === 'release_ready') {
        const latest = (await getReleases(ctx.liara, appName, 1, 1)).releases[0];
        evidence.push(`آخرین نسخه: ${latest ? (RELEASE_READY.test(latest.state) ? 'آماده' : latest.state) : 'نامشخص'}`);
        if (!latest || !RELEASE_READY.test(latest.state)) ok = false;
      }
    } catch {
      evidence.push('یکی از بررسی‌ها انجام نشد (داده در دسترس نبود)');
    }
  }
  return { ok, evidence };
}

/** Playbook to verify against: explicit id, or the top cause of a fresh diagnosis that recommended this tool. */
export function playbookFor(rt: AgentRuntime, appName: string | undefined, tool: string, explicitId?: string): Playbook | undefined {
  if (explicitId) return getPlaybook(explicitId);
  if (!appName) return undefined;
  const d = getMemoryKey(rt.deps.db, appName, 'lastDiagnosis');
  if (!d?.topCause?.playbookId || rt.now().getTime() - Date.parse(d.ts) > DIAGNOSIS_FRESH_MS) return undefined;
  const pb = getPlaybook(d.topCause.playbookId);
  return pb && (d.recommendedTool === tool || pb.fixes.some((f) => f.tool === tool)) ? pb : undefined;
}

export function nextFixTitle(pb: Playbook | undefined, tool: string): string | undefined {
  if (!pb) return undefined;
  const fixes = [...pb.fixes].sort((a, b) => a.priority - b.priority);
  const i = fixes.findIndex((f) => f.tool === tool);
  const next = fixes[i + 1] ?? (i < 0 ? fixes[0] : undefined);
  return next ? next.title_fa.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').trim() : pb.advice_fa;
}

export interface VerifyActionInput {
  def: ToolDef;
  input: unknown;
  before: unknown;
  result: ToolResult<unknown>;
  auditId: number | null;
  playbookId?: string;
}

export async function verifyAction(rt: AgentRuntime, session: AgentSession, v: VerifyActionInput): Promise<VerifyResult> {
  const ctx = toolContextFor(rt, session);
  const appName = ((v.input as Record<string, unknown>)?.appName as string | undefined) ?? session.appName;
  const actedAt = (v.before as { at?: string } | undefined)?.at ? new Date((v.before as { at: string }).at) : rt.now();
  if (v.def.verifyDelayMs) await rt.sleep(v.def.verifyDelayMs);
  const own = await v.def.verify!(v.input, v.before, ctx, v.result);
  const pb = playbookFor(rt, appName, v.def.name, v.playbookId);
  const pbOutcome = pb && appName && pb.verify.length ? await runVerifyChecks(ctx, appName, pb.verify, actedAt) : { ok: true, evidence: [] };
  const fixed = own.ok && pbOutcome.ok;
  const evidence = mergeEvidence(own.evidence, pbOutcome.evidence);
  const nextSuggestion = fixed ? undefined : (nextFixTitle(pb, v.def.name) ?? 'دوباره شواهد را جمع کنم و بررسی کنم؟');
  session.emit({ type: 'verify_result', action: v.def.name, fixed, evidence, ...(nextSuggestion ? { nextSuggestion } : {}) });
  if (v.auditId !== null) recordVerify(rt.deps.db, v.auditId, { ok: fixed, evidence });
  if (appName) pushAction(rt.deps.db, appName, { tool: v.def.name, ts: rt.now().toISOString(), ok: true, fixed }, rt.now());
  if (fixed && appName) resolveAlerts(rt, appName);
  const turnedOff = v.def.name === 'scale_app' && (v.input as { on?: boolean })?.on === false;
  if (fixed && appName && RESTART_TYPE.has(v.def.name) && !turnedOff) scheduleFollowUp(rt, session, appName, v.def.name, actedAt);
  return { action: v.def.name, fixed, evidence, ...(nextSuggestion ? { nextSuggestion } : {}) };
}

/** One line per label («وضعیت سایت: …» from both the tool and the playbook check): first position, latest value. */
export function mergeEvidence(...lists: string[][]): string[] {
  const byLabel = new Map<string, string>();
  for (const line of lists.flat()) byLabel.set(line.split(':')[0]!.trim(), line);
  return [...byLabel.values()];
}

/** +3 min: if crash events or a failing health check are back, raise an alert. */
export function scheduleFollowUp(rt: AgentRuntime, session: AgentSession, appName: string, tool: string, actedAt: Date): void {
  rt.schedule(async () => {
    const ctx = toolContextFor(rt, session);
    const [crashes, health] = await Promise.all([
      crashEventsSince(ctx, appName, new Date(actedAt.getTime() + 60_000)).catch(() => []),
      httpProbe(appUrlFor(ctx, appName), { samples: 1, timeoutMs: 8000, fetchImpl: ctx.httpFetch }),
    ]);
    if (!crashes.length && health.ok) return;
    const why = crashes.length ? `${crashes.length} رویداد ${[...new Set(crashes.map((c) => c.reason))].join('، ')}` : healthLineFa(health);
    raiseAlert(
      rt,
      {
        appName,
        severity: 'critical',
        title: tool === 'restart_app' ? 'مشکل دوباره برگشت؛ ری‌استارت کافی نبود' : 'مشکل بعد از اقدام دوباره دیده شد',
        summary: `چند دقیقه بعد از ${tool} دوباره نشانه‌ی مشکل دیده شد: ${why}.`,
        suggestedPrompt: `مشکل ${appName} دوباره برگشته؛ دقیق‌تر بررسی کن و راه‌حل ماندگار پیشنهاد بده`,
      },
      [session.id],
    );
  }, FOLLOW_UP_MS);
}
