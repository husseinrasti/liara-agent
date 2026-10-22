/** Registers every PRD-01 tool and builds tool contexts. Import this module to get a populated registry. */
import { getConfig, type AppConfig } from '../config';
import { openDb, type Db } from '../db';
import { LiaraClient } from '../liara/client';
import { createLogger, type Logger } from '../logger';
import { collectEvidenceTool } from './composite/collect-evidence';
import { accountTools } from './liara/account';
import { appTools } from './liara/apps';
import { deployTools } from './liara/deploy';
import { domainTools } from './liara/domains';
import { envTools } from './liara/envs';
import { observeTools } from './liara/observe';
import { shellTools } from './liara/shell';
import { analyzeProjectTool } from './local/analyze-project';
import { buildSourceArchiveTool } from './local/build-source-archive';
import { httpHealthCheckTool } from './local/http-health-check';
import { searchDocsTool } from './local/search-docs';
import { registerTools, registry, type ToolContext, type ToolDef } from './registry';

export const ALL_TOOLS: ToolDef[] = [
  ...appTools,
  ...observeTools,
  ...accountTools,
  ...domainTools,
  ...deployTools,
  ...envTools,
  ...shellTools,
  httpHealthCheckTool,
  searchDocsTool,
  analyzeProjectTool,
  buildSourceArchiveTool,
  collectEvidenceTool,
];

registerTools(ALL_TOOLS);

export { registry };
export * from './registry';

export interface RuntimeDeps {
  config: AppConfig;
  liara: LiaraClient;
  db: Db;
  logger: Logger;
}

/** Shared runtime (Liara client, DB, logger) from validated config. */
export function createRuntime(opts: { logger?: Logger; config?: AppConfig } = {}): RuntimeDeps {
  const config = opts.config ?? getConfig();
  const logger = opts.logger ?? createLogger({ level: config.logLevel });
  const liara = new LiaraClient({ token: config.liara.token, baseUrl: config.liara.baseUrl, teamId: config.liara.teamId, logger });
  const db = openDb(config.databasePath);
  return { config, liara, db, logger };
}

export function createToolContext(rt: RuntimeDeps, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    liara: rt.liara,
    db: rt.db,
    logger: rt.logger,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    workdir: rt.config.rootDir,
    dataDir: rt.config.dataDir,
    publicUrlSuffix: rt.config.liara.publicUrlSuffix,
    ...extra,
  };
}
