/** Registers the agent-level tools (they need the LLM, memory or the deploy wizard) into the shared registry. */
import '../../tools';
import { registerTools, type ToolDef } from '../../tools/registry';
import { diagnoseAppTool } from './diagnose';
import { memoryTools } from './memory-tools';

export const AGENT_TOOLS: ToolDef[] = [diagnoseAppTool, ...memoryTools];

registerTools(AGENT_TOOLS);
