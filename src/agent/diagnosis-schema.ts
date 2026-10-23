/** Diagnosis shapes (pure Zod; shared by the agent, events and the UI). */
import { z } from 'zod';

export const EVIDENCE_SOURCES = ['events', 'logs', 'metrics', 'applets', 'health', 'release', 'account', 'domain'] as const;
export const EvidenceSourceSchema = z.enum(EVIDENCE_SOURCES);
export const SeveritySchema = z.enum(['critical', 'degraded', 'warning', 'healthy']);

export const ActionSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  title_fa: z.string(),
  why_fa: z.string(),
  risk: z.number().int().min(0).max(2),
  reversible: z.boolean(),
});
export type DiagnosisAction = z.infer<typeof ActionSchema>;

export const DiagnosisSchema = z.object({
  summaryFa: z.string(),
  severity: SeveritySchema,
  causes: z
    .array(
      z.object({
        title_fa: z.string(),
        playbookId: z.string().optional(),
        confidence: z.number().min(0).max(1),
        evidence: z.array(z.object({ source: EvidenceSourceSchema, text_fa: z.string(), raw: z.string().optional() })).min(1),
        explanation_fa: z.string(),
      }),
    )
    .min(1)
    .max(4),
  recommendedAction: ActionSchema.nullable(),
  alternatives: z.array(ActionSchema).max(3),
  manualStepsFa: z.array(z.string()).max(5),
  limitationsFa: z.array(z.string()),
  followUpQuestionsFa: z.array(z.string()).max(2),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

/** What the LLM fills: strict-mode friendly (no optional fields, no records, no bounds). */
const LlmActionSchema = z.object({
  tool: z.string().describe('One tool name from availableActions'),
  argsJson: z.string().describe('JSON object with the tool arguments, e.g. {"appName":"my-shop"}'),
  title_fa: z.string(),
  why_fa: z.string(),
});

export const LlmDiagnosisSchema = z.object({
  summaryFa: z.string().describe('One plain Persian sentence'),
  severity: SeveritySchema,
  causes: z
    .array(
      z.object({
        title_fa: z.string(),
        playbookId: z.string().nullable(),
        confidence: z.number().describe('0..1, justified by the cited evidence'),
        evidence: z.array(z.object({ source: EvidenceSourceSchema, text_fa: z.string(), raw: z.string().nullable().describe('Exact quote from the packet, or null') })),
        explanation_fa: z.string(),
      }),
    )
    .describe('1 to 4 causes, most likely first'),
  recommendedAction: LlmActionSchema.nullable(),
  alternatives: z.array(LlmActionSchema).describe('0 to 3'),
  manualStepsFa: z.array(z.string()).describe('Steps only the user can do; 0 to 5'),
  limitationsFa: z.array(z.string()),
  followUpQuestionsFa: z.array(z.string()).describe('0 to 2'),
});
export type LlmDiagnosis = z.infer<typeof LlmDiagnosisSchema>;
