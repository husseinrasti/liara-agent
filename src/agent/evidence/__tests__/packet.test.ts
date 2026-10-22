import { describe, expect, it } from 'vitest';
import { packetSize, trimPacket, type EvidencePacket } from '../packet';

function bigPacket(): EvidencePacket {
  const long = (i: number) => `line ${i} ${'x'.repeat(250)}`;
  return {
    app: null,
    health: { status: 502, ok: false, latencyMs: null, sampledAt: '2026-10-22T10:00:00Z' },
    applets: [],
    releases: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, state: 'READY', tag: `v${i}`, createdAt: null })),
    events: {
      windowMinutes: 120,
      byReason: { OOMKilled: 9 },
      timeline: Array.from({ length: 40 }, (_, i) => ({ ts: `t${i}`, reason: 'OOMKilled', message: 'y'.repeat(230), severity: 'error' })),
    },
    logs: {
      windowMinutes: 60,
      totalLines: 1000,
      errorLines: 400,
      clusters: Array.from({ length: 12 }, (_, i) => ({ signature: `sig ${i} ${'s'.repeat(150)}`, count: i, firstTs: 'a', lastTs: 'b', sample: long(i), isError: true })),
      lastLines: Array.from({ length: 30 }, (_, i) => long(i)),
      stackTraces: Array.from({ length: 3 }, () => Array.from({ length: 25 }, (_, j) => `    at fn${j} (/app/x.js:${j}:1) ${'z'.repeat(60)}`).join('\n')),
    },
    metrics: null,
    domains: [],
    account: null,
    signals: [],
    limitations: [],
    collectedAt: '2026-10-22T10:00:00Z',
    durationMs: 10,
  };
}

describe('trimPacket', () => {
  it('fits the 20KB budget, keeps the newest log lines and core sections', () => {
    const p = bigPacket();
    expect(packetSize(p)).toBeGreaterThan(20_000);
    const t = trimPacket(p);
    expect(packetSize(t)).toBeLessThanOrEqual(20_000);
    expect(t.health).toEqual(p.health);
    expect(t.events.byReason).toEqual({ OOMKilled: 9 });
    if (t.logs.lastLines.length) expect(t.logs.lastLines[t.logs.lastLines.length - 1]).toBe(p.logs.lastLines[29]);
    expect(t.logs.clusters[0]!.signature).toBe(p.logs.clusters[0]!.signature);
  });

  it('leaves small packets untouched', () => {
    const p = bigPacket();
    p.logs.lastLines = p.logs.lastLines.slice(0, 2);
    p.logs.clusters = [];
    p.logs.stackTraces = [];
    p.events.timeline = [];
    expect(trimPacket(p)).toEqual(p);
  });
});
