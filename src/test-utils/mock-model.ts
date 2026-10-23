/** Scripted language models for offline agent tests (AI SDK LanguageModelV4 mocks). */
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export type ScriptedStep = { text?: string; toolCalls?: { name: string; input: unknown }[] };

let callSeq = 0;

function streamParts(step: ScriptedStep) {
  const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
  if (step.text) {
    const id = `t${++callSeq}`;
    parts.push({ type: 'text-start', id });
    for (const chunk of step.text.match(/.{1,12}/gsu) ?? []) parts.push({ type: 'text-delta', id, delta: chunk });
    parts.push({ type: 'text-end', id });
  }
  for (const c of step.toolCalls ?? []) {
    parts.push({ type: 'tool-call', toolCallId: `call_${++callSeq}`, toolName: c.name, input: JSON.stringify(c.input) });
  }
  parts.push({ type: 'finish', usage, finishReason: { unified: step.toolCalls?.length ? 'tool-calls' : 'stop', raw: undefined } });
  return parts;
}

/**
 * A streaming model that plays `steps` in order (one step per model call). Extra
 * calls replay the last step. `calls` records the prompts it received.
 */
export function scriptedStreamModel(steps: ScriptedStep[]) {
  let i = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(i++, steps.length - 1)]!;
      return { stream: convertArrayToReadableStream(streamParts(step) as never[]) };
    },
    doGenerate: async () => {
      const step = steps[Math.min(i++, steps.length - 1)]!;
      return {
        content: [{ type: 'text' as const, text: step.text ?? '' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  return model;
}

/** A non-streaming model that returns the given texts in order (for generateText / structured output). */
export function scriptedTextModel(texts: (string | Error)[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const t = texts[Math.min(i++, texts.length - 1)]!;
      if (t instanceof Error) throw t;
      return { content: [{ type: 'text' as const, text: t }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] };
    },
  });
}
