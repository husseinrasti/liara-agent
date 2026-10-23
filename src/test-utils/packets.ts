/** Synthetic evidence packets for rule-engine and diagnosis tests. */
import { clusterLogs, extractStackTraces, isErrorLine } from '../agent/evidence/logs';
import type { EvidencePacket } from '../agent/evidence/packet';
import type { Plan } from '../liara/plans';

export const PLANS: Plan[] = [
  { id: 'small-g2', label: 'small', ramMB: 512, cpu: 0.5, diskGB: 3, hourlyPriceIRT: 150, monthlyEstimateIRT: 108_000, available: true, region: 'iran', isFree: false, bundles: [] },
  { id: 'medium-g2', label: 'medium', ramMB: 1024, cpu: 1, diskGB: 5, hourlyPriceIRT: 300, monthlyEstimateIRT: 216_000, available: true, region: 'iran', isFree: false, bundles: [] },
];

export function healthyPacket(): EvidencePacket {
  return {
    app: {
      name: 'shop',
      platform: 'node',
      status: 'ACTIVE',
      scale: 1,
      plan: { id: 'small-g2', ramMB: 512, cpu: 0.5 },
      isDeployed: true,
      url: 'https://shop.liara.run',
      currentRelease: { id: 'r2', tag: 'v2', state: 'READY', createdAt: '2026-10-20T10:00:00Z', ageMinutes: 3000 },
      lastDeployAgeMinutes: 3000,
    },
    health: { status: 200, ok: true, latencyMs: 180, sampledAt: '2026-10-22T12:00:00Z' },
    applets: [{ name: 'shop-1', state: 'Running', reason: null }],
    releases: [
      { id: 'r2', state: 'READY', tag: 'v2', createdAt: '2026-10-20T10:00:00Z', port: 3000 },
      { id: 'r1', state: 'READY', tag: 'v1', createdAt: '2026-10-19T10:00:00Z', port: 3000 },
    ],
    events: { windowMinutes: 120, byReason: {}, timeline: [] },
    logs: { windowMinutes: 60, totalLines: 3, errorLines: 0, clusters: [], lastLines: ['12:00:00 GET / 200 3ms'], stackTraces: [] },
    metrics: {
      cpu: { avg: 10, max: 15, last: 9, trend: 'flat', unit: 'percent_of_plan' },
      memory: { avgMB: 120, maxMB: 130, lastMB: 125, limitMB: 512, pctOfLimit: 25.4, lastPctOfLimit: 24.4, trend: 'flat', nearLimit: false },
      network: { rxKBps: 1, txKBps: 2 },
      disks: [],
      points: 60,
    },
    domains: [],
    account: { balanceIRT: 500_000, lowBalance: false },
    signals: [],
    limitations: ['Liara API has no HTTP access logs or status-code histograms; site status comes from our own HTTP health check.'],
    collectedAt: '2026-10-22T12:00:00Z',
    durationMs: 900,
  };
}

/** Sets packet.logs from raw lines (clusters, stack traces, last lines) like collect_evidence does. */
export function withLogs(p: EvidencePacket, lines: string[], startIso = '2026-10-22T11:30:00Z'): EvidencePacket {
  const t0 = Date.parse(startIso);
  const entries = lines.map((msg, i) => ({ t: new Date(t0 + i * 1000).toISOString(), msg }));
  p.logs = {
    ...p.logs,
    totalLines: entries.length,
    errorLines: entries.filter((e) => isErrorLine(e.msg)).length,
    clusters: clusterLogs(entries),
    lastLines: entries.slice(-30).map((e) => `${e.t.slice(11, 19)} ${e.msg}`),
    stackTraces: extractStackTraces(entries),
  };
  return p;
}

export function oomPacket(): EvidencePacket {
  const p = withLogs(healthyPacket(), [
    ...Array.from({ length: 10 }, (_, i) => `memory usage: ${300 + i * 20} MB`),
    '<--- Last few GCs --->',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  ]);
  p.health = { status: 502, ok: false, latencyMs: null, error: undefined, sampledAt: '2026-10-22T12:00:00Z' };
  p.applets = [{ name: 'shop-1', state: 'CrashLoopBackOff', reason: 'OOMKilled' }];
  p.events = {
    windowMinutes: 120,
    byReason: { OOMKilled: 3, BackOff: 2 },
    timeline: [
      { ts: '2026-10-22T11:50:00Z', reason: 'OOMKilled', message: 'Container shop was OOM killed', severity: 'error' },
      { ts: '2026-10-22T11:51:00Z', reason: 'BackOff', message: 'Back-off restarting failed container', severity: 'error' },
    ],
  };
  p.metrics!.memory = { avgMB: 420, maxMB: 497, lastMB: 497, limitMB: 512, pctOfLimit: 97.1, lastPctOfLimit: 97.1, trend: 'rising', nearLimit: true };
  p.app!.lastDeployAgeMinutes = 25;
  p.app!.currentRelease = { id: 'r3', tag: 'v3', state: 'READY', createdAt: '2026-10-22T11:35:00Z', ageMinutes: 25 };
  p.releases = [{ id: 'r3', state: 'READY', tag: 'v3', createdAt: '2026-10-22T11:35:00Z', port: 3000 }, ...p.releases];
  return p;
}
