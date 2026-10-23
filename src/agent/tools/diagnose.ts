/** diagnose_app: collect evidence → rule engine → structured diagnosis → Diagnosis Card. */
import { z } from 'zod';
import { sourcesFor } from '../../db/repo';
import { getPlans } from '../../liara/endpoints/account';
import { collectEvidence } from '../../tools/composite/collect-evidence';
import { appNameSchema, ok } from '../../tools/helpers';
import { defineTool } from '../../tools/registry';
import { diagnose } from '../diagnosis';
import { getMemory, setMemoryKey } from '../memory';
import { evaluate } from '../playbooks/engine';
import type { AgentRuntime } from '../runtime';

export const diagnoseAppTool = defineTool({
  name: 'diagnose_app',
  title: 'Diagnose app',
  description:
    'Investigate a problem with an app (slow, HTTP 500, down, crashing, failed deploy) or confirm it is healthy: collects all evidence, matches incident playbooks and returns a structured diagnosis with ranked causes, cited evidence and one recommended action. Call this first for any "something is wrong" request.',
  input: z.object({ appName: appNameSchema, windowMinutes: z.number().int().min(10).max(1440).default(60) }),
  risk: 0,
  category: 'composite',
  describeFa: ({ appName }) => `بررسی و عیب‌یابی سرویس ${appName}`,
  run: async ({ appName, windowMinutes }, ctx) => {
    const packet = await collectEvidence(ctx, appName, windowMinutes);
    const plans = await getPlans(ctx.liara).catch(() => []);
    const evaluation = evaluate(packet, { plans, latestSourceID: sourcesFor(ctx.db, appName)[0]?.sourceID ?? null });
    packet.signals = evaluation.signals;
    const memory = getMemory(ctx.db, appName);
    const config = (ctx.agent as AgentRuntime | undefined)?.deps.config;
    const { diagnosis, source } = await diagnose(packet, evaluation, { model: ctx.llm?.('smart'), config, logger: ctx.logger, memory });
    ctx.emit?.({ type: 'diagnosis', appName, source, diagnosis });
    const top = diagnosis.causes[0];
    setMemoryKey(
      ctx.db,
      appName,
      'lastDiagnosis',
      {
        ts: ctx.now().toISOString(),
        summaryFa: diagnosis.summaryFa,
        severity: diagnosis.severity,
        ...(top ? { topCause: { title_fa: top.title_fa, playbookId: top.playbookId, confidence: top.confidence } } : {}),
        ...(diagnosis.recommendedAction ? { recommendedTool: diagnosis.recommendedAction.tool } : {}),
      },
      ctx.now(),
    );
    return ok({ diagnosis, source, rulesTop: evaluation.candidates.slice(0, 3).map((c) => ({ playbookId: c.playbookId, score: c.score })) }, diagnosis.summaryFa);
  },
});
