import { getAgentRuntime } from '@/src/runtime';
import { appStatus } from '@/src/server/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET → compact status of one app for the side panel (polled every 30s). */
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return Response.json({ ok: false }, { status: 400 });
  const status = await appStatus(getAgentRuntime().rt, name, new URL(req.url).searchParams.get('fresh') === '1');
  return Response.json({ ok: true, status });
}
