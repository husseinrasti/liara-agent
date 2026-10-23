import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppConfig } from '../../config';
import { scriptedTextModel } from '../../test-utils/mock-model';
import { createModel, DEFAULT_MODELS, extractFirstJsonObject, llmHealthCheck, modelId, safeGenerateObject } from '../providers';

const schema = z.object({ city: z.string(), confidence: z.number().min(0).max(1) });

function cfg(llm: Partial<AppConfig['llm']>): AppConfig {
  return { llm: { provider: 'openai', ...llm } } as AppConfig;
}

describe('provider switch', () => {
  it('uses configured model ids, else provider defaults', () => {
    expect(modelId('fast', cfg({ fastModel: 'gpt-5.4-mini' }))).toBe('gpt-5.4-mini');
    expect(modelId('smart', cfg({ provider: 'gemini' }))).toBe(DEFAULT_MODELS.gemini.smart);
  });

  it('fails fast with a readable message when the key is missing', () => {
    expect(() => createModel('fast', cfg({ provider: 'openrouter' }))).toThrow(/OPENROUTER_API_KEY/);
    expect(createModel('fast', cfg({ openaiApiKey: 'sk-test' }))).toBeTruthy();
  });
});

describe('extractFirstJsonObject', () => {
  it('finds a balanced object inside prose and code fences', () => {
    expect(extractFirstJsonObject('Here:\n```json\n{"a":{"b":"}"},"c":1}\n```\nthanks')).toBe('{"a":{"b":"}"},"c":1}');
    expect(extractFirstJsonObject('no json')).toBeNull();
  });
});

describe('safeGenerateObject', () => {
  it('returns the structured path when the model complies', async () => {
    const res = await safeGenerateObject({ model: scriptedTextModel(['{"city":"Tehran","confidence":0.9}']), schema, prompt: 'x' });
    expect(res).toEqual({ object: { city: 'Tehran', confidence: 0.9 }, path: 'structured' });
  });

  it('falls back to free text and extracts the JSON block', async () => {
    const model = scriptedTextModel([new Error('schema not supported'), new Error('json mode not supported'), 'Sure! {"city":"Tabriz","confidence":0.5} hope it helps']);
    const res = await safeGenerateObject({ model, schema, prompt: 'x' });
    expect(res.path).toBe('text');
    expect(res.object.city).toBe('Tabriz');
  });

  it('throws when nothing validates', async () => {
    const model = scriptedTextModel(['{"city":1}', '{"city":1}', 'still {"city":1}']);
    await expect(safeGenerateObject({ model, schema, prompt: 'x' })).rejects.toThrow(/validation/);
  });
});

describe('llmHealthCheck', () => {
  it('reports ok and failures without throwing', async () => {
    const c = cfg({ fastModel: 'm' });
    expect((await llmHealthCheck(scriptedTextModel(['ok']), c)).ok).toBe(true);
    const bad = await llmHealthCheck(scriptedTextModel([new Error('401 unauthorized')]), c);
    expect(bad).toMatchObject({ ok: false, provider: 'openai', model: 'm' });
    expect(bad.error).toMatch(/401/);
  });
});
