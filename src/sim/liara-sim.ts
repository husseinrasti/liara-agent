/**
 * Liara API simulator (opt-in, LIARA_FAKE=1): a `fetch` that answers the
 * endpoints our client uses with the shapes recorded from liara-cli/spec, and an
 * `httpFetch` for `*.liara.run` health checks. For offline UI work and rehearsal
 * only — the UI labels this mode clearly and it is never the default.
 */
import { appletState, eventsBetween, healthAt, logsBetween, memoryMB, cpuCores, type SimEvent } from './behavior';
import { SIM_PLANS, planSpec } from './catalog';
import { SimState, type SimApp } from './state';

type Json = Record<string, unknown>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = (msg = 'Not Found') => json({ statusCode: 404, error: 'Not Found', message: msg }, 404);
const ns = (ms: number) => `${Math.floor(ms)}000000`;
const iso = (ms?: number) => (ms === undefined ? null : new Date(ms).toISOString());

function project(app: SimApp, s: SimState) {
  const spec = planSpec(app.planID);
  const run = s.runState(app);
  return {
    _id: app._id,
    project_id: app.name,
    type: app.type,
    status: app.scale ? 'ACTIVE' : 'DEACTIVE',
    scale: app.scale,
    planID: app.planID,
    bundlePlanID: app.bundlePlanID,
    created_at: iso(app.createdAt),
    isDeployed: run.deployed,
    network: 'sim-network',
  };
}

function details(app: SimApp, s: SimState) {
  return {
    ...project(app, s),
    defaultSubdomain: true,
    readOnlyRootFilesystem: false,
    zeroDowntime: false,
    envs: app.envs.map((e, i) => ({ ...e, encrypted: false, _id: `env${i}` })),
    fixedIPStatus: 'DISABLED',
    hourlyPrice: planSpec(app.planID)?.hourly ?? 0,
    reservedDiskSpace: 0,
  };
}

function lokiStreams(lines: { t: number; line: string }[], meta: Json = {}) {
  return { data: lines.length ? [{ metaData: meta, values: lines.map((l) => [ns(l.t), l.line]) }] : [] };
}

export interface LiaraSimulator {
  state: SimState;
  fetch: typeof fetch;
  httpFetch: typeof fetch;
}

