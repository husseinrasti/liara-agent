import type { ZodType } from 'zod';
import { silentLogger, type Logger } from '../logger';
import { LiaraApiError, messageFromBody } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | undefined | null;

export interface RequestInit {
  method?: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  multipart?: FormData;
  timeoutMs?: number;
  /** Override retry count (GET only). */
  retries?: number;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  body: unknown;
  durationMs: number;
  endpoint: string;
}

export interface LiaraClientOptions {
  token: string;
  baseUrl?: string;
  teamId?: string;
  fetch?: typeof fetch;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export const LIARA_EXEC_WS_URL = 'wss://api.iran.liara.ir/v1/exec';
const DEFAULT_TIMEOUT_MS = 20_000;
export const UPLOAD_TIMEOUT_MS = 180_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_GET_RETRIES = 2;

export class LiaraClient {
  readonly baseUrl: string;
  readonly teamId?: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: LiaraClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? 'https://api.liara.ir').replace(/\/+$/, '');
    this.teamId = opts.teamId;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger ?? silentLogger;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Performs a request and validates the JSON body with `schema` leniently:
   * on mismatch it logs a warning and returns the raw value cast to T.
   * Throws LiaraApiError for non-2xx, timeouts and network failures.
   */
  async request<T>(schema: ZodType<T>, init: RequestInit): Promise<T> {
    const res = await this.requestRaw(init);
    if (!res.ok) {
      throw new LiaraApiError({
        status: res.status,
        endpoint: res.endpoint,
        message: messageFromBody(res.body, `HTTP ${res.status}`),
        body: res.body,
      });
    }
    const parsed = schema.safeParse(res.body);
    if (parsed.success) return parsed.data;
    this.logger.warn(
      {
        endpoint: res.endpoint,
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      'liara response did not match schema; using raw value',
    );
    return res.body as T;
  }

  /** Like request() but never throws on HTTP status; used by the probe and for tolerant calls. */
  async requestRaw(init: RequestInit): Promise<RawResponse> {
    const method = init.method ?? 'GET';
    const endpoint = `${method} ${init.path}`;
    const maxRetries = method === 'GET' ? (init.retries ?? DEFAULT_GET_RETRIES) : 0;
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.once(method, endpoint, init);
        if (attempt < maxRetries && RETRY_STATUSES.has(res.status)) {
          attempt++;
          await this.sleep(backoffMs(attempt));
          continue;
        }
        return res;
      } catch (err) {
        if (attempt < maxRetries && err instanceof LiaraApiError && err.status === 0) {
          attempt++;
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * WebSocket URL for the in-container console (liara-cli: `wss://api.iran.liara.ir/v1/exec`).
   * Contains the token: never log or return it.
   */
  consoleSocketUrl(params: Record<string, string>, endpoint = LIARA_EXEC_WS_URL): string {
    const url = new URL(endpoint);
    url.searchParams.set('token', this.token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (this.teamId) url.searchParams.set('teamID', this.teamId);
    return url.toString();
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    if (this.teamId && !url.searchParams.has('teamID')) url.searchParams.set('teamID', this.teamId);
    return url.toString();
  }

  private async once(method: HttpMethod, endpoint: string, init: RequestInit): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'User-Agent': 'liara-agent/0.1',
    };
    let body: BodyInit | undefined;
    if (init.multipart) {
      body = init.multipart; // fetch sets the multipart boundary header
    } else if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const timeoutMs = init.timeoutMs ?? (init.multipart ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(init.path, init.query), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      this.logger.warn({ endpoint, isTimeout }, 'liara request failed before response');
      throw new LiaraApiError({
        status: 0,
        endpoint,
        message: isTimeout ? `timeout after ${timeoutMs}ms` : `network error: ${(err as Error)?.message ?? err}`,
        code: isTimeout ? 'TIMEOUT' : 'NETWORK',
      });
    }
    const text = await response.text();
    const durationMs = Date.now() - started;
    let parsedBody: unknown = undefined;
    if (text) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    }
    this.logger.debug({ endpoint, status: response.status, durationMs, bytes: text.length }, 'liara request');
    return { status: response.status, ok: response.ok, body: parsedBody, durationMs, endpoint };
  }
}

function backoffMs(attempt: number): number {
  return 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}
