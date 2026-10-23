/** In-memory simulated Liara account (LIARA_FAKE=1): apps, releases, envs, domains, balance. */
import { randomBytes } from 'node:crypto';
import { readTarGz } from './archive';
import { CHAOS_MODES, type ChaosMode, type RunState, type SimEvent } from './behavior';
import { planSpec } from './catalog';

export interface SimRelease {
  _id: string;
  sourceID: string;
  createdAt: number;
  finishedAt?: number;
  port: number;
  type: string;
  tag: string;
  chaos?: ChaosMode;
  requiredEnv?: string;
  /** liara.json disks mounted by this release */
  disks?: { name: string; mountTo: string }[];
  failLines?: string[];
  state: string;
}

export interface SimApp {
  _id: string;
  name: string;
  type: string;
  planID: string;
  bundlePlanID: string;
  scale: number;
  envs: { key: string; value: string }[];
  releases: SimRelease[];
  current?: string;
  createdAt: number;
  startedAt: number;
  lifecycle: SimEvent[];
  disks: { name: string; size: number; createdAt: number }[];
}

export interface SimDomain {
  _id: string;
  name: string;
  app: string;
  createdAt: number;
  sslRequestedAt?: number;
}

const id = (p: string) => `${p}${randomBytes(6).toString('hex')}`;
const BUILD_FAIL_AT = 7_000;
const READY_AT = 12_000;
export const DNS_PROPAGATION_MS = 60_000;
export const SSL_ISSUE_MS = 20_000;

export class SimState {
  readonly apps = new Map<string, SimApp>();
  readonly domains = new Map<string, SimDomain>();
  /** private networks; g2 apps are created inside one */
  readonly networks: { _id: string; name: string }[] = [{ _id: 'net1', name: 'my-network' }];
  readonly sources = new Map<string, { app: string; chaos?: ChaosMode; failLines?: string[]; requiredEnv?: string }>();
  balance = 6_000_000;

  constructor(readonly now: () => number = Date.now) {}

  seed(): this {
    const t = this.now();
    this.createApp({ name: 'liara-agent-demo', planID: 'small-g2', platform: 'node', bundlePlanID: 'basic' }, t - 3 * 86_400_000);
    this.setEnvsRaw('liara-agent-demo', [
      { key: 'NODE_ENV', value: 'production' },
      { key: 'PAYMENT_API_KEY', value: 'demo-key' },
    ]);
    this.seedRelease('liara-agent-demo', t - 2 * 86_400_000);
    this.createApp({ name: 'my-blog', planID: 'small-g2', platform: 'static', bundlePlanID: 'basic' }, t - 12 * 86_400_000);
    this.seedRelease('my-blog', t - 10 * 86_400_000, 80);
    return this;
  }

  private seedRelease(app: string, at: number, port = 3000) {
    const a = this.apps.get(app)!;
    const sourceID = id('src');
    this.sources.set(sourceID, { app });
    a.releases.push({ _id: id('rel'), sourceID, createdAt: at, finishedAt: at + READY_AT, port, type: a.type, tag: 'v1', state: 'READY' });
    a.current = a.releases[0]!._id;
    a.startedAt = at + READY_AT;
  }

  createApp(input: { name: string; planID: string; platform: string; bundlePlanID?: string }, at = this.now()): SimApp {
    const app: SimApp = {
      _id: id('p'),
      name: input.name,
      type: input.platform,
      planID: input.planID,
      bundlePlanID: input.bundlePlanID ?? 'free',
      scale: 1,
      envs: [],
      releases: [],
      createdAt: at,
      startedAt: at,
      lifecycle: [],
      disks: [],
    };
    this.apps.set(app.name, app);
    return app;
  }

  /** Advances release states (BUILDING → PUSHING → DEPLOYING → READY | FAILED) to `now`. */
  advance(app: SimApp): void {
    const now = this.now();
    for (const r of app.releases) {
      if (r.finishedAt !== undefined) continue;
      const age = now - r.createdAt;
      if (r.failLines) {
        r.state = age >= BUILD_FAIL_AT ? 'FAILED' : 'BUILDING';
        if (r.state === 'FAILED') r.finishedAt = r.createdAt + BUILD_FAIL_AT;
        continue;
      }
      r.state = age < 6_000 ? 'BUILDING' : age < 9_000 ? 'PUSHING' : age < READY_AT ? 'DEPLOYING' : 'READY';
      if (r.state === 'READY') {
        r.finishedAt = r.createdAt + READY_AT;
        app.current = r._id;
        app.startedAt = r.finishedAt;
        app.lifecycle.push(
          { t: r.finishedAt - 2000, reason: 'Pulled', type: 'Normal', message: `Successfully pulled image for release ${r.tag}` },
          { t: r.finishedAt, reason: 'Started', type: 'Normal', message: 'Started container' },
        );
      }
    }
  }

