import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeClient, type FakeCall } from '../../test-utils/fake-liara';
import { LiaraClient } from '../client';
import { LiaraApiError } from '../errors';

describe('LiaraClient', () => {
  it('sends bearer auth, teamID and parses JSON', async () => {
    const calls: FakeCall[] = [];
    const c = new LiaraClient({
      token: 'tkn',
      teamId: 'team1',
      fetch: (async (input: string, init: RequestInit) => {
        calls.push({ method: init.method!, url: new URL(input), headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify({ projects: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await c.request(z.looseObject({ projects: z.array(z.unknown()) }), { path: '/v1/projects' });
    expect(res.projects).toEqual([]);
    expect(calls[0]!.headers.Authorization).toBe('Bearer tkn');
    expect(calls[0]!.url.searchParams.get('teamID')).toBe('team1');
  });

  it('retries GET on 503 but never retries POST', async () => {
    let gets = 0;
    let posts = 0;
    const c = fakeClient({
      'GET /v1/projects': () => (++gets < 3 ? { status: 503, body: { message: 'busy' } } : { body: { projects: [] } }),
      'POST /v1/projects/x/actions/restart': () => (++posts, { status: 503, body: { message: 'busy' } }),
    });
    await expect(c.request(z.unknown(), { path: '/v1/projects' })).resolves.toEqual({ projects: [] });
    expect(gets).toBe(3);
    await expect(c.request(z.unknown(), { method: 'POST', path: '/v1/projects/x/actions/restart' })).rejects.toBeInstanceOf(LiaraApiError);
    expect(posts).toBe(1);
  });

  it('maps errors to LiaraApiError with a Persian user message and no token leakage', async () => {
    const c = fakeClient({ 'GET /v1/projects/nope': { status: 404, body: { statusCode: 404, error: 'Not Found', message: 'App does not exist.' } } });
    const err = (await c.request(z.unknown(), { path: '/v1/projects/nope' }).catch((e) => e)) as LiaraApiError;
    expect(err).toBeInstanceOf(LiaraApiError);
    expect(err.status).toBe(404);
    expect(err.endpoint).toBe('GET /v1/projects/nope');
    expect(err.message).toBe('App does not exist.');
    expect(err.userMessage).toMatch(/پیدا نشد/);
    expect(JSON.stringify(err)).not.toContain('test-token-not-real');
  });

  it('recognises insufficient balance', () => {
    const err = new LiaraApiError({ status: 400, endpoint: 'POST /v1/projects', message: 'Insufficient balance' });
    expect(err.userMessage).toMatch(/موجودی/);
  });

  it('returns the raw body when the schema does not match (lenient)', async () => {
    const c = fakeClient({ 'GET /v1/projects': { body: { projects: 'unexpected' } } });
    const res = await c.request(z.looseObject({ projects: z.array(z.unknown()) }), { path: '/v1/projects' });
    expect(res).toEqual({ projects: 'unexpected' });
  });

  it('turns timeouts into status 0 errors', async () => {
    const c = new LiaraClient({
      token: 't',
      sleep: async () => {},
      fetch: (async (_i: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))))) as unknown as typeof fetch,
    });
    const err = (await c.request(z.unknown(), { path: '/v1/me', timeoutMs: 20, retries: 0 }).catch((e) => e)) as LiaraApiError;
    expect(err.status).toBe(0);
    expect(err.isTimeout).toBe(true);
  });

  it('builds the console websocket URL without exposing it in errors', () => {
    const c = new LiaraClient({ token: 'secret-token' });
    const url = c.consoleSocketUrl({ cmd: 'ls', project_id: 'my-app' });
    expect(url.startsWith('wss://api.iran.liara.ir/v1/exec?')).toBe(true);
    expect(new URL(url).searchParams.get('project_id')).toBe('my-app');
  });
});
