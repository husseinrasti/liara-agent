import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../events';
import { fakeAgent, healthyAppRoutes } from '../../test-utils/fake-agent';
import { scriptedTextModel } from '../../test-utils/mock-model';
import { oomPacket, PLANS } from '../../test-utils/packets';
import { getTool, runTool } from '../../tools/registry';
import type { LlmDiagnosis } from '../diagnosis-schema';
import { diagnose, fallbackDiagnosis, postProcess, rankCauses } from '../diagnosis';
import { getMemoryKey } from '../memory';
import { evaluate } from '../playbooks/engine';
import { toolContextFor } from '../runtime';
import { AgentSession } from '../session';
import '../tools';

const llmOom: LlmDiagnosis = {
  summaryFa: 'سایت به‌خاطر پر شدن حافظه بالا و پایین می‌شود.',
  severity: 'critical',
  causes: [
    {
      title_fa: 'پر شدن حافظه (RAM)',
      playbookId: 'oom_kill',
      confidence: 1.4,
      evidence: [
        { source: 'events', text_fa: '۳ بار OOMKilled', raw: 'Container shop was OOM killed' },
        { source: 'logs', text_fa: 'خطای کمبود حافظه در لاگ', raw: 'invented line that is not in the packet' },
      ],
      explanation_fa: 'رم به سقف رسیده و برنامه کشته شده است.',
    },
  ],
  recommendedAction: { tool: 'rollback_release', argsJson: '{}', title_fa: 'برگشت به نسخه‌ی قبلی', why_fa: 'مشکل بعد از انتشار شروع شد' },
  alternatives: [
    { tool: 'restart_app', argsJson: '{"appName":"shop"}', title_fa: 'ری‌استارت', why_fa: 'موقت' },
    { tool: 'format_disk', argsJson: '{"appName":"shop"}', title_fa: 'فرمت کردن دیسک', why_fa: 'ابزار وجود ندارد' },
  ],
  manualStepsFa: [],
  limitationsFa: [],
  followUpQuestionsFa: ['آیا اخیراً ترافیک زیاد شده؟', 'q2', 'q3'],
};

describe('postProcess', () => {
  const packet = oomPacket();
  const evaluation = evaluate(packet, { plans: PLANS });

  it('clamps confidence, keeps only quotes present in the packet, validates actions', () => {
    const d = postProcess(llmOom, packet, evaluation.candidates);
    expect(d.causes[0]!.confidence).toBe(1);
    expect(d.causes[0]!.evidence[0]!.raw).toBe('Container shop was OOM killed');
    expect(d.causes[0]!.evidence[1]!.raw).toBeUndefined();
    expect(d.recommendedAction).toMatchObject({ tool: 'rollback_release', args: { appName: 'shop' }, risk: 1, reversible: true });
    expect(d.alternatives.map((a) => a.tool)).toEqual(['restart_app']);
    expect(d.manualStepsFa).toContain('فرمت کردن دیسک');
    expect(d.followUpQuestionsFa).toHaveLength(2);
    expect(d.limitationsFa[0]).toContain('لاگ دسترسی');
  });

  it('replaces raw English state words in Persian text but keeps exact quotes', () => {
    const raw = { ...llmOom, summaryFa: 'بعد از rollback به نسخه‌ی READY قبلی، health check سالم بود.' };
    const d = postProcess(raw, packet, evaluation.candidates);
    expect(d.summaryFa).toBe('بعد از برگشت به نسخه‌ی قبلی به نسخه‌ی آماده قبلی، بررسی سلامت سالم بود.');
    expect(d.causes[0]!.evidence[0]!.raw).toBe('Container shop was OOM killed');
  });

  it('ranks causes by confidence, a specific mechanism above "after the last deploy" at a near tie', () => {
    const ids = (cs: { playbookId?: string }[]) => cs.map((c) => c.playbookId);
    expect(ids(rankCauses([{ playbookId: 'recent_deploy_regression', confidence: 0.95 }, { playbookId: 'oom_kill', confidence: 0.99 }]))).toEqual(['oom_kill', 'recent_deploy_regression']);
    expect(ids(rankCauses([{ playbookId: 'recent_deploy_regression', confidence: 0.96 }, { playbookId: 'crash_loop', confidence: 0.93 }]))).toEqual(['crash_loop', 'recent_deploy_regression']);
    expect(ids(rankCauses([{ playbookId: 'recent_deploy_regression', confidence: 0.9 }, { playbookId: 'crash_loop', confidence: 0.6 }]))).toEqual(['recent_deploy_regression', 'crash_loop']);
  });

  it('drops a contradictory "healthy" cause when a real problem has evidence', () => {
    const cause = (playbookId: string, confidence: number) => ({ ...llmOom.causes[0]!, playbookId, confidence });
    const d = postProcess({ ...llmOom, severity: 'healthy', causes: [cause('healthy', 0.98), cause('build_failed', 1)] }, packet, evaluation.candidates);
    expect(d.causes.map((c) => c.playbookId)[0]).toBe('build_failed');
    expect(d.causes.some((c) => c.playbookId === 'healthy')).toBe(false);
    expect(d.severity).toBe('warning');
  });

  it('adds a strong rule candidate the LLM missed', () => {
    const missed = { ...llmOom, causes: [{ ...llmOom.causes[0]!, playbookId: 'crash_loop', title_fa: 'کرش' }] };
    const d = postProcess(missed, packet, evaluation.candidates);
    expect(d.causes.map((c) => c.playbookId)).toEqual(['crash_loop', 'oom_kill']);
  });
});

