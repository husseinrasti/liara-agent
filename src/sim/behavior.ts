/**
 * Simulator time model (LIARA_FAKE=1 only): what a running app looks like at
 * time t for each chaos mode — health, memory, CPU, log lines and platform events.
 * Deterministic for a given (startedAt, now) so repeated reads agree.
 */

export const CHAOS_MODES = ['none', 'leak', 'crash', 'slow', 'missing-env', 'error500'] as const;
export type ChaosMode = (typeof CHAOS_MODES)[number];

export interface RunState {
  mode: ChaosMode;
  startedAt: number;
  ramMB: number;
  cpuCores: number;
  envs: Record<string, string>;
  scale: number;
  deployed: boolean;
}

export interface SimLog {
  t: number;
  msg: string;
  stream: 'stdout' | 'stderr';
}

export interface SimEvent {
  t: number;
  reason: string;
  type: 'Normal' | 'Warning';
  message: string;
}

const BASE_MB = 120;
const LEAK_MB_PER_S = 4;
const RESTART_GAP_MS = 10_000;
const CRASH_AFTER_MS = 3_000;
const STEP_MS = 15_000;

/** Effective mode: missing-env only bites when PAYMENT_API_KEY is absent. */
export function effectiveMode(s: RunState): ChaosMode {
  if (s.mode === 'missing-env' && s.envs.PAYMENT_API_KEY) return 'none';
  return s.mode;
}

/** OOM cycle for the leak mode: [cycleStart, oomAt] pairs up to `now`. */
export function leakCycles(s: RunState, now: number): { start: number; oom: number }[] {
  const cycleMs = ((s.ramMB - BASE_MB) / LEAK_MB_PER_S) * 1000;
  const out: { start: number; oom: number }[] = [];
  for (let start = s.startedAt; start <= now && out.length < 500; start += cycleMs + RESTART_GAP_MS) out.push({ start, oom: start + cycleMs });
  return out;
}

/** Crash-loop restarts with exponential back-off (10s → 60s max). */
export function crashStarts(s: RunState, now: number): number[] {
  const starts: number[] = [];
  let t = s.startedAt;
  let backoff = 10_000;
  while (t <= now && starts.length < 500) {
    starts.push(t);
    t += CRASH_AFTER_MS + backoff;
    backoff = Math.min(backoff * 2, 60_000);
  }
  return starts;
}

export function memoryMB(s: RunState, t: number): number {
  const mode = effectiveMode(s);
  if (!s.deployed || s.scale === 0 || t < s.startedAt) return 0;
  if (mode === 'leak') {
    const c = leakCycles(s, t).pop();
    if (!c || t > c.oom) return BASE_MB;
    return Math.min(s.ramMB, BASE_MB + ((t - c.start) / 1000) * LEAK_MB_PER_S);
  }
  if (mode === 'crash') return 60 + (t % 7);
  return BASE_MB - 10 + ((t / 60_000) % 9);
}

export function cpuCores(s: RunState, t: number): number {
  if (!s.deployed || s.scale === 0) return 0;
  const jitter = ((t / 60_000) % 5) / 100;
  switch (effectiveMode(s)) {
    case 'slow':
      return s.cpuCores * (0.93 + jitter);
    case 'leak':
      return s.cpuCores * (0.25 + jitter);
    case 'crash':
      return 0.01;
    default:
      return s.cpuCores * (0.06 + jitter);
  }
}

export interface Health {
  status: number;
  latencyMs: number;
  body: string;
}

export function healthAt(s: RunState, t: number): Health {
  if (!s.deployed) return { status: 404, latencyMs: 40, body: 'Application not found' };
  if (s.scale === 0) return { status: 503, latencyMs: 30, body: 'Service Unavailable' };
  const mode = effectiveMode(s);
  if (mode === 'crash') return { status: 503, latencyMs: 25, body: 'Service Unavailable' };
  if (mode === 'leak') {
    const c = leakCycles(s, t).pop();
    if (c && t > c.oom) return { status: 502, latencyMs: 35, body: 'Bad Gateway' };
    const pct = memoryMB(s, t) / s.ramMB;
    return { status: 200, latencyMs: pct > 0.8 ? 1200 : 220, body: 'فروشگاه نمونه' };
  }
  if (mode === 'slow') return { status: 200, latencyMs: 2500 + (t % 1500), body: 'فروشگاه نمونه' };
  if (mode === 'missing-env' || mode === 'error500') return { status: 500, latencyMs: 12, body: 'Internal Server Error' };
  return { status: 200, latencyMs: 140 + (t % 90), body: 'فروشگاه نمونه' };
}

