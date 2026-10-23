/**
 * Server-side singleton for the Next.js app: the agent runtime (live Liara, or
 * the opt-in simulator when LIARA_FAKE=1), the watcher, and per-session locks.
 * Cached on globalThis so dev hot-reloads reuse one instance.
 */
import { createAgentRuntime, type AgentRuntime } from './agent';
import { startWatcher, type Watcher } from './agent/watcher';
import { createSimulatedDeps, isSimulated, SIM_DEMO_APP } from './sim/deps';
import type { LiaraSimulator } from './sim/liara-sim';
import { createRuntime } from './tools';

export type RuntimeMode = 'live' | 'simulated';

export interface ServerRuntime {
  rt: AgentRuntime;
  mode: RuntimeMode;
  sim?: LiaraSimulator;
  demoAppName?: string;
  watcher: Watcher | null;
  ensureWatcher(): Watcher | null;
  /** Sessions with a turn in progress (one turn per session at a time). */
  busy: Set<string>;
  /** Runs fn once the session is idle, holding it busy meanwhile (post-approval turns queue behind a chat turn). */
  runExclusive(sessionId: string, fn: () => Promise<void>): Promise<void>;
}

const g = globalThis as unknown as { __liaraAgent?: ServerRuntime };


function build(): ServerRuntime {
  let rt: AgentRuntime;
  let sim: LiaraSimulator | undefined;
  let demoAppName: string | undefined;
  if (isSimulated()) {
    const simulated = createSimulatedDeps();
    sim = simulated.sim;
    rt = createAgentRuntime({ deps: simulated.deps, httpFetch: sim.httpFetch });
    demoAppName = SIM_DEMO_APP;
  } else {
    const deps = createRuntime();
    rt = createAgentRuntime({ deps });
    demoAppName = deps.config.liara.demoAppName;
  }
  const server: ServerRuntime = {
    rt,
    mode: sim ? 'simulated' : 'live',
    sim,
    demoAppName,
    watcher: null,
    busy: new Set(),
    ensureWatcher() {
      if (!server.watcher) server.watcher = startWatcher(rt);
      return server.watcher;
    },
    async runExclusive(sessionId, fn) {
      const deadline = Date.now() + 120_000;
      while (server.busy.has(sessionId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      server.busy.add(sessionId);
      try {
        await fn();
      } finally {
        server.busy.delete(sessionId);
      }
    },
  };
  return server;
}

export function getAgentRuntime(): ServerRuntime {
  g.__liaraAgent ??= build();
  return g.__liaraAgent;
}
