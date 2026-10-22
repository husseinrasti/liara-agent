import type { LiaraClient } from '../client';
import { normalizeRange, type MetricSeries } from '../normalize';
import { formatTime, LIARA_TIME_FORMATS } from '../time';
import { MetricRangeSchema, MetricsSummarySchema, type MetricsSummary } from '../types';
import { appPath } from './apps';

export type MetricKind = 'cpu' | 'memory' | 'network-receive' | 'network-transmit';

export async function getMetricsSummary(c: LiaraClient, name: string): Promise<MetricsSummary> {
  return c.request(MetricsSummarySchema, { path: `${appPath(name)}/metrics/summary` });
}

export async function getMetric(c: LiaraClient, name: string, kind: MetricKind, since: Date): Promise<MetricSeries> {
  const raw = await c.request(MetricRangeSchema, {
    path: `${appPath(name)}/metrics/${kind}`,
    query: { since: formatTime(since, LIARA_TIME_FORMATS.metricsSince) },
  });
  return normalizeRange(raw);
}

export const getCpu = (c: LiaraClient, name: string, since: Date) => getMetric(c, name, 'cpu', since);
export const getMemory = (c: LiaraClient, name: string, since: Date) => getMetric(c, name, 'memory', since);
export const getNetRx = (c: LiaraClient, name: string, since: Date) => getMetric(c, name, 'network-receive', since);
export const getNetTx = (c: LiaraClient, name: string, since: Date) => getMetric(c, name, 'network-transmit', since);
