/**
 * Structured diagnosis: evidence packet + rule-engine candidates → smart model
 * (strict-friendly schema) → post-processing that only lets through evidence and
 * actions we can check. Falls back to a rule-only diagnosis when the LLM fails.
 */
import type { LanguageModel } from 'ai';
import type { AppConfig } from '../config';
import { silentLogger, type Logger } from '../logger';
import { getTool } from '../tools/registry';
import { DiagnosisSchema, LlmDiagnosisSchema, type Diagnosis, type DiagnosisAction, type LlmDiagnosis } from './diagnosis-schema';
import type { EvidencePacket } from './evidence/packet';
import type { AppMemory } from './memory';
import type { Candidate, Evaluation } from './playbooks/engine';
import { DIAGNOSIS_SYSTEM, diagnosisUserPrompt } from './prompts/diagnosis';
import { callSettings, safeGenerateObject, type StructuredPath } from './providers';

export const NO_ACCESS_LOGS_FA = 'لاگ دسترسی HTTP در API لیارا وجود ندارد؛ وضعیت سایت را با درخواست مستقیم به آدرس آن سنجیدیم.';
const RULES_ONLY_FA = 'این تشخیص با قواعد از پیش تعریف‌شده ساخته شد، چون سرویس هوش مصنوعی در دسترس نبود.';
const IRREVERSIBLE = new Set(['delete_app', 'resize_disk']);

