import type { LiaraClient } from '../client';
import { normalizeEvents } from '../normalize';
import { formatTime, LIARA_TIME_FORMATS } from '../time';
import { EventsRawSchema, type AppEvent, type EventsRaw } from '../types';
import { appPath } from './apps';

/**
 * The events API returns at most this many rows per call, newest first, and rejects
 * limit/count/page/skip with 400; `end` is exclusive [probe 2026-10-23].
 */
export const EVENTS_PAGE_SIZE = 12;
export const DEFAULT_EVENT_PAGES = 4;

type EventRow = NonNullable<EventsRaw['data']>[number];

/** Unix seconds of a flat container event row, or null for Loki-style streams. */
function rowSeconds(r: EventRow): number | null {
  if (Array.isArray(r.values) || r.time === undefined || r.time === null) return null;
  const n = Number(r.time);
  return Number.isFinite(n) ? n : null;
}

/**
 * Container events (create/start/kill/die/stop/oom…), normalized and ascending. Pages backwards
 * through the 12-row cap by moving `end` to the oldest row seen (+1 s, deduped), up to `maxPages`.
 */
export async function getEvents(
  c: LiaraClient,
  name: string,
  opts: { start?: Date; end?: Date; search?: string; maxPages?: number } = {},
): Promise<AppEvent[]> {
  const fmt = LIARA_TIME_FORMATS.eventsRange;
  const rows: EventRow[] = [];
  const seen = new Set<string>();
  let end = opts.end;
  for (let page = 0; page < (opts.maxPages ?? DEFAULT_EVENT_PAGES); page++) {
    const raw = await c.request(EventsRawSchema, {
      path: `${appPath(name)}/events`,
      query: {
        start: opts.start ? formatTime(opts.start, fmt) : undefined,
        end: end ? formatTime(end, fmt) : undefined,
        search: opts.search,
      },
    });
    const data = raw?.data ?? [];
    let oldest: number | null = null;
    let added = 0;
    for (const r of data) {
      const t = rowSeconds(r);
      const key = t === null ? null : `${r.id}|${r.action ?? r.status}|${t}`;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rows.push(r);
      added++;
      if (t !== null) oldest = oldest === null ? t : Math.min(oldest, t);
    }
    if (data.length < EVENTS_PAGE_SIZE || oldest === null || added === 0) break;
    const next = new Date((oldest + 1) * 1000);
    if (opts.start && next <= opts.start) break;
    end = next;
  }
  return normalizeEvents({ data: rows });
}
