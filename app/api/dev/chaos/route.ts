import { z } from 'zod';
import { CHAOS_MODES } from '@/src/sim/behavior';
import { linkSourceRelease, recordSource } from '@/src/db/repo';
import { getAgentRuntime } from '@/src/runtime';
import { invalidateStatus } from '@/src/server/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Simulator only (LIARA_FAKE=1): switch a simulated app's chaos mode, either via
 * its CHAOS_MODE env (restart) or as a new release with the mode baked in
 * (so "rollback to the previous release" really fixes it). 404 in live mode.
 */
export async function POST(req: Request) {
  const server = getAgentRuntime();
  if (server.mode !== 'simulated' || !server.sim) return Response.json({ ok: false, error: 'simulator only' }, { status: 404 });
  const parsed = z.object({ appName: z.string(), mode: z.enum(CHAOS_MODES), deploy: z.boolean().default(false) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: 'bad request' }, { status: 400 });
  const { state } = server.sim;
  const app = state.apps.get(parsed.data.appName);
  if (!app) return Response.json({ ok: false, error: 'app not found' }, { status: 404 });
  const others = app.envs.filter((e) => e.key !== 'CHAOS_MODE');
  if (parsed.data.deploy) {
    state.setEnvsRaw(app.name, others);
    const sourceID = `sim-chaos-${Date.now()}`;
    state.sources.set(sourceID, { app: app.name, chaos: parsed.data.mode });
    const releaseID = state.createRelease(app.name, { sourceID, port: 3000, type: app.type });
    // Like `npm run chaos -- --deploy` against Liara: the release's source is recorded for rollback.
    if (releaseID) {
      recordSource(server.rt.deps.db, { appName: app.name, sourceID, archivePath: '', createdAt: new Date().toISOString() });
      linkSourceRelease(server.rt.deps.db, app.name, sourceID, releaseID);
    }
    invalidateStatus(app.name);
    return Response.json({ ok: true, via: 'release', releaseID });
  }
  state.setEnvsRaw(app.name, parsed.data.mode === 'none' ? others : [...others, { key: 'CHAOS_MODE', value: parsed.data.mode }]);
  invalidateStatus(app.name);
  return Response.json({ ok: true, via: 'env', mode: parsed.data.mode });
}
