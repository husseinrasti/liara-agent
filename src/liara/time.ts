export type TimeFormat = 'unix-seconds' | 'unix-ms' | 'iso';

/**
 * Time formats accepted by Liara query parameters, as discovered by the probe
 * (docs/API-NOTES.md → Decisions). Change here only with fixture evidence.
 */
export const LIARA_TIME_FORMATS: { logsSince: TimeFormat; eventsRange: TimeFormat; metricsSince: TimeFormat } = {
  logsSince: 'unix-seconds',
  eventsRange: 'unix-seconds',
  metricsSince: 'unix-seconds',
};

export function formatTime(d: Date, format: TimeFormat): string | number {
  switch (format) {
    case 'unix-seconds':
      return Math.floor(d.getTime() / 1000);
    case 'unix-ms':
      return d.getTime();
    case 'iso':
      return d.toISOString();
  }
}

/**
 * Parses timestamps in any of the shapes Liara returns: ISO strings, unix
 * seconds, milliseconds, microseconds or nanoseconds (numbers or numeric strings).
 */
export function parseTimestamp(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const digits = Math.floor(n).toString().length;
    const ms = digits >= 18 ? n / 1e6 : digits >= 15 ? n / 1e3 : digits >= 12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}
