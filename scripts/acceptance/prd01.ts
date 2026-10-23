/**
 * PRD-01 acceptance — runs against the REAL Liara account and DEMO_APP_NAME.
 * Mutating steps run because this script is the only place AUTO_APPROVE is allowed.
 * Usage: npm run accept:prd01
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { list } from 'tar';
import { ConfigError, getConfig, ROOT_DIR } from '../../src/config';
import type { DeployStage } from '../../src/events';
import { createLogger } from '../../src/logger';
import { createRuntime, createToolContext, getTool, runTool, type ToolContext, type ToolResult } from '../../src/tools';
import { Acceptance, assert, runCommand } from './harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyData = any;

async function run(name: string, input: unknown, ctx: ToolContext): Promise<AnyData> {
  const res = await runTool(getTool(name)!, input, ctx);
  assert(res.ok, `${name} failed: ${res.ok ? '' : `${res.error} | ${res.userMessageFa}`}`);
  return res.data;
}

/** Same sequence the policy gate uses after approval: snapshot → run → wait → verify. */
async function runApproved(name: string, input: unknown, ctx: ToolContext): Promise<{ result: ToolResult<AnyData>; verify: { ok: boolean; evidence: string[] } }> {
  const def = getTool(name)!;
  const parsed = def.input.parse(input);
  const before = def.snapshot ? await def.snapshot(parsed, ctx) : undefined;
  const result = await runTool(def, parsed, ctx);
  assert(result.ok, `${name} failed: ${result.ok ? '' : `${result.error} | ${result.userMessageFa}`}`);
  if (def.verifyDelayMs) await ctx.sleep(def.verifyDelayMs);
  const verify = await def.verify!(parsed, before, ctx, result);
  return { result, verify };
}

