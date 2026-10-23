import { describe, expect, it } from 'vitest';
import { fakeClient, fakeContext } from '../../test-utils/fake-liara';
import { collectEvidence } from '../composite/collect-evidence';
import { pickRollbackTarget } from '../liara/deploy';

const MB = 1024 * 1024;
const ns = (iso: string) => `${Date.parse(iso)}000000`;

describe('pickRollbackTarget', () => {
  const releases = [
    { _id: 'r3', state: 'READY', createdAt: '2026-10-22T11:00:00Z', tag: 'v3' },
    { _id: 'r2', state: 'FAILED', createdAt: '2026-10-22T10:30:00Z', tag: 'v2' },
    { _id: 'r1', state: 'READY', createdAt: '2026-10-22T10:00:00Z', tag: 'v1' },
    { _id: 'r0', state: 'READY', createdAt: '2026-10-22T09:00:00Z', tag: 'v0' },
  ];
  it('picks the latest READY release older than the current one', () => {
    expect(pickRollbackTarget({ releases, currentRelease: 'r3' })?._id).toBe('r1');
  });
  it('falls back to the newest READY as current when currentRelease is missing', () => {
    expect(pickRollbackTarget({ releases, currentRelease: null })?._id).toBe('r1');
  });
  it('honours an explicit target and returns null when none exists', () => {
    expect(pickRollbackTarget({ releases, currentRelease: 'r3' }, 'r0')?._id).toBe('r0');
    expect(pickRollbackTarget({ releases: [releases[0]!], currentRelease: 'r3' })).toBeNull();
  });
  it('never returns to a release we already rolled back from', () => {
    expect(pickRollbackTarget({ releases, currentRelease: 'r3' }, undefined, ['r1'])?._id).toBe('r0');
  });
});

describe('collect_evidence (OOM scenario over a fake Liara)', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const memPoints = Array.from({ length: 30 }, (_, i) => [Math.floor((now - (30 - i) * 60_000) / 1000), String((200 + i * 10) * MB)]);
  const client = fakeClient({
    'GET /v1/me': { body: { plans: { projects: { 'small-g2': { available: true, region: 'iran', RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, volume: 3, price: 150 } } } } },
    'GET /v1/billing': { body: { user: { balance: 50_000 } } },
    'GET /v1/projects/shop': { body: { project: { _id: 'p1', project_id: 'shop', type: 'node', status: 'ACTIVE', scale: 1, planID: 'small-g2', hourlyPrice: 150, envs: [] } } },
    'GET /v1/projects/shop/applets': { body: { applets: [{ name: 'shop-1', state: 'CrashLoopBackOff', reason: 'OOMKilled' }] } },
    'GET /v1/projects/shop/releases': { body: { total: 2, currentRelease: 'r2', releases: [{ _id: 'r2', state: 'READY', createdAt: '2026-10-22T11:40:00Z', tag: 'v2' }, { _id: 'r1', state: 'READY', createdAt: '2026-10-21T10:00:00Z', tag: 'v1' }] } },
    'GET /v1/projects/shop/events': {
      body: {
        data: [
          {
            metaData: { pod: 'shop-1' },
            values: [
              [ns('2026-10-22T11:50:00Z'), JSON.stringify({ reason: 'OOMKilled', type: 'Warning', message: 'Container shop was OOM killed' })],
              [ns('2026-10-22T11:51:00Z'), JSON.stringify({ reason: 'BackOff', type: 'Warning', message: 'Back-off restarting failed container' })],
            ],
          },
        ],
      },
    },
    'GET /v2/projects/shop/logs': {
      body: {
        data: [
          {
            metaData: { releaseId: 'r2' },
            values: [
              ...Array.from({ length: 40 }, (_, i) => [ns(`2026-10-22T11:${String(10 + i).padStart(2, '0')}:00Z`), JSON.stringify({ _entry: `memory usage: ${200 + i * 7} MB`, type: 'stdout' })]),
              [ns('2026-10-22T11:50:01Z'), JSON.stringify({ _entry: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', type: 'stderr' })],
            ],
          },
        ],
      },
    },
    'GET /v1/projects/shop/metrics/summary': { body: { cpuUsage: [], memoryUsage: [], disksUsage: [] } },
    'GET /v1/projects/shop/metrics/memory': { body: { end: 0, result: [{ applet: 'shop-1', values: memPoints }] } },
    'GET /v1/projects/shop/metrics/cpu': { body: { end: 0, result: [] } },
    'GET /v1/projects/shop/metrics/network-receive': { body: { end: 0, result: [] } },
    'GET /v1/projects/shop/metrics/network-transmit': { body: { end: 0, result: [] } },
    'GET /v1/domains': { body: { domains: [] } },
  });

  it('builds a compact packet with the key OOM signals', async () => {
    const httpFetch = (async () => new Response('Bad Gateway', { status: 502 })) as unknown as typeof fetch;
    const ctx = fakeContext(client, { now: () => new Date(now), httpFetch });
    const p = await collectEvidence(ctx, 'shop', 60);
    expect(p.health).toMatchObject({ status: 502, ok: false });
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(20_000);
    expect(p.app).toMatchObject({ name: 'shop', plan: { id: 'small-g2', ramMB: 512 }, lastDeployAgeMinutes: 20 });
    expect(p.app?.currentRelease).toMatchObject({ id: 'r2', ageMinutes: 20 });
    expect(p.events.byReason).toEqual({ OOMKilled: 1, BackOff: 1 });
    expect(p.events.timeline[0]!.severity).toBe('error');
    expect(p.metrics?.memory).toMatchObject({ nearLimit: true, trend: 'rising', limitMB: 512 });
    expect(p.logs.errorLines).toBe(1);
    expect(p.logs.clusters[0]!.isError).toBe(true);
    expect(p.logs.lastLines.length).toBeLessThanOrEqual(30);
    expect(p.applets[0]).toMatchObject({ state: 'CrashLoopBackOff', reason: 'OOMKilled' });
    expect(p.account).toMatchObject({ balanceIRT: 50_000, lowBalance: false });
    expect(p.health).not.toBeNull();
    expect(p.limitations.join(' ')).toMatch(/no HTTP access logs/);
  });
});
