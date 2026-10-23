/**
 * Tool registry — the single source of truth shared by the agent (Vercel AI SDK)
 * and the MCP server. Risk is a property of the tool; enforcement lives in the
 * policy gate (PRD-02) and in the MCP server, never in prompts.
 */
import { tool, type LanguageModel, type ToolSet } from 'ai';
import { z, type ZodType } from 'zod';
import type { Db } from '../db';
import type { EmitFn } from '../events';
import type { LiaraClient } from '../liara/client';
import { describeError } from '../liara/errors';
import type { Logger } from '../logger';

export type Risk = 0 | 1 | 2;
export type ToolCategory = 'read' | 'deploy' | 'ops' | 'domain' | 'local' | 'composite';

export interface ToolContext {
  liara: LiaraClient;
  db: Db;
  logger: Logger;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Repo root; local tools resolve relative paths against it. */
  workdir: string;
  /** `<repo>/data` — archives, clones. */
  dataDir: string;
  /** e.g. `.liara.run` */
  publicUrlSuffix: string;
  appName?: string;
  sessionId?: string;
  emit?: EmitFn;
  /** fetch used for public HTTP health checks (injectable for tests). */
  httpFetch?: typeof fetch;
  /** Language models, for agent-level tools (diagnose_app…). Absent when no LLM is configured. */
  llm?: (tier: 'fast' | 'smart') => LanguageModel;
  /** The agent runtime when running inside the agent (opaque here to avoid a dependency cycle). */
  agent?: unknown;
}

export type ToolSuccess<O> = { ok: true; data: O; summaryFa: string; raw?: unknown };
export type ToolFailure = { ok: false; error: string; userMessageFa: string; limitation?: boolean };
export type ToolResult<O> = ToolSuccess<O> | ToolFailure;

export interface Consequences {
  why: string;
  reversible: boolean;
  costNote?: string;
}

export interface VerifyOutcome {
  ok: boolean;
  evidence: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ToolDef<I = any, O = any> {
  /** snake_case; the name the LLM and MCP hosts see. */
  name: string;
  /** Short English title (MCP `title`). */
  title: string;
  /** English, for the LLM; precise about when to use it. */
  description: string;
  input: ZodType<I>;
  risk: Risk;
  category: ToolCategory;
  /** Persian one-liner for the timeline / approval card. */
  describeFa: (input: I) => string;
  /** risk ≥ 1: Persian consequences, reversibility, cost. */
  consequencesFa?: (input: I, ctx: ToolContext) => Promise<Consequences>;
  run: (input: I, ctx: ToolContext) => Promise<ToolResult<O>>;
  /**
   * Mutating tools: re-check after `verifyDelayMs`; returns Persian evidence.
   * `result` is the run() result (e.g. the new releaseID) when the caller has it.
   */
  verify?: (input: I, before: unknown, ctx: ToolContext, result?: ToolResult<O>) => Promise<VerifyOutcome>;
  /** Input as it may be shown in timelines/audit rows (secret values masked). Default: input as-is. */
  redactInput?: (input: I) => unknown;
  /** Captures state before running (used by verify + audit). */
  snapshot?: (input: I, ctx: ToolContext) => Promise<unknown>;
  /** Suggested wait before verify. */
  verifyDelayMs?: number;
  /** risk 2: the input field whose value the user must type to confirm (default `appName`). */
  confirmField?: string;
}

/**
 * Declares a tool. `run`, `verify` and `consequencesFa` are wrapped so they never
 * throw: failures become `{ok:false}` results with a Persian user message.
 */
export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`tool name must be snake_case: ${def.name}`);
  if (def.risk > 0 && !def.verify) throw new Error(`mutating tool ${def.name} must define verify()`);
  if (def.risk > 0 && !def.consequencesFa) throw new Error(`mutating tool ${def.name} must define consequencesFa()`);
  const { run, verify, consequencesFa } = def;
  return {
    ...def,
    run: async (input, ctx) => {
      try {
        return await run(input, ctx);
      } catch (err) {
        return { ok: false, ...describeError(err) };
      }
    },
    verify: verify
      ? async (input, before, ctx, result) => {
          try {
            return await verify(input, before, ctx, result);
          } catch (err) {
            return { ok: false, evidence: [`بررسی نتیجه با خطا روبه‌رو شد: ${describeError(err).userMessageFa}`] };
          }
        }
      : undefined,
    consequencesFa: consequencesFa
      ? async (input, ctx) => {
          try {
            return await consequencesFa(input, ctx);
          } catch {
            return { why: def.describeFa(input), reversible: false, costNote: 'جزئیات هزینه در دسترس نبود.' };
          }
        }
      : undefined,
  };
}