export interface DiagnoseResult {
  diagnosis: Diagnosis;
  source: 'llm' | 'rules';
  path?: StructuredPath;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Turns a proposed tool call into a validated action, or null if the tool/args are not usable. */
export function validateAction(tool: string, args: unknown, title_fa: string, why_fa: string, appName?: string): DiagnosisAction | null {
  const def = getTool(tool);
  if (!def) return null;
  const withApp: Record<string, unknown> = args && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {};
  const shape = (def.input as unknown as { shape?: Record<string, unknown> }).shape;
  if (appName && shape && 'appName' in shape && !withApp.appName) withApp.appName = appName;
  const parsed = def.input.safeParse(withApp);
  if (!parsed.success) return null;
  return { tool, args: withApp, title_fa, why_fa, risk: def.risk, reversible: !IRREVERSIBLE.has(tool) };
}

function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Clamps, checks quotes against the packet, validates actions, merges a strong rule candidate the LLM missed. */
export function postProcess(llm: LlmDiagnosis, packet: EvidencePacket, candidates: Candidate[], logger: Logger = silentLogger): Diagnosis {
  const haystack = norm(JSON.stringify(packet));
  const appName = packet.app?.name;
  const manual = [...llm.manualStepsFa];
  const causes = llm.causes
    .map((c) => ({
      title_fa: c.title_fa,
      ...(c.playbookId ? { playbookId: c.playbookId } : {}),
      confidence: Math.max(0, Math.min(1, Number.isFinite(c.confidence) ? c.confidence : 0)),
      evidence: c.evidence
        .filter((e) => e.text_fa.trim())
        .map((e) => {
          const quote = e.raw ? norm(e.raw) : '';
          const verified = quote && haystack.includes(norm(JSON.stringify(quote)).slice(1, 61));
          return { source: e.source, text_fa: e.text_fa, ...(verified ? { raw: e.raw! } : {}) };
        }),
      explanation_fa: c.explanation_fa,
    }))
    .filter((c) => c.evidence.length > 0)
    .slice(0, 4);

  const top = candidates[0];
  if (top && top.score >= 0.8 && top.playbookId !== 'healthy' && !causes.some((c) => c.playbookId === top.playbookId) && causes.length < 4) {
    logger.info({ playbookId: top.playbookId, score: top.score }, 'diagnosis: added strong rule candidate missing from LLM output');
    causes.push(causeFromCandidate(top));
  }
  if (!causes.length) throw new Error('LLM diagnosis had no causes with evidence');

  const toAction = (a: LlmDiagnosis['recommendedAction']) => {
    if (!a) return null;
    const action = validateAction(a.tool, parseArgs(a.argsJson), a.title_fa, a.why_fa, appName);
    if (!action) manual.push(a.title_fa);
    return action;
  };
  const recommendedAction = toAction(llm.recommendedAction);
  const alternatives = llm.alternatives.map(toAction).filter((a): a is DiagnosisAction => Boolean(a)).slice(0, 3);
  const limitations = llm.limitationsFa.length ? llm.limitationsFa : [NO_ACCESS_LOGS_FA];

  return DiagnosisSchema.parse({
    summaryFa: llm.summaryFa,
    severity: llm.severity,
    causes,
    recommendedAction,
    alternatives,
    manualStepsFa: [...new Set(manual)].slice(0, 5),
    limitationsFa: limitations.slice(0, 4),
    followUpQuestionsFa: llm.followUpQuestionsFa.slice(0, 2),
  });
}

function causeFromCandidate(c: Candidate): Diagnosis['causes'][number] {
  const evidence = c.matchedSignals.slice(0, 4).map((s) => ({ source: s.source, text_fa: s.detail }));
  return {
    title_fa: c.title_fa,
    playbookId: c.playbookId,
    confidence: c.score,
    evidence: evidence.length ? evidence : [{ source: 'health' as const, text_fa: 'نشانه‌ی خرابی دیده نشد' }],
    explanation_fa: c.causes_fa[0] ?? c.title_fa,
  };
}

function fixToAction(f: Candidate['fixes'][number]): DiagnosisAction {
  return { tool: f.tool, args: f.args, title_fa: f.title_fa, why_fa: f.why_fa, risk: f.risk, reversible: !IRREVERSIBLE.has(f.tool) };
}

/** Deterministic diagnosis straight from rule-engine candidates (Persian template text). */
export function fallbackDiagnosis(packet: EvidencePacket, evaluation: Evaluation, reasonFa = RULES_ONLY_FA): Diagnosis {
  const candidates = evaluation.candidates;
  const top = candidates[0];
  const healthy = !top || top.playbookId === 'healthy';
  const down = packet.health ? !packet.health.ok : false;
  const severity: Diagnosis['severity'] = healthy && !down ? 'healthy' : down ? 'critical' : (top?.score ?? 0) >= 0.6 ? 'degraded' : 'warning';
  const healthFa = packet.health ? (packet.health.status ? `پاسخ سایت ${packet.health.status}` : 'سایت پاسخ نمی‌دهد') : '';
  const fixes = top?.fixes ?? [];
  const others = candidates.slice(1).flatMap((c) => c.fixes.slice(0, 1));
  const causes = candidates.length ? candidates.slice(0, 4).map(causeFromCandidate) : [{ title_fa: 'علت مشخصی پیدا نشد', confidence: 0.2, evidence: [{ source: 'health' as const, text_fa: healthFa || 'داده‌ی کافی در دسترس نبود' }], explanation_fa: 'شواهد جمع‌شده با هیچ‌کدام از الگوهای شناخته‌شده جور نبود.' }];
  return DiagnosisSchema.parse({
    summaryFa: healthy && !down ? 'سرویس سالم به نظر می‌رسد و نشانه‌ی خرابی دیده نشد.' : `${top?.title_fa ?? 'مشکل نامشخص'}${healthFa ? ` (${healthFa})` : ''}.`,
    severity,
    causes,
    recommendedAction: fixes[0] ? fixToAction(fixes[0]) : null,
    alternatives: [...fixes.slice(1), ...others].slice(0, 3).map(fixToAction),
    manualStepsFa: [...(top?.manualStepsFa ?? []), ...(top?.advice_fa ? [top.advice_fa] : [])].slice(0, 5),
    limitationsFa: [NO_ACCESS_LOGS_FA, reasonFa],
    followUpQuestionsFa: [],
  });
}

export interface DiagnoseOptions {
  model?: LanguageModel;
  config?: AppConfig;
  logger?: Logger;
  memory?: Partial<AppMemory>;
}

export async function diagnose(packet: EvidencePacket, evaluation: Evaluation, opts: DiagnoseOptions = {}): Promise<DiagnoseResult> {
  const logger = opts.logger ?? silentLogger;
  if (!opts.model) return { diagnosis: fallbackDiagnosis(packet, evaluation), source: 'rules' };
  try {
    const { object, path } = await safeGenerateObject({
      model: opts.model,
      schema: LlmDiagnosisSchema,
      schemaName: 'diagnosis',
      system: DIAGNOSIS_SYSTEM,
      prompt: diagnosisUserPrompt(packet, evaluation.candidates, opts.memory),
      timeoutMs: 120_000,
      logger,
      ...(opts.config ? callSettings('smart', opts.config) : {}),
    });
    return { diagnosis: postProcess(object, packet, evaluation.candidates, logger), source: 'llm', path };
  } catch (err) {
    logger.warn({ err: (err as Error).message.slice(0, 200) }, 'LLM diagnosis failed; using rule-engine fallback');
    return { diagnosis: fallbackDiagnosis(packet, evaluation), source: 'rules' };
  }
}
