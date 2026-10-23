/**
 * LLM provider switch (openai | gemini | openrouter) on the Vercel AI SDK, plus a
 * structured-output helper that degrades gracefully: strict schema → JSON mode →
 * free text with the first {...} block parsed and validated.
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, Output, type LanguageModel } from 'ai';
import type { ZodType } from 'zod';
import { ConfigError, getConfig, type AppConfig, type LlmProvider } from '../config';
import { silentLogger, type Logger } from '../logger';

export type ModelTier = 'fast' | 'smart';

export const DEFAULT_MODELS: Record<LlmProvider, Record<ModelTier, string>> = {
  openai: { fast: 'gpt-4.1-mini', smart: 'gpt-4.1' },
  gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
  openrouter: { fast: 'google/gemini-2.5-flash', smart: 'anthropic/claude-sonnet-4.5' },
};

export function modelId(tier: ModelTier, cfg: AppConfig = getConfig()): string {
  const configured = tier === 'fast' ? cfg.llm.fastModel : cfg.llm.smartModel;
  return configured || DEFAULT_MODELS[cfg.llm.provider][tier];
}

function missingKey(name: string): never {
  throw new ConfigError(`${name} is missing for LLM_PROVIDER. Set it in .env.\nکلید ${name} برای سرویس هوش مصنوعی تنظیم نشده است.`);
}

/** Builds a language model for the configured provider (not cached; see AgentRuntime for reuse). */
export function createModel(tier: ModelTier, cfg: AppConfig = getConfig()): LanguageModel {
  const id = modelId(tier, cfg);
  switch (cfg.llm.provider) {
    case 'openai': {
      if (!cfg.llm.openaiApiKey) missingKey('OPENAI_API_KEY');
      return createOpenAI({ apiKey: cfg.llm.openaiApiKey, baseURL: cfg.llm.openaiBaseUrl || undefined })(id);
    }
    case 'gemini': {
      if (!cfg.llm.googleApiKey) missingKey('GOOGLE_GENERATIVE_AI_API_KEY');
      return createGoogleGenerativeAI({ apiKey: cfg.llm.googleApiKey })(id);
    }
    case 'openrouter': {
      if (!cfg.llm.openrouterApiKey) missingKey('OPENROUTER_API_KEY');
      return createOpenRouter({ apiKey: cfg.llm.openrouterApiKey })(id);
    }
  }
}

const cache = new Map<ModelTier, LanguageModel>();

export function getModel(tier: ModelTier): LanguageModel {
  let m = cache.get(tier);
  if (!m) {
    m = createModel(tier);
    cache.set(tier, m);
  }
  return m;
}

/** OpenAI reasoning models (gpt-5*, o-series) reject `temperature`. */
export function isReasoningModel(provider: LlmProvider, id: string): boolean {
  return provider === 'openai' && /^(gpt-5|o\d)/i.test(id);
}

/** Sampling settings appropriate for the configured model of a tier. */
export function callSettings(tier: ModelTier, cfg: AppConfig = getConfig(), temperature = 0.2) {
  const id = modelId(tier, cfg);
  if (!isReasoningModel(cfg.llm.provider, id)) return { temperature };
  return { providerOptions: { openai: { reasoningEffort: tier === 'fast' ? 'low' : 'medium' } } };
}

export interface LlmHealth {
  ok: boolean;
  provider: LlmProvider;
  model: string;
  latencyMs: number;
  error?: string;
}

/** One tiny generation; used by /api/health and the acceptance script. */
export async function llmHealthCheck(model: LanguageModel = getModel('fast'), cfg: AppConfig = getConfig()): Promise<LlmHealth> {
  const started = Date.now();
  const base = { provider: cfg.llm.provider, model: modelId('fast', cfg) };
  try {
    const r = await generateText({ model, prompt: 'Reply with exactly: ok', maxOutputTokens: 16, abortSignal: AbortSignal.timeout(30_000) });
    return { ...base, ok: /ok/i.test(r.text), latencyMs: Date.now() - started, ...(/ok/i.test(r.text) ? {} : { error: `unexpected reply: ${r.text.slice(0, 40)}` }) };
  } catch (err) {
    return { ...base, ok: false, latencyMs: Date.now() - started, error: (err as Error).message.slice(0, 200) };
  }
}

export type StructuredPath = 'structured' | 'json' | 'text';

export interface SafeGenerateOptions<T> {
  model: LanguageModel;
  schema: ZodType<T>;
  system?: string;
  prompt: string;
  schemaName?: string;
  /** Use callSettings(tier) — reasoning models reject temperature. */
  temperature?: number;
  providerOptions?: Record<string, Record<string, string | number | boolean>>;
  maxOutputTokens?: number;
  timeoutMs?: number;
  logger?: Logger;
}

/** Returns the first balanced `{...}` block in a text (handles strings and escapes). */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const JSON_ONLY = '\n\nRespond with ONE valid JSON object only (no markdown, no prose) that matches the requested structure exactly.';

/**
 * Structured output with fallbacks. Throws only if all three paths fail; the
 * caller is expected to have a deterministic fallback (e.g. rule-engine diagnosis).
 */
export async function safeGenerateObject<T>(opts: SafeGenerateOptions<T>): Promise<{ object: T; path: StructuredPath }> {
  const logger = opts.logger ?? silentLogger;
  const common = {
    model: opts.model,
    system: opts.system,
    temperature: opts.temperature,
    providerOptions: opts.providerOptions,
    maxOutputTokens: opts.maxOutputTokens,
  };
  const signal = () => AbortSignal.timeout(opts.timeoutMs ?? 90_000);
  const errors: string[] = [];

  try {
    const r = await generateText({ ...common, prompt: opts.prompt, output: Output.object({ schema: opts.schema, name: opts.schemaName }), abortSignal: signal() });
    const parsed = opts.schema.safeParse(r.output);
    if (parsed.success) {
      logger.info({ path: 'structured' }, 'structured output');
      return { object: parsed.data, path: 'structured' };
    }
    errors.push(`structured: ${parsed.error.issues[0]?.message}`);
  } catch (err) {
    errors.push(`structured: ${(err as Error).message.slice(0, 160)}`);
  }

  try {
    const r = await generateText({ ...common, prompt: opts.prompt + JSON_ONLY, output: Output.json(), abortSignal: signal() });
    const parsed = opts.schema.safeParse(r.output);
    if (parsed.success) {
      logger.warn({ path: 'json', errors }, 'structured output fell back to JSON mode');
      return { object: parsed.data, path: 'json' };
    }
    errors.push(`json: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  } catch (err) {
    errors.push(`json: ${(err as Error).message.slice(0, 160)}`);
  }

  const r = await generateText({ ...common, prompt: opts.prompt + JSON_ONLY, abortSignal: signal() });
  const block = extractFirstJsonObject(r.text);
  if (!block) throw new Error(`no JSON object in model output (${errors.join(' | ')})`);
  const parsed = opts.schema.safeParse(JSON.parse(block));
  if (!parsed.success) throw new Error(`model JSON failed validation: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  logger.warn({ path: 'text', errors }, 'structured output fell back to free-text JSON');
  return { object: parsed.data, path: 'text' };
}
