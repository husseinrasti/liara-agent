/**
 * PRD-02 acceptance — headless agent against the REAL Liara account and the
 * configured LLM. Needs DEMO_APP_NAME, a reachable api.liara.ir and an LLM key.
 * Usage: npm run accept:prd02 (sets AUTO_APPROVE=true; step 9 turns it off).
 *   `-- --sim` runs the same checks against the LIARA_FAKE simulator (real LLM):
 *   useful offline, NOT a substitute for the live run.
 */
import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { approve } from '../../src/agent/approvals';
import { runTurn } from '../../src/agent/loop';
import { setMemoryKey } from '../../src/agent/memory';
import { llmHealthCheck } from '../../src/agent/providers';
import { createAgentRuntime, toolContextFor } from '../../src/agent/runtime';
import { Watcher } from '../../src/agent/watcher';
import '../../src/agent/tools';
import { ConfigError, getConfig, ROOT_DIR } from '../../src/config';
import type { AgentEvent, EventOf } from '../../src/events';
import { getEvents } from '../../src/liara/endpoints/events';
import { createLogger } from '../../src/logger';
import { collectMetrics } from '../../src/tools/liara/observe';
import { createSimulatedDeps } from '../../src/sim/deps';
import { createRuntime } from '../../src/tools';
import { Acceptance, assert, runCommand } from './harness';
import { act, deployFixture, FIXTURES, lastDiagnosis, PERSIAN, sessionWithEvents, textOf, waitFor } from './prd02-helpers';

const sim = process.argv.includes('--sim');

