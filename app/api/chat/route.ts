import { z } from 'zod';
import { runTurn } from '@/src/agent/loop';
import { AgentSession } from '@/src/agent/session';
import { getAgentRuntime } from '@/src/runtime';
import { sseResponse, UUID } from '@/src/server/sse';
import { invalidateStatus } from '@/src/server/status';
import { fa } from '@/app/i18n/fa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  sessionId: z.string().regex(UUID).optional(),
  appName: z.string().max(64).nullish(),
  text: z.string().trim().min(1).max(4000),
});

/** POST {sessionId?, appName?, text} → text/event-stream of the turn's events (ends after `done`). */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: fa.errors.badRequest }, { status: 400 });
  const server = getAgentRuntime();
  const { rt } = server;
  const session = AgentSession.loadOrCreate(rt, parsed.data.sessionId, parsed.data.appName ?? undefined);
  if (parsed.data.appName === null && session.appName) session.setApp(undefined);
  if (server.busy.has(session.id)) return Response.json({ ok: false, error: fa.errors.busy }, { status: 409 });
  server.busy.add(session.id);
  return sseResponse(
    req.signal,
    (send, close) => {
      const unsubscribe = rt.bus.subscribe(session.id, send);
      session.emit({ type: 'user_message', text: parsed.data.text });
      void runTurn(rt, session, parsed.data.text).finally(() => {
        server.busy.delete(session.id);
        if (session.appName) invalidateStatus(session.appName);
        setTimeout(close, 20);
      });
      return unsubscribe;
    },
    { 'X-Session-Id': session.id },
  );
}
