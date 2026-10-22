import type { LiaraClient } from '../client';
import { normalizeEvents } from '../normalize';
import { formatTime, LIARA_TIME_FORMATS } from '../time';
import { EventsRawSchema, type AppEvent } from '../types';
import { appPath } from './apps';

/** Kubernetes-style app events (OOMKilled, BackOff, Pulled…), normalized and ascending. */
export async function getEvents(
  c: LiaraClient,
  name: string,
  opts: { start?: Date; end?: Date; search?: string } = {},
): Promise<AppEvent[]> {
  const fmt = LIARA_TIME_FORMATS.eventsRange;
  const raw = await c.request(EventsRawSchema, {
    path: `${appPath(name)}/events`,
    query: {
      start: opts.start ? formatTime(opts.start, fmt) : undefined,
      end: opts.end ? formatTime(opts.end, fmt) : undefined,
      search: opts.search,
    },
  });
  return normalizeEvents(raw);
}
