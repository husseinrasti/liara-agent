import { describeError } from '@/src/liara/errors';
import { getAgentRuntime } from '@/src/runtime';
import { cachedApps } from '@/src/server/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET → the account's apps (cached 30s). */
export async function GET(req: Request) {
  const server = getAgentRuntime();
  try {
    const apps = await cachedApps(server.rt, new URL(req.url).searchParams.get('fresh') === '1');
    return Response.json({
      ok: true,
      mode: server.mode,
      demoAppName: server.demoAppName ?? null,
      apps: apps.map((a) => ({ name: a.project_id, platform: a.type, scale: a.scale ?? null, planID: a.planID ?? null, isDeployed: a.isDeployed ?? null, status: a.status ?? null })),
    });
  } catch (err) {
    return Response.json({ ok: false, error: describeError(err).userMessageFa }, { status: 502 });
  }
}
