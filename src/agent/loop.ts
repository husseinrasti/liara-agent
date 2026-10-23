/**
 * The turn loop: our own thin harness over streamText (no agent framework).
 * Streams text deltas, routes every tool call through the policy gate, stops
 * calling tools once an approval is pending, persists history, emits chips and
 * always ends with `done`.
 */
import { APICallError, stepCountIs, streamText, type ModelMessage } from 'ai';
import { getTool, toAiSdkTools } from '../tools/registry';
import { suggestChips } from './chips';
import { executeAction, policyExecutor, type ExecutedAction, type TurnPolicyState } from './policy';
import { invalidateAppContext } from './prompts/context';
import { buildSystemPrompt } from './prompts';
import { callSettings } from './providers';
import { toolContextFor, type AgentRuntime } from './runtime';
import type { AgentSession } from './session';

export const MAX_STEPS = 10;

export interface TurnOptions {
  /** A system-authored message (approved action narration); still stored in history. */
  synthetic?: boolean;
  abortSignal?: AbortSignal;
  maxSteps?: number;
  suggestions?: boolean;
}

export interface TurnResult {
  text: string;
  steps: number;
  pendingApprovals: string[];
  error?: string;
}

const STEP_BUDGET_FA = '\n\nبه سقف مراحل این نوبت رسیدم. اگر بخواهید ادامه می‌دهم؛ کافی است بنویسید «ادامه بده».';

/** Provider budget/quota exhausted (e.g. a gateway's "Spending limit reached" / budget_exceeded). */
const LLM_BUDGET = /spending limit|budget_exceeded|insufficient_quota|exceeded your current quota/i;

export function turnErrorFa(err: unknown): string {
  const raw = err instanceof Error ? `${err.message} ${APICallError.isInstance(err) ? (err.responseBody ?? '') : ''}` : String(err);
  if (LLM_BUDGET.test(raw)) return 'سقف هزینه‌ی کلید سرویس هوش مصنوعی پر شده است. تا وقتی اعتبارش بیشتر نشود یا کلید دیگری تنظیم نشود، نمی‌توانم پاسخ بدهم.';
  if (APICallError.isInstance(err)) {
    if (err.statusCode === 401 || err.statusCode === 403) return 'اتصال به سرویس هوش مصنوعی برقرار نشد؛ کلید API آن معتبر نیست.';
    if (err.statusCode === 429) return 'سرویس هوش مصنوعی فعلاً شلوغ است؛ چند لحظه بعد دوباره امتحان کنید.';
  }
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/timeout|abort|ECONN|fetch failed|network/i.test(msg)) return 'ارتباط با سرویس هوش مصنوعی برقرار نشد؛ لطفاً دوباره امتحان کنید.';
  return 'متأسفم، در پردازش درخواست خطایی رخ داد. لطفاً دوباره امتحان کنید.';
}

