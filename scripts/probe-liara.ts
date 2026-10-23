/**
 * PRD-01 step 0.2 — records REAL Liara API responses into fixtures/liara and
 * docs/API-NOTES.md. Never prints secrets. Only mutates the probe/demo app
 * (DEMO_APP_NAME, or a new `liara-agent-probe-xxxx` app it creates).
 *
 * Usage: npm run probe [-- --plan <planID>] [-- --bundle <bundlePlanID>] [-- --skip-domain]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { appUrl, ConfigError, getConfig, ROOT_DIR } from '../src/config';
import { LiaraClient } from '../src/liara/client';
import { execShell } from '../src/liara/endpoints/shell';
import { cheapestBundle, extractProjectPlans, purchasablePlans } from '../src/liara/plans';
import { createLogger } from '../src/logger';
import {
  arrSummary,
  envKeys,
  eventRows,
  metricSummary,
  newFacts,
  type AnyJson,
  type ProbeFacts,
} from './probe/facts';
import { writeProbeNotes } from './probe/notes';
import { Recorder } from './probe/recorder';
import { buildTarGz, probeSourceFiles } from './probe/source';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sec = (ms: number) => Math.floor(ms / 1000);
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const TERMINAL_STATE = /READY|FAIL|CANCEL|ERROR|TIMEOUT|SUCCESS/i;

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
  const logger = createLogger({ level: 'warn', name: 'probe' });
  const client = new LiaraClient({ token: cfg.liara.token, baseUrl: cfg.liara.baseUrl, teamId: cfg.liara.teamId, logger });

  // Preflight: record nothing and change nothing unless the API answers with this token.
  const pre = await client.requestRaw({ path: '/v1/me', retries: 0, timeoutMs: 15_000 }).catch((err: unknown) => err as Error);
  if (pre instanceof Error) {
    console.error(
      `Cannot reach the Liara API (${pre.message}). Nothing was recorded or created.\n` +
        'This process needs a direct route to api.liara.ir: `curl https://api.liara.ir/v1/me` must print 401 from the same terminal/app.',
    );
    process.exit(3);
  }
  if (pre.status === 401 || pre.status === 403) {
    console.error(`Liara rejected the token (${pre.status}). Check LIARA_API_TOKEN (and LIARA_TEAM_ID) in .env. Nothing was recorded.`);
    process.exit(2);
  }

  const rec = new Recorder(client, path.join(ROOT_DIR, 'fixtures/liara'));
  const facts = newFacts(cfg.liara.demoAppName ?? '');
  const t0 = Date.now();

  // 1. Account + plan catalogue
  const me = await rec.call('01-me', 'Account', { path: '/v1/me' });
  if (me?.status === 401) return fatal('Liara rejected the token (401). Check LIARA_API_TOKEN in .env.', rec);
  const meBody = me?.body as AnyJson;
  facts.meTopKeys = Object.keys(meBody ?? {});
  const firstPlanRaw = meBody?.plans?.projects && Object.values(meBody.plans.projects)[0];
  facts.planFieldNames = firstPlanRaw && typeof firstPlanRaw === 'object' ? Object.keys(firstPlanRaw) : [];
  facts.plans = extractProjectPlans(meBody);
  const bundles = meBody?.plans?.projectBundlePlans;
  facts.bundlePlansSample = bundles && typeof bundles === 'object' ? Object.fromEntries(Object.entries(bundles).slice(0, 2)) : undefined;

  // 2. Billing / balance
  const billing = await rec.call('02a-billing', 'Billing', { path: '/v1/billing' });
  await rec.call('02b-me-subscription', 'Subscription', { path: '/v1/me/subscription' });
  await rec.call('02c-me-free-credit', 'Free credit', { path: '/v1/me/free-credit' });
  const bal = (billing?.body as AnyJson)?.user?.balance ?? meBody?.team?.balance;
  facts.balance = typeof bal === 'number' ? { source: billing?.ok ? 'GET /v1/billing → user.balance' : 'GET /v1/me → team.balance', value: bal } : { source: 'not found', value: null };

  // 3–4. Projects; reuse DEMO_APP_NAME or create a probe app
  const projects = await rec.call('03-projects', 'List apps', { path: '/v1/projects' });
  if (!projects?.ok) return fatal('Could not list apps, so nothing will be created. Re-run when GET /v1/projects works.', rec, facts);
  const list: AnyJson[] = (projects?.body as AnyJson)?.projects ?? [];
  let name = cfg.liara.demoAppName ?? '';
  if (!name || !list.some((p) => p.project_id === name)) {
    name = name || `liara-agent-probe-${Math.random().toString(36).slice(2, 6)}`;
    const ok = await createApp(rec, facts, name, arg('--plan'), arg('--bundle'));
    if (!ok) return fatal('Could not create the probe app. See the plan list above and re-run with --plan/--bundle.', rec, facts);
    facts.appCreated = true;
    writeDemoAppName(name);
  }
  facts.appName = name;
  const P = `/v1/projects/${name}`;

  // 5. Details
  const details = await rec.call('05-project', 'App details', { path: P });
  const project = (details?.body as AnyJson)?.project ?? {};
  facts.projectDetailKeys = Object.keys(project);
  facts.projectHourlyPrice = project.hourlyPrice;
  facts.projectPlanID = project.planID;

  // 6–12. Reads on the (possibly fresh) app
  await readLogs(rec, facts, name, 'initial', Date.now() - 3_600_000);
  await readEvents(rec, facts, P, 'initial');
  await rec.call('08-applets', 'Applets', { path: `${P}/applets` });
  await rec.call('09-releases', 'Releases', { path: `${P}/releases`, query: { page: 1, count: 10 } });
  await rec.call('10-metrics-summary', 'Metrics summary', { path: `${P}/metrics/summary` });
  await readMetrics(rec, facts, P, 'initial');
  await rec.call('12-domains', 'Domains', { path: '/v1/domains', query: { project: name } });

  // 13–15. Upload source → release → poll states
  const archivePath = path.join(ROOT_DIR, 'data/sources', name, `probe-${Date.now()}.tar.gz`);
  const tgz = await buildTarGz(path.join(ROOT_DIR, 'data/probe-source'), probeSourceFiles(name), archivePath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(tgz)], { type: 'application/gzip' }), 'source.tar.gz');
  const upload = await rec.call('13-upload-source', 'Upload source', { method: 'POST', path: `/v2/projects/${name}/sources`, multipart: form });
  const sourceID: string | undefined = (upload?.body as AnyJson)?.sourceID;
  if (!sourceID) return fatal('Source upload failed; cannot continue the deploy part of the probe.', rec, facts);
  const deployBody = { sourceID, port: 3000, type: 'node' };
  const release = await rec.call('14-deploy-release', 'Create release', { method: 'POST', path: `/v2/projects/${name}/releases`, body: deployBody });
  const releaseID: string | undefined = (release?.body as AnyJson)?.releaseID;
  if (!releaseID) return fatal('Release creation failed; see 14-deploy-release fixture.', rec, facts);
  facts.release.releaseID = releaseID;
  facts.release.deployBodyAccepted = { ...deployBody, sourceID: '<sourceID>' };
  const polled = await pollRelease(client, name, releaseID, 240_000);
  facts.release.states = polled.states;
  facts.release.finalState = polled.final?.state;
  facts.release.durationSec = polled.durationSec;
  facts.release.releaseKeys = Object.keys(polled.final ?? {});
  rec.record('15-release-poll', 'Release state sequence', polled, polled.states.join('→'));

  // 16. Release status + build logs (liara-cli: v1/releases/{id}, v2/releases/{id}/build-logs)
  const createdAtMs = Date.parse(polled.final?.createdAt ?? '') || Date.now() - 300_000;
  await rec.call('16a-release-status', 'Release status (v1/releases/{id})', { path: `/v1/releases/${releaseID}` });
  const bl = await rec.call('16b-build-logs-v2', 'Build logs (v2/releases/{id})', { path: `/v2/releases/${releaseID}/build-logs` });
  const output: AnyJson[] = (bl?.body as AnyJson)?.buildOutput ?? [];
  facts.buildLogs.v2 = { status: bl?.status ?? null, count: Array.isArray(output) ? output.length : null, first: output[0]?.createdAt, last: output.at?.(-1)?.createdAt };
  facts.buildLogSample = Array.isArray(output) ? output.slice(0, 2) : undefined;
  if (output.length) {
    const since = output[Math.floor(output.length / 2)]?.createdAt;
    facts.buildLogs.v2Since = arrSummary(await rec.call('16c-build-logs-v2-since', 'Build logs since=createdAt', { path: `/v2/releases/${releaseID}/build-logs`, query: { since } }), 'createdAt');
  }
  await readLogs(rec, facts, name, 'afterDeploy', createdAtMs);

  // 17. Public health check (not the Liara API). CLI: `.iran.liara.run` for old-infra apps (no network), else `.liara.run`.
  facts.health = await healthCheck(appUrl(name, cfg.liara.publicUrlSuffix), 120_000);
  if (facts.health.status !== 200) {
    const alt = await healthCheck(appUrl(name, '.iran.liara.run'), 30_000);
    if (alt.status === 200) facts.health = alt;
  }
  rec.record('17-health', 'HTTP health check', facts.health, `${facts.health.status} ${facts.health.latencyMs}ms`, facts.health.status ?? 'ERR');

  // 18. update-envs semantics: set A, then set B; if A survives → merge, else replace
  await probeEnvs(rec, facts, name, P);

  // 19. Restart
  const restart = await rec.call('19a-restart', 'Restart', { method: 'POST', path: `${P}/actions/restart` });
  facts.restart.status = restart?.status ?? null;
  await sleep(10_000);
  const applets = await rec.call('19b-applets-after-restart', 'Applets after restart', { path: `${P}/applets` });
  facts.restart.appletStates = ((applets?.body as AnyJson)?.applets ?? []).map((a: AnyJson) => `${a.state}${a.reason ? `(${a.reason})` : ''}`);

  // Console WebSocket (liara-cli `app shell` protocol) with a read-only command
  await sleep(10_000);
  try {
    const shell = await execShell(client, name, 'node -v', { timeoutMs: 20_000 });
    rec.record('19c-shell-node-v', 'Shell exec (node -v)', shell, `out: ${shell.output.slice(0, 40)} clean=${shell.exitedCleanly}`);
  } catch (err) {
    rec.record('19c-shell-node-v', 'Shell exec (node -v)', { error: (err as Error).message }, `error: ${(err as Error).message.slice(0, 50)}`, 'ERR');
  }

  // 20. Rollback discovery
  await probeRollback(rec, client, facts, name, sourceID, releaseID);

  // Domain lifecycle on a throwaway name (no DNS needed for add/check/delete)
  if (!process.argv.includes('--skip-domain')) await probeDomain(rec, facts, name, project._id);

  // Late reads: the app has now been running for a few minutes
  await readLogs(rec, facts, name, 'late', t0 - 600_000);
  await readEvents(rec, facts, P, 'late');
  await rec.call('21e-metrics-summary-late', 'Metrics summary late', { path: `${P}/metrics/summary` });
  await readMetrics(rec, facts, P, 'late');
  await rec.call('21j-releases-late', 'Releases late', { path: `${P}/releases`, query: { page: 1, count: 10 } });
  await rec.call('21k-applets-late', 'Applets late', { path: `${P}/applets` });

  finish(rec, facts);
}

async function readLogs(rec: Recorder, facts: ProbeFacts, name: string, phase: string, sinceMs: number) {
  const P = `/v1/projects/${name}`;
  const V2 = `/v2/projects/${name}/logs`;
  const fwd = await rec.call(`06-logs-v2-forward-${phase}`, `Logs v2 start=s forward (${phase})`, { path: V2, query: { start: sec(sinceMs), direction: 'forward' } });
  facts.logs[`v2Forward_${phase}`] = arrSummary(fwd);
  const back = await rec.call(`06-logs-v2-backward-${phase}`, `Logs v2 start=s backward (${phase})`, { path: V2, query: { start: sec(sinceMs), direction: 'backward' } });
  facts.logs[`v2Backward_${phase}`] = arrSummary(back);
  for (const b of [fwd?.body, back?.body] as AnyJson[]) {
    const d = b?.data?.find((x: AnyJson) => x?.values?.length);
    if (d) facts.logLineSample = { metaData: d.metaData, firstRow: d.values[0] };
  }
  facts.logs[`v1Seconds_${phase}`] = arrSummary(await rec.call(`06-logs-v1-seconds-${phase}`, `Logs v1 since=s (${phase})`, { path: `${P}/logs`, query: { since: sec(sinceMs) } }));
  if (phase === 'initial') {
    facts.logs.v1Ms_initial = arrSummary(await rec.call('06-logs-v1-ms-initial', 'Logs v1 since=ms', { path: `${P}/logs`, query: { since: sinceMs } }));
    facts.logs.v1Iso_initial = arrSummary(await rec.call('06-logs-v1-iso-initial', 'Logs v1 since=ISO', { path: `${P}/logs`, query: { since: new Date(sinceMs).toISOString() } }));
  }
}

async function createApp(rec: Recorder, facts: ProbeFacts, name: string, planOverride?: string, bundleOverride?: string) {
  const plans = purchasablePlans(facts.plans);
  const plan = (planOverride ? facts.plans.find((p) => p.id === planOverride) : plans.find((p) => !p.isFree)) ?? plans[0];
  const planID = planOverride ?? plan?.id ?? 'free';
  const bundlePlanID = bundleOverride ?? (plan ? cheapestBundle(plan)?.id : undefined) ?? 'free';
  const body: Record<string, unknown> = { name, planID, platform: 'node', bundlePlanID };
  const res = await rec.call('04a-create-app', `Create app (${planID})`, { method: 'POST', path: '/v1/projects', body });
  facts.createAttempts.push({ body, status: res?.status ?? null, message: (res?.body as AnyJson)?.message });
  if (res?.ok) {
    facts.createBody = body;
    return true;
  }
  console.error('\nCreate app failed. Plans found in /v1/me (cheapest first):');
  for (const p of plans) console.error(`  ${p.id.padEnd(24)} RAM ${p.ramMB}MB  CPU ${p.cpu}  disk ${p.diskGB}GB  ~${p.monthlyEstimateIRT} IRT/month`);
  return false;
}

async function readEvents(rec: Recorder, facts: ProbeFacts, P: string, phase: string) {
  const now = Date.now();
  const s = await rec.call(`07a-events-seconds-${phase}`, `Events start/end=unix s (${phase})`, { path: `${P}/events`, query: { start: sec(now - 86_400_000), end: sec(now) } });
  const ms = await rec.call(`07b-events-ms-${phase}`, `Events start/end=unix ms (${phase})`, { path: `${P}/events`, query: { start: now - 86_400_000, end: now } });
  const none = await rec.call(`07c-events-noparams-${phase}`, `Events no params (${phase})`, { path: `${P}/events` });
  facts.events[`${phase}Seconds`] = { status: s?.status ?? null, rows: eventRows(s) };
  facts.events[`${phase}Ms`] = { status: ms?.status ?? null, rows: eventRows(ms) };
  facts.events[`${phase}NoParams`] = { status: none?.status ?? null, rows: eventRows(none) };
  for (const res of [s, ms, none]) {
    const d = (res?.body as AnyJson)?.data?.find((x: AnyJson) => x?.values?.length);
    if (d) facts.eventSample = { metaData: d.metaData, firstRow: d.values[0] };
  }
}

async function readMetrics(rec: Recorder, facts: ProbeFacts, P: string, phase: string) {
  const now = Date.now();
  const variants: [string, number][] = [['seconds', sec(now - 3_600_000)], ['ms', now - 3_600_000], ['relative3600', 3600]];
  for (const [label, since] of variants) {
    const res = await rec.call(`11-cpu-${label}-${phase}`, `CPU since=${label} (${phase})`, { path: `${P}/metrics/cpu`, query: { since } });
    facts.metrics[`cpu_${label}_${phase}`] = metricSummary(res);
  }
  const mem = await rec.call(`11-memory-seconds-${phase}`, `Memory since=s (${phase})`, { path: `${P}/metrics/memory`, query: { since: sec(now - 3_600_000) } });
  facts.metrics[`memory_seconds_${phase}`] = metricSummary(mem);
  if (phase === 'late') {
    facts.metrics.netRx = metricSummary(await rec.call('11-net-rx-late', 'Network receive', { path: `${P}/metrics/network-receive`, query: { since: sec(now - 3_600_000) } }));
    facts.metrics.netTx = metricSummary(await rec.call('11-net-tx-late', 'Network transmit', { path: `${P}/metrics/network-transmit`, query: { since: sec(now - 3_600_000) } }));
  }
}

async function pollRelease(client: LiaraClient, name: string, releaseID: string, timeoutMs: number) {
  const started = Date.now();
  const states: string[] = [];
  const timeline: { atSec: number; state: string }[] = [];
  let final: AnyJson;
  while (Date.now() - started < timeoutMs) {
    const res = await client.requestRaw({ path: `/v1/projects/${name}/releases`, query: { page: 1, count: 10 } }).catch(() => null);
    const r = ((res?.body as AnyJson)?.releases ?? []).find((x: AnyJson) => x._id === releaseID);
    if (r) {
      final = r;
      if (states[states.length - 1] !== r.state) {
        states.push(String(r.state));
        timeline.push({ atSec: Math.round((Date.now() - started) / 1000), state: String(r.state) });
      }
      if (TERMINAL_STATE.test(String(r.state))) break;
    }
    await sleep(5000);
  }
  return { releaseID, states, timeline, final, durationSec: Math.round((Date.now() - started) / 1000) };
}

async function healthCheck(url: string, timeoutMs: number): Promise<ProbeFacts['health']> {
  const started = Date.now();
  let attempts = 0;
  let last: ProbeFacts['health'] = { url, status: null, latencyMs: null, attempts: 0 };
  while (Date.now() - started < timeoutMs) {
    attempts++;
    const t = Date.now();
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'liara-agent/1.0' } });
      const text = await res.text();
      last = { url, status: res.status, latencyMs: Date.now() - t, attempts, bodySnippet: text.slice(0, 80) };
      if (res.status === 200) return last;
    } catch (err) {
      last = { url, status: null, latencyMs: Date.now() - t, attempts, bodySnippet: (err as Error).message.slice(0, 80) };
    }
    await sleep(5000);
  }
  return last;
}

async function probeEnvs(rec: Recorder, facts: ProbeFacts, name: string, P: string) {
  const before = await rec.call('18a-project-before-envs', 'Envs before', { path: P });
  const beforeEnvs: AnyJson[] = (before?.body as AnyJson)?.project?.envs ?? [];
  facts.envs.keysBefore = envKeys(before);
  const set = (id: string, variables: { key: string; value: string }[]) =>
    rec.call(id, `update-envs (${variables.map((v) => v.key).join(',') || 'empty'})`, { method: 'POST', path: '/v1/projects/update-envs', body: { project: name, variables } });
  await set('18b-update-envs-a', [{ key: 'PROBE_A', value: '1' }]);
  await sleep(4000);
  facts.envs.keysAfterA = envKeys(await rec.call('18c-project-after-a', 'Envs after A', { path: P }));
  await set('18d-update-envs-b', [{ key: 'PROBE_B', value: '1' }]);
  await sleep(4000);
  facts.envs.keysAfterB = envKeys(await rec.call('18e-project-after-b', 'Envs after B', { path: P }));
  facts.envs.semantics = facts.envs.keysAfterB.includes('PROBE_A') ? 'merge' : facts.envs.keysAfterB.includes('PROBE_B') ? 'replace' : 'unknown';
  if (beforeEnvs.some((e) => e.encrypted)) {
    facts.envs.note = 'restore skipped: app has encrypted env values that cannot be re-sent safely';
    return;
  }
  const restore = beforeEnvs.filter((e) => !String(e.key).startsWith('PROBE_')).map((e) => ({ key: String(e.key), value: String(e.value) }));
  const r = await set('18f-update-envs-restore', restore);
  facts.envs.restoreStatus = r?.status ?? null;
  await sleep(4000);
  facts.envs.keysAfterRestore = envKeys(await rec.call('18g-project-after-restore', 'Envs after restore', { path: P }));
  await sleep(15_000); // update-envs restarts the app; let it settle before the restart test
}

async function probeRollback(rec: Recorder, client: LiaraClient, facts: ProbeFacts, name: string, sourceID: string, firstReleaseID: string) {
  const reuse = await rec.call('20a-release-reuse-source', 'Release again with same sourceID', { method: 'POST', path: `/v2/projects/${name}/releases`, body: { sourceID, port: 3000, type: 'node' } });
  facts.rollback.sourceReuseStatus = reuse?.status ?? null;
  const reuseID = (reuse?.body as AnyJson)?.releaseID;
  if (reuseID) {
    const p = await pollRelease(client, name, reuseID, 240_000);
    facts.rollback.sourceReuseFinalState = p.final?.state;
    rec.record('20b-release2-poll', 'Second release states', p, p.states.join('→'));
  }
  const candidates: [string, string, unknown][] = [
    ['20c-rollback-v2-releases-releaseID', `/v2/projects/${name}/releases`, { releaseID: firstReleaseID }],
    ['20d-rollback-v1-redeploy', `/v1/projects/${name}/releases/${firstReleaseID}/redeploy`, undefined],
    ['20e-rollback-v1-rollback', `/v1/projects/${name}/releases/${firstReleaseID}/rollback`, undefined],
    ['20f-rollback-v2-rollback', `/v2/projects/${name}/releases/${firstReleaseID}/rollback`, undefined],
    ['20g-rollback-v2-redeploy', `/v2/projects/${name}/releases/${firstReleaseID}/redeploy`, undefined],
  ];
  for (const [id, p, body] of candidates) {
    const res = await rec.call(id, `Rollback candidate`, { method: 'POST', path: p, body });
    facts.rollback.candidates.push({ call: `POST ${p.replace(firstReleaseID, '{releaseID}')}`, status: res?.status ?? null, message: (res?.body as AnyJson)?.message });
    const newID = (res?.body as AnyJson)?.releaseID;
    if (res?.ok) {
      if (newID) await pollRelease(client, name, newID, 240_000);
      break;
    }
  }
  const native = facts.rollback.candidates.find((c) => c.status !== null && c.status >= 200 && c.status < 300);
  facts.rollback.decision = native
    ? `native endpoint works: ${native.call}`
    : reuse?.ok
      ? 'no native endpoint; re-release a previous sourceID (sourceIDs are reusable), fall back to re-uploading the stored archive'
      : 'no native endpoint; re-upload the stored archive from data/sources/<app>/ and create a new release';
}

async function probeDomain(rec: Recorder, facts: ProbeFacts, name: string, projectId?: string) {
  const domain = `probe-${Math.random().toString(36).slice(2, 8)}.liara-agent-test.ir`;
  facts.domain.name = domain;
  let created = await rec.call('22a-domain-create', 'Add domain', { method: 'POST', path: '/v1/domains', body: { name: domain, project: name, type: 'PROJECT' } });
  if (created && !created.ok && projectId) {
    created = await rec.call('22a2-domain-create-projectid', 'Add domain (project=_id)', { method: 'POST', path: '/v1/domains', body: { name: domain, project: projectId, type: 'PROJECT' } });
  }
  facts.domain.createStatus = created?.status ?? null;
  facts.domain.createMessage = (created?.body as AnyJson)?.message;
  const list = await rec.call('22b-domains-list', 'Domains list', { path: '/v1/domains', query: { project: name } });
  facts.domain.listStatus = list?.status ?? null;
  const found = ((list?.body as AnyJson)?.domains ?? []).find((d: AnyJson) => d.name === domain);
  const id = found?._id ?? (created?.body as AnyJson)?.domain?._id ?? (created?.body as AnyJson)?._id;
  if (!id) return;
  const check = await rec.call('22c-domain-check', 'Domain check', { path: `/v1/domains/${id}/check` });
  facts.domain.checkStatus = check?.status ?? null;
  facts.domain.cname = (check?.body as AnyJson)?.domain?.CNameRecord ?? found?.CNameRecord;
  const del = await rec.call('22d-domain-delete', 'Delete domain', { method: 'DELETE', path: `/v1/domains/${id}` });
  facts.domain.deleteStatus = del?.status ?? null;
}

function writeDemoAppName(name: string) {
  const file = path.join(ROOT_DIR, '.env');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = `DEMO_APP_NAME=${name}`;
  const next = /^DEMO_APP_NAME=.*$/m.test(text) ? text.replace(/^DEMO_APP_NAME=.*$/m, line) : `${text.trimEnd()}\n${line}\n`;
  writeFileSync(file, next);
  console.log(`DEMO_APP_NAME=${name} written to .env`);
}

function finish(rec: Recorder, facts: ProbeFacts) {
  rec.record('99-probe-facts', 'Probe facts (derived)', facts, 'see docs/API-NOTES.md');
  writeProbeNotes(facts, path.join(ROOT_DIR, 'docs/API-NOTES.md'));
  console.log('');
  rec.printTable();
  console.log(`\nApp: ${facts.appName}${facts.appCreated ? ' (created by probe)' : ''}`);
  console.log(`update-envs semantics: ${facts.envs.semantics} | release states: ${facts.release.states.join('→')} | health: ${facts.health.status}`);
  console.log(`rollback: ${facts.rollback.decision}`);
}

function fatal(message: string, rec: Recorder, facts?: ProbeFacts): void {
  if (facts) {
    facts.errors.push(message);
    rec.record('99-probe-facts', 'Probe facts (partial)', facts, 'partial');
  }
  rec.printTable();
  console.error(`\nPROBE STOPPED: ${message}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('Probe crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
