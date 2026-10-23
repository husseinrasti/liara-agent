/**
 * Switch the demo app's failure mode without the LLM (for recording the demo).
 *
 *   npm run chaos -- <none|leak|crash|slow|missing-env|error500> [--deploy] [--app <name>]
 *
 * Default: sets CHAOS_MODE with update_envs (Liara restarts the app).
 * --deploy: publishes a NEW release of demo-app with the mode baked into
 *   chaos.json, so "it broke right after the last deploy" is true and a rollback
 *   to the previous release really fixes it. The source is recorded for rollback.
 * With LIARA_FAKE=1 it drives the local simulator through /api/dev/chaos instead.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, getConfig, ROOT_DIR } from '../src/config';
import { linkSourceRelease, recordSource } from '../src/db/repo';
import { deployRelease, uploadSource, waitForRelease } from '../src/liara/endpoints/deploy';
import { updateEnvs } from '../src/liara/endpoints/envs';
import { createLogger } from '../src/logger';
import { CHAOS_MODES, type ChaosMode } from '../src/sim/behavior';
import { buildArchive } from '../src/tools/local/build-source-archive';
import { createRuntime } from '../src/tools';

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--app') as ChaosMode | undefined;
const deploy = args.includes('--deploy');
const appArg = args.includes('--app') ? args[args.indexOf('--app') + 1] : undefined;

async function viaSimulator(app: string, m: ChaosMode) {
  const url = process.env.CHAOS_URL ?? 'http://localhost:3210/api/dev/chaos';
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appName: app, mode: m, deploy }) });
  console.log(`simulator: ${res.status} ${await res.text()}`);
}

async function main() {
  if (!mode || !CHAOS_MODES.includes(mode)) {
    console.error(`usage: npm run chaos -- <${CHAOS_MODES.join('|')}> [--deploy] [--app <name>]`);
    process.exit(2);
  }
  if (/^(1|true)$/i.test(process.env.LIARA_FAKE ?? '')) return viaSimulator(appArg ?? 'liara-agent-demo', mode);
  let deps;
  try {
    deps = createRuntime({ logger: createLogger({ level: 'warn', name: 'chaos' }) });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  const app = appArg ?? getConfig().liara.demoAppName;
  if (!app) {
    console.error('No app: pass --app <name> or set DEMO_APP_NAME in .env');
    process.exit(2);
  }
  const { liara, db } = deps;
  if (!deploy) {
    const set: Record<string, string> = mode === 'none' ? {} : { CHAOS_MODE: mode };
    const unset = mode === 'none' ? ['CHAOS_MODE'] : mode === 'missing-env' ? ['PAYMENT_API_KEY'] : [];
    const keys = await updateEnvs(liara, app, set, unset);
    console.log(`${app}: CHAOS_MODE=${mode} via env (${keys.length} env vars kept); Liara restarts the app now.`);
    return;
  }
  // Bake the mode into a fresh copy of demo-app and publish it as a new release.
  await updateEnvs(liara, app, {}, ['CHAOS_MODE']);
  const work = path.join(ROOT_DIR, 'data', 'chaos', mode);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(path.dirname(work), { recursive: true });
  cpSync(path.join(ROOT_DIR, 'demo-app'), work, { recursive: true });
  writeFileSync(path.join(work, 'chaos.json'), JSON.stringify({ mode }));
  const archive = await buildArchive(work, path.join(ROOT_DIR, 'data', 'sources', app, `chaos-${mode}-${Date.now()}.tar.gz`));
  const sourceID = await uploadSource(liara, app, readFileSync(archive.archivePath), path.basename(archive.archivePath));
  recordSource(db, { appName: app, sourceID, archivePath: archive.archivePath, createdAt: new Date().toISOString() });
  const releaseID = await deployRelease(liara, app, { sourceID, port: 3000, type: 'node', message: `chaos: ${mode}` });
  linkSourceRelease(db, app, sourceID, releaseID);
  console.log(`${app}: release ${releaseID} with CHAOS_MODE=${mode} building…`);
  const rel = await waitForRelease(liara, app, releaseID, { onState: (s) => console.log(`  ${s}`) });
  console.log(`${app}: ${rel.state} — demo app now runs in "${mode}" mode.`);
}

main().catch((err) => {
  console.error('chaos failed:', (err as Error).message);
  process.exit(1);
});