export async function runTurn(rt: AgentRuntime, session: AgentSession, userText: string, opts: TurnOptions = {}): Promise<TurnResult> {
  const state: TurnPolicyState = { pendingApprovals: [] };
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  let text = '';
  let steps = 0;
  let error: string | undefined;
  try {
    session.touch();
    await session.compactIfNeeded().catch((err) => rt.deps.logger.warn({ err: (err as Error).message }, 'history compaction failed'));
    const system = await buildSystemPrompt(rt, session);
    const userMessage: ModelMessage = { role: 'user', content: userText };
    const started = new Set<string>();
    const execute = policyExecutor(rt, session, state);
    const result = streamText({
      model: rt.model('fast'),
      system,
      messages: [...session.history, userMessage],
      tools: toAiSdkTools(toolContextFor(rt, session), {
        execute: async (def, input, meta) => {
          started.add(meta.toolCallId);
          return execute(def, input, meta);
        },
      }),
      ...callSettings('fast', rt.deps.config),
      stopWhen: stepCountIs(maxSteps),
      prepareStep: () => (state.pendingApprovals.length ? { toolChoice: 'none' as const } : {}),
      abortSignal: opts.abortSignal,
    });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
        session.emit({ type: 'assistant_text_delta', delta: part.text });
      } else if (part.type === 'tool-error') {
        if (!started.has(part.toolCallId)) {
          session.emit({ type: 'tool_start', callId: part.toolCallId, tool: part.toolName, argsSummary: getTool(part.toolName)?.title ?? part.toolName, risk: getTool(part.toolName)?.risk ?? 0 });
        }
        session.emit({ type: 'tool_result', callId: part.toolCallId, tool: part.toolName, ok: false, summary: 'اجرای این ابزار ممکن نشد.', durationMs: 0 });
      } else if (part.type === 'error') {
        throw part.error;
      }
    }
    steps = (await result.steps).length;
    if (steps >= maxSteps && (await result.finishReason) === 'tool-calls') {
      text += STEP_BUDGET_FA;
      session.emit({ type: 'assistant_text_delta', delta: STEP_BUDGET_FA });
    }
    session.appendMessages([userMessage, ...((await result.responseMessages) as ModelMessage[])]);
    session.flushText();
    // With an approval pending, the Approval Card is the next step: no chips.
    if (opts.suggestions !== false && !state.pendingApprovals.length) {
      const chips = await suggestChips(rt, text, session.appName).catch(() => []);
      if (chips.length) session.emit({ type: 'suggestions', chips });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    rt.deps.logger.error({ err: error.slice(0, 300), sessionId: session.id }, 'turn failed');
    session.emit({ type: 'error', message: turnErrorFa(err) });
  } finally {
    session.emit({ type: 'done' });
  }
  return { text, steps, pendingApprovals: state.pendingApprovals, ...(error ? { error } : {}) };
}

export interface ApprovalRow {
  id: string;
  sessionId: string;
  tool: string;
  args: string;
  risk: number;
  status: string;
  createdAt: string;
}

/**
 * After /api/approve: runs the tool directly (bypassing the model), verifies it,
 * then asks the model to narrate the outcome in Persian.
 */
export async function runApprovedAction(rt: AgentRuntime, session: AgentSession, approval: ApprovalRow): Promise<ExecutedAction | null> {
  const def = getTool(approval.tool);
  if (!def) {
    session.emit({ type: 'error', message: 'این اقدام دیگر در دسترس نیست.' });
    session.emit({ type: 'done' });
    return null;
  }
  const input = JSON.parse(approval.args) as Record<string, unknown>;
  let executed: ExecutedAction | null = null;
  try {
    executed = await executeAction(rt, session, def, input, { callId: approval.id, emitTimeline: true });
  } catch (err) {
    rt.deps.logger.error({ err: (err as Error).message, tool: def.name }, 'approved action crashed');
  }
  invalidateAppContext(typeof input.appName === 'string' ? input.appName : undefined);
  const r = executed?.result;
  const outcome = !r ? 'failed unexpectedly' : r.ok ? `succeeded — ${r.summaryFa}` : `failed — ${r.userMessageFa}`;
  const v = executed?.verification;
  const verification = v
    ? `${v.fixed ? 'FIXED' : 'NOT FIXED'} — ${v.evidence.join('; ')}${v.nextSuggestion ? ` (suggested next step: ${v.nextSuggestion})` : ''}`
    : r?.ok
      ? 'no verification step for this action'
      : 'not run';
  await runTurn(
    rt,
    session,
    `[system] The user approved ${def.name}. Result: ${outcome}. Verification: ${verification}. ` +
      'Summarize this for the user in Persian in 2–3 short sentences. Say whether the problem is fixed ONLY based on the verification, and suggest one next step. Do not call mutating tools now.',
    { synthetic: true },
  );
  return executed;
}

export async function runDeclinedNarration(rt: AgentRuntime, session: AgentSession, approval: ApprovalRow): Promise<void> {
  await runTurn(
    rt,
    session,
    `[system] The user declined ${approval.tool}; nothing was changed. Acknowledge it in one short Persian sentence and offer one safer alternative or ask what they prefer. If they ask for it again later, call the tool again: a new approval card will be shown.`,
    { synthetic: true },
  );
}
