import { parseTimestamp } from './time';
import type { AppEvent, EventSeverity, EventsRaw, LogLine, LokiStreams, MetricRange } from './types';

const ERROR_REASONS = /OOMKill|BackOff|Fail|Error|Unhealthy|Evict|CrashLoop/i;
const WARNING_REASONS = /Kill|Scal|Resiz|Preempt|NodeNotReady|Pressure/i;

export function eventSeverity(reason?: string, type?: string, message = ''): EventSeverity {
  const text = `${reason ?? ''} ${message}`;
  if (ERROR_REASONS.test(reason ?? '') || /OOMKilled|CrashLoopBackOff/i.test(text)) return 'error';
  if (WARNING_REASONS.test(reason ?? '') || /^warning$/i.test(type ?? '')) return 'warning';
  return 'info';
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function tryJson(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || !v.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nested(obj: Record<string, unknown> | null, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Flattens the `events` endpoint's Loki-like streams into AppEvent[] (ascending by time).
 * Each row is `[timestamp, line, ...]`; the line may be a JSON-encoded Kubernetes event.
 */
export function normalizeEvents(raw: EventsRaw | null | undefined): AppEvent[] {
  const out: AppEvent[] = [];
  for (const stream of raw?.data ?? []) {
    const meta = (stream.metaData ?? {}) as Record<string, unknown>;
    for (const row of stream.values ?? []) {
      if (!Array.isArray(row) || row.length === 0) continue;
      let json = tryJson(row[1]);
      const inner = tryJson(json?._entry);
      if (inner) json = { ...json, ...inner };
      const ts = parseTimestamp(row[0]) ?? parseTimestamp(json?.lastTimestamp) ?? parseTimestamp(meta.timestamp);
      const reason = asString(json?.reason) ?? asString(meta.reason);
      const type = asString(json?.type) ?? asString(meta.type);
      const message =
        asString(json?.message) ??
        asString(json?.note) ??
        asString(json?._entry) ??
        (json ? undefined : asString(row[1])) ??
        asString(meta.message) ??
        reason ??
        '';
      const applet =
        asString(nested(json, 'involvedObject', 'name')) ??
        asString(nested(json, 'regarding', 'name')) ??
        asString(meta.pod) ??
        asString(meta.applet) ??
        asString(meta.name);
      const countRaw = json?.count ?? meta.count;
      out.push({
        ts: (ts ?? new Date(0)).toISOString(),
        type,
        reason,
        message: message.slice(0, 500),
        count: typeof countRaw === 'number' ? countRaw : countRaw ? Number(countRaw) || undefined : undefined,
        applet,
        severity: eventSeverity(reason, type, message),
      });
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * v2 logs → LogLine[]. Rows are `[timestampNs, line]` where line is JSON
 * `{"_entry": "...", "type": "stdout|stderr"}` (plain strings are accepted too).
 */
export function parseLokiLogs(raw: LokiStreams | null | undefined): LogLine[] {
  const out: LogLine[] = [];
  for (const stream of raw?.data ?? []) {
    const meta = (stream.metaData ?? {}) as Record<string, unknown>;
    for (const row of stream.values ?? []) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const json = tryJson(row[1]);
      const message = asString(json?._entry) ?? asString(json?.message) ?? asString(json?.log) ?? (json ? JSON.stringify(json) : asString(row[1])) ?? '';
      out.push({
        datetime: (parseTimestamp(row[0]) ?? new Date(0)).toISOString(),
        message: message.replace(/\n$/, ''),
        type: asString(json?.type) ?? asString(json?.stream) ?? asString(meta.type) ?? null,
        releaseId: asString(meta.releaseId) ?? null,
      });
    }
  }
  return out;
}

/** Sorts log lines ascending by datetime (stable for equal timestamps). */
export function sortLogs(lines: LogLine[]): LogLine[] {
  return lines
    .map((l, i) => ({ l, i, t: parseTimestamp(l.datetime)?.getTime() ?? 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.l);
}

export interface MetricPoint {
  /** epoch milliseconds */
  t: number;
  v: number;
}
export interface MetricSeries {
  series: { applet?: string; points: MetricPoint[] }[];
}

/** Converts a Prometheus-like range result into numeric points (ms timestamps). */
export function normalizeRange(raw: MetricRange | null | undefined): MetricSeries {
  return {
    series: (raw?.result ?? []).map((s) => ({
      applet: s.applet ?? undefined,
      points: (s.values ?? [])
        .map((pair) => ({ t: parseTimestamp(pair[0])?.getTime() ?? NaN, v: Number(pair[1]) }))
        .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)),
    })),
  };
}