async function main() {
  if (sim) process.env.LIARA_API_TOKEN ||= 'simulated';
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
  const logger = createLogger({ level: 'warn', name: 'accept02' });
  const simulated = sim ? createSimulatedDeps({ dbFile: 'accept-prd02-sim.db', logger }) : null;
  const app = simulated ? simulated.deps.config.liara.demoAppName : cfg.liara.demoAppName;
  if (!app) {
    console.error('DEMO_APP_NAME is not set. Run `npm run probe` first.');
    process.exit(2);
  }
  const deps = simulated?.deps ?? createRuntime({ logger });
  if (!simulated) {
    const pre = await deps.liara.requestRaw({ path: '/v1/me', retries: 0, timeoutMs: 15_000 }).catch((e: Error) => e);
    if (pre instanceof Error || pre.status >= 400) {
      console.error(`Liara API not usable from this process (${pre instanceof Error ? pre.message : `HTTP ${pre.status}`}). Nothing was run.`);
      process.exit(3);
    }
  }
  const rt = createAgentRuntime({ deps, autoApprove: true, ...(simulated ? { httpFetch: simulated.sim.httpFetch } : {}) });
  const sleep = rt.sleep;
  const t = new Acceptance(`PRD-02 acceptance — app "${app}", ${cfg.llm.provider}${sim ? ' — SIMULATOR (LIARA_FAKE, not the real Liara API)' : ''}`);
  const wizardApp = `${app}-wiz`.slice(0, 30);
  let wizardCreated = false;

  await t.check('1. LLM health check', async () => {
    const h = await llmHealthCheck(rt.model('fast'), cfg);
    assert(h.ok, h.error ?? 'not ok');
    return `${h.provider}/${h.model} ${h.latencyMs}ms`;
  });

  await t.check('2. status turn: get_app → Persian answer mentioning the plan', async () => {
    const { session, events } = sessionWithEvents(rt, app);
    await runTurn(rt, session, `وضعیت اپ ${app} چطوره؟`);
    assert(events.some((e) => e.type === 'tool_start' && e.tool === 'get_app'), 'get_app was not called');
    assert(events[events.length - 1]?.type === 'done', 'no done event');
    const text = textOf(events);
    assert(PERSIAN.test(text) && /پلن|plan/i.test(text), `answer: ${text.slice(0, 120)}`);
    return text.slice(0, 90);
  });

  let recommended: string | undefined;
  let incidentEvents: AgentEvent[] = [];
  await t.check('3. leak → OOM → diagnosis oom_kill (≥ 0.6) with a sensible action', async () => {
    const healthy = await deployFixture(rt, app, 'healthy');
    assert(healthy.ok, `healthy deploy: ${healthy.message}`);
    const leak = await deployFixture(rt, app, 'leak');
    assert(leak.ok || /UNHEALTHY/.test(leak.message), `leak deploy: ${leak.message}`);
    const ctx = toolContextFor(rt);
    const signal = await waitFor(
      async () => {
        const ev = await getEvents(rt.deps.liara, app, { start: new Date(Date.now() - 15 * 60_000), end: new Date() });
        if (ev.some((e) => /OOMKill/i.test(e.reason ?? ''))) return 'OOMKilled event';
        const { digest } = await collectMetrics(ctx, app, 15);
        return (digest.memory?.pctOfLimit ?? 0) >= 90 ? `memory ${digest.memory?.pctOfLimit}%` : null;
      },
      { timeoutMs: 6 * 60_000, intervalMs: 20_000, sleep },
    );
    assert(signal, 'no OOM signal within 6 minutes');
    const { session, events } = sessionWithEvents(rt, app);
    await runTurn(rt, session, 'سایتم کند شده و گاهی ۵۰۰ می‌ده');
    incidentEvents = events;
    const d = lastDiagnosis(events);
    assert(d, 'no diagnosis event');
    const top = d.causes[0]!;
    recommended = d.recommendedAction?.tool;
    assert(top.playbookId === 'oom_kill' && top.confidence >= 0.6, `top cause ${top.playbookId} ${top.confidence}`);
    assert(['rollback_release', 'restart_app', 'resize_app'].includes(recommended ?? ''), `recommended ${recommended}`);
    return `${signal}; top ${top.playbookId} ${top.confidence}; action ${recommended}`;
  });

  await t.check('4. approved fix runs and is verified (rollback must restore health)', async () => {
    // With AUTO_APPROVE the agent often proposes and runs the fix in the incident turn itself.
    const verifyOf = (events: AgentEvent[]) => events.filter((e): e is EventOf<'verify_result'> => e.type === 'verify_result').pop();
    let v = verifyOf(incidentEvents);
    if (!v) {
      const { session, events } = sessionWithEvents(rt, app);
      await runTurn(rt, session, 'اقدام پیشنهادی را اجرا کن');
      v = verifyOf(events);
    }
    assert(v, 'no verify_result');
    if (v.action === 'rollback_release') assert(v.fixed, `rollback not verified: ${v.evidence.join(' | ')}`);
    return `${v.action} fixed=${v.fixed}: ${v.evidence.join(' | ').slice(0, 120)}`;
  });

  await t.check('5. missing env → missing_env with API_KEY', async () => {
    await deployFixture(rt, app, 'missing-env');
    await sleep(30_000);
    const { session, events } = sessionWithEvents(rt, app);
    await runTurn(rt, session, 'چرا سایتم بالا نمیاد؟');
    const d = lastDiagnosis(events);
    assert(d, 'no diagnosis');
    assert(d.causes[0]!.playbookId === 'missing_env', `top ${d.causes[0]!.playbookId}`);
    const mentions = JSON.stringify(d.manualStepsFa).includes('API_KEY') || (d.recommendedAction?.tool === 'update_envs' && JSON.stringify(d.recommendedAction.args).includes('API_KEY'));
    assert(mentions, 'API_KEY not mentioned in manual steps or action');
    return d.manualStepsFa[0]?.slice(0, 100) ?? '';
  });

  await t.check('6. broken build → build_failed quoting the failing line', async () => {
    // From a healthy baseline: step 5 may have left the missing-env release crash-looping.
    const healthy = await deployFixture(rt, app, 'healthy');
    assert(healthy.ok, `healthy deploy: ${healthy.message}`);
    const res = await deployFixture(rt, app, 'broken-build');
    assert(!res.ok, 'broken build unexpectedly succeeded');
    const { session, events } = sessionWithEvents(rt, app);
    await runTurn(rt, session, 'دیپلوی کردم ولی خطا می‌ده');
    const d = lastDiagnosis(events);
    assert(d?.causes[0]?.playbookId === 'build_failed', `top ${d?.causes[0]?.playbookId}`);
    const quoted = d.causes[0]!.evidence.some((e) => /npm|JSON|ERR|token|parse/i.test(`${e.raw ?? ''} ${e.text_fa}`));
    assert(quoted, 'failing line not quoted');
    return d.causes[0]!.evidence.map((e) => e.raw ?? e.text_fa).join(' | ').slice(0, 120);
  });

  await t.check('7. deploy assistant: plan card, all stages, .liara.run URL, health 200', async () => {
    const { session, events } = sessionWithEvents(rt);
    // A copy: the wizard writes liara.json into the project it deploys, and the fixture must stay pristine.
    const projectPath = path.join(deps.config.dataDir, 'accept-prd02', 'healthy');
    rmSync(projectPath, { recursive: true, force: true });
    cpSync(path.join(FIXTURES, 'healthy'), projectPath, { recursive: true });
    await runTurn(rt, session, `این پروژه رو دیپلوی کن: ${projectPath} — اسم سرویس: ${wizardApp}`);
    for (let i = 0; i < 2 && !events.some((e) => e.type === 'deploy_progress'); i++) await runTurn(rt, session, 'بله، با همین پلن ادامه بده');
    wizardCreated = events.some((e) => e.type === 'deploy_progress' && e.stage === 'create' && e.status === 'done');
    assert(events.some((e) => e.type === 'plan_recommendation'), 'no plan_recommendation');
    const done = new Set(events.filter((e): e is EventOf<'deploy_progress'> => e.type === 'deploy_progress' && e.status === 'done').map((e) => e.stage));
    for (const s of ['analyze', 'create', 'envs', 'archive', 'upload', 'release', 'build', 'health'] as const) assert(done.has(s), `stage ${s} not done`);
    assert(textOf(events).includes('.liara.run'), 'URL not mentioned');
    return [...done].join(' → ');
  });

  await t.check('8. watcher raises a critical alert within 3 intervals of breaking the app', async () => {
    setMemoryKey(rt.deps.db, app, 'watch', true);
    await deployFixture(rt, app, 'leak');
    const w = new Watcher(rt, { intervalSec: 30, autoDiagnose: false });
    for (let i = 0; i < 6; i++) {
      await w.tick();
      const row = rt.deps.db.prepare("SELECT title FROM alerts WHERE appName = ? AND severity = 'critical' ORDER BY createdAt DESC LIMIT 1").get(app) as { title: string } | undefined;
      if (row) return row.title;
      await sleep(30_000);
    }
    throw new Error('no critical alert');
  });

  await t.check('9. policy: approval_required without AUTO_APPROVE, audit only after approve', async () => {
    const healthy = await deployFixture(rt, app, 'healthy');
    assert(healthy.ok, `restore before policy test: ${healthy.message}`);
    rt.autoApprove = false;
    try {
      const { session, events } = sessionWithEvents(rt, app);
      const since = new Date().toISOString();
      const turn = await runTurn(rt, session, 'ری‌استارت کن');
      const id = turn.pendingApprovals[0];
      assert(id && events.some((e) => e.type === 'approval_required'), 'no approval_required');
      const count = () => (rt.deps.db.prepare("SELECT COUNT(*) n FROM audit WHERE tool = 'restart_app' AND startedAt >= ?").get(since) as { n: number }).n;
      assert(count() === 0, 'restart ran before approval');
      const res = approve(rt, { approvalId: id, approved: true, by: 'acceptance' });
      assert(res.ok, res.ok ? '' : res.messageFa);
      await res.done;
      assert(count() === 1 && events.some((e) => e.type === 'verify_result'), 'no audit row or verify_result after approval');
      return 'approval → audit → verify_result';
    } finally {
      rt.autoApprove = true;
    }
  });

  await t.check('10. npm run test + typecheck', async () => {
    const tests = await runCommand('npm', ['run', '--silent', 'test'], ROOT_DIR);
    assert(tests.code === 0, tests.output.slice(-300));
    const tsc = await runCommand('npm', ['run', '--silent', 'typecheck'], ROOT_DIR);
    assert(tsc.code === 0, tsc.output.slice(-300));
    return /Tests\s+(\d+ passed[^\n]*)/.exec(tests.output)?.[1] ?? 'ok';
  });

  // Restore: healthy demo app, monitoring off, wizard app removed.
  setMemoryKey(rt.deps.db, app, 'watch', false);
  const restored = await deployFixture(rt, app, 'healthy').catch((e: Error) => ({ ok: false, message: e.message }));
  console.error(restored.ok ? `restored ${app} to the healthy source` : `WARNING: could not restore ${app}: ${restored.message}`);
  if (wizardCreated) await act(rt, wizardApp, 'delete_app', { appName: wizardApp }).catch(() => console.error(`WARNING: delete ${wizardApp} manually`));

  const ok = t.print();
  rt.deps.db.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('acceptance crashed:', (err as Error).message);
  process.exit(1);
});
