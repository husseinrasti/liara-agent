import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../events';
import { fakeAgent, healthyAppRoutes } from '../../test-utils/fake-agent';
import { scriptedStreamModel } from '../../test-utils/mock-model';
import '../../tools';
import { approve } from '../approvals';
import { runTurn, turnErrorFa } from '../loop';
import { AgentSession } from '../session';

function collect(rt: ReturnType<typeof fakeAgent>['rt'], session: AgentSession) {
  const events: AgentEvent[] = [];
  rt.bus.subscribe(session.id, (e) => events.push(e));
  return events;
}

const text = (events: AgentEvent[]) =>
  events
    .filter((e) => e.type === 'assistant_text_delta')
    .map((e) => (e as Extract<AgentEvent, { type: 'assistant_text_delta' }>).delta)
    .join('');

describe('runTurn', () => {
  it('streams text, runs read tools through the gate and ends with done', async () => {
    const model = scriptedStreamModel([
      { toolCalls: [{ name: 'get_app', input: { appName: 'shop' } }] },
      { text: 'سرویس shop روشن است و پلن small-g2 دارد.' },
      { text: '{"chips":["لاگ‌ها را نشان بده","مصرف رم چقدر است؟"]}' },
    ]);
    const { rt } = fakeAgent({ routes: healthyAppRoutes(), fast: model });
    const session = AgentSession.create(rt, { appName: 'shop' });
    const events = collect(rt, session);
    const res = await runTurn(rt, session, 'وضعیت اپ shop چطوره؟');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('tool_start');
    expect(types).toContain('tool_result');
    expect(types[types.length - 1]).toBe('done');
    expect(text(events)).toContain('small-g2');
    expect(res.pendingApprovals).toEqual([]);
    expect(events.find((e) => e.type === 'suggestions')).toMatchObject({ chips: ['لاگ‌ها را نشان بده', 'مصرف رم چقدر است؟'] });
    // history persisted: user + assistant(tool call) + tool result + assistant text
    const reloaded = AgentSession.load(rt, session.id)!;
    expect(reloaded.history.length).toBeGreaterThanOrEqual(4);
    expect(reloaded.history[0]).toMatchObject({ role: 'user' });
  });

  it('suspends on a risk-1 tool: approval card, no more tool calls, then done', async () => {
    const model = scriptedStreamModel([
      { toolCalls: [{ name: 'restart_app', input: { appName: 'shop' } }] },
      { text: 'پیشنهاد کردم سرویس ری‌استارت شود؛ منتظر تأیید شما هستم.' },
    ]);
    const { rt } = fakeAgent({ routes: healthyAppRoutes(), fast: model });
    const session = AgentSession.create(rt, { appName: 'shop' });
    const events = collect(rt, session);
    const res = await runTurn(rt, session, 'ری‌استارت کن');
    expect(res.pendingApprovals).toHaveLength(1);
    expect(events.filter((e) => e.type === 'approval_required')).toHaveLength(1);
    expect(rt.deps.db.prepare('SELECT COUNT(*) n FROM audit').get()).toEqual({ n: 0 });
    expect(events.some((e) => e.type === 'suggestions')).toBe(false);
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('after approval: runs the tool, verifies, and narrates in a new turn', async () => {
    const model = scriptedStreamModel([
      { toolCalls: [{ name: 'restart_app', input: { appName: 'shop' } }] },
      { text: 'منتظر تأیید شما هستم.' },
      { text: 'سرویس ری‌استارت شد و بررسی بعد از آن نشان داد سالم است.' },
      { text: '{"chips":[]}' },
    ]);
    const { rt, scheduled } = fakeAgent({ routes: healthyAppRoutes(), fast: model });
    const session = AgentSession.create(rt, { appName: 'shop' });
    const events = collect(rt, session);
    const res = await runTurn(rt, session, 'ری‌استارت کن');
    const outcome = approve(rt, { approvalId: res.pendingApprovals[0]!, approved: true });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) await outcome.done;
    const verify = events.find((e) => e.type === 'verify_result');
    expect(verify).toMatchObject({ action: 'restart_app', fixed: true });
    expect(rt.deps.db.prepare('SELECT tool, ok, verifyOk FROM audit').all()).toEqual([{ tool: 'restart_app', ok: 1, verifyOk: 1 }]);
    expect(scheduled.some((s) => s.ms === 180_000)).toBe(true); // +3 min follow-up re-check
    expect(text(events)).toContain('سالم');
  });

  it('turns model failures into a Persian error and still ends with done', async () => {
    const { MockLanguageModelV4 } = await import('ai/test');
    const broken = new MockLanguageModelV4({ doStream: async () => Promise.reject(new Error('fetch failed')) });
    const { rt } = fakeAgent({ fast: broken });
    const session = AgentSession.create(rt);
    const events = collect(rt, session);
    const res = await runTurn(rt, session, 'سلام');
    expect(res.error).toBeTruthy();
    expect(events.map((e) => e.type).slice(-2)).toEqual(['error', 'done']);
    expect(turnErrorFa(new Error('fetch failed'))).toMatch(/ارتباط/);
  });

  it('says plainly when the LLM key is out of budget [live: gateway budget_exceeded]', () => {
    expect(turnErrorFa(new Error('Spending limit reached for this API key.'))).toMatch(/سقف هزینه/);
    expect(turnErrorFa(new Error('Failed after 3 attempts. Last error: You exceeded your current quota'))).toMatch(/سقف هزینه/);
  });
});
