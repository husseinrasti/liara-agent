import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../events';
import { extractProjectPlans } from '../../liara/plans';
import { fakeAgent } from '../../test-utils/fake-agent';
import { getTool } from '../../tools/registry';
import { recommendPlan } from '../deploy/plan';
import { ensureLiaraJson, suggestAppName, versionConfig } from '../deploy/project-files';
import { policyExecutor } from '../policy';
import { AgentSession } from '../session';
import '../tools';

const me = {
  plans: {
    projects: {
      free: { available: true, region: 'iran', RAM: { amount: 0.25 }, CPU: { amount: 0.1 }, volume: 0.5, price: 0 },
      'small-g2': { available: true, region: 'iran', RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, volume: 3, price: 150 },
      'medium-g2': { available: true, region: 'iran', RAM: { amount: 1 }, CPU: { amount: 1 }, volume: 5, price: 300 },
      'large-g2': { available: true, region: 'iran', RAM: { amount: 2 }, CPU: { amount: 2 }, volume: 10, price: 600 },
    },
    projectBundlePlans: { 'medium-g2': { free: { available: true, displayPrice: 0 }, standard: { available: true, displayPrice: 99_000 } } },
  },
};
const PLANS = extractProjectPlans(me);

describe('recommendPlan', () => {
  it('static sites get the smallest paid plan, with a bigger alternative', () => {
    const r = recommendPlan({ platform: 'react' }, PLANS)!;
    expect(r.planID).toBe('small-g2');
    expect(r.alternatives.map((a) => a.planID)).toEqual(['medium-g2']);
  });

  it('server apps need ≥ 1 GB; heavy deps bump one step; costs include the bundle', () => {
    const node = recommendPlan({ platform: 'node' }, PLANS)!;
    expect(node).toMatchObject({ planID: 'medium-g2', monthlyEstimateIRT: 216_000, bundlePlanID: 'free', totalMonthlyIRT: 216_000 });
    expect(node.reasonsFa[0]).toContain('۱ گیگابایت');
    const next = recommendPlan({ platform: 'next', notableDeps: ['sharp'] }, PLANS)!;
    expect(next.planID).toBe('large-g2');
    expect(next.reasonsFa.join(' ')).toContain('sharp');
  });

  it('flags an insufficient balance', () => {
    const r = recommendPlan({ platform: 'node' }, PLANS, { known: true, amountIRT: 5_000, source: 'billing' })!;
    expect(r.balance).toMatchObject({ sufficient: false, enoughForDays: 0 });
  });
});

describe('project files', () => {
  it('suggests valid unique app names', () => {
    expect(suggestAppName('/home/u/My Shop!')).toBe('my-shop');
    expect(suggestAppName('https://github.com/u/123-api.git')).toBe('app-123-api');
    expect(suggestAppName('shop', ['shop'], () => 0.5)).toMatch(/^shop-[a-z0-9]{2}$/);
  });

  it('writes liara.json only when missing, with a supported runtime version', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'liara-json-'));
    expect(ensureLiaraJson(dir, { app: 'shop', platform: 'node', port: 3000, versions: { nodeVersion: '>=22' } }).written).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'liara.json'), 'utf8'))).toEqual({ app: 'shop', platform: 'node', port: 3000, node: { version: 22 } });
    expect(ensureLiaraJson(dir, { app: 'other', platform: 'node', port: 1 }).written).toBe(false);
    expect(versionConfig('django', { pythonVersion: '3.12.4' })).toEqual({ pythonVersion: '3.12' });
    expect(versionConfig('node', { nodeVersion: '15' })).toBeUndefined();
  });
});

function deployRoutes(balance = 10_000_000) {
  const state = { created: false, envs: [] as { key: string; value: string }[] };
  const routes = {
    'GET /v1/me': { body: me },
    'GET /v1/billing': { body: { user: { balance } } },
    'GET /v1/projects': () => ({ body: { projects: state.created ? [{ _id: 'p9', project_id: 'my-shop', type: 'node' }] : [] } }),
    'POST /v1/projects': () => ((state.created = true), { body: {} }),
    'GET /v1/projects/my-shop': () => ({ body: { project: { _id: 'p9', project_id: 'my-shop', type: 'node', scale: 1, planID: 'medium-g2', envs: state.envs } } }),
    'POST /v1/projects/update-envs': (c: { body?: unknown }) => ((state.envs = (c.body as { variables: typeof state.envs }).variables), { body: {} }),
    'POST /v2/projects/my-shop/sources': { body: { sourceID: 'src-1' } },
    'POST /v2/projects/my-shop/releases': { body: { releaseID: 'rel-1' } },
    'GET /v1/projects/my-shop/releases': { body: { total: 1, currentRelease: 'rel-1', releases: [{ _id: 'rel-1', state: 'READY', createdAt: '2026-10-22T12:00:00Z', tag: 'v1', port: 3000 }] } },
    'GET /v1/projects/my-shop/applets': { body: { applets: [{ name: 'my-shop-1', state: 'Running' }] } },
    'GET /v1/projects/my-shop/events': { body: { data: [] } },
  };
  return { routes, state };
}

function tempProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'my-shop-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-shop', scripts: { start: 'node index.js' }, engines: { node: '22.x' } }));
  writeFileSync(path.join(dir, 'index.js'), "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT || 3000)");
  writeFileSync(path.join(dir, '.env'), 'PAYMENT_API_KEY=real-secret');
  return dir;
}

describe('deploy_project wizard', () => {
  it('runs every stage with progress events, verifies, audits with masked envs', async () => {
    const { routes, state } = deployRoutes();
    const { rt, calls } = fakeAgent({ routes, autoApprove: true });
    const session = AgentSession.create(rt);
    const events: AgentEvent[] = [];
    rt.bus.subscribe(session.id, (e) => events.push(e));
    const dir = tempProject();
    const exec = policyExecutor(rt, session, { pendingApprovals: [] });
    const out = await exec(getTool('deploy_project')!, { path: dir, appName: 'my-shop', planID: 'medium-g2', envs: { PAYMENT_API_KEY: 'demo-secret' } }, { toolCallId: 'c1' });
    expect(out).toMatchObject({ ok: true, data: { url: 'https://my-shop.liara.run', created: true, wroteLiaraJson: true, port: 3000 }, verification: { fixed: true } });
    const stages = events.filter((e) => e.type === 'deploy_progress').map((e) => `${(e as { stage: string }).stage}:${(e as { status: string }).status}`);
    expect(stages.filter((s) => s.endsWith(':done')).map((s) => s.split(':')[0])).toEqual(['analyze', 'create', 'envs', 'archive', 'upload', 'release', 'build', 'health']);
    expect(state.envs).toEqual([{ key: 'PAYMENT_API_KEY', value: 'demo-secret' }]);
    expect(calls.find((c) => c.method === 'POST' && c.url.pathname === '/v1/projects')?.body).toMatchObject({ name: 'my-shop', planID: 'medium-g2', platform: 'node', bundlePlanID: 'free' });
    expect(calls.find((c) => c.url.pathname === '/v2/projects/my-shop/releases')?.body).toMatchObject({ sourceID: 'src-1', port: 3000, type: 'node', platformConfig: { version: 22 } });
    expect(existsSync(path.join(dir, 'liara.json'))).toBe(true);
    const audit = rt.deps.db.prepare('SELECT args, ok, verifyOk FROM audit').get() as { args: string; ok: number; verifyOk: number };
    expect(audit).toMatchObject({ ok: 1, verifyOk: 1 });
    expect(audit.args).not.toContain('demo-secret');
    expect(JSON.stringify(events)).not.toContain('demo-secret');
  });

  it('stops before creating anything when the balance cannot cover a day', async () => {
    const { routes } = deployRoutes(1_000);
    const { rt, calls } = fakeAgent({ routes, autoApprove: true });
    const session = AgentSession.create(rt);
    const exec = policyExecutor(rt, session, { pendingApprovals: [] });
    const out = await exec(getTool('deploy_project')!, { path: tempProject(), appName: 'my-shop', planID: 'medium-g2' }, { toolCallId: 'c1' });
    expect(out).toMatchObject({ ok: false, limitation: true });
    expect(String(out.userMessageFa)).toContain('شارژ');
    expect(calls.some((c) => c.method === 'POST' && c.url.pathname === '/v1/projects')).toBe(false);
  });

  it('recommend_plan emits a Plan Card', async () => {
    const { routes } = deployRoutes();
    const { rt } = fakeAgent({ routes });
    const session = AgentSession.create(rt);
    const events: AgentEvent[] = [];
    rt.bus.subscribe(session.id, (e) => events.push(e));
    const out = await policyExecutor(rt, session, { pendingApprovals: [] })(getTool('recommend_plan')!, { path: tempProject() }, { toolCallId: 'c1' });
    expect(out.ok).toBe(true);
    expect(events.find((e) => e.type === 'plan_recommendation')).toMatchObject({ recommendation: { planID: 'medium-g2', balance: { sufficient: true } } });
  });
});
