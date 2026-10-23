import { llmHealthCheck, type LlmHealth } from '@/src/agent/providers';
import { getAgentRuntime } from '@/src/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let llmCache: { at: number; value: LlmHealth } | null = null;

/** GET → {liara, llm, provider, watcher, mode}. The LLM probe is cached for a minute. */
export async function GET() {
  const server = getAgentRuntime();
  const { rt } = server;
  const started = Date.now();
  const liara = await rt.deps.liara
    .requestRaw({ path: '/v1/me', retries: 0, timeoutMs: 10_000 })
    .then((r) => ({ ok: r.ok, status: r.status, latencyMs: Date.now() - started }))
    .catch((err: Error) => ({ ok: false, status: 0, latencyMs: Date.now() - started, error: err.message.slice(0, 120) }));
  if (!llmCache || Date.now() - llmCache.at > 60_000 || !llmCache.value.ok) {
    let value: LlmHealth;
    try {
      value = await llmHealthCheck(rt.model('fast'), rt.deps.config);
    } catch (err) {
      value = { ok: false, provider: rt.deps.config.llm.provider, model: '', latencyMs: 0, error: (err as Error).message.slice(0, 160) };
    }
    llmCache = { at: Date.now(), value };
  }
  return Response.json({
    ok: liara.ok && llmCache.value.ok,
    mode: server.mode,
    liara,
    llm: llmCache.value,
    provider: rt.deps.config.llm.provider,
    watcher: Boolean(server.watcher),
    demoAppName: server.demoAppName ?? null,
  });
}
