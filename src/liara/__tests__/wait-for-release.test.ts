import { describe, expect, it } from 'vitest';
import { fakeClient } from '../../test-utils/fake-liara';
import { ReleaseWaitError, waitForRelease } from '../endpoints/deploy';

function releaseApi(states: string[], failReason?: string) {
  let i = 0;
  return fakeClient({
    'GET /v1/projects/app/releases': () => {
      const state = states[Math.min(i++, states.length - 1)]!;
      return { body: { total: 1, currentRelease: null, releases: [{ _id: 'r1', state, createdAt: '2026-10-22T10:00:00Z', tag: 'v1' }] } };
    },
    'GET /v1/releases/r1': { body: { release: { state: 'FAILED', failReason } } },
  });
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe('waitForRelease', () => {
  it('reports each state change once and resolves on READY', async () => {
    const seen: string[] = [];
    const clock = fakeClock();
    const rel = await waitForRelease(releaseApi(['BUILDING', 'BUILDING', 'PUSHING', 'DEPLOYING', 'READY']), 'app', 'r1', {
      ...clock,
      onState: (s) => seen.push(s),
    });
    expect(rel.state).toBe('READY');
    expect(seen).toEqual(['BUILDING', 'PUSHING', 'DEPLOYING', 'READY']);
    expect(clock.now()).toBe(4 * 5000);
  });

  it('rejects with the fail reason on FAILED', async () => {
    const err = (await waitForRelease(releaseApi(['BUILDING', 'FAILED'], 'npm ERR! missing script: start'), 'app', 'r1', fakeClock()).catch((e) => e)) as ReleaseWaitError;
    expect(err).toBeInstanceOf(ReleaseWaitError);
    expect(err.reason).toBe('failed');
    expect(err.failReason).toContain('missing script');
  });

  it('treats UNHEALTHY as a failure', async () => {
    const err = (await waitForRelease(releaseApi(['DEPLOYING', 'UNHEALTHY']), 'app', 'r1', fakeClock()).catch((e) => e)) as ReleaseWaitError;
    expect(err.state).toBe('UNHEALTHY');
  });

  it('times out with the last state', async () => {
    const err = (await waitForRelease(releaseApi(['BUILDING']), 'app', 'r1', { ...fakeClock(), timeoutMs: 30_000 }).catch((e) => e)) as ReleaseWaitError;
    expect(err.reason).toBe('timeout');
    expect(err.state).toBe('BUILDING');
  });
});
