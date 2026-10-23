/** Zod schema for incident playbooks (src/agent/playbooks/*.yaml). Playbooks are data, not code. */
import { z } from 'zod';

export const CATEGORIES = ['resources', 'crash', 'build', 'config', 'network', 'domain', 'account', 'performance'] as const;
export const OPS = ['<', '<=', '>', '>=', '==', '!='] as const;

const weight = z.number().min(0).max(1);

export const SignalRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event_reason'), match: z.string(), weight }),
  z.object({ kind: z.literal('applet_reason'), match: z.string(), weight }),
  z.object({ kind: z.literal('log_regex'), match: z.string(), weight, extract: z.string().optional() }),
  z.object({ kind: z.literal('build_log_regex'), match: z.string(), weight }),
  z.object({ kind: z.literal('metric'), field: z.string(), op: z.enum(OPS), value: z.number(), weight }),
  z.object({ kind: z.literal('health'), status_in: z.array(z.number()).optional(), latency_over_ms: z.number().optional(), weight }),
  z.object({ kind: z.literal('release_state'), match: z.string(), weight }),
  z.object({
    kind: z.literal('expr'),
    when: z.string(),
    detail: z.string(),
    weight,
    source: z.enum(['events', 'logs', 'metrics', 'applets', 'health', 'release', 'account', 'domain']).default('release'),
  }),
]);
export type SignalRule = z.infer<typeof SignalRuleSchema>;

export const FixSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args_template: z.record(z.string(), z.unknown()).default({}),
  when: z.string().optional(),
  title_fa: z.string(),
  why_fa: z.string(),
  priority: z.number().int().min(1),
});
export type Fix = z.infer<typeof FixSchema>;

export const VerifyCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no_event'), match: z.string(), withinMinutes: z.number().default(5) }),
  z.object({ kind: z.literal('health'), status: z.number().default(200) }),
  z.object({ kind: z.literal('metric'), field: z.string(), op: z.enum(OPS), value: z.number() }),
  z.object({ kind: z.literal('no_log'), match: z.string(), withinMinutes: z.number().default(5) }),
  z.object({ kind: z.literal('release_ready') }),
  z.object({ kind: z.literal('domain_verified') }),
]);
export type VerifyCheck = z.infer<typeof VerifyCheckSchema>;

export const PlaybookSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title_fa: z.string(),
  category: z.enum(CATEGORIES),
  signals: z.array(SignalRuleSchema).default([]),
  causes_fa: z.array(z.string()).min(1),
  checks_fa: z.array(z.string()).default([]),
  fixes: z.array(FixSchema).default([]),
  manual_steps_fa: z.array(z.string()).default([]),
  verify: z.array(VerifyCheckSchema).default([]),
  advice_fa: z.string().optional(),
  /** Minimum score for this playbook to be considered a candidate. */
  threshold: z.number().min(0).max(1).default(0.3),
});
export type Playbook = z.infer<typeof PlaybookSchema>;
