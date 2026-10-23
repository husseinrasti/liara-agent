import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../events';
import { fakeAgent, healthyAppRoutes, TEST_NOW } from '../../test-utils/fake-agent';
import { getTool, runTool } from '../../tools/registry';
import { activeAlerts, raiseAlert } from '../alerts';
import { getMemoryKey, setMemoryKey } from '../memory';
import { toolContextFor } from '../runtime';
import { AgentSession } from '../session';
import { FOLLOW_UP_MS, mergeEvidence, runVerifyChecks, verifyAction } from '../verify';
import '../tools';

const ns = (iso: string) => `${Date.parse(iso)}000000`;
const oomEvent = (iso: string) => ({ data: [{ metaData: {}, values: [[ns(iso), JSON.stringify({ reason: 'OOMKilled', message: 'OOM killed', type: 'Warning' })]] }] });

function setup(httpStatus = 200) {
  const routes = healthyAppRoutes();
  const agent = fakeAgent({ routes, httpStatus });
  const session = AgentSession.create(agent.rt, { appName: 'shop' });
  const events: AgentEvent[] = [];
  agent.rt.bus.subscribe(session.id, (e) => events.push(e));
  // a fresh diagnosis that recommended restart_app for an OOM
  setMemoryKey(agent.rt.deps.db, 'shop', 'lastDiagnosis', {
    ts: TEST_NOW.toISOString(),
    summaryFa: 'رم پر شده',
    severity: 'critical',
    topCause: { title_fa: 'پر شدن حافظه', playbookId: 'oom_kill', confidence: 0.9 },
    recommendedTool: 'restart_app',
  });
  return { ...agent, routes, session, events };
}

async function restartAndVerify(s: ReturnType<typeof setup>) {
  const def = getTool('restart_app')!;
  const ctx = toolContextFor(s.rt, s.session);
  const before = await def.snapshot!({ appName: 'shop' }, ctx);
  const result = await runTool(def, { appName: 'shop' }, ctx);
  return verifyAction(s.rt, s.session, { def, input: { appName: 'shop' }, before, result, auditId: null });
}

describe('verifyAction', () => {
  it('fixed: tool checks + playbook checks pass → green strip, memory, +3 min follow-up, alerts closed', async () => {
    const s = setup();
    raiseAlert(s.rt, { appName: 'shop', severity: 'critical', title: 'کرش یا کمبود رم در shop', summary: 's', suggestedPrompt: 'p' });
    const v = await restartAndVerify(s);
    expect(v.fixed).toBe(true);
    expect(activeAlerts(s.rt, 'shop')).toHaveLength(0);
    expect(v.evidence.join(' ')).toContain('بسته شدن برنامه به‌خاطر کمبود رم بعد از اقدام: ۰ بار');
    expect(s.events.find((e) => e.type === 'verify_result')).toMatchObject({ action: 'restart_app', fixed: true });
    expect(getMemoryKey(s.rt.deps.db, 'shop', 'lastActions')[0]).toMatchObject({ tool: 'restart_app', fixed: true });
    expect(s.scheduled.map((x) => x.ms)).toContain(FOLLOW_UP_MS);
  });

  it('not fixed: OOM again after the restart → red strip with the next playbook fix', async () => {
    const s = setup();
    s.routes['GET /v1/projects/shop/events'] = { body: oomEvent('2026-10-22T12:00:30Z') };
    const v = await restartAndVerify(s);
    expect(v.fixed).toBe(false);
    expect(v.nextSuggestion).toContain('ارتقای پلن');
    expect(s.scheduled).toHaveLength(0);
  });

  it('follow-up re-check raises an alert when the problem comes back', async () => {
    const s = setup();
    await restartAndVerify(s);
    s.routes['GET /v1/projects/shop/events'] = { body: oomEvent('2026-10-22T12:02:30Z') };
    await s.scheduled.find((x) => x.ms === FOLLOW_UP_MS)!.fn();
    const alerts = activeAlerts(s.rt, 'shop');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', title: 'مشکل دوباره برگشت؛ ری‌استارت کافی نبود' });
    expect(s.events.some((e) => e.type === 'alert')).toBe(true);
  });
});

describe('runVerifyChecks', () => {
  it('fails on a bad health status and tolerates unavailable metrics', async () => {
    const s = setup(502);
    const ctx = toolContextFor(s.rt, s.session);
    const res = await runVerifyChecks(
      ctx,
      'shop',
      [
        { kind: 'health', status: 200 },
        { kind: 'metric', field: 'memory.lastPctOfLimit', op: '<', value: 85 },
        { kind: 'release_ready' },
      ],
      TEST_NOW,
    );
    expect(res.ok).toBe(false);
    expect(res.evidence.some((e) => e.startsWith('وضعیت سایت: 502'))).toBe(true);
    expect(res.evidence).toContain('آخرین نسخه: آماده');
    expect(res.evidence.join(' ')).toContain('داده‌ای در دسترس نیست');
  });
});

describe('mergeEvidence', () => {
  it('keeps one line per label, in first position with the latest value', () => {
    expect(mergeEvidence(['وضعیت سایت: 200 (سالم، ۱۵۸ میلی‌ثانیه)', 'نمونه‌ها: ۱ از ۱'], ['وضعیت سایت: 200 (سالم، ۱۷۶ میلی‌ثانیه)', 'رم: ۲۲٪'])).toEqual([
      'وضعیت سایت: 200 (سالم، ۱۷۶ میلی‌ثانیه)',
      'نمونه‌ها: ۱ از ۱',
      'رم: ۲۲٪',
    ]);
  });
});
