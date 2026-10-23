/** Pure metric summarization (no LLM). Used by get_app_metrics and collect_evidence. */
import type { MetricSeries } from '../../liara/normalize';
import type { MetricsSummary } from '../../liara/types';

export type Trend = 'rising' | 'falling' | 'flat';

/** Compares the mean of the first third with the last third; ±15% is "flat". */
export function trendOf(values: number[]): Trend {
  if (values.length < 3) return 'flat';
  const third = Math.max(1, Math.floor(values.length / 3));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const first = mean(values.slice(0, third));
  const last = mean(values.slice(-third));
  if (first === 0) return last > 0 ? 'rising' : 'flat';
  const change = (last - first) / Math.abs(first);
  return change > 0.15 ? 'rising' : change < -0.15 ? 'falling' : 'flat';
}

export interface SeriesStats {
  avg: number;
  max: number;
  last: number;
  trend: Trend;
  points: number;
}

export function summarizeSeries(values: number[]): SeriesStats | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return null;
  return {
    avg: xs.reduce((a, b) => a + b, 0) / xs.length,
    max: Math.max(...xs),
    last: xs[xs.length - 1]!,
    trend: trendOf(xs),
    points: xs.length,
  };
}

/** Merges per-applet series into one ascending series, combining equal timestamps with `combine`. */
export function mergeSeries(m: MetricSeries | undefined, combine: (a: number, b: number) => number): number[] {
  const byTs = new Map<number, number>();
  for (const s of m?.series ?? []) for (const p of s.points) byTs.set(p.t, byTs.has(p.t) ? combine(byTs.get(p.t)!, p.v) : p.v);
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const MB = 1024 * 1024;

/** Memory values arrive in bytes (Prometheus working-set); small values are assumed to already be MB. */
export function toMB(v: number): number {
  return v > 100_000 ? v / MB : v;
}

export interface MetricsDigest {
  cpu: { avg: number; max: number; last: number; trend: Trend; unit: 'percent_of_plan' | 'cores' } | null;
  memory: {
    avgMB: number;
    maxMB: number;
    lastMB: number;
    limitMB: number | null;
    /** max over the window ÷ plan limit */
    pctOfLimit: number | null;
    /** latest value ÷ plan limit (used to verify a fix) */
    lastPctOfLimit: number | null;
    trend: Trend;
    nearLimit: boolean;
  } | null;
  network: { rxKBps: number | null; txKBps: number | null };
  disks: { name: string; pctUsed: number | null }[];
  points: number;
}

export interface SummarizeInput {
  cpu?: MetricSeries;
  memory?: MetricSeries;
  rx?: MetricSeries;
  tx?: MetricSeries;
  summary?: MetricsSummary | null;
  plan?: { ramMB: number; cpu: number } | null;
}

/** Builds the compact metrics digest the LLM and UI consume. */
export function summarizeMetrics(input: SummarizeInput): MetricsDigest {
  const cpuVals = mergeSeries(input.cpu, Math.max);
  const memVals = mergeSeries(input.memory, Math.max).map(toMB);
  const cpuStats = summarizeSeries(cpuVals);
  const memStats = summarizeSeries(memVals);
  const planCpu = input.plan?.cpu && input.plan.cpu > 0 ? input.plan.cpu : null;
  // CPU series are core-seconds per second (cores); express as % of the plan's CPU when known.
  const cpuScale = planCpu ? 100 / planCpu : 1;
  const limitMB = input.plan?.ramMB && input.plan.ramMB > 0 ? input.plan.ramMB : null;
  const pct = memStats && limitMB ? round((memStats.max / limitMB) * 100) : null;
  const lastPct = memStats && limitMB ? (memStats.last / limitMB) * 100 : null;
  const rx = summarizeSeries(mergeSeries(input.rx, (a, b) => a + b));
  const tx = summarizeSeries(mergeSeries(input.tx, (a, b) => a + b));
  return {
    cpu: cpuStats
      ? {
          avg: round(cpuStats.avg * cpuScale, 2),
          max: round(cpuStats.max * cpuScale, 2),
          last: round(cpuStats.last * cpuScale, 2),
          trend: cpuStats.trend,
          unit: planCpu ? 'percent_of_plan' : 'cores',
        }
      : null,
    memory: memStats
      ? {
          avgMB: round(memStats.avg),
          maxMB: round(memStats.max),
          lastMB: round(memStats.last),
          limitMB,
          pctOfLimit: pct,
          lastPctOfLimit: lastPct === null ? null : round(lastPct),
          trend: memStats.trend,
          nearLimit: (pct ?? 0) >= 90 || (lastPct ?? 0) >= 90,
        }
      : null,
    network: { rxKBps: rx ? round(rx.avg / 1024, 2) : null, txKBps: tx ? round(tx.avg / 1024, 2) : null },
    disks: (input.summary?.disksUsage ?? []).map((d) => {
      const size = Number(d.size);
      const usage = Number(d.usage);
      return { name: d.name ?? 'disk', pctUsed: size > 0 && Number.isFinite(usage) ? round((usage / size) * 100) : null };
    }),
    points: Math.max(cpuStats?.points ?? 0, memStats?.points ?? 0),
  };
}
