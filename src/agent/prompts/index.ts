/** Assembles the layered system prompt for a turn. */
import type { AgentRuntime } from '../runtime';
import type { AgentSession } from '../session';
import { buildContextFa } from './context';
import { FORMAT_FA } from './format';
import { LIARA_KNOWLEDGE_FA } from './liara-knowledge';
import { POLICY_FA, WORKFLOWS_FA } from './policy';
import { ROLE_FA } from './role';

export const STATIC_LAYERS = [ROLE_FA, POLICY_FA, WORKFLOWS_FA, LIARA_KNOWLEDGE_FA, FORMAT_FA];

export function assembleSystemPrompt(contextFa: string): string {
  return [...STATIC_LAYERS, contextFa].join('\n\n');
}

export async function buildSystemPrompt(rt: AgentRuntime, session: AgentSession): Promise<string> {
  return assembleSystemPrompt(await buildContextFa(rt, session));
}

/** Token estimate used for budgets (chars / 3.5). */
export const estimatePromptTokens = (text: string) => Math.ceil(text.length / 3.5);
