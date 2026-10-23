/** EvidencePacket: the compact, structured input to diagnosis (PRD-01 §2.4). No LLM here. */
import type { LogCluster } from './logs';
import type { MetricsDigest } from './metrics';

export interface Signal {
  kind: string;
  detail: string;
  weight: number;
  source: 'events' | 'logs' | 'metrics' | 'applets' | 'health' | 'release' | 'account' | 'domain';
  ts?: string;
}

export interface EvidencePacket {
  app: {
    name: string;
    platform: string | null;
    status: string | null;
    scale: number | null;
    plan: { id: string | null; ramMB: number | null; cpu: number | null };
    isDeployed: boolean | null;
    url: string;
    currentRelease: { id: string; tag: string | null; state: string; createdAt: string | null; ageMinutes: number | null } | null;
    lastDeployAgeMinutes: number | null;
  } | null;
  health: { status: number; ok: boolean; latencyMs: number | null; error?: string; sampledAt: string } | null;
  applets: { name: string; state: string | null; reason: string | null }[];
  releases: { id: string; state: string; tag: string | null; createdAt: string | null; port?: number | null; failReason?: string }[];
  events: {
    windowMinutes: number;
    byReason: Record<string, number>;
    timeline: { ts: string; reason: string | null; message: string; severity: string }[];
  };
  logs: {
    windowMinutes: number;
    totalLines: number;
    errorLines: number;
    clusters: LogCluster[];
    lastLines: string[];
    stackTraces: string[];
    buildLog?: string[];
  };
  metrics: (MetricsDigest & { unavailable?: string[] }) | null;
  domains: { id?: string; name: string; status: string | null; certificatesStatus: string | null }[];
  account: { balanceIRT?: number; lowBalance?: boolean } | null;
  signals: Signal[];
  limitations: string[];
  collectedAt: string;
  durationMs: number;
}

/** ≈ 6000 tokens. */
export const PACKET_BUDGET_BYTES = 20_000;

export const packetSize = (p: EvidencePacket) => Buffer.byteLength(JSON.stringify(p), 'utf8');

/**
 * Trims the packet to the byte budget, in order: lastLines → timeline → clusters
 * → stack traces → build log → releases. Never drops app/health/metrics.
 */
export function trimPacket(p: EvidencePacket, budget = PACKET_BUDGET_BYTES): EvidencePacket {
  const out: EvidencePacket = structuredClone(p);
  const steps: (() => boolean)[] = [
    () => shrink(out.logs.lastLines, 5, true),
    () => shrink(out.events.timeline, 10),
    () => {
      let changed = false;
      for (const c of out.logs.clusters) {
        if (c.sample.length > 160) {
          c.sample = `${c.sample.slice(0, 157)}…`;
          changed = true;
        }
      }
      return changed || shrink(out.logs.clusters, 4);
    },
    () => {
      let changed = false;
      out.logs.stackTraces = out.logs.stackTraces.map((t) => {
        const lines = t.split('\n');
        if (lines.length <= 8) return t;
        changed = true;
        return lines.slice(0, 8).join('\n');
      });
      return changed || shrink(out.logs.stackTraces, 1);
    },
    () => (out.logs.buildLog ? shrink(out.logs.buildLog, 15, true) : false),
    () => shrink(out.releases, 2),
    () => shrink(out.logs.lastLines, 0, true),
    () => shrink(out.events.timeline, 3),
  ];
  for (const step of steps) {
    while (packetSize(out) > budget) if (!step()) break;
  }
  if (packetSize(out) > budget) out.limitations.push('evidence packet trimmed to fit the size budget');
  return out;
}

/**
 * Halves an array down to `min`, keeping the head (most relevant first) or, with
 * `keepTail`, the tail (most recent last). Returns false when nothing changed.
 */
function shrink<T>(arr: T[], min: number, keepTail = false): boolean {
  if (arr.length <= min) return false;
  const keep = Math.max(min, Math.floor(arr.length / 2));
  if (keepTail) arr.splice(0, arr.length - keep);
  else arr.splice(keep);
  return true;
}
