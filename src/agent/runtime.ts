/**
 * AgentRuntime: everything a turn needs (Liara client, DB, models, event bus,
 * clock). Created once per process; tests inject fakes and scripted models.
 */
import type { LanguageModel } from 'ai';
import { createRuntime, createToolContext, type RuntimeDeps, type ToolContext } from '../tools';
import { EventBus } from './bus';
import { createModel, type ModelTier } from './providers';

export interface AgentRuntime {
  deps: RuntimeDeps;
  bus: EventBus;
  model(tier: ModelTier): LanguageModel;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Acceptance scripts only: risk ≥ 1 tools run without an approval card. */
  autoApprove: boolean;
  /** Schedules a background follow-up (verify re-checks, domain polls). Tests replace it. */
  schedule(fn: () => Promise<void> | void, ms: number): void;
  /** fetch for public HTTP probes (tests stub it). */
  httpFetch?: typeof fetch;
}

export interface AgentRuntimeOptions {
  deps?: RuntimeDeps;
  models?: Partial<Record<ModelTier, LanguageModel>>;
  autoApprove?: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  schedule?: AgentRuntime['schedule'];
  httpFetch?: typeof fetch;
  bus?: EventBus;
}

export function createAgentRuntime(opts: AgentRuntimeOptions = {}): AgentRuntime {
  const deps = opts.deps ?? createRuntime();
  const models = new Map<ModelTier, LanguageModel>(Object.entries(opts.models ?? {}) as [ModelTier, LanguageModel][]);
  return {
    deps,
    bus: opts.bus ?? new EventBus(),
    model(tier) {
      let m = models.get(tier);
      if (!m) {
        m = createModel(tier, deps.config);
        models.set(tier, m);
      }
      return m;
    },
    now: opts.now ?? (() => new Date()),
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    autoApprove: opts.autoApprove ?? deps.config.autoApprove,
    schedule:
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(() => void Promise.resolve(fn()).catch((err) => deps.logger.warn({ err: (err as Error).message }, 'scheduled task failed')), ms);
        t.unref?.();
      }),
    httpFetch: opts.httpFetch,
  };
}

/** Tool context bound to a session's event stream and the runtime's clock/models. */
export function toolContextFor(rt: AgentRuntime, session?: { id: string; appName?: string; emit: ToolContext['emit'] }): ToolContext {
  return createToolContext(rt.deps, {
    now: rt.now,
    sleep: rt.sleep,
    sessionId: session?.id,
    appName: session?.appName,
    emit: session?.emit,
    httpFetch: rt.httpFetch,
    llm: (tier) => rt.model(tier),
    agent: rt,
  });
}
