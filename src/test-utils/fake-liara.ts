/** Test helpers: a LiaraClient backed by an in-memory route table, and a ToolContext around it. */
import { openDb } from '../db';
import { LiaraClient } from '../liara/client';
import { silentLogger } from '../logger';
import type { ToolContext } from '../tools/registry';

export interface FakeCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

export type RouteHandler = (call: FakeCall) => { status?: number; body?: unknown } | undefined;

/** Routes are matched as `"GET /v1/projects"` (path only, query ignored) or by a `*` fallback. */
export function fakeFetch(routes: Record<string, RouteHandler | { status?: number; body?: unknown }>, calls: FakeCall[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    let body: unknown;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    else if (init?.body) body = init.body;
    const call = { method, url, headers, body };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`] ?? routes['*'];
    const res = typeof route === 'function' ? route(call) : route;
    if (!res) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const status = res.status ?? 200;
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

export function fakeClient(routes: Parameters<typeof fakeFetch>[0], calls: FakeCall[] = []): LiaraClient {
  return new LiaraClient({ token: 'test-token-not-real', fetch: fakeFetch(routes, calls), sleep: async () => {} });
}

export function fakeContext(liara: LiaraClient, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    liara,
    db: openDb(':memory:'),
    logger: silentLogger,
    now: () => new Date('2026-10-22T12:00:00Z'),
    sleep: async () => {},
    workdir: process.cwd(),
    dataDir: '/tmp/liara-agent-test-data',
    publicUrlSuffix: '.liara.run',
    httpFetch: (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    ...extra,
  };
}
