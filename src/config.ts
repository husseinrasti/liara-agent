import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** Repo root, resolved from this file so scripts/MCP work from any cwd. */
export const ROOT_DIR = resolveRootDir();

function resolveRootDir(): string {
  if (process.env.LIARA_AGENT_ROOT) return path.resolve(process.env.LIARA_AGENT_ROOT);
  try {
    if (import.meta.url.startsWith('file:')) {
      const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
  } catch {
    // bundled environments may not expose a file URL; fall back to cwd
  }
  return process.cwd();
}

let envLoaded = false;

/** Loads `.env` from the repo root once. Existing process env always wins. */
export function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.NEXT_RUNTIME) return; // Next.js loads .env itself
  const file = path.join(ROOT_DIR, '.env');
  if (existsSync(file)) loadDotenv({ path: file, quiet: true });
}

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().trim().optional());
const bool = (fallback: boolean) =>
  z.preprocess(blankToUndefined, z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional()).transform((v) =>
    v === undefined ? fallback : v === 'true' || v === '1' || v === 'yes',
  );

const EnvSchema = z.object({
  LIARA_API_TOKEN: optionalString,
  LIARA_TEAM_ID: optionalString,
  LIARA_API_BASE_URL: z.preprocess(blankToUndefined, z.url().default('https://api.liara.ir')),
  DEMO_APP_NAME: optionalString,
  LLM_PROVIDER: z.preprocess(blankToUndefined, z.enum(['openai', 'gemini', 'openrouter']).default('gemini')),
  LLM_FAST_MODEL: optionalString,
  LLM_SMART_MODEL: optionalString,
  OPENAI_API_KEY: optionalString,
  GOOGLE_GENERATIVE_AI_API_KEY: optionalString,
  OPENROUTER_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalString,
  DATABASE_PATH: z.preprocess(blankToUndefined, z.string().default('./data/agent.db')),
  WATCHER_ENABLED: bool(true),
  WATCHER_INTERVAL_SEC: z.preprocess(blankToUndefined, z.coerce.number().int().min(10).default(60)),
  APP_PUBLIC_URL_SUFFIX: z.preprocess(blankToUndefined, z.string().default('.liara.run')),
  AUTO_APPROVE: bool(false),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
});

export type LlmProvider = 'openai' | 'gemini' | 'openrouter';

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  liara: {
    token: string;
    teamId?: string;
    baseUrl: string;
    demoAppName?: string;
    publicUrlSuffix: string;
  };
  llm: {
    provider: LlmProvider;
    fastModel?: string;
    smartModel?: string;
    openaiApiKey?: string;
    googleApiKey?: string;
    openrouterApiKey?: string;
    openaiBaseUrl?: string;
  };
  databasePath: string;
  watcher: { enabled: boolean; intervalSec: number };
  autoApprove: boolean;
  logLevel: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const MISSING_TOKEN_MESSAGE = [
  'LIARA_API_TOKEN is missing. Copy .env.example to .env and set your Liara API token',
  '(Liara console → profile → API).',
  'توکن API لیارا تنظیم نشده است. فایل .env را از روی .env.example بسازید و مقدار LIARA_API_TOKEN را وارد کنید.',
].join('\n');

let cached: AppConfig | undefined;

/**
 * Validated configuration. Throws ConfigError with a readable (English + Persian)
 * message when something is wrong. Never includes secret values in messages.
 */
export function getConfig(): AppConfig {
  if (cached) return cached;
  loadEnvFile();
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new ConfigError(`Invalid environment variables: ${keys.join(', ')}. Check .env against .env.example.`);
  }
  const env = parsed.data;
  if (!env.LIARA_API_TOKEN) throw new ConfigError(MISSING_TOKEN_MESSAGE);
  const dataDir = path.join(ROOT_DIR, 'data');
  cached = {
    rootDir: ROOT_DIR,
    dataDir,
    liara: {
      token: env.LIARA_API_TOKEN,
      teamId: env.LIARA_TEAM_ID,
      baseUrl: env.LIARA_API_BASE_URL.replace(/\/+$/, ''),
      demoAppName: env.DEMO_APP_NAME,
      publicUrlSuffix: env.APP_PUBLIC_URL_SUFFIX,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      fastModel: env.LLM_FAST_MODEL,
      smartModel: env.LLM_SMART_MODEL,
      openaiApiKey: env.OPENAI_API_KEY,
      googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      openrouterApiKey: env.OPENROUTER_API_KEY,
      openaiBaseUrl: env.OPENAI_BASE_URL,
    },
    databasePath: path.resolve(ROOT_DIR, env.DATABASE_PATH),
    watcher: { enabled: env.WATCHER_ENABLED, intervalSec: env.WATCHER_INTERVAL_SEC },
    autoApprove: env.AUTO_APPROVE,
    logLevel: env.LOG_LEVEL,
  };
  return cached;
}

/** For tests: drop the cached config so env changes are picked up. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Public URL of a Liara app on its default subdomain. */
export function appUrl(appName: string, suffix = cached?.liara.publicUrlSuffix ?? '.liara.run'): string {
  return `https://${appName}${suffix}`;
}
