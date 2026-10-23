/**
 * Runtime dependencies wired to the simulator (LIARA_FAKE=1), shared by the web
 * server, the MCP server and `accept:prd02 -- --sim`. Never used unless asked for.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config';
import { openDb } from '../db';
import { linkSourceRelease, recordSource } from '../db/repo';
import { LiaraClient } from '../liara/client';
import { createLogger, type Logger } from '../logger';
import type { RuntimeDeps } from '../tools';
import { createLiaraSimulator, type LiaraSimulator } from './liara-sim';

export const SIM_DEMO_APP = 'liara-agent-demo';

export function isSimulated(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LIARA_FAKE ?? '');
}

/**
 * A fresh simulated account with its own fresh SQLite file in data/. Seeded
 * releases are recorded as deployed by this assistant (as in the real demo),
 * so rollback can reuse their source.
 */
export function createSimulatedDeps(opts: { dbFile?: string; logger?: Logger } = {}): { deps: RuntimeDeps; sim: LiaraSimulator } {
  // The simulator never talks to Liara; a placeholder satisfies config validation when no token is set.
  process.env.LIARA_API_TOKEN ||= 'simulated';
  const config = getConfig();
  const logger = opts.logger ?? createLogger({ level: config.logLevel, name: 'liara-agent-sim' });
  const sim = createLiaraSimulator();
  const liara = new LiaraClient({ token: 'simulated', baseUrl: config.liara.baseUrl, fetch: sim.fetch, logger });
  const databasePath = path.join(config.dataDir, opts.dbFile ?? 'agent-sim.db');
  for (const f of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) rmSync(f, { force: true });
  const db = openDb(databasePath);
  for (const app of sim.state.apps.values()) {
    for (const r of app.releases) {
      recordSource(db, { appName: app.name, sourceID: r.sourceID, archivePath: '', createdAt: new Date(r.createdAt).toISOString() });
      linkSourceRelease(db, app.name, r.sourceID, r._id);
    }
  }
  return { deps: { config: { ...config, databasePath, liara: { ...config.liara, demoAppName: SIM_DEMO_APP } }, liara, db, logger }, sim };
}
