/** An AgentRuntime over the fake Liara client, an in-memory DB and scripted models. */
import type { LanguageModel } from 'ai';
import { createAgentRuntime, type AgentRuntime } from '../agent/runtime';
import type { AppConfig } from '../config';
import { openDb } from '../db';
import { silentLogger } from '../logger';
import { fakeClient, type FakeCall } from './fake-liara';

export const TEST_NOW = new Date('2026-10-22T12:00:00Z');

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    rootDir: process.cwd(),
    dataDir: '/tmp/liara-agent-test-data',
    liara: { token: 'test-token', baseUrl: 'https://api.liara.ir', publicUrlSuffix: '.liara.run' },
    llm: { provider: 'openai', fastModel: 'test-model', smartModel: 'test-model', openaiApiKey: 'sk-test' },
    databasePath: ':memory:',
    watcher: { enabled: false, intervalSec: 60 },
    autoApprove: false,
    logLevel: 'silent',
    ...over,
  };
}

export interface FakeAgent {
  rt: AgentRuntime;
  calls: FakeCall[];
  scheduled: { fn: () => Promise<void> | void; ms: number }[];
}

export function fakeAgent(opts: {
  routes?: Parameters<typeof fakeClient>[0];
  fast?: LanguageModel;
  smart?: LanguageModel;
  autoApprove?: boolean;
  /** status of the app's public URL; a function lets a test change it between checks */
  httpStatus?: number | (() => number);
  now?: () => Date;
}): FakeAgent {
  const calls: FakeCall[] = [];
  const scheduled: FakeAgent['scheduled'] = [];
  const deps = { config: testConfig(), liara: fakeClient(opts.routes ?? {}, calls), db: openDb(':memory:'), logger: silentLogger };
  const statusOf = typeof opts.httpStatus === 'function' ? opts.httpStatus : () => (opts.httpStatus as number | undefined) ?? 200;
  const rt = createAgentRuntime({
    deps,
    models: { ...(opts.fast ? { fast: opts.fast } : {}), ...(opts.smart ? { smart: opts.smart } : {}) },
    autoApprove: opts.autoApprove ?? false,
    now: opts.now ?? (() => TEST_NOW),
    sleep: async () => {},
    schedule: (fn, ms) => void scheduled.push({ fn, ms }),
    httpFetch: (async () => {
      const status = statusOf();
      return new Response(status === 200 ? 'ok' : 'error', { status });
    }) as unknown as typeof fetch,
  });
  return { rt, calls, scheduled };
}

/** Liara routes for a healthy app `shop` (details, applets, events, releases, plans). */
export function healthyAppRoutes(app = 'shop'): Parameters<typeof fakeClient>[0] {
  return {
    'GET /v1/me': { body: { plans: { projects: { 'small-g2': { available: true, region: 'iran', RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, volume: 3, price: 150 } } } } },
    [`GET /v1/projects/${app}`]: { body: { project: { _id: 'p1', project_id: app, type: 'node', status: 'ACTIVE', scale: 1, planID: 'small-g2', envs: [] } } },
    [`GET /v1/projects/${app}/applets`]: { body: { applets: [{ name: `${app}-1`, state: 'Running' }] } },
    [`GET /v1/projects/${app}/events`]: { body: { data: [] } },
    [`GET /v1/projects/${app}/releases`]: { body: { total: 1, currentRelease: 'r1', releases: [{ _id: 'r1', state: 'READY', createdAt: '2026-10-20T10:00:00Z', tag: 'v1' }] } },
    [`POST /v1/projects/${app}/actions/restart`]: { body: {} },
    [`POST /v1/projects/${app}/actions/scale`]: { body: {} },
  };
}
