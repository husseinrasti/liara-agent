import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@/src/events';
import { initialState, latestAssistant, reducer, type AssistantTurn } from './reducer';

let n = 0;
const ev = (e: Record<string, unknown>): AgentEvent => ({ id: `e${++n}`, ts: `2026-10-22T12:00:${String(n).padStart(2, '0')}Z`, sessionId: 's', ...e }) as AgentEvent;

describe('chat reducer', () => {
  it('builds a turn with text, timeline, cards and chips in order', () => {
    const events = [
      ev({ type: 'user_message', text: 'سایتم کند شده' }),
      ev({ type: 'tool_start', callId: 'c1', tool: 'diagnose_app', argsSummary: 'بررسی', risk: 0 }),
      ev({ type: 'diagnosis', appName: 'shop', source: 'llm', diagnosis: { summaryFa: 'x', severity: 'critical', causes: [], recommendedAction: null, alternatives: [], manualStepsFa: [], limitationsFa: [], followUpQuestionsFa: [] } }),
      ev({ type: 'tool_result', callId: 'c1', tool: 'diagnose_app', ok: true, summary: 'ok', durationMs: 10 }),
      ev({ type: 'assistant_text_delta', delta: 'سلام ' }),
      ev({ type: 'assistant_text_delta', delta: 'دنیا' }),
      ev({ type: 'tool_start', callId: 'c2', tool: 'restart_app', argsSummary: 'ری‌استارت', risk: 1 }),
      ev({ type: 'approval_required', approvalId: 'a1', tool: 'restart_app', args: {}, title: 't', why: 'w', risk: 1, reversible: true }),
      ev({ type: 'tool_result', callId: 'c2', tool: 'restart_app', ok: false, summary: 'منتظر', durationMs: 1, pendingApproval: true }),
      ev({ type: 'done' }),
    ];
    const s = reducer(initialState, { type: 'events', events });
    expect(s.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    const turn = s.messages[1] as AssistantTurn;
    expect(turn.items.map((i) => i.kind)).toEqual(['diagnosis', 'text', 'approval']);
    expect(turn.items[1]).toMatchObject({ text: 'سلام دنیا' });
    expect(turn.timeline.map((r) => r.status)).toEqual(['ok', 'waiting']);
    expect(turn.done).toBe(true);
  });

  it('dedupes events and resolves approvals in earlier turns', () => {
    const a = ev({ type: 'approval_required', approvalId: 'a9', tool: 'restart_app', args: {}, title: 't', why: 'w', risk: 1, reversible: true });
    let s = reducer(initialState, { type: 'event', event: ev({ type: 'tool_start', callId: 'c9', tool: 'restart_app', argsSummary: 'ری‌استارت', risk: 1 }) });
    s = reducer(s, { type: 'event', event: a });
    s = reducer(s, { type: 'event', event: a });
    s = reducer(s, { type: 'event', event: ev({ type: 'tool_result', callId: 'c9', tool: 'restart_app', ok: false, summary: 'منتظر', durationMs: 1, pendingApproval: true }) });
    s = reducer(s, { type: 'event', event: ev({ type: 'done' }) });
    s = reducer(s, { type: 'event', event: ev({ type: 'approval_resolved', approvalId: 'a9', approved: true, by: 'user' }) });
    s = reducer(s, { type: 'event', event: ev({ type: 'verify_result', action: 'restart_app', fixed: true, evidence: ['200'] }) });
    expect(s.messages).toHaveLength(2);
    const first = s.messages[0] as AssistantTurn;
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ kind: 'approval', resolved: { approved: true } });
    expect(first.timeline.map((r) => r.status)).toEqual(['approved']);
    expect((s.messages[1] as AssistantTurn).items[0]).toMatchObject({ kind: 'verify' });
  });

  it('merges deploy progress into one stepper and keeps chips on the latest reply', () => {
    let s = reducer(initialState, { type: 'event', event: ev({ type: 'user_message', text: 'دیپلوی' }) });
    for (const [stage, status] of [['analyze', 'running'], ['analyze', 'done'], ['create', 'done']] as const) s = reducer(s, { type: 'event', event: ev({ type: 'deploy_progress', stage, status }) });
    s = reducer(s, { type: 'event', event: ev({ type: 'deploy_progress', stage: 'health', status: 'done', url: 'https://x.liara.run' }) });
    s = reducer(s, { type: 'event', event: ev({ type: 'suggestions', chips: ['دامنه‌ی خودم را وصل کن'] }) });
    const turn = latestAssistant(s)!;
    expect(turn.items).toHaveLength(1);
    expect(turn.items[0]).toMatchObject({ kind: 'deploy', url: 'https://x.liara.run', stages: { analyze: { status: 'done' }, create: { status: 'done' } } });
    expect(turn.suggestions).toEqual(['دامنه‌ی خودم را وصل کن']);
  });

  it('collects alerts outside the thread, replacing same-title alerts', () => {
    const alert = { type: 'alert', appName: 'shop', severity: 'critical', title: 'سایت shop پاسخ نمی‌دهد', summary: 's', suggestedPrompt: 'p' };
    let s = reducer(initialState, { type: 'event', event: ev(alert) });
    s = reducer(s, { type: 'event', event: ev(alert) });
    expect(s.alerts).toHaveLength(1);
    expect(s.messages).toHaveLength(0);
  });
});
