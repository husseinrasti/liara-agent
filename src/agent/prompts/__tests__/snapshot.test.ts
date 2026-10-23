import { describe, expect, it } from 'vitest';
import { fakeAgent, healthyAppRoutes } from '../../../test-utils/fake-agent';
import '../../../tools';
import { setMemoryKey } from '../../memory';
import { AgentSession } from '../../session';
import { buildSystemPrompt, estimatePromptTokens, STATIC_LAYERS } from '..';
import { confidenceWordFa } from '../format';
import { LIARA_KNOWLEDGE_FA } from '../liara-knowledge';

describe('system prompt', () => {
  it('renders all layers with live context and stays within 3500 tokens', async () => {
    const { rt } = fakeAgent({ routes: healthyAppRoutes() });
    const session = AgentSession.create(rt, { appName: 'shop' });
    setMemoryKey(rt.deps.db, 'shop', 'userNotes', ['این اپ شب‌ها ترافیک بالا دارد']);
    setMemoryKey(rt.deps.db, 'shop', 'lastDiagnosis', { ts: new Date().toISOString(), summaryFa: 'رم پر شده بود', severity: 'degraded', topCause: { title_fa: 'پر شدن حافظه', playbookId: 'oom_kill', confidence: 0.8 } });
    const prompt = await buildSystemPrompt(rt, session);
    for (const layer of STATIC_LAYERS) expect(prompt).toContain(layer);
    expect(prompt).toContain('سرویس انتخاب‌شده: shop');
    expect(prompt).toContain('ترافیک بالا');
    expect(prompt).toContain('زمان فعلی (تهران)');
    expect(estimatePromptTokens(prompt)).toBeLessThanOrEqual(3500);
  });

  it('keeps the knowledge layer within 1200 tokens', () => {
    expect(estimatePromptTokens(LIARA_KNOWLEDGE_FA)).toBeLessThanOrEqual(1200);
  });

  it('maps confidence to words', () => {
    expect(confidenceWordFa(0.85)).toBe('خیلی محتمل');
    expect(confidenceWordFa(0.5)).toBe('محتمل');
    expect(confidenceWordFa(0.2)).toBe('کم‌احتمال');
  });
});