describe('diagnose', () => {
  const packet = oomPacket();
  const evaluation = evaluate(packet, { plans: PLANS });

  it('uses the LLM when it returns a valid diagnosis', async () => {
    const res = await diagnose(packet, evaluation, { model: scriptedTextModel([JSON.stringify(llmOom)]) });
    expect(res.source).toBe('llm');
    expect(res.diagnosis.causes[0]!.playbookId).toBe('oom_kill');
  });

  it('falls back to the rule engine when the LLM fails', async () => {
    const res = await diagnose(packet, evaluation, { model: scriptedTextModel([new Error('503'), new Error('503'), new Error('503')]) });
    expect(res.source).toBe('rules');
    expect(res.diagnosis).toMatchObject({ severity: 'critical', recommendedAction: { tool: 'rollback_release' } });
    expect(res.diagnosis.causes[0]!.evidence.length).toBeGreaterThan(0);
    expect(res.diagnosis.limitationsFa.join(' ')).toContain('قواعد');
  });

  it('fallback for a healthy app says so', () => {
    const p = oomPacket();
    p.health = { status: 200, ok: true, latencyMs: 100, sampledAt: 'x' };
    const d = fallbackDiagnosis(p, { signals: [], candidates: [] });
    expect(d.severity).toBe('healthy');
  });
});

describe('diagnose_app tool', () => {
  it('collects evidence, emits a Diagnosis Card and remembers the result', async () => {
    const routes = {
      ...healthyAppRoutes(),
      'GET /v1/projects/shop/events': {
        body: { data: [{ metaData: {}, values: [[`${Date.parse('2026-10-22T11:50:00Z')}000000`, JSON.stringify({ reason: 'OOMKilled', message: 'Container shop was OOM killed', type: 'Warning' })]] }] },
      },
    };
    const { rt } = fakeAgent({ routes, smart: scriptedTextModel([JSON.stringify(llmOom)]), httpStatus: 502 });
    const session = AgentSession.create(rt, { appName: 'shop' });
    const events: AgentEvent[] = [];
    rt.bus.subscribe(session.id, (e) => events.push(e));
    const res = await runTool(getTool('diagnose_app')!, { appName: 'shop' }, toolContextFor(rt, session));
    expect(res.ok).toBe(true);
    const card = events.find((e) => e.type === 'diagnosis') as Extract<AgentEvent, { type: 'diagnosis' }> | undefined;
    expect(card).toMatchObject({ appName: 'shop', source: 'llm' });
    expect(card!.diagnosis.causes[0]!.title_fa).toContain('حافظه');
    expect(getMemoryKey(rt.deps.db, 'shop', 'lastDiagnosis')).toMatchObject({ severity: 'critical', recommendedTool: 'rollback_release' });
  });
});
