import type { LiaraClient } from '../client';
import { LiaraApiError } from '../errors';
import { parseLokiLogs, sortLogs } from '../normalize';
import { formatTime, LIARA_TIME_FORMATS } from '../time';
import { LogsResponseSchema, LokiStreamsSchema, type LogLine } from '../types';
import { appPath } from './apps';

/**
 * Container stdout/stderr since `since`, ascending. Liara exposes no HTTP access
 * logs (only what the app/web server itself prints).
 *
 * New-infrastructure apps use `GET /v2/projects/{app}/logs?start=<unix s>&direction=…`
 * (Loki-like streams, lines are JSON `{_entry, type}`), as liara-cli does; apps on
 * the old infrastructure only answer `GET /v1/projects/{app}/logs?since=…`.
 */
export async function getLogs(c: LiaraClient, name: string, since: Date, opts: { releaseId?: string } = {}): Promise<LogLine[]> {
  try {
    const raw = await c.request(LokiStreamsSchema, {
      path: `/v2/projects/${encodeURIComponent(name)}/logs`,
      query: { start: Math.floor(since.getTime() / 1000), direction: 'backward', releaseId: opts.releaseId },
      timeoutMs: 20_000,
    });
    return sortLogs(parseLokiLogs(raw));
  } catch (err) {
    if (!(err instanceof LiaraApiError) || ![400, 404, 405, 422].includes(err.status)) throw err;
    const lines = await c.request(LogsResponseSchema, {
      path: `${appPath(name)}/logs`,
      query: { since: formatTime(since, LIARA_TIME_FORMATS.logsSince) },
    });
    return sortLogs(Array.isArray(lines) ? lines : []);
  }
}
