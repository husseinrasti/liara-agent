import { describe, expect, it } from 'vitest';
import { eventSeverity, normalizeEvents, normalizeRange, parseLokiLogs, sortLogs } from '../normalize';
import { parseTimestamp } from '../time';

const ns = (iso: string) => `${Date.parse(iso)}000000`;

describe('parseTimestamp', () => {
  it('handles ns, µs, ms, s and ISO', () => {
    const iso = '2026-10-22T10:00:00.000Z';
    for (const v of [ns(iso), `${Date.parse(iso)}000`, Date.parse(iso), Date.parse(iso) / 1000, iso]) {
      expect(parseTimestamp(v)?.toISOString()).toBe(iso);
    }
    expect(parseTimestamp('nope')).toBeNull();
    expect(parseTimestamp(0)).toBeNull();
  });
});

describe('normalizeEvents', () => {
  it('flattens Loki-like streams with JSON Kubernetes events', () => {
    const raw = {
      data: [
        {
          metaData: { pod: 'my-app-abc' },
          values: [
            [ns('2026-10-22T10:01:00Z'), JSON.stringify({ reason: 'OOMKilled', type: 'Warning', message: 'Container was OOM killed', count: 3 })],
            [ns('2026-10-22T10:00:00Z'), JSON.stringify({ reason: 'Pulled', type: 'Normal', message: 'Image pulled' })],
          ],
        },
        { metaData: { reason: 'BackOff', type: 'Warning' }, values: [[ns('2026-10-22T10:02:00Z'), 'Back-off restarting failed container']] },
        { metaData: {}, values: [[ns('2026-10-22T10:03:00Z'), JSON.stringify({ _entry: JSON.stringify({ reason: 'Killing', message: 'Stopping container' }) })]] },
      ],
    };
    const events = normalizeEvents(raw);
    expect(events.map((e) => e.reason)).toEqual(['Pulled', 'OOMKilled', 'BackOff', 'Killing']);
    expect(events[1]).toMatchObject({ severity: 'error', count: 3, applet: 'my-app-abc', message: 'Container was OOM killed' });
    expect(events[2]).toMatchObject({ severity: 'error', message: 'Back-off restarting failed container' });
    expect(events[3]!.severity).toBe('warning');
    expect(events[0]!.severity).toBe('info');
  });

  it('maps severities', () => {
    expect(eventSeverity('Evicted')).toBe('error');
    expect(eventSeverity('Unhealthy')).toBe('error');
    expect(eventSeverity('Scaling')).toBe('warning');
    expect(eventSeverity('Scheduled', 'Warning')).toBe('warning');
    expect(eventSeverity('Started')).toBe('info');
  });

  it('tolerates empty or missing data', () => {
    expect(normalizeEvents({ data: [] })).toEqual([]);
    expect(normalizeEvents(null)).toEqual([]);
  });
});

describe('parseLokiLogs', () => {
  it('reads _entry/type JSON lines and sorts ascending', () => {
    const raw = {
      data: [
        {
          metaData: { releaseId: 'r1' },
          values: [
            [ns('2026-10-22T10:00:02Z'), JSON.stringify({ _entry: 'second\n', type: 'stderr' })],
            [ns('2026-10-22T10:00:01Z'), JSON.stringify({ _entry: 'first', type: 'stdout' })],
          ],
        },
        { metaData: {}, values: [[ns('2026-10-22T10:00:03Z'), 'plain text line']] },
      ],
    };
    const lines = sortLogs(parseLokiLogs(raw));
    expect(lines.map((l) => l.message)).toEqual(['first', 'second', 'plain text line']);
    expect(lines[1]).toMatchObject({ type: 'stderr', releaseId: 'r1', datetime: '2026-10-22T10:00:02.000Z' });
  });
});

describe('normalizeRange', () => {
  it('converts Prometheus pairs to numeric ms points', () => {
    const series = normalizeRange({ end: 1, result: [{ applet: 'a', values: [[1761127200, '0.5'], [1761127260, 'NaN'], ['1761127320', '1.5']] }] });
    expect(series.series[0]!.points).toEqual([
      { t: 1761127200000, v: 0.5 },
      { t: 1761127320000, v: 1.5 },
    ]);
  });
});

describe('normalizeEvents — flat container events (new infrastructure) [probe 07a]', () => {
  const raw = {
    data: [
      { id: '2d074edf17615bdd', status: 'start', action: 'start', time: '1792765519', release: 'r1', tag: 'v1' },
      { id: '2d074edf17615bdd', status: 'create', action: 'create', time: '1792765517', release: 'r1', tag: 'v1' },
      { id: '2d074edf17615bdd', status: 'oom', action: 'oom', time: '1792765600', release: 'r1', tag: 'v1' },
      { id: '2d074edf17615bdd', status: 'die', action: 'die', time: '1792765601', release: 'r1', tag: 'v1', exitCode: '137' },
    ],
  };

  it('maps actions to the reasons the playbooks use, sorted by time', () => {
    const events = normalizeEvents(raw);
    expect(events.map((e) => e.reason)).toEqual(['Created', 'Started', 'OOMKilled', 'Exited']);
    expect(events[0]!.ts).toBe(new Date(1792765517 * 1000).toISOString());
    expect(events[2]).toMatchObject({ type: 'Warning', severity: 'error', message: 'oom (v1)' });
    expect(events[3]).toMatchObject({ type: 'Warning', severity: 'warning', message: 'die (v1) exit code 137 — exited on its own' });
    expect(events[1]).toMatchObject({ type: 'Normal', severity: 'info' });
  });
});

describe('normalizeEvents — die classification', () => {
  const ev = (id: string, action: string, time: number) => ({ id, status: action, action, time: String(time), release: 'r', tag: 'v1' });

  it('restart and deploy (kill → die → stop) is a planned stop [probe 07a-late]', () => {
    const events = normalizeEvents({ data: [ev('aaa', 'kill', 100), ev('aaa', 'die', 101), ev('aaa', 'stop', 101), ev('bbb', 'create', 101), ev('bbb', 'start', 103)] });
    expect(events.filter((e) => e.applet === 'aaa').map((e) => e.reason)).toEqual(['Killed', 'Stopped', 'Stopped']);
    expect(events.some((e) => e.reason === 'Exited')).toBe(false);
  });

  it('a die followed by a start of the same container is a crash', () => {
    const events = normalizeEvents({ data: [ev('aaa', 'start', 100), ev('aaa', 'die', 110), ev('aaa', 'start', 121), ev('aaa', 'die', 131)] });
    expect(events.map((e) => e.reason)).toEqual(['Started', 'Exited', 'Started', 'Died']);
    expect(events[1]).toMatchObject({ type: 'Warning', severity: 'warning' });
  });

  it('a lone die (list may be truncated) stays neutral', () => {
    expect(normalizeEvents({ data: [ev('aaa', 'die', 100), ev('aaa', 'destroy', 240)] }).map((e) => e.reason)).toEqual(['Died', 'Destroyed']);
  });
});
