import { z } from 'zod';
import { approve, getApproval } from '@/src/agent/approvals';
import { getAgentRuntime } from '@/src/runtime';
import { invalidateStatus } from '@/src/server/status';
import { fa } from '@/app/i18n/fa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ approvalId: z.string().min(1), approved: z.boolean(), typedName: z.string().max(64).optional() });

/** POST {approvalId, approved, typedName?} → {ok}; the action and its narration stream on the session's events. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: fa.errors.badRequest }, { status: 400 });
  const server = getAgentRuntime();
  const sessionId = getApproval(server.rt, parsed.data.approvalId)?.sessionId;
  const res = approve(server.rt, { ...parsed.data, by: 'user' }, sessionId ? { gate: (run) => server.runExclusive(sessionId, run) } : {});
  if (!res.ok) return Response.json({ ok: false, code: res.code, error: res.messageFa }, { status: res.code === 'not_found' ? 404 : 409 });
  void res.done.then(() => invalidateStatus());
  return Response.json({ ok: true, status: res.status });
}
