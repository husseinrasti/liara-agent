/**
 * Typed event protocol shared by the agent, the API routes (SSE) and the UI.
 * See docs/00-overview-architecture.md §6. Every event carries {id, ts, sessionId, type}.
 */
import { z } from 'zod';
import { PlanRecommendationSchema } from './agent/deploy/plan-schema';
import { DiagnosisSchema } from './agent/diagnosis-schema';

export const RiskSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const DEPLOY_STAGES = ['analyze', 'create', 'envs', 'archive', 'upload', 'release', 'build', 'health'] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

const payloads = {
  assistant_text_delta: z.object({ delta: z.string() }),
  tool_start: z.object({ callId: z.string(), tool: z.string(), argsSummary: z.string(), risk: RiskSchema }),
  tool_result: z.object({
    callId: z.string(),
    tool: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    durationMs: z.number(),
    raw: z.unknown().optional(),
  }),
  approval_required: z.object({
    approvalId: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    title: z.string(),
    why: z.string(),
    risk: RiskSchema,
    reversible: z.boolean(),
    costNote: z.string().optional(),
    requiresTypedName: z.string().optional(),
  }),
  approval_resolved: z.object({ approvalId: z.string(), approved: z.boolean(), by: z.string() }),
  diagnosis: z.object({ appName: z.string(), source: z.enum(['llm', 'rules']), diagnosis: DiagnosisSchema }),
  plan_recommendation: z.object({ recommendation: PlanRecommendationSchema }),
  deploy_progress: z.object({
    stage: z.enum(DEPLOY_STAGES),
    status: z.enum(['pending', 'running', 'done', 'failed']),
    detail: z.string().optional(),
  }),
  verify_result: z.object({
    action: z.string(),
    fixed: z.boolean(),
    evidence: z.array(z.string()),
    nextSuggestion: z.string().optional(),
  }),
  limitation: z.object({ message: z.string() }),
  alert: z.object({
    appName: z.string(),
    severity: z.enum(['critical', 'warning', 'info']),
    title: z.string(),
    summary: z.string(),
    suggestedPrompt: z.string(),
  }),
  suggestions: z.object({ chips: z.array(z.string()).max(4) }),
  error: z.object({ message: z.string() }),
  done: z.looseObject({}),
};

export type EventType = keyof typeof payloads;
type Payload<T extends EventType> = z.infer<(typeof payloads)[T]>;

const base = z.object({ id: z.string(), ts: z.string(), sessionId: z.string() });

export const AgentEventSchema = z.discriminatedUnion(
  'type',
  Object.entries(payloads).map(([type, schema]) => base.extend({ type: z.literal(type) }).extend(schema.shape)) as unknown as [
    z.ZodObject,
    ...z.ZodObject[],
  ],
);

/** A fully stamped event as stored and streamed. */
export type AgentEvent = { [T in EventType]: { id: string; ts: string; sessionId: string; type: T } & Payload<T> }[EventType];

/** What producers emit; the session stamps id/ts/sessionId. */
export type AgentEventInput = { [T in EventType]: { type: T } & Payload<T> }[EventType];

export type EventOf<T extends EventType> = Extract<AgentEvent, { type: T }>;

/** Optional sink tools use to report progress (deploy stages, limitations…). */
export type EmitFn = (event: AgentEventInput) => void;
