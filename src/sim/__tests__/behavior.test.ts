import { describe, expect, it } from 'vitest';
import { appletState, effectiveMode, eventsBetween, healthAt, logsBetween, type RunState } from '../behavior';

const base: RunState = { mode: 'none', startedAt: 0, ramMB: 512, cpuCores: 0.5, envs: {}, scale: 1, deployed: true };

describe('simulator behaviour', () => {
  it('code that requires an env var crash-loops without it and recovers once it is set', () => {
    const s: RunState = { ...base, requiredEnv: 'API_KEY' };
    expect(effectiveMode(s)).toBe('missing-env');
    expect(healthAt(s, 60_000).status).toBe(503);
    expect(appletState(s, 60_000)).toEqual({ state: 'CrashLoopBackOff', reason: 'Error' });
    expect(logsBetween(s, 0, 60_000).map((l) => l.msg)).toContain('Error: API_KEY is not set');
    expect(eventsBetween(s, 0, 60_000).some((e) => e.reason === 'BackOff')).toBe(true);
    const fixed: RunState = { ...s, envs: { API_KEY: 'k' } };
    expect(effectiveMode(fixed)).toBe('none');
    expect(healthAt(fixed, 60_000).status).toBe(200);
  });

  it("the demo app's missing-env mode answers 500 until PAYMENT_API_KEY is set", () => {
    const s: RunState = { ...base, mode: 'missing-env' };
    expect(healthAt(s, 60_000).status).toBe(500);
    expect(logsBetween(s, 0, 60_000).map((l) => l.msg)).toContain('Error: PAYMENT_API_KEY is not set');
    expect(effectiveMode({ ...s, envs: { PAYMENT_API_KEY: 'x' } })).toBe('none');
  });

  it('leak ends in an OOM kill with a heap error in the logs', () => {
    const s: RunState = { ...base, mode: 'leak' };
    const oomAt = ((512 - 120) / 4) * 1000;
    expect(eventsBetween(s, 0, oomAt + 1).map((e) => e.reason)).toContain('OOMKilled');
    expect(logsBetween(s, 0, oomAt + 1).some((l) => /heap out of memory/.test(l.msg))).toBe(true);
    expect(healthAt(s, oomAt + 2000).status).toBe(502);
  });
});
