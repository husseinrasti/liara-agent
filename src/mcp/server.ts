/**
 * MCP stdio server exposing the same tool registry the web agent uses.
 * There is no approval UI here, so the server enforces confirmation itself:
 * risk 1 tools need `confirm: true`, risk 2 tools need `confirmAppName` equal to
 * the target app name. Mutating tools are audited and verified after running.
 * stdout is reserved for JSON-RPC; all logs go to stderr.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LanguageModel } from 'ai';
import '../agent/tools';
import { createModel, type ModelTier } from '../agent/providers';
import { ConfigError, ROOT_DIR } from '../config';
import { finishAudit, recordVerify, startAudit } from '../db/repo';
import type { AgentEventInput } from '../events';
import { createLogger } from '../logger';
import { createSimulatedDeps, isSimulated } from '../sim/deps';
import { compactForModel, createRuntime, createToolContext, getTool, runTool, toMcpTools, type RuntimeDeps, type ToolContext, type ToolDef } from '../tools';

const logger = createLogger({ name: 'mcp' });
const version = (JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as { version: string }).version;

const INSTRUCTIONS = [
  'Liara co-worker tools: deploy, observe, diagnose and fix apps on Liara (https://liara.ir).',
  'Risk tiers are enforced by this server: risk 0 tools run directly; risk 1 tools (marked "[risk 1 — confirm]") require `confirm: true`',
  'only after the user approved; risk 2 tools ("[risk 2 — dangerous]") require `confirmAppName` typed by the user.',
  'Mutating tools are verified after running; only report success when `verification.ok` is true.',
  'Prefer collect_evidence when investigating a problem. Liara exposes no HTTP access logs; use http_health_check for live status.',
  'Results start with a Persian one-line summary for the end user.',
].join(' ');

const SIM_NOTE = ' SIMULATOR MODE (LIARA_FAKE=1): apps and data are simulated, not a real Liara account; say so to the user.';

let runtime: RuntimeDeps | null = null;
let runtimeError: string | null = null;
/** Public-URL fetch for health checks; the simulator answers for *.liara.run in LIARA_FAKE mode. */
let httpFetch: typeof fetch | undefined;
const models = new Map<ModelTier, LanguageModel | null>();

/** LLM for agent-level tools (diagnose_app); absent when no LLM key is configured (rule-based fallback). */
function llmFor(rt: RuntimeDeps) {
  return (tier: ModelTier): LanguageModel => {
    if (!models.has(tier)) {
      try {
        models.set(tier, createModel(tier, rt.config));
      } catch {
        models.set(tier, null);
      }
    }
    const m = models.get(tier);
    if (!m) throw new Error('LLM not configured');
    return m;
  };
}

function hasLlm(rt: RuntimeDeps): boolean {
  try {
    llmFor(rt)('smart');
    return true;
  } catch {
    return false;
  }
}

function getRuntime(): RuntimeDeps | null {
  if (runtime || runtimeError) return runtime;
  try {
    if (isSimulated()) {
      const simulated = createSimulatedDeps({ dbFile: 'mcp-sim.db', logger });
      runtime = simulated.deps;
      httpFetch = simulated.sim.httpFetch;
      logger.warn('LIARA_FAKE=1: serving the simulator, not the real Liara API');
    } else {
      runtime = createRuntime({ logger });
    }
  } catch (err) {
    runtimeError = err instanceof ConfigError ? err.message : `startup failed: ${(err as Error).message}`;
    logger.error({ err: runtimeError }, 'mcp runtime unavailable');
  }
  return runtime;
}

const text = (s: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: s }], isError });

const contextFor = (rt: RuntimeDeps, extra: Partial<ToolContext> = {}) => createToolContext(rt, { sessionId: 'mcp', ...(httpFetch ? { httpFetch } : {}), ...extra });

