/** Plain HTTP health probing of a public URL (not the Liara API — Liara exposes no access logs). */

export interface HealthResult {
  url: string;
  /** Last observed HTTP status; 0 when no response (timeout, DNS, TLS…). */
  status: number;
  ok: boolean;
  latencyMs: { min: number; avg: number; max: number } | null;
  bodySnippet: string;
  error?: string;
  samples: number;
  sampledAt: string;
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?fc|\[?fd)/i;

/** Only public http(s) URLs may be probed (prevents the agent from poking internal services). */
export function validatePublicUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'only http(s) URLs are allowed' };
  if (PRIVATE_HOST.test(url.hostname)) return { ok: false, reason: 'private/local addresses are not allowed' };
  return { ok: true, url };
}

export interface ProbeOptions {
  timeoutMs?: number;
  samples?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function httpProbe(url: string, opts: ProbeOptions = {}): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const samples = Math.max(1, Math.min(opts.samples ?? 3, 10));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const latencies: number[] = [];
  let status = 0;
  let body = '';
  let error: string | undefined;
  for (let i = 0; i < samples; i++) {
    const started = Date.now();
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'liara-agent/1.0', Accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = (await res.text()).slice(0, 2000);
      status = res.status;
      error = undefined;
      latencies.push(Date.now() - started);
    } catch (err) {
      status = 0;
      const e = err as Error;
      error = e.name === 'TimeoutError' || e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e.cause as Error)?.message ?? e.message;
    }
  }
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  return {
    url,
    status,
    ok: status >= 200 && status < 400,
    latencyMs: latencies.length ? { min: Math.min(...latencies), avg, max: Math.max(...latencies) } : null,
    bodySnippet: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
    error,
    samples,
    sampledAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
}

/** Polls until the URL answers 2xx/3xx or `deadlineMs / intervalMs` attempts are used; returns the last result. */
export async function waitForHealthy(
  url: string,
  opts: ProbeOptions & { deadlineMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<HealthResult> {
  const interval = opts.intervalMs ?? 5000;
  const attempts = Math.max(1, Math.ceil((opts.deadlineMs ?? 60_000) / interval));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = await httpProbe(url, { ...opts, samples: 1 });
  for (let i = 1; i < attempts && !last.ok; i++) {
    await sleep(interval);
    last = await httpProbe(url, { ...opts, samples: 1 });
  }
  return last;
}

export function healthLineFa(h: HealthResult): string {
  if (h.status === 0) return `سایت پاسخ نداد (${h.error ?? 'بدون پاسخ'})`;
  const fa = (n: number) => n.toLocaleString('fa-IR');
  return `وضعیت سایت: ${h.status} (${h.ok ? 'سالم' : 'خطا'}${h.latencyMs ? `، ${fa(h.latencyMs.avg)} میلی‌ثانیه` : ''})`;
}