  runState(app: SimApp): RunState {
    this.advance(app);
    const spec = planSpec(app.planID) ?? { ramMB: 512, cpu: 0.5, hourly: 0 };
    const envs = Object.fromEntries(app.envs.map((e) => [e.key, e.value]));
    const release = app.releases.find((r) => r._id === app.current);
    const envMode = CHAOS_MODES.find((m) => m === envs.CHAOS_MODE);
    return { mode: envMode ?? release?.chaos ?? 'none', startedAt: app.startedAt, ramMB: spec.ramMB, cpuCores: spec.cpu, envs, scale: app.scale, deployed: Boolean(release), requiredEnv: release?.requiredEnv };
  }

  restart(app: SimApp, reason = 'Killing'): void {
    const t = this.now();
    app.lifecycle.push({ t, reason, type: 'Normal', message: 'Stopping container' }, { t: t + 2000, reason: 'Started', type: 'Normal', message: 'Started container' });
    app.startedAt = t + 2000;
  }

  setEnvsRaw(name: string, variables: { key: string; value: string }[]): void {
    const app = this.apps.get(name);
    if (!app) return;
    app.envs = variables.map((v) => ({ key: v.key, value: v.value }));
    this.restart(app);
  }

  /**
   * Reads what the uploaded code would do: chaos.json (baked chaos mode), the
   * acceptance fixtures by package name (liara-agent-fixture-leak|crash), an
   * `if (!process.env.X) … process.exit` guard, and package.json validity.
   */
  registerSource(app: string, archive: Buffer): string {
    const files = readTarGz(archive);
    let chaos: ChaosMode | undefined;
    try {
      const c = JSON.parse(files.get('chaos.json') ?? 'null') as { mode?: string } | null;
      chaos = CHAOS_MODES.find((m) => m === c?.mode);
    } catch {
      chaos = undefined;
    }
    let failLines: string[] | undefined;
    const pkg = files.get('package.json');
    if (pkg !== undefined) {
      try {
        const fixture = /^liara-agent-fixture-(leak|crash)$/.exec(String((JSON.parse(pkg) as { name?: unknown }).name ?? ''))?.[1];
        chaos ??= fixture as ChaosMode | undefined;
      } catch (err) {
        failLines = ['npm ERR! code EJSONPARSE', `npm ERR! JSON.parse ${(err as Error).message}`, 'npm ERR! JSON.parse Failed to parse JSON data.', 'npm ERR! A complete log of this run can be found in: /root/.npm/_logs/debug.log'];
      }
    }
    const requiredEnv = /if\s*\(\s*!process\.env\.([A-Z_][A-Z0-9_]*)\s*\)\s*\{[^}]*process\.exit/.exec(files.get('index.js') ?? '')?.[1];
    const sourceID = id('src');
    this.sources.set(sourceID, { app, chaos, failLines, requiredEnv });
    return sourceID;
  }

  createRelease(name: string, body: { sourceID: string; port: number; type: string; disks?: { name: string; mountTo: string }[] }): string | null {
    const app = this.apps.get(name);
    const src = this.sources.get(body.sourceID);
    if (!app || !src) return null;
    const r: SimRelease = { _id: id('rel'), sourceID: body.sourceID, disks: body.disks, createdAt: this.now(), port: body.port, type: body.type, tag: `v${app.releases.length + 1}`, chaos: src.chaos, failLines: src.failLines, requiredEnv: src.requiredEnv, state: 'BUILDING' };
    app.releases.push(r);
    return r._id;
  }

  findRelease(releaseID: string): { app: SimApp; release: SimRelease } | null {
    for (const app of this.apps.values()) {
      this.advance(app);
      const release = app.releases.find((r) => r._id === releaseID);
      if (release) return { app, release };
    }
    return null;
  }

  addDomain(name: string, app: string): SimDomain {
    const d: SimDomain = { _id: id('d'), name, app, createdAt: this.now() };
    this.domains.set(d._id, d);
    return d;
  }

  domainView(d: SimDomain) {
    const now = this.now();
    const active = now - d.createdAt >= DNS_PROPAGATION_MS;
    const ssl = active && d.sslRequestedAt !== undefined && now - Math.max(d.sslRequestedAt, d.createdAt + DNS_PROPAGATION_MS) >= SSL_ISSUE_MS;
    const app = this.apps.get(d.app);
    return {
      _id: d._id,
      name: d.name,
      type: 'PROJECT',
      project: app ? { _id: app._id, project_id: app.name } : null,
      status: active ? 'ACTIVE' : 'PENDING',
      certificatesStatus: ssl ? 'ACTIVE' : 'PENDING',
      redirectTo: null,
      redirectStatus: null,
      created_at: new Date(d.createdAt).toISOString(),
      CNameRecord: `${d.app}.liara.run`,
    };
  }
}
