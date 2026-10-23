/**
 * Deploys this web UI to Liara with the assistant's own tools (optional follow-up in docs/KICKOFF-PROMPT.md).
 *
 *   npm run deploy:self                   prints the plan (app, plan, cost, disk, env keys) and stops
 *   npm run deploy:self -- --yes          does it: create_app → create_disk → deploy_project (audited + verified)
 *   options: --app <name> (default liara-agent-ui), --plan <planID>, --disk-gb <n> (default 1), --sim
 *
 * The SQLite database lives on a persistent disk mounted at /data (liara.json `disks`), via
 * DATABASE_PATH=/data/agent.db. Non-secret .env values are set on the app; secrets (LIARA_API_TOKEN,
 * LLM keys) are never sent — add them in the Liara console (Liara restarts the app).
 * `--sim` runs the same steps against the LIARA_FAKE simulator.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { executeAction } from '../src/agent/policy';
import { createAgentRuntime, toolContextFor } from '../src/agent/runtime';
import { AgentSession } from '../src/agent/session';
import '../src/agent/tools';
import { ConfigError, ROOT_DIR } from '../src/config';
import { getApp, listApps } from '../src/liara/endpoints/apps';
import { getDisks } from '../src/liara/endpoints/disks';
import { createLogger } from '../src/logger';
import { createSimulatedDeps } from '../src/sim/deps';
import { createRuntime, getTool, runTool } from '../src/tools';
import { formatIRT, isSecretKey } from '../src/tools/helpers';

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sim = args.includes('--sim');
const appName = arg('--app') ?? 'liara-agent-ui';
const diskGB = Number(arg('--disk-gb') ?? 1);
const DISK = { name: 'data', mountTo: '/data' };
/** Keys the deployed UI must not inherit from a local .env. */
const LOCAL_ONLY = /^(AUTO_APPROVE|LIARA_FAKE|DATABASE_PATH)$/;

function envPlan(): { envs: Record<string, string>; secrets: string[] } {
  const file = path.join(ROOT_DIR, '.env');
  const local = existsSync(file) ? parse(readFileSync(file)) : {};
  const envs: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(local)) {
    if (!value.trim() || LOCAL_ONLY.test(key)) continue;
    if (isSecretKey(key)) secrets.push(key);
    else envs[key] = value;
  }
  return { envs: { ...envs, NODE_ENV: 'production', AUTO_APPROVE: 'false', DATABASE_PATH: `${DISK.mountTo}/agent.db` }, secrets };
}

async function main() {
  const logger = createLogger({ level: 'warn', name: 'deploy-self' });
  let simulated: ReturnType<typeof createSimulatedDeps> | null = null;
  let deps;
  try {
    simulated = sim ? createSimulatedDeps({ dbFile: 'deploy-self-sim.db', logger }) : null;
    deps = simulated?.deps ?? createRuntime({ logger });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (!simulated) {
    const pre = await deps.liara.requestRaw({ path: '/v1/me', retries: 0, timeoutMs: 15_000 }).catch((e: Error) => e);
    if (pre instanceof Error || pre.status >= 400) {
      console.error(`Liara API not usable from this process (${pre instanceof Error ? pre.message : `HTTP ${pre.status}`}). Nothing was changed.`);
      process.exit(3);
    }
  }
  const rt = createAgentRuntime({ deps, autoApprove: true, ...(simulated ? { httpFetch: simulated.sim.httpFetch } : {}) });
  const session = AgentSession.create(rt, { appName });
  rt.bus.subscribe(session.id, (e) => {
    if (e.type === 'deploy_progress' && e.status !== 'running') console.log(`  ${e.stage}: ${e.status}${e.detail ? ` — ${e.detail}` : ''}`);
  });

  const exists = (await listApps(deps.liara)).some((a) => a.project_id === appName);
  let planID = arg('--plan');
  let monthly = '';
  if (!exists && !planID) {
    const rec = await runTool(getTool('recommend_plan')!, { path: ROOT_DIR }, toolContextFor(rt, session));
    if (!rec.ok) throw new Error(`recommend_plan: ${rec.userMessageFa}`);
    const data = rec.data as { planID: string; totalMonthlyIRT: number | null };
    planID = data.planID;
    monthly = formatIRT(data.totalMonthlyIRT);
  }
  const { envs, secrets } = envPlan();
  console.log(`${sim ? '[SIMULATOR] ' : ''}Deploy this UI to Liara as "${appName}"`);
  console.log(`  app:     ${exists ? 'exists (new release only)' : `create, platform next, plan ${planID}${monthly ? ` (~${monthly}/month)` : ''}`}`);
  console.log(`  disk:    "${DISK.name}" ${diskGB} GB mounted at ${DISK.mountTo} (SQLite: ${envs.DATABASE_PATH}) — billed hourly`);
  console.log(`  envs:    ${Object.keys(envs).join(', ')}`);
  console.log(`  secrets: NOT sent — add in the Liara console afterwards: ${secrets.length ? secrets.join(', ') : 'LIARA_API_TOKEN and your LLM key'}`);
  if (!args.includes('--yes')) {
    console.log('\nNothing changed. Re-run with --yes to deploy.');
    return;
  }

  const act = async (tool: string, input: Record<string, unknown>) => {
    const { result, verification } = await executeAction(rt, session, getTool(tool)!, input);
    if (!result.ok) throw new Error(`${tool}: ${result.userMessageFa}`);
    console.log(`✓ ${tool}${verification ? ` — verified: ${verification.fixed}` : ''}`);
    return { result, verification };
  };
  if (!exists) await act('create_app', { appName, platform: 'next', planID });
  const app = await getApp(deps.liara, appName);
  if (!(await getDisks(deps.liara, app._id)).disks.some((d) => d.name === DISK.name)) await act('create_disk', { appName, diskName: DISK.name, sizeGB: diskGB });
  const { result, verification } = await act('deploy_project', { path: ROOT_DIR, appName, envs });
  const url = (result.data as { url?: string }).url;
  console.log(`\n${verification?.fixed ? 'Deployed and healthy' : 'Deployed, but the health check did not pass yet'}: ${url}`);
  console.log(`Next: in the Liara console → ${appName} → env vars, add ${secrets.length ? secrets.join(', ') : 'LIARA_API_TOKEN and your LLM key'} (Liara restarts the app).`);
}

main().catch((err) => {
  console.error('deploy:self failed:', (err as Error).message);
  process.exit(1);
});
