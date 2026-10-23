import { describe, expect, it } from 'vitest';
import { EVENTS_PAGE_SIZE, getEvents } from '../endpoints/events';
import { fakeClient, type FakeCall } from '../../test-utils/fake-liara';

interface Row {
  id: string;
  status: string;
  action: string;
  time: string;
  release: string;
  tag: string;
}

/** Like the real API [probe 2026-10-23]: newest first, 12 rows max, `end` exclusive, unknown params → 400. */
function eventsApi(rows: Row[], calls: FakeCall[]) {
  return fakeClient(
    {
      'GET /v1/projects/app/events': ({ url }) => {
        for (const k of url.searchParams.keys()) if (!['start', 'end', 'search'].includes(k)) return { status: 400, body: { message: `"${k}" is not allowed` } };
        const start = Number(url.searchParams.get('start') ?? 0);
        const end = Number(url.searchParams.get('end') ?? Infinity);
        const data = rows.filter((r) => +r.time >= start && +r.time < end).sort((a, b) => +b.time - +a.time);
        return { body: { data: data.slice(0, EVENTS_PAGE_SIZE) } };
      },
    },
    calls,
  );
}

/** A restart cycle per minute: kill/die/stop on the old container, create/start on the next. */
function restartCycles(n: number, t0: number): Row[] {
  const rows: Row[] = [];
  const row = (id: string, action: string, t: number): Row => ({ id, status: action, action, time: String(t), release: 'r1', tag: 'v1' });
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 60;
    rows.push(row(`c${i}`, 'kill', t), row(`c${i}`, 'die', t + 1), row(`c${i}`, 'stop', t + 1), row(`c${i + 1}`, 'create', t + 2), row(`c${i + 1}`, 'start', t + 2));
  }
  return rows;
}

describe('getEvents', () => {
  const t0 = 1_792_760_000;

  it('pages backwards through the 12-row cap and returns every event ascending', async () => {
    const calls: FakeCall[] = [];
    const rows = restartCycles(6, t0);
    const events = await getEvents(eventsApi(rows, calls), 'app', { start: new Date((t0 - 60) * 1000), end: new Date((t0 + 3600) * 1000) });
    expect(events).toHaveLength(30);
    expect(events.map((e) => e.ts)).toEqual([...events.map((e) => e.ts)].sort());
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('keeps rows that share the oldest second of a page (no gaps, no duplicates)', async () => {
    const calls: FakeCall[] = [];
    const events = await getEvents(eventsApi(restartCycles(4, t0), calls), 'app');
    expect(events).toHaveLength(20);
    // a die preceded by its kill on an older page is still a normal stop, not a crash
    expect(events.filter((e) => e.reason === 'Died' || e.reason === 'Exited')).toHaveLength(0);
    expect(events.filter((e) => e.reason === 'Stopped')).toHaveLength(8); // 4 stop + 4 die-after-kill
  });

  it('stops at maxPages and when a page is not full', async () => {
    const many: FakeCall[] = [];
    await getEvents(eventsApi(restartCycles(20, t0), many), 'app', { maxPages: 2 });
    expect(many).toHaveLength(2);
    const few: FakeCall[] = [];
    const events = await getEvents(eventsApi(restartCycles(1, t0), few), 'app');
    expect(few).toHaveLength(1);
    expect(events).toHaveLength(5);
  });
});
