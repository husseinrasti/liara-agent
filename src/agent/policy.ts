/**
 * Policy gate — enforced in code, not in the prompt. Risk 0 tools run directly;
 * risk ≥ 1 tools create a pending approval and suspend the turn (unless
 * AUTO_APPROVE, acceptance scripts only). Executed mutations are audited and
 * verified before anyone may call them "fixed".
 */
import { randomUUID } from 'node:crypto';
import { finishAudit, startAudit } from '../db/repo';
import { runTool, type ToolDef, type ToolResult } from '../tools/registry';
import { afterAction } from './hooks';
import { toolContextFor, type AgentRuntime } from './runtime';
import type { AgentSession } from './session';
import { verifyAction, type VerifyResult } from './verify';

export const APPROVAL_TTL_MS = 15 * 60_000;
export const WAITING_FOR_APPROVAL_FA = 'منتظر تأیید شما هستم';

export interface PendingApprovalResult {
  ok: false;
  pendingApproval: true;
  approvalId: string;
  error: string;
  userMessageFa: string;
}

export interface ExecutedAction {
  result: ToolResult<unknown>;
  verification?: VerifyResult;
}

export const redactedInput = (def: ToolDef, input: unknown): Record<string, unknown> =>
  ((def.redactInput ? def.redactInput(input) : input) ?? {}) as Record<string, unknown>;

export function summaryOf(result: ToolResult<unknown> | PendingApprovalResult): string {
  if ('pendingApproval' in result) return WAITING_FOR_APPROVAL_FA;
  return result.ok ? result.summaryFa : result.userMessageFa;
}

function safeDescribe(def: ToolDef, input: unknown): string {
  try {
    return def.describeFa(input);
  } catch {
    return def.title;
  }
}

/** Persists a pending approval and emits the Approval Card event. */
export async function requestApproval(rt: AgentRuntime, session: AgentSession, def: ToolDef, input: unknown): Promise<PendingApprovalResult> {
  const ctx = toolContextFor(rt, session);
  const consequences = def.consequencesFa ? await def.consequencesFa(input, ctx) : { why: safeDescribe(def, input), reversible: true };
  const approvalId = randomUUID();
  rt.deps.db
    .prepare('INSERT INTO approvals (id, sessionId, tool, args, risk, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(approvalId, session.id, def.name, JSON.stringify(input), def.risk, 'pending', rt.now().toISOString());
  const typed = def.risk === 2 ? String((input as Record<string, unknown>)[def.confirmField ?? 'appName'] ?? '') : undefined;
  session.emit({
    type: 'approval_required',
    approvalId,
    tool: def.name,
    args: redactedInput(def, input),
    title: safeDescribe(def, input),
    why: consequences.why,
    risk: def.risk,
    reversible: consequences.reversible,
    ...(consequences.costNote ? { costNote: consequences.costNote } : {}),
    ...(typed ? { requiresTypedName: typed } : {}),
  });
  return { ok: false, pendingApproval: true, approvalId, error: 'awaiting user approval', userMessageFa: WAITING_FOR_APPROVAL_FA };
}

/**
 * Runs an approved (or auto-approved) mutating tool: snapshot → audit → run →
 * verify. Emits tool_start/tool_result when `emitTimeline` (outside a model turn).
 */
export async function executeAction(
  rt: AgentRuntime,
  session: AgentSession,
  def: ToolDef,
  input: unknown,
  opts: { callId?: string; emitTimeline?: boolean } = {},
): Promise<ExecutedAction> {
  const ctx = toolContextFor(rt, session);
  const callId = opts.callId ?? randomUUID();
  const started = Date.now();
  if (opts.emitTimeline) session.emit({ type: 'tool_start', callId, tool: def.name, argsSummary: safeDescribe(def, input), risk: def.risk });
  const before = def.snapshot ? await def.snapshot(input, ctx).catch(() => undefined) : undefined;
  const auditId = def.risk > 0 ? startAudit(rt.deps.db, { sessionId: session.id, tool: def.name, args: redactedInput(def, input), risk: def.risk }, rt.now()) : null;
  const result = await runTool(def, input, ctx);
  if (auditId !== null) finishAudit(rt.deps.db, auditId, { ok: result.ok, resultSummary: summaryOf(result) }, rt.now());
  afterAction(rt, session, def.name, input, result);
  if (opts.emitTimeline) {
    session.emit({ type: 'tool_result', callId, tool: def.name, ok: result.ok, summary: summaryOf(result), durationMs: Date.now() - started, ...(!result.ok && result.limitation ? { limitation: true } : {}) });
    if (!result.ok && result.limitation) session.emit({ type: 'limitation', message: result.userMessageFa });
  }
  const verification =
    result.ok && def.risk > 0 && def.verify ? await verifyAction(rt, session, { def, input, before, result, auditId }) : undefined;
  return { result, verification };
}

export interface TurnPolicyState {
  pendingApprovals: string[];
}

/**
 * The `execute` used by every AI SDK tool inside a turn: emits the timeline,
 * gates by risk, and returns a compact result (plus verification) to the model.
 */
export function policyExecutor(rt: AgentRuntime, session: AgentSession, state: TurnPolicyState) {
  return async (def: ToolDef, input: unknown, meta: { toolCallId: string }): Promise<Record<string, unknown>> => {
    const started = Date.now();
    session.emit({ type: 'tool_start', callId: meta.toolCallId, tool: def.name, argsSummary: safeDescribe(def, input), risk: def.risk });
    const parsed = def.input.safeParse(input ?? {});
    let out: ToolResult<unknown> | PendingApprovalResult;
    let verification: VerifyResult | undefined;
    if (def.risk === 0 || !parsed.success) {
      out = await runTool(def, input, toolContextFor(rt, session));
    } else if (rt.autoApprove) {
      ({ result: out, verification } = await executeAction(rt, session, def, parsed.data));
    } else {
      const pending = await requestApproval(rt, session, def, parsed.data);
      state.pendingApprovals.push(pending.approvalId);
      out = pending;
    }
    const raw = out.ok ? (out.raw ?? out.data) : undefined;
    session.emit({
      type: 'tool_result',
      callId: meta.toolCallId,
      tool: def.name,
      ok: out.ok,
      summary: summaryOf(out),
      durationMs: Date.now() - started,
      ...(raw === undefined ? {} : { raw }),
      ...('pendingApproval' in out ? { pendingApproval: true } : {}),
      ...(!out.ok && 'limitation' in out && out.limitation ? { limitation: true } : {}),
    });
    if (!out.ok && 'limitation' in out && out.limitation) session.emit({ type: 'limitation', message: out.userMessageFa });
    const forModel: Record<string, unknown> = { ...out };
    if (verification) forModel.verification = { fixed: verification.fixed, evidence: verification.evidence, nextSuggestion: verification.nextSuggestion };
    if ('pendingApproval' in out) forModel.instruction = 'STOP: the user must approve this in the UI. In one Persian sentence say what you proposed and why, then wait. Do not call other tools.';
    return forModel;
  };
}