const STACK_CRASH = [
  '/app/index.js:57',
  '    const id = order.id;',
  '                     ^',
  '',
  "TypeError: Cannot read properties of undefined (reading 'id')",
  '    at Timeout._onTimeout (/app/index.js:57:22)',
  '    at listOnTimeout (node:internal/timers:581:17)',
  '    at process.processTimers (node:internal/timers:519:7)',
  '',
  'Node.js v22.14.0',
];

const STACK_500 = [
  "TypeError: Cannot read properties of undefined (reading 'price')",
  '    at handler (/app/index.js:42:31)',
  '    at Server.<anonymous> (/app/index.js:88:5)',
  '    at Server.emit (node:events:519:28)',
];

/** Synthesized container output in [from, to]. */
export function logsBetween(s: RunState, from: number, to: number): SimLog[] {
  const out: SimLog[] = [];
  if (!s.deployed || s.scale === 0) return out;
  const mode = effectiveMode(s);
  const push = (t: number, msg: string, stream: SimLog['stream'] = 'stdout') => {
    if (t >= from && t <= to) out.push({ t, msg, stream });
  };
  const listen = (t: number) => push(t, 'demo app listening on port 3000');
  if (mode === 'leak') {
    for (const c of leakCycles(s, to)) {
      listen(c.start);
      for (let t = c.start + 5000; t < Math.min(c.oom, to); t += 5000) push(t, `memory usage: ${Math.round(memoryMB(s, t))} MB`);
      for (let t = c.start + 7000; t < Math.min(c.oom, to); t += STEP_MS) push(t, `GET / 200 ${memoryMB(s, t) / s.ramMB > 0.8 ? 1180 : 210}ms`);
      push(c.oom - 1, '<--- Last few GCs --->', 'stderr');
      push(c.oom, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'stderr');
    }
  } else if (mode === 'crash') {
    for (const start of crashStarts(s, to)) {
      listen(start);
      STACK_CRASH.forEach((line, i) => push(start + CRASH_AFTER_MS + i, line, 'stderr'));
    }
  } else {
    listen(s.startedAt);
    for (let t = s.startedAt + 4000; t <= to; t += STEP_MS) {
      if (t < from) continue;
      if (mode === 'missing-env') {
        push(t, 'Error: PAYMENT_API_KEY is not set', 'stderr');
        push(t + 1, 'GET / 500 3ms');
      } else if (mode === 'error500') {
        STACK_500.forEach((line, i) => push(t + i, line, 'stderr'));
        push(t + 10, 'GET / 500 4ms');
      } else if (mode === 'slow') {
        push(t, `GET /api/products 200 ${2600 + (t % 1300)}ms`);
      } else {
        push(t, `GET / 200 ${8 + (t % 23)}ms`);
      }
    }
  }
  return out.sort((a, b) => a.t - b.t).slice(-400);
}

/** Model-derived events (OOM kills, back-offs) in [from, to]. Lifecycle events are stored by the simulator. */
export function eventsBetween(s: RunState, from: number, to: number): SimEvent[] {
  const out: SimEvent[] = [];
  if (!s.deployed || s.scale === 0) return out;
  const mode = effectiveMode(s);
  if (mode === 'leak') {
    leakCycles(s, to).forEach((c, i) => {
      if (c.oom >= from && c.oom <= to) {
        out.push({ t: c.oom, reason: 'OOMKilled', type: 'Warning', message: `Container was OOM killed (memory limit ${s.ramMB}Mi)` });
        if (i > 0) out.push({ t: c.oom + 1000, reason: 'BackOff', type: 'Warning', message: 'Back-off restarting failed container' });
      }
    });
  }
  if (mode === 'crash') {
    for (const start of crashStarts(s, to).slice(1)) if (start >= from && start <= to) out.push({ t: start - 1000, reason: 'BackOff', type: 'Warning', message: 'Back-off restarting failed container' });
  }
  return out;
}

export function appletState(s: RunState, now: number): { state: string; reason: string | null } | null {
  if (!s.deployed || s.scale === 0) return null;
  const mode = effectiveMode(s);
  if (mode === 'crash') return { state: 'CrashLoopBackOff', reason: 'Error' };
  if (mode === 'leak') {
    const c = leakCycles(s, now).pop();
    const recentOom = leakCycles(s, now).some((x) => now - x.oom < 120_000 && now >= x.oom);
    if (c && now > c.oom) return { state: 'CrashLoopBackOff', reason: 'OOMKilled' };
    return { state: 'Running', reason: recentOom ? 'OOMKilled' : null };
  }
  return { state: 'Running', reason: null };
}
