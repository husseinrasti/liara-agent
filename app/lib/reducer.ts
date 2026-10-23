/**
 * Client state: reduces the agent event stream (live + replay, deduped by id)
 * into a thread of user messages and assistant turns. Each turn keeps its text
 * and cards in arrival order, a tool timeline and suggestion chips.
 */
import type { AgentEvent, DeployStage, EventOf } from '@/src/events';

export type TimelineStatus = 'running' | 'ok' | 'failed' | 'waiting' | 'approved' | 'rejected' | 'limited';

export interface TimelineRow {
  callId: string;
  tool: string;
  argsSummary: string;
  risk: number;
  status: TimelineStatus;
  summary?: string;
  durationMs?: number;
  raw?: unknown;
}

export type DeployStageState = { status: 'pending' | 'running' | 'done' | 'failed'; detail?: string };

export type TurnItem =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'approval'; id: string; event: EventOf<'approval_required'>; resolved?: { approved: boolean; by: string; ts: string } }
  | { kind: 'diagnosis'; id: string; event: EventOf<'diagnosis'> }
  | { kind: 'plan'; id: string; event: EventOf<'plan_recommendation'> }
  | { kind: 'domain'; id: string; event: EventOf<'domain_steps'> }
  | { kind: 'deploy'; id: string; stages: Partial<Record<DeployStage, DeployStageState>>; url?: string }
  | { kind: 'verify'; id: string; event: EventOf<'verify_result'> }
  | { kind: 'limitation'; id: string; message: string }
  | { kind: 'error'; id: string; message: string };

export interface UserMessage {
  kind: 'user';
  id: string;
  text: string;
  ts: string;
}

export interface AssistantTurn {
  kind: 'assistant';
  id: string;
  ts: string;
  items: TurnItem[];
  timeline: TimelineRow[];
  suggestions: string[];
  done: boolean;
}

export type AlertEvent = EventOf<'alert'>;

export interface ChatState {
  messages: (UserMessage | AssistantTurn)[];
  seen: ReadonlySet<string>;
  /** live alerts received on this session (the banner also loads persisted ones) */
  alerts: AlertEvent[];
}

export const initialState: ChatState = { messages: [], seen: new Set(), alerts: [] };

export type Action = { type: 'event'; event: AgentEvent } | { type: 'events'; events: AgentEvent[] } | { type: 'reset' };

function lastTurn(messages: ChatState['messages']): AssistantTurn | undefined {
  const last = messages[messages.length - 1];
  return last?.kind === 'assistant' && !last.done ? last : undefined;
}

/** Applies one event (mutates the given draft arrays/objects; callers pass fresh copies). */
function apply(state: ChatState, e: AgentEvent): ChatState {
  if (state.seen.has(e.id)) return state;
  const seen = new Set(state.seen).add(e.id);
  const messages = [...state.messages];

  if (e.type === 'user_message') {
    messages.push({ kind: 'user', id: e.id, text: e.text, ts: e.ts });
    return { ...state, messages, seen };
  }
  if (e.type === 'alert') {
    return { ...state, seen, alerts: [...state.alerts.filter((a) => a.title !== e.title || a.appName !== e.appName), e] };
  }
  if (e.type === 'approval_resolved') {
    return {
      ...state,
      seen,
      messages: messages.map((m) => {
        if (m.kind !== 'assistant') return m;
        const card = m.items.find((it) => it.kind === 'approval' && it.event.approvalId === e.approvalId);
        if (!card || card.kind !== 'approval') return m;
        return {
          ...m,
          items: m.items.map((it) => (it === card ? { ...card, resolved: { approved: e.approved, by: e.by, ts: e.ts } } : it)),
          // The "waiting for approval" row of this turn now shows the decision.
          timeline: m.timeline.map((r) => (r.status === 'waiting' && r.tool === card.event.tool ? { ...r, status: e.approved ? 'approved' : 'rejected' } : r)),
        };
      }),
    };
  }

  let turn = lastTurn(messages);
  if (!turn) {
    if (e.type === 'done') return { ...state, seen };
    turn = { kind: 'assistant', id: e.id, ts: e.ts, items: [], timeline: [], suggestions: [], done: false };
    messages.push(turn);
  }
  const t: AssistantTurn = { ...turn, items: [...turn.items], timeline: [...turn.timeline] };
  messages[messages.length - 1] = t;

  switch (e.type) {
    case 'assistant_text_delta': {
      const last = t.items[t.items.length - 1];
      if (last?.kind === 'text') t.items[t.items.length - 1] = { ...last, text: last.text + e.delta };
      else t.items.push({ kind: 'text', id: e.id, text: e.delta });
      break;
    }
    case 'tool_start':
      t.timeline.push({ callId: e.callId, tool: e.tool, argsSummary: e.argsSummary, risk: e.risk, status: 'running' });
      break;
    case 'tool_result': {
      const i = t.timeline.findIndex((r) => r.callId === e.callId);
      const row: TimelineRow = {
        ...(i >= 0 ? t.timeline[i]! : { callId: e.callId, tool: e.tool, argsSummary: e.tool, risk: 0 }),
        status: e.pendingApproval ? 'waiting' : e.ok ? 'ok' : e.limitation ? 'limited' : 'failed',
        summary: e.summary,
        durationMs: e.durationMs,
        raw: e.raw,
      };
      if (i >= 0) t.timeline[i] = row;
      else t.timeline.push(row);
      break;
    }
    case 'approval_required':
      t.items.push({ kind: 'approval', id: e.id, event: e });
      break;
    case 'diagnosis':
      t.items.push({ kind: 'diagnosis', id: e.id, event: e });
      break;
    case 'plan_recommendation':
      t.items.push({ kind: 'plan', id: e.id, event: e });
      break;
    case 'domain_steps':
      t.items.push({ kind: 'domain', id: e.id, event: e });
      break;
    case 'deploy_progress': {
      const i = t.items.findIndex((it) => it.kind === 'deploy');
      const prev = i >= 0 ? (t.items[i] as Extract<TurnItem, { kind: 'deploy' }>) : { kind: 'deploy' as const, id: e.id, stages: {} };
      const next = { ...prev, stages: { ...prev.stages, [e.stage]: { status: e.status, detail: e.detail } }, ...(e.url ? { url: e.url } : {}) };
      if (i >= 0) t.items[i] = next;
      else t.items.push(next);
      break;
    }
    case 'verify_result':
      t.items.push({ kind: 'verify', id: e.id, event: e });
      break;
    case 'limitation':
      if (!t.items.some((it) => it.kind === 'limitation' && it.message === e.message)) t.items.push({ kind: 'limitation', id: e.id, message: e.message });
      break;
    case 'error':
      t.items.push({ kind: 'error', id: e.id, message: e.message });
      break;
    case 'suggestions':
      t.suggestions = e.chips;
      break;
    case 'done':
      t.done = true;
      t.timeline = t.timeline.map((r) => (r.status === 'running' ? { ...r, status: 'failed' } : r));
      break;
  }
  return { ...state, messages, seen };
}

export function reducer(state: ChatState, action: Action): ChatState {
  if (action.type === 'reset') return initialState;
  if (action.type === 'event') return apply(state, action.event);
  return [...action.events].sort((a, b) => a.ts.localeCompare(b.ts)).reduce(apply, state);
}

/** Last assistant turn, finished or not (for chips under the last reply). */
export function latestAssistant(state: ChatState): AssistantTurn | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m.kind === 'assistant') return m;
    if (m.kind === 'user') return undefined;
  }
  return undefined;
}