async function main() {
  let cfg;
  try {
    cfg = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  assert(cfg.autoApprove, 'AUTO_APPROVE=true is required for the acceptance run (set by the npm script)');
  const app = cfg.liara.demoAppName;
  if (!app) {
    console.error('DEMO_APP_NAME is not set. Run `npm run probe` first (it creates the demo app and writes DEMO_APP_NAME to .env).');
    process.exit(2);
  }
  const rt = createRuntime({ logger: createLogger({ level: 'warn', name: 'accept' }) });
  const stages: string[] = [];
  const ctx = createToolContext(rt, {
    sessionId: 'accept-prd01',
    emit: (e) => {
      if (e.type === 'deploy_progress') stages.push(`${e.stage as DeployStage}:${e.status}${e.detail ? `(${e.detail})` : ''}`);
    },
  });
  const t = new Acceptance(`PRD-01 acceptance — app "${app}"`);
  const url = `https://${app}${cfg.liara.publicUrlSuffix}`;

  await t.check('1. list_apps includes the demo app', async () => {
    const apps = (await run('list_apps', {}, ctx)) as { name: string }[];
    assert(apps.some((a) => a.name === app), `apps: ${apps.map((a) => a.name).join(', ')}`);
    return `${apps.length} apps`;
  });

  await t.check('2. get_app joins the plan catalogue (ramMB > 0)', async () => {
    const d = await run('get_app', { appName: app }, ctx);
    assert(d.plan?.ramMB > 0, `plan: ${JSON.stringify(d.plan)}`);
    return `plan ${d.plan.id}: ${d.plan.ramMB}MB, ${d.plan.cpu} CPU, ~${d.plan.monthlyEstimateIRT} IRT/month`;
  });

  await t.check('3. read tools: logs, events, applets, releases, metrics ok', async () => {
    const logs = await run('get_app_logs', { appName: app, sinceMinutes: 60 }, ctx);
    const events = await run('get_app_events', { appName: app }, ctx);
    // applets return 500 on the new infrastructure [probe]; the tool must say so as a limitation
    const appletsRes = await runTool(getTool('get_app_applets')!, { appName: app }, ctx);
    assert(appletsRes.ok || appletsRes.limitation === true, `get_app_applets failed: ${appletsRes.ok ? '' : appletsRes.error}`);
    const applets = appletsRes.ok ? (appletsRes.data as unknown[]).length : 'limitation';
    const releases = await run('get_app_releases', { appName: app }, ctx);
    const metrics = await run('get_app_metrics', { appName: app }, ctx);
    return `logs ${logs.stats.total}, events ${events.events.length}, applets ${applets}, releases ${releases.releases.length}, mem ${metrics.memory?.maxMB ?? '—'}MB`;
  });

  await t.check('4. http_health_check returns a status', async () => {
    const h = await run('http_health_check', { url, samples: 2 }, ctx);
    assert(typeof h.status === 'number', 'no status');
    return `${url} → ${h.status} (${h.latencyMs?.avg ?? '—'}ms)`;
  });

  await t.check('5. analyze_project demo-app → node, port 3000', async () => {
    const a = await run('analyze_project', { path: path.join(ROOT_DIR, 'demo-app') }, ctx);
    assert(a.platform === 'node' && a.port === 3000, `got ${a.platform}:${a.port}`);
    return `${a.platform}, port ${a.port}, confidence ${a.confidence}`;
  });

  let archivePath = '';
  await t.check('6. build_source_archive → tar.gz without node_modules', async () => {
    const copy = path.join(cfg.dataDir, 'acceptance', 'demo-app');
    rmSync(copy, { recursive: true, force: true });
    cpSync(path.join(ROOT_DIR, 'demo-app'), copy, { recursive: true });
    mkdirSync(path.join(copy, 'node_modules/left-pad'), { recursive: true });
    writeFileSync(path.join(copy, 'node_modules/left-pad/index.js'), 'module.exports = 1');
    const a = await run('build_source_archive', { path: copy, appName: app }, ctx);
    archivePath = a.archivePath;
    assert(existsSync(archivePath), 'archive missing');
    const entries: string[] = [];
    await list({ file: archivePath, onReadEntry: (e) => void entries.push(e.path) });
    assert(!entries.some((e) => e.includes('node_modules')), 'node_modules included');
    assert(entries.includes('index.js') && entries.includes('package.json'), `entries: ${entries.join(',')}`);
    return `${a.fileCount} files, ${a.sizeMB}MB: ${entries.join(', ')}`;
  });

  await t.check('7. upload_source → deploy_release (wait) → READY → health 200', async () => {
    assert(archivePath, 'no archive from step 6');
    const up = await runApproved('upload_source', { appName: app, archivePath }, ctx);
    assert(up.verify.ok, up.verify.evidence.join(' | '));
    const sourceID = (up.result as AnyData).data.sourceID;
    const dep = await runApproved('deploy_release', { appName: app, sourceID, port: 3000, platform: 'node', waitForReady: true }, ctx);
    assert((dep.result as AnyData).data.state === 'READY', `state ${(dep.result as AnyData).data.state}`);
    assert(dep.verify.ok, `verify failed: ${dep.verify.evidence.join(' | ')}`);
    return `stages: ${stages.join(' → ')} | ${dep.verify.evidence.join(' | ')}`;
  });

  await t.check('8. collect_evidence packet ≤ 20KB with health.ok', async () => {
    const p = await run('collect_evidence', { appName: app, windowMinutes: 30 }, ctx);
    const size = Buffer.byteLength(JSON.stringify(p));
    assert(size <= 20_000, `packet ${size} bytes`);
    assert(p.health?.ok === true, `health ${JSON.stringify(p.health)}`);
    return `${size} bytes, ${p.durationMs}ms, health ${p.health.status}, ${p.logs.totalLines} log lines, ${p.limitations.length} limitations`;
  });

  await t.check('9. update_envs set/unset PROBE_FLAG (merge semantics kept)', async () => {
    // a name without key/token/secret: those values are masked in tool output by design
    const before = await run('get_app', { appName: app }, ctx);
    const keysBefore = (before.envs as { key: string }[]).map((e) => e.key).filter((k) => k !== 'PROBE_FLAG');
    const set = await runApproved('update_envs', { appName: app, set: { PROBE_FLAG: '2' } }, ctx);
    const mid = await run('get_app', { appName: app }, ctx);
    const probe = (mid.envs as { key: string; value: string }[]).find((e) => e.key === 'PROBE_FLAG');
    assert(probe?.value === '2', `PROBE_FLAG after set: ${JSON.stringify(probe)}`);
    for (const k of keysBefore) assert(mid.envs.some((e: { key: string }) => e.key === k), `lost env ${k}`);
    const unset = await runApproved('update_envs', { appName: app, unset: ['PROBE_FLAG'] }, ctx);
    const after = await run('get_app', { appName: app }, ctx);
    assert(!after.envs.some((e: { key: string }) => e.key === 'PROBE_FLAG'), 'PROBE_FLAG still present');
    return `set verify ${set.verify.ok}, unset verify ${unset.verify.ok}; kept ${keysBefore.length} other keys`;
  });

  await t.check('10. MCP: tools/list ≥ 20 and delete_app is destructive', async () => {
    const transport = new StdioClientTransport({ command: 'npm', args: ['run', '--silent', 'mcp'], cwd: ROOT_DIR, stderr: 'ignore' });
    const client = new Client({ name: 'accept-prd01', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const del = tools.find((x) => x.name === 'delete_app');
      assert(tools.length >= 20, `only ${tools.length} tools`);
      assert(del?.annotations?.destructiveHint === true, 'delete_app missing destructiveHint');
      const res = (await client.callTool({ name: 'restart_app', arguments: { appName: app } })) as { isError?: boolean };
      assert(res.isError === true, 'restart_app without confirm must be refused');
      const ok = (await client.callTool({ name: 'get_app_releases', arguments: { appName: app, count: 1 } })) as { isError?: boolean };
      assert(!ok.isError, 'read tool failed over MCP');
      return `${tools.length} tools; unconfirmed restart refused; read tool works`;
    } finally {
      await client.close();
    }
  });

  await t.check('11. npm run test', async () => {
    const r = await runCommand('npm', ['run', '--silent', 'test'], ROOT_DIR);
    assert(r.code === 0, r.output.slice(-400));
    return /Tests\s+(\d+ passed[^\n]*)/.exec(r.output)?.[1] ?? 'ok';
  });

  await t.check('12. npm run typecheck', async () => {
    const r = await runCommand('npm', ['run', '--silent', 'typecheck'], ROOT_DIR);
    assert(r.code === 0, r.output.slice(-400));
    return 'tsc clean';
  });

  const ok = t.print();
  rt.db.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('acceptance crashed:', (err as Error).message);
  process.exit(1);
});