export const registry = new Map<string, ToolDef>();

export function registerTools(defs: ToolDef[]): void {
  for (const d of defs) {
    if (registry.has(d.name) && registry.get(d.name) !== d) throw new Error(`duplicate tool ${d.name}`);
    registry.set(d.name, d);
  }
}

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

export function listTools(): ToolDef[] {
  return [...registry.values()];
}

/** Validates input and runs a tool; never throws. */
export async function runTool<O = unknown>(def: ToolDef<any, O>, rawInput: unknown, ctx: ToolContext): Promise<ToolResult<O>> {
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    return { ok: false, error: `invalid input for ${def.name}: ${detail}`, userMessageFa: 'ورودی این ابزار کامل یا درست نبود.' };
  }
  try {
    return await def.run(parsed.data, ctx);
  } catch (err) {
    ctx.logger.warn({ tool: def.name, err: describeError(err).error }, 'tool threw; converted to failure');
    return { ok: false, ...describeError(err) };
  }
}

/** Max characters of a tool result passed back to the model (~2k tokens). */
export const MODEL_RESULT_CHAR_BUDGET = 8000;

/** Drops `raw` and caps size so the model context stays small. */
export function compactForModel(result: ToolResult<unknown> | Record<string, unknown>): Record<string, unknown> {
  const { raw: _raw, ...rest } = result as Record<string, unknown>;
  const text = JSON.stringify(rest);
  if (text.length <= MODEL_RESULT_CHAR_BUDGET) return rest;
  return { ...rest, data: undefined, dataTruncated: `${JSON.stringify(rest.data).slice(0, MODEL_RESULT_CHAR_BUDGET - 500)}…` };
}

export interface AiToolsOptions {
  only?: string[];
  /** The agent wires the policy gate here; default runs the tool directly. */
  execute?: (def: ToolDef, input: unknown, meta: { toolCallId: string }) => Promise<ToolResult<unknown> | Record<string, unknown>>;
}

/** Vercel AI SDK `tools` object for the given context. */
export function toAiSdkTools(ctx: ToolContext, opts: AiToolsOptions = {}): ToolSet {
  const out: ToolSet = {};
  for (const def of listTools()) {
    if (opts.only && !opts.only.includes(def.name)) continue;
    out[def.name] = tool({
      description: riskPrefix(def.risk) + def.description,
      inputSchema: def.input as ZodType<unknown>,
      execute: async (input: unknown, options: { toolCallId: string }) =>
        opts.execute ? opts.execute(def, input, { toolCallId: options.toolCallId }) : runTool(def, input, ctx),
      toModelOutput: ({ output }) => ({ type: 'json', value: JSON.parse(JSON.stringify(compactForModel(output as ToolResult<unknown>))) }),
    });
  }
  return out;
}

export function riskPrefix(risk: Risk): string {
  return risk === 2 ? '[risk 2 — dangerous] ' : risk === 1 ? '[risk 1 — confirm] ' : '';
}

export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

/** MCP tool list. Risk 1 tools require `confirm: true`; risk 2 require `confirmAppName`. */
export function toMcpTools(defs: ToolDef[] = listTools()): McpToolDescriptor[] {
  return defs.map((def) => {
    const schema = z.toJSONSchema(def.input, { io: 'input', unrepresentable: 'any' }) as McpToolDescriptor['inputSchema'];
    delete (schema as Record<string, unknown>).$schema;
    const properties = { ...(schema.properties ?? {}) };
    const required = [...(schema.required ?? [])];
    if (def.risk === 1) {
      properties.confirm = { type: 'boolean', description: 'Must be true: the user explicitly approved this change.' };
      required.push('confirm');
    }
    if (def.risk === 2) {
      const field = def.confirmField ?? 'appName';
      properties.confirmAppName = { type: 'string', description: `Dangerous action: the user must type the exact value of "${field}" to confirm.` };
      required.push('confirmAppName');
    }
    return {
      name: def.name,
      title: def.title,
      description: riskPrefix(def.risk) + def.description,
      inputSchema: { ...schema, type: 'object', properties, required },
      annotations: {
        title: def.title,
        readOnlyHint: def.risk === 0,
        destructiveHint: def.risk === 2,
        idempotentHint: def.risk === 0,
        openWorldHint: def.category !== 'local',
      },
    };
  });
}
