import { z } from 'zod';
import { setMemoryKey } from '@/src/agent/memory';
import { getAgentRuntime } from '@/src/runtime';
import { invalidateStatus } from '@/src/server/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST {appName, on} → toggles this assistant's background monitoring for the app (nothing changes on Liara). */
export async function POST(req: Request) {
  const parsed = z.object({ appName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), on: z.boolean() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false }, { status: 400 });
  const server = getAgentRuntime();
  setMemoryKey(server.rt.deps.db, parsed.data.appName, 'watch', parsed.data.on, server.rt.now());
  if (parsed.data.on) server.ensureWatcher();
  invalidateStatus(parsed.data.appName);
  return Response.json({ ok: true, watch: parsed.data.on });
}
