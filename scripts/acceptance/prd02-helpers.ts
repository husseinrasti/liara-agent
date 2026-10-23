/** Helpers for the PRD-02 acceptance run (real Liara + real LLM). */
import path from 'node:path';
import type { Diagnosis } from '../../src/agent/diagnosis-schema';
import { executeAction } from '../../src/agent/policy';
import { toolContextFor, type AgentRuntime } from '../../src/agent/runtime';
import { AgentSession } from '../../src/agent/session';
import { ROOT_DIR } from '../../src/config';
import type { AgentEvent, EventOf } from '../../src/events';
import { getTool, runTool } from '../../src/tools/registry';

export const PERSIAN = /[\u0600-\u06FF]/;
export const FIXTURES = path.join(ROOT_DIR, 'fixtures/apps');

export function sessionWithEvents(rt: AgentRuntime, appName?: string) {
  const session = AgentSession.create(rt, { appName });
  const events: AgentEvent[] = [];
  rt.bus.subscribe(session.id, (e) => events.push(e));
  return { session, events };
}

export const textOf = (events: AgentEvent[]) =>
  events
    .filter((e): e is EventOf<'assistant_text_delta'> => e.type === 'assistant_text_delta')
    .map((e) => e.delta)
    .join('');

export function lastDiagnosis(events: AgentEvent[]): Diagnosis | undefined {
  return (events.filter((e) => e.type === 'diagnosis').pop() as EventOf<'diagnosis'> | undefined)?.diagnosis;
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs: number; intervalMs: number; sleep: (ms: number) => Promise<void> }): Promise<T | null> {
  const started = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - started > opts.timeoutMs) return null;
    await opts.sleep(opts.intervalMs);
  }
}

/** Archives a fixture app, uploads it and releases it on `app` (no LLM involved). */
export async function deployFixture(rt: AgentRuntime, app: string, fixture: string, platform = 'node'): Promise<{ ok: boolean; state?: string; releaseID?: string; message: string }> {
  const { session } = sessionWithEvents(rt, app);
  const ctx = toolContextFor(rt, session);
  const archive = await runTool(getTool('build_source_archive')!, { path: path.join(FIXTURES, fixture), appName: app }, ctx);
  if (!archive.ok) return { ok: false, message: archive.userMessageFa };
  const up = await executeAction(rt, session, getTool('upload_source')!, { appName: app, archivePath: (archive.data as { archivePath: string }).archivePath });
  if (!up.result.ok) return { ok: false, message: up.result.userMessageFa };
  const sourceID = (up.result.data as { sourceID: string }).sourceID;
  const dep = await executeAction(rt, session, getTool('deploy_release')!, { appName: app, sourceID, port: 3000, platform, waitForReady: true });
  if (!dep.result.ok) return { ok: false, message: `${dep.result.error}` };
  const data = dep.result.data as { state: string; releaseID: string };
  return { ok: true, state: data.state, releaseID: data.releaseID, message: dep.verification?.evidence.join(' | ') ?? '' };
}

/** Runs a mutating tool directly with audit + verification (acceptance has AUTO_APPROVE). */
export async function act(rt: AgentRuntime, app: string, tool: string, input: Record<string, unknown>) {
  const { session } = sessionWithEvents(rt, app);
  return executeAction(rt, session, getTool(tool)!, input);
}
