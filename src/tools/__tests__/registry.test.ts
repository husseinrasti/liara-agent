import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeClient, fakeContext } from '../../test-utils/fake-liara';
import { ALL_TOOLS, compactForModel, defineTool, getTool, listTools, runTool, toAiSdkTools, toMcpTools } from '../index';

describe('tool registry', () => {
  it('registers ≥ 20 snake_case tools with risk tiers', () => {
    const tools = listTools();
    expect(tools.length).toBeGreaterThanOrEqual(20);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      if (t.risk > 0) {
        expect(t.verify, `${t.name} verify`).toBeTypeOf('function');
        expect(t.consequencesFa, `${t.name} consequencesFa`).toBeTypeOf('function');
      }
    }
    expect(ALL_TOOLS).toHaveLength(tools.length);
  });

  it('assigns the documented tiers', () => {
    const risk = (n: string) => getTool(n)!.risk;
    for (const n of ['list_apps', 'get_app', 'get_app_logs', 'collect_evidence', 'analyze_project', 'build_source_archive', 'http_health_check']) expect(risk(n)).toBe(0);
    for (const n of ['restart_app', 'deploy_release', 'rollback_release', 'update_envs', 'add_domain', 'enable_ssl', 'create_app', 'upload_source']) expect(risk(n)).toBe(1);
    for (const n of ['resize_app', 'scale_app', 'delete_app', 'delete_domain', 'exec_shell']) expect(risk(n)).toBe(2);
  });

  it('rejects mutating tools without verify', () => {
    expect(() =>
      defineTool({ name: 'bad_tool', title: 'x', description: 'x', input: z.object({}), risk: 1, category: 'ops', describeFa: () => '', run: async () => ({ ok: true, data: 1, summaryFa: '' }) }),
    ).toThrow(/verify/);
  });

  it('validates input and never throws from run', async () => {
    const ctx = fakeContext(fakeClient({ 'GET /v1/projects': { status: 500, body: { message: 'boom' } } }));
    const bad = await runTool(getTool('get_app')!, { appName: 'Bad Name!' }, ctx);
    expect(bad.ok).toBe(false);
    const failing = await runTool(getTool('list_apps')!, {}, ctx);
    expect(failing).toMatchObject({ ok: false });
    if (!failing.ok) expect(failing.userMessageFa).toMatch(/لیارا/);
  });

  it('exposes MCP annotations and confirmation fields', () => {
    const mcp = toMcpTools();
    const byName = Object.fromEntries(mcp.map((t) => [t.name, t]));
    expect(byName.delete_app!.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(byName.delete_app!.inputSchema.required).toContain('confirmAppName');
    expect(byName.restart_app!.inputSchema.required).toContain('confirm');
    expect(byName.restart_app!.description.startsWith('[risk 1')).toBe(true);
    expect(byName.list_apps!.annotations.readOnlyHint).toBe(true);
    expect(byName.list_apps!.inputSchema.required ?? []).not.toContain('confirm');
  });

  it('builds AI SDK tools and strips raw from model output', () => {
    const tools = toAiSdkTools(fakeContext(fakeClient({})), { only: ['list_apps', 'get_app'] });
    expect(Object.keys(tools)).toEqual(['list_apps', 'get_app']);
    expect(compactForModel({ ok: true, data: { a: 1 }, summaryFa: 's', raw: { big: true } })).toEqual({ ok: true, data: { a: 1 }, summaryFa: 's' });
    const huge = compactForModel({ ok: true, data: 'x'.repeat(20_000), summaryFa: 's' });
    expect(JSON.stringify(huge).length).toBeLessThan(9000);
  });
});

describe('read tools over a fake Liara', () => {
  const me = { plans: { projects: { 'small-g2': { available: true, region: 'iran', RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, volume: 3, price: 150 } } } };
  const ctx = fakeContext(
    fakeClient({
      'GET /v1/me': { body: me },
      'GET /v1/projects/shop': {
        body: {
          project: {
            _id: 'p1',
            project_id: 'shop',
            type: 'node',
            status: 'ACTIVE',
            scale: 1,
            planID: 'small-g2',
            envs: [
              { key: 'DB_PASSWORD', value: 'hunter2' },
              { key: 'NODE_ENV', value: 'production' },
            ],
          },
        },
      },
    }),
  );

  it('get_app joins the plan catalogue and masks secret env values', async () => {
    const res = await runTool(getTool('get_app')!, { appName: 'shop' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.plan).toMatchObject({ id: 'small-g2', ramMB: 512 });
    expect(res.data.url).toBe('https://shop.liara.run');
    expect(JSON.stringify(res.data)).not.toContain('hunter2');
    expect(res.data.envs).toContainEqual({ key: 'NODE_ENV', value: 'production' });
    expect(res.summaryFa).toMatch(/روشن/);
  });
});
