import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../events';
import { fakeAgent, healthyAppRoutes, TEST_NOW } from '../../test-utils/fake-agent';
import { scriptedTextModel } from '../../test-utils/mock-model';
import { getTool } from '../../tools/registry';
import { activeAlerts } from '../alerts';
import { getMemoryKey, setMemoryKey } from '../memory';
import { executeAction } from '../policy';
import { AgentSession } from '../session';
import { Watcher } from '../watcher';
import '../tools';

const MB = 1024 * 1024;
const ns = (ms: number) => `${ms}000000`;

function watched(opts: Parameters<typeof fakeAgent>[0] = {}, routesOver: Record<string, unknown> = {}) {
  const agent = fakeAgent({ ...opts, routes: { ...healthyAppRoutes(), ...routesOver } as never });
  setMemoryKey(agent.rt.deps.db, 'shop', 'watch', true);
  const session = AgentSession.create(agent.rt, { appName: 'shop' });
  const events: AgentEvent[] = [];
  agent.rt.bus.subscribe(session.id, (e) => events.push(e));
  return { ...agent, session, events, watcher: new Watcher(agent.rt, { autoDiagnose: false }) };
}

describe('Watcher', () => {
  it('raises a critical alert only after two failed health checks, pushed to open sessions', async () => {
    const { rt, watcher, events } = watched({ httpStatus: 502 });
    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toHaveLength(0);
    await watcher.tick();
    const alerts = activeAlerts(rt, 'shop');
    expect(alerts).toMatchObject([{ severity: 'critical', title: 'سایت shop پاسخ نمی‌دهد' }]);
    expect(events.find((e) => e.type === 'alert')).toMatchObject({ appName: 'shop', severity: 'critical' });
    expect((events.find((e) => e.type === 'alert') as { suggestedPrompt: string }).suggestedPrompt).toContain('بررسی کن');
  });

  it('closes alerts after three healthy checks, and alerts again if the problem returns', async () => {
    let status = 502;
    const { rt, watcher } = watched({ httpStatus: () => status });
    await watcher.tick();
    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toHaveLength(1);
    status = 200;
    await watcher.tick();
    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toHaveLength(1);
    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toHaveLength(0);
    status = 502;
    await watcher.tick();
    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toMatchObject([{ severity: 'critical', title: 'سایت shop پاسخ نمی‌دهد' }]);
  });

  it('alerts immediately on new OOMKilled/BackOff events, once', async () => {
    const oom = { body: { data: [{ metaData: {}, values: [[ns(TEST_NOW.getTime() - 120_000), JSON.stringify({ reason: 'OOMKilled', message: 'killed' })]] }] } };
    const { rt, watcher } = watched({}, { 'GET /v1/projects/shop/events': oom });
    const [report] = await watcher.tick();
    expect(report!.alerts.map((a) => a.severity)).toEqual(['critical']);
    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toHaveLength(1);
  });

  it('warns after three checks above 90% memory, and stores snapshots + baseline', async () => {
    const mem = { body: { end: 0, result: [{ applet: 'a', values: [[Math.floor(TEST_NOW.getTime() / 1000) - 60, String(480 * MB)]] }] } };
    const { rt, watcher } = watched({}, { 'GET /v1/projects/shop/metrics/memory': mem });
    await watcher.tick();
    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toHaveLength(0);
    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toMatchObject([{ severity: 'warning', title: 'مصرف رم shop نزدیک سقف است' }]);
    expect(rt.deps.db.prepare('SELECT COUNT(*) n FROM metric_snapshots').get()).toEqual({ n: 3 });
    expect(getMemoryKey(rt.deps.db, 'shop', 'baseline')).toMatchObject({ samples: expect.any(Number) });
  });

  it('flags a stopped app', async () => {
    const stopped = { body: { project: { _id: 'p1', project_id: 'shop', type: 'node', status: 'ACTIVE', scale: 0, planID: 'small-g2', envs: [] } } };
    const { rt, watcher } = watched({}, { 'GET /v1/projects/shop': stopped });
    await watcher.tick();
    expect(activeAlerts(rt, 'shop').map((a) => a.title)).toContain('سرویس shop خاموش است');
  });

  it('auto-diagnoses critical alerts when enabled', async () => {
    const { rt } = watched({ httpStatus: 502, smart: scriptedTextModel([new Error('x'), new Error('x'), new Error('x')]) });
    const w = new Watcher(rt, { autoDiagnose: true });
    await w.tick();
    await w.tick();
    expect(activeAlerts(rt, 'shop')[0]!.summary).toContain('تشخیص اولیه');
    expect(getMemoryKey(rt.deps.db, 'shop', 'lastDiagnosis')).toBeTruthy();
  });
});

describe('domain flow', () => {
  it('add_domain: IRNIC limitation, tracked, then verified by the watcher with an SSL suggestion', async () => {
    let verified = false;
    const domain = () => ({ _id: 'd1', name: 'myshop.ir', status: verified ? 'ACTIVE' : 'PENDING', certificatesStatus: 'PENDING', CNameRecord: 'shop.liara.run' });
    const { rt, session, events, watcher } = watched(
      { autoApprove: true },
      {
        'POST /v1/domains': { body: {} },
        'GET /v1/domains': () => ({ body: { domains: [domain()] } }),
        'GET /v1/domains/d1/check': () => ({ body: { domain: domain() } }),
      },
    );
    setMemoryKey(rt.deps.db, 'shop', 'watch', false);
    const { result } = await executeAction(rt, session, getTool('add_domain')!, { appName: 'shop', domain: 'myshop.ir' });
    expect(result.ok).toBe(true);
    expect((result as { data: { stepsFa: string[] } }).data.stepsFa[0]).toContain('irnic.ir');
    expect(events.find((e) => e.type === 'limitation')).toMatchObject({ message: expect.stringContaining('ایرنیک') });
    expect(events.find((e) => e.type === 'domain_steps')).toMatchObject({
      domain: 'myshop.ir',
      records: [
        { type: 'ALIAS / ANAME', name: '@', value: 'shop.liara.run' },
        { type: 'CNAME', name: 'www', value: 'shop.liara.run' },
      ],
      stepsFa: expect.arrayContaining([expect.stringContaining('irnic.ir')]),
    });
    expect(getMemoryKey(rt.deps.db, 'shop', 'pendingDomains')).toMatchObject([{ domainId: 'd1', name: 'myshop.ir' }]);

    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toHaveLength(0);
    verified = true;
    await watcher.tick();
    expect(activeAlerts(rt, 'shop')).toMatchObject([{ severity: 'info', title: 'دامنه‌ی myshop.ir وصل شد' }]);
    expect(getMemoryKey(rt.deps.db, 'shop', 'pendingDomains')).toEqual([]);
    expect((events.filter((e) => e.type === 'alert').pop() as { suggestedPrompt: string }).suggestedPrompt).toContain('SSL');
  });
});