/** Returns an error result when the confirmation inputs required by the tool's risk tier are missing. */
async function checkConfirmation(def: ToolDef, args: Record<string, unknown>, rt: RuntimeDeps): Promise<CallToolResult | null> {
  if (def.risk === 0) return null;
  if (def.risk === 1 && args.confirm === true) return null;
  const field = def.confirmField ?? 'appName';
  if (def.risk === 2 && typeof args.confirmAppName === 'string' && args.confirmAppName === args[field]) return null;
  const parsed = def.input.safeParse(args);
  const consequences = parsed.success && def.consequencesFa ? await def.consequencesFa(parsed.data, contextFor(rt)) : null;
  const need =
    def.risk === 1
      ? 'Ask the user to approve, then call again with "confirm": true.'
      : `Dangerous action: ask the user to type the exact ${field} ("${String(args[field] ?? '')}") and pass it as "confirmAppName".`;
  const lines = [
    `⚠️ نیاز به تأیید: ${parsed.success ? def.describeFa(parsed.data) : def.title}`,
    consequences ? `پیامد: ${consequences.why}${consequences.costNote ? ` ${consequences.costNote}` : ''} (${consequences.reversible ? 'برگشت‌پذیر' : 'برگشت‌ناپذیر'})` : '',
    need,
  ].filter(Boolean);
  return text(lines.join('\n'), true);
}

async function callTool(name: string, rawArgs: Record<string, unknown>, notify: (event: AgentEventInput) => void): Promise<CallToolResult> {
  const def = getTool(name);
  if (!def) return text(`Unknown tool: ${name}`, true);
  const rt = getRuntime();
  if (!rt) return text(`Server is not configured: ${runtimeError}`, true);
  const gate = await checkConfirmation(def, rawArgs, rt);
  if (gate) return gate;
  const { confirm: _c, confirmAppName: _n, ...args } = rawArgs;
  const ctx = contextFor(rt, { emit: notify, ...(hasLlm(rt) ? { llm: llmFor(rt) } : {}) });

  if (def.risk === 0) {
    const result = await runTool(def, args, ctx);
    return render(result, undefined);
  }

  const parsed = def.input.safeParse(args);
  if (!parsed.success) return render(await runTool(def, args, ctx), undefined);
  const input = parsed.data;
  const before = def.snapshot ? await def.snapshot(input, ctx).catch(() => undefined) : undefined;
  const auditId = startAudit(rt.db, { sessionId: 'mcp', tool: def.name, args: def.redactInput ? def.redactInput(input) : input, risk: def.risk });
  const result = await runTool(def, input, ctx);
  finishAudit(rt.db, auditId, { ok: result.ok, resultSummary: result.ok ? result.summaryFa : result.userMessageFa });
  let verification: { ok: boolean; evidence: string[] } | undefined;
  if (result.ok && def.verify) {
    if (def.verifyDelayMs) await ctx.sleep(def.verifyDelayMs);
    verification = await def.verify(input, before, ctx, result);
    recordVerify(rt.db, auditId, verification);
  }
  return render(result, verification);
}

function render(result: Awaited<ReturnType<typeof runTool>>, verification?: { ok: boolean; evidence: string[] }): CallToolResult {
  const head = result.ok ? result.summaryFa : `${result.limitation ? 'ℹ️ محدودیت: ' : '❌ '}${result.userMessageFa}`;
  const verifyLine = verification ? `\n${verification.ok ? '✅ بررسی بعد از اقدام: موفق' : '⚠️ بررسی بعد از اقدام: مشکل هنوز برطرف نشده'} — ${verification.evidence.join(' | ')}` : '';
  const body = { ...compactForModel(result), ...(verification ? { verification } : {}) };
  return text(`${head}${verifyLine}\n${JSON.stringify(body, null, 2)}`, !result.ok);
}

async function main() {
  const server = new Server({ name: 'liara-agent', version }, { capabilities: { tools: {}, logging: {} }, instructions: isSimulated() ? INSTRUCTIONS + SIM_NOTE : INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toMcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const progressToken = req.params._meta?.progressToken;
    let step = 0;
    const notify = (event: AgentEventInput) => {
      if (event.type !== 'deploy_progress' || progressToken === undefined) return;
      step++;
      void extra
        .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: step, message: `${event.stage}: ${event.status}${event.detail ? ` — ${event.detail}` : ''}` } })
        .catch(() => undefined);
    };
    try {
      return await callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, notify);
    } catch (err) {
      logger.error({ tool: req.params.name, err: (err as Error).message }, 'tool call crashed');
      return text(`Tool ${req.params.name} failed unexpectedly.`, true);
    }
  });
  await server.connect(new StdioServerTransport());
  logger.info({ version, tools: toMcpTools().length }, 'liara-agent MCP server ready on stdio');
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, 'mcp server crashed');
  process.exit(1);
});
