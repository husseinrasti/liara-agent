import { describe, expect, it } from 'vitest';
import type { MetricSeries } from '../../../liara/normalize';
import { mergeSeries, summarizeMetrics, summarizeSeries, toMB, trendOf } from '../metrics';

const MB = 1024 * 1024;
const series = (values: number[], applet = 'a'): MetricSeries => ({ series: [{ applet, points: values.map((v, i) => ({ t: 1_000_000 + i * 60_000, v })) }] });

describe('trendOf', () => {
  it('detects rising, falling and flat', () => {
    expect(trendOf([100, 110, 120, 200, 260, 320])).toBe('rising');
    expect(trendOf([300, 280, 250, 120, 100, 90])).toBe('falling');
    expect(trendOf([100, 102, 98, 101, 99, 103])).toBe('flat');
    expect(trendOf([1, 2])).toBe('flat');
    expect(trendOf([0, 0, 0, 5, 5, 5])).toBe('rising');
  });
});

describe('summarizeSeries', () => {
  it('computes avg/max/last', () => {
    expect(summarizeSeries([1, 2, 3, 6])).toMatchObject({ avg: 3, max: 6, last: 6, points: 4 });
    expect(summarizeSeries([])).toBeNull();
  });
});

describe('summarizeMetrics', () => {
  it('flags the OOM pattern: memory rising to the plan limit', () => {
    const mem = series([200, 260, 330, 400, 470, 500].map((m) => m * MB));
    const d = summarizeMetrics({ memory: mem, cpu: series([0.1, 0.12, 0.2, 0.25, 0.3, 0.35]), plan: { ramMB: 512, cpu: 0.5 } });
    expect(d.memory).toMatchObject({ maxMB: 500, lastMB: 500, limitMB: 512, trend: 'rising', nearLimit: true });
    expect(d.memory!.pctOfLimit).toBeCloseTo(97.7, 1);
    expect(d.cpu).toMatchObject({ unit: 'percent_of_plan', max: 70 });
  });

  it('reports a healthy steady app', () => {
    const d = summarizeMetrics({ memory: series([120, 121, 119, 120, 122, 120].map((m) => m * MB)), plan: { ramMB: 1024, cpu: 1 } });
    expect(d.memory).toMatchObject({ trend: 'flat', nearLimit: false });
    expect(d.cpu).toBeNull();
  });

  it('computes disk usage and network rates, tolerating missing plan', () => {
    const d = summarizeMetrics({
      rx: series([2048, 2048]),
      summary: { disksUsage: [{ name: 'uploads', size: '1000', usage: '950' }] },
    });
    expect(d.disks).toEqual([{ name: 'uploads', pctUsed: 95 }]);
    expect(d.network.rxKBps).toBe(2);
    expect(d.memory).toBeNull();
  });

  it('merges applets by max per timestamp', () => {
    const m: MetricSeries = { series: [series([1, 5]).series[0]!, { applet: 'b', points: [{ t: 1_000_000, v: 3 }] }] };
    expect(mergeSeries(m, Math.max)).toEqual([3, 5]);
  });

  it('treats small values as MB already', () => {
    expect(toMB(512)).toBe(512);
    expect(toMB(512 * MB)).toBe(512);
  });
});
