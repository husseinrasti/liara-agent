import { AgentSession } from '@/src/agent/session';
import { getAgentRuntime } from '@/src/runtime';
import { sseResponse, UUID } from '@/src/server/sse';
import { fa } from '@/app/i18n/fa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET ?sessionId=&appName= → live SSE of every event of the session (approvals,
 * narrations after approval, watcher alerts). With &replay=1 → JSON of the
 * persisted events, used to rebuild the thread after a reload.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId') ?? '';
  if (!UUID.test(sessionId)) return Response.json({ ok: false, error: fa.errors.badRequest }, { status: 400 });
  const appName = url.searchParams.get('appName') || undefined;
  const { rt } = getAgentRuntime();
  if (url.searchParams.get('replay') === '1') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
    return Response.json({ ok: true, events: AgentSession.load(rt, sessionId)?.replay(limit) ?? [] });
  }
  const session = AgentSession.loadOrCreate(rt, sessionId, appName);
  if (!appName && session.appName) rt.bus.track(session.id, session.appName);
  return sseResponse(req.signal, (send) => rt.bus.subscribe(session.id, send));
}
