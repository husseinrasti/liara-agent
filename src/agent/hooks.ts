/** Agent reactions after a mutating tool succeeded (kept out of the shared tool layer). */
import type { ToolResult } from '../tools/registry';
import { IRNIC_LIMITATION_FA, trackDomain } from './domain/flow';
import { invalidateAppContext } from './prompts/context';
import type { AgentRuntime } from './runtime';
import type { AgentSession } from './session';

export function afterAction(rt: AgentRuntime, session: AgentSession, tool: string, input: unknown, result: ToolResult<unknown>): void {
  if (!result.ok) return;
  const appName = (input as { appName?: string })?.appName;
  invalidateAppContext(appName);
  if (tool === 'add_domain' && appName) {
    const d = result.data as { id?: string; name?: string };
    if (d.id && d.name) trackDomain(rt.deps.db, appName, { domainId: d.id, name: d.name }, rt.now());
    session.emit({ type: 'limitation', message: IRNIC_LIMITATION_FA });
  }
}