export function createLiaraSimulator(opts: { now?: () => number; seed?: boolean; realFetch?: typeof fetch } = {}): LiaraSimulator {
  const state = new SimState(opts.now ?? Date.now);
  if (opts.seed !== false) state.seed();
  const now = () => state.now();

  async function handle(method: string, url: URL, body: unknown): Promise<Response> {
    const p = url.pathname.replace(/\/+$/, '');
    const q = url.searchParams;
    let m: RegExpExecArray | null;
    if (method === 'GET' && p === '/v1/me') return json({ user: { _id: 'sim-user', fullname: 'کاربر آزمایشی', isTeam: false }, plans: SIM_PLANS });
    if (method === 'GET' && p === '/v1/billing') return json({ user: { balance: state.balance, accountType: 'personal' } });
    if (method === 'GET' && p === '/v1/projects') return json({ projects: [...state.apps.values()].map((a) => project(a, state)) });
    if (method === 'GET' && p === '/v1/networks') return json({ networks: state.networks });
    if (method === 'POST' && p === '/v1/networks') {
      const name = (body as { networkName?: string }).networkName;
      if (!name) return json({ statusCode: 400, message: 'networkName is required' }, 400);
      if (state.networks.some((n) => n.name === name)) return json({ statusCode: 409, message: 'Network already exists' }, 409);
      state.networks.push({ _id: `net${state.networks.length + 1}`, name });
      return json({}, 201);
    }
    if (method === 'POST' && p === '/v1/projects') {
      const b = body as { name?: string; planID?: string; platform?: string; bundlePlanID?: string; network?: string };
      if (!b.name || !/^[a-z][a-z0-9-]{2,30}$/.test(b.name)) return json({ statusCode: 400, message: 'Invalid name' }, 400);
      if (state.apps.has(b.name)) return json({ statusCode: 409, message: 'Project already exists' }, 409);
      if (!b.planID || !planSpec(b.planID)) return json({ statusCode: 400, message: 'Invalid planID' }, 400);
      // Real API: g2 plans without a private network → 400 g2_plan_unavailable [probe].
      if (b.planID.includes('g2') && !state.networks.some((n) => n._id === b.network)) return json({ statusCode: 400, error: 'Bad Request', message: 'g2_plan_unavailable', data: null }, 400);
      state.createApp({ name: b.name, planID: b.planID, platform: b.platform ?? 'node', bundlePlanID: b.bundlePlanID }, now());
      return json({});
    }
    if (method === 'POST' && p === '/v1/projects/update-envs') {
      const b = body as { project?: string; variables?: { key: string; value: string }[] };
      if (!b.project || !state.apps.has(b.project)) return notFound('App not found');
      state.setEnvsRaw(b.project, b.variables ?? []);
      return json({ message: 'envs updated' });
    }
    if ((m = /^\/v1\/releases\/([^/]+)$/.exec(p)) && method === 'GET') {
      const f = state.findRelease(m[1]!);
      if (!f) return notFound();
      return json({ release: { state: f.release.state, status: f.release.state, failReason: f.release.state === 'FAILED' ? 'Build failed: npm ci exited with code 1' : undefined } });
    }
    if ((m = /^\/v2\/releases\/([^/]+)\/build-logs$/.exec(p)) && method === 'GET') {
      const f = state.findRelease(m[1]!);
      if (!f) return notFound();
      const r = f.release;
      const lines = ['Step 1/6 : FROM liara/node:22', 'Step 2/6 : COPY . /app', 'Step 3/6 : RUN npm ci --omit=dev', ...(r.failLines ?? ['added 1 package in 2s', 'Successfully tagged release'])];
      const finished = (r.finishedAt ?? now()) >= r.createdAt + 6000;
      const output = finished ? lines.map((line, i) => ({ _id: `${r._id}-${i}`, line, stream: /npm ERR!/.test(line) ? 'STDERR' : 'STDOUT', releaseID: r._id, createdAt: iso(r.createdAt + 1000 + i * 500) })) : [];
      return json({ release: { state: r.state, status: r.state }, buildOutput: output });
    }
    if ((m = /^\/v2\/projects\/([^/]+)\/sources$/.exec(p)) && method === 'POST') {
      if (!state.apps.has(m[1]!)) return notFound('App not found');
      const file = body instanceof FormData ? body.get('file') : null;
      if (!(file instanceof Blob)) return json({ statusCode: 400, message: 'file is required' }, 400);
      return json({ sourceID: state.registerSource(m[1]!, Buffer.from(await file.arrayBuffer())) });
    }
    if ((m = /^\/v2\/projects\/([^/]+)\/releases$/.exec(p)) && method === 'POST') {
      const b = body as { sourceID?: string; port?: number; type?: string; disks?: { name: string; mountTo: string }[] };
      if (!b.sourceID) return json({ statusCode: 400, message: 'sourceID is required' }, 400);
      const target = state.apps.get(m[1]!);
      const missing = (b.disks ?? []).find((d) => !target?.disks.some((x) => x.name === d.name));
      if (missing) return json({ statusCode: 400, message: `Disk ${missing.name} does not exist.` }, 400);
      const releaseID = state.createRelease(m[1]!, { sourceID: b.sourceID, port: b.port ?? 3000, type: b.type ?? 'node', ...(b.disks ? { disks: b.disks } : {}) });
      return releaseID ? json({ releaseID }) : json({ statusCode: 400, message: 'Unknown sourceID or app' }, 400);
    }
    if ((m = /^\/v1\/domains\/([^/]+)\/check$/.exec(p)) && method === 'GET') {
      const d = state.domains.get(m[1]!);
      return d ? json({ domain: { ...state.domainView(d), user: 'sim-user', verificationCode: 'sim' } }) : notFound();
    }
    if (p === '/v1/domains' && method === 'GET') {
      const app = q.get('project');
      return json({ domains: [...state.domains.values()].filter((d) => !app || d.app === app).map((d) => state.domainView(d)) });
    }
    if (p === '/v1/domains' && method === 'POST') {
      const b = body as { name?: string; project?: string };
      if (!b.name || !b.project || !state.apps.has(b.project)) return json({ statusCode: 400, message: 'Invalid domain or project' }, 400);
      if ([...state.domains.values()].some((d) => d.name === b.name)) return json({ statusCode: 409, message: 'Domain already exists' }, 409);
      return json({ domain: state.domainView(state.addDomain(b.name, b.project)) }, 201);
    }
    if (p === '/v1/domains/provision-ssl-certs' && method === 'POST') {
      const d = [...state.domains.values()].find((x) => x.name === (body as { domain?: string }).domain);
      if (!d) return notFound();
      d.sslRequestedAt = now();
      return json({ message: 'ssl requested' });
    }
    if ((m = /^\/v1\/domains\/([^/]+)$/.exec(p)) && method === 'DELETE') return state.domains.delete(m[1]!) ? json({}) : notFound();
    if ((m = /^\/v1\/projects\/([^/]+)\/disks$/.exec(p)) && method === 'GET') {
      // Liara takes the app _id here (the CLI passes the name to POST).
      const a = [...state.apps.values()].find((x) => x._id === m![1] || x.name === m![1]);
      if (!a) return notFound('App does not exist.');
      const current = a.releases.find((r) => r._id === a.current);
      return json({
        disks: a.disks.map((d) => ({ _id: `disk-${d.name}`, name: d.name, size: d.size, createdAt: iso(d.createdAt) })),
        mounts: (current?.disks ?? []).map((d) => ({ name: d.name, mountedTo: d.mountTo })),
      });
    }

    m = /^\/v[12]\/projects\/([^/]+)(\/.*)?$/.exec(p);
    const app = m ? state.apps.get(m[1]!) : undefined;
    if (!m || !app) return notFound('App does not exist.');
    const sub = m[2] ?? '';
    const run = state.runState(app);
    const t = now();
    if (sub === '' && method === 'GET') return json({ project: details(app, state) });
    if (sub === '' && method === 'DELETE') return state.apps.delete(app.name) ? json({}) : notFound();
    if (sub === '/actions/restart' && method === 'POST') return state.restart(app), json({ message: 'restarted' });
    if (sub === '/actions/scale' && method === 'POST') {
      app.scale = (body as { scale?: number }).scale ? 1 : 0;
      app.lifecycle.push({ t, reason: app.scale ? 'ScalingUp' : 'ScalingDown', type: 'Normal', message: `Scaled to ${app.scale}` });
      if (app.scale) app.startedAt = t + 2000;
      return json({ message: 'scaled' });
    }
    if (sub === '/resize' && method === 'POST') {
      const planID = (body as { planID?: string }).planID;
      if (!planID || !planSpec(planID)) return json({ statusCode: 400, message: 'Invalid planID' }, 400);
      app.planID = planID;
      state.restart(app, 'Resize');
      return json({ message: 'resized' });
    }
    if (sub === '/applets' && method === 'GET') {
      const st = appletState(run, t);
      const release = app.releases.find((r) => r._id === app.current);
      return json({ applets: st ? [{ id: `${app._id}-a1`, name: `${app.name}-7d9f6c-x2k`, timestamp: iso(app.startedAt), ...st, release: release ? { releaseID: release._id, tag: release.tag } : null }] : [] });
    }
    if (sub === '/disks' && method === 'POST') {
      const b = body as { name?: string; size?: string | number };
      const size = Number(b.size);
      if (!b.name || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(b.name)) return json({ statusCode: 400, message: 'Invalid disk name.' }, 400);
      if (!Number.isFinite(size) || size < 1) return json({ statusCode: 400, message: '"size" must be a number' }, 400);
      if (app.disks.some((d) => d.name === b.name)) return json({ statusCode: 409, message: 'Disk already exists' }, 409);
      app.disks.push({ name: b.name, size, createdAt: now() });
      return json({ message: 'disk created' }, 201);
    }
    if ((m = /^\/disks\/([^/]+)\/resize$/.exec(sub)) && method === 'POST') {
      const d = app.disks.find((x) => x.name === m![1]);
      const size = Number((body as { size?: string | number }).size);
      if (!d) return notFound('Disk does not exist.');
      if (!Number.isFinite(size) || size <= d.size) return json({ statusCode: 400, message: 'New size must be larger' }, 400);
      d.size = size;
      return json({ message: 'disk resized' });
    }
    if (sub === '/releases' && method === 'GET') {
      const count = Number(q.get('count') ?? 10);
      const releases = [...app.releases].sort((a, b) => b.createdAt - a.createdAt).slice(0, count);
      return json({
        total: app.releases.length,
        currentRelease: app.current ?? null,
        readyReleasesCount: app.releases.filter((r) => r.state === 'READY').length,
        platform: app.type,
        releases: releases.map((r) => ({ _id: r._id, type: r.type, projectType: r.type, state: r.state, port: r.port, client: 'liara-agent', createdAt: iso(r.createdAt), finishedAt: iso(r.finishedAt), tag: r.tag, sourceAvailable: true })),
      });
    }
    if (sub === '/events' && method === 'GET') {
      const start = Number(q.get('start') ?? 0) * 1000 || t - 86_400_000;
      const end = Number(q.get('end') ?? 0) * 1000 || t;
      const evs: SimEvent[] = [...app.lifecycle.filter((e) => e.t >= start && e.t <= end), ...eventsBetween(run, start, end)].sort((a, b) => a.t - b.t);
      return json(lokiStreams(evs.map((e) => ({ t: e.t, line: JSON.stringify({ reason: e.reason, type: e.type, message: e.message, involvedObject: { name: `${app.name}-7d9f6c-x2k` } }) }))));
    }
    if (sub === '/logs' && method === 'GET') {
      const since = Number(q.get('start') ?? q.get('since') ?? 0);
      const from = since > 1e12 ? since : since * 1000 || t - 3_600_000;
      const lines = logsBetween(run, from, t);
      if (p.startsWith('/v1/')) return json(lines.map((l) => ({ type: l.stream, datetime: iso(l.t), message: l.msg })));
      return json(lokiStreams(lines.map((l) => ({ t: l.t, line: JSON.stringify({ _entry: l.msg, type: l.stream }) })), { releaseId: app.current }));
    }
    if (sub === '/metrics/summary' && method === 'GET') {
      const ts = Math.floor(t / 1000);
      return json({ cpuUsage: [{ value: [ts, String(cpuCores(run, t))], applet: app.name }], memoryUsage: [{ value: [ts, String(memoryMB(run, t) * 1048576)], applet: app.name }], disksUsage: [] });
    }
    if ((m = /^\/metrics\/(cpu|memory|network-receive|network-transmit)$/.exec(sub)) && method === 'GET') {
      const since = Number(q.get('since') ?? 0) * 1000 || t - 3_600_000;
      const values: [number, string][] = [];
      for (let x = Math.max(since, run.startedAt); x <= t; x += 30_000) {
        const v = m[1] === 'cpu' ? cpuCores(run, x) : m[1] === 'memory' ? memoryMB(run, x) * 1048576 : run.deployed && app.scale ? 2048 + (x % 900) : 0;
        values.push([Math.floor(x / 1000), String(v)]);
      }
      return json({ end: Math.floor(t / 1000), result: values.length ? [{ values, applet: app.name }] : [] });
    }
    return notFound();
  }

  const simFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === 'string') body = JSON.parse(body);
    return handle(method, url, body);
  }) as typeof fetch;

  const real = opts.realFetch ?? fetch;
  const httpFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const host = /^([a-z0-9-]+)\.liara\.run$/.exec(url.hostname);
    if (!host) return real(input, init);
    const app = state.apps.get(host[1]!);
    if (!app) return new Response('Not Found', { status: 404 });
    const h = healthAt(state.runState(app), now());
    await new Promise((r) => setTimeout(r, Math.min(h.latencyMs, 4000)));
    return new Response(h.body, { status: h.status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;

  return { state, fetch: simFetch, httpFetch };
}
