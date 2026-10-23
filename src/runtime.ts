/**
 * Server-side singleton for the Next.js app: the agent runtime (live Liara, or
 * the opt-in simulator when LIARA_FAKE=1), the watcher, and per-session locks.
 * Cached on globalThis so dev hot-reloads reuse one instance.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { createAgentRuntime, type AgentRuntime } from './agent';
import { startWatcher, type Watcher } from './agent/watcher';
import { getConfig } from './config';
import { openDb } from './db';
import { linkSourceRelease, recordSource } from './db/repo';
import { LiaraClient } from './liara/client';
import { createLogger } from './logger';
import { createLiaraSimulator, type LiaraSimulator } from './sim/liara-sim';
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

export function isSimulated(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LIARA_FAKE ?? '');
}

function build(): ServerRuntime {
  let rt: AgentRuntime;
  let sim: LiaraSimulator | undefined;
  let demoAppName: string | undefined;
  if (isSimulated()) {
    // The simulator never talks to Liara; a placeholder satisfies config validation if no token is set.
    process.env.LIARA_API_TOKEN ||= 'simulated';
    const config = getConfig();
    const logger = createLogger({ level: config.logLevel, name: 'liara-agent-sim' });
    sim = createLiaraSimulator();
    const liara = new LiaraClient({ token: 'simulated', baseUrl: config.liara.baseUrl, fetch: sim.fetch, logger });
    const databasePath = path.join(config.dataDir, 'agent-sim.db');
    // The simulated account starts fresh on every start, so its conversations, alerts and sources do too.
    for (const f of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) rmSync(f, { force: true });
    const db = openDb(databasePath);
    // Seeded releases stand for ones this assistant deployed earlier (as in the real demo), so rollback can reuse their source.
    for (const app of sim.state.apps.values()) {
      for (const r of app.releases) {
        recordSource(db, { appName: app.name, sourceID: r.sourceID, archivePath: '', createdAt: new Date(r.createdAt).toISOString() });
        linkSourceRelease(db, app.name, r.sourceID, r._id);
      }
    }
    rt = createAgentRuntime({ deps: { config: { ...config, databasePath }, liara, db, logger }, httpFetch: sim.httpFetch });
    demoAppName = 'liara-agent-demo';
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
