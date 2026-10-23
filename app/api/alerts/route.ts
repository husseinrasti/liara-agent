import { z } from 'zod';
import { acknowledgeAlert, activeAlerts } from '@/src/agent/alerts';
import { getAgentRuntime } from '@/src/runtime';
import { invalidateStatus } from '@/src/server/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?appName= → unacknowledged alerts. */
export async function GET(req: Request) {
  const appName = new URL(req.url).searchParams.get('appName') || undefined;
  return Response.json({ ok: true, alerts: activeAlerts(getAgentRuntime().rt, appName) });
}

/** POST {id} → acknowledge. */
export async function POST(req: Request) {
  const parsed = z.object({ id: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false }, { status: 400 });
  const ok = acknowledgeAlert(getAgentRuntime().rt, parsed.data.id);
  invalidateStatus();
  return Response.json({ ok });
}
