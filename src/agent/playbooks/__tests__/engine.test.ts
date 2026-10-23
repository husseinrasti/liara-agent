import { describe, expect, it } from 'vitest';
import { healthyPacket, oomPacket, PLANS, withLogs } from '../../../test-utils/packets';
import '../../tools';
import { evaluate } from '../engine';
import { loadPlaybooks } from '../load';

describe('playbooks', () => {
  it('loads all 15 valid playbooks', () => {
    const ids = loadPlaybooks().map((p) => p.id).sort();
    expect(ids).toEqual(
      ['app_stopped', 'build_failed', 'cpu_saturation_slow', 'crash_loop', 'db_unreachable', 'disk_full', 'domain_not_verified', 'healthy', 'high_latency_unknown', 'insufficient_balance', 'missing_env', 'oom_kill', 'port_mismatch', 'readonly_fs', 'recent_deploy_regression'].sort(),
    );
  });
});

describe('rule engine', () => {
  it('EROFS in the logs: readonly_fs with the disk / read-only guidance (new apps default to a read-only root fs) [probe 05]', () => {
    const packet = withLogs(healthyPacket(), ["Error: EROFS: read-only file system, open '/usr/src/app/uploads/a.png'"]);
    const top = evaluate(packet, { plans: PLANS }).candidates[0]!;
    expect(top.playbookId).toBe('readonly_fs');
    expect(top.manualStepsFa.join(' ')).toContain('disks');
  });

  it('OOM: oom_kill on top with rollback (recent deploy), restart and upgrade fixes', () => {
    const { candidates, signals } = evaluate(oomPacket(), { plans: PLANS });
    const top = candidates[0]!;
    expect(top.playbookId).toBe('oom_kill');
    expect(top.score).toBeGreaterThanOrEqual(0.8);
    expect(top.fixes.map((f) => f.tool)).toEqual(['rollback_release', 'restart_app', 'resize_app']);
    expect(top.fixes[2]).toMatchObject({ args: { appName: 'shop', planID: 'medium-g2' }, risk: 2 });
    expect(top.fixes[2]!.title_fa).toContain('گیگابایت');
    expect(signals.some((s) => s.detail.includes('OOMKilled ×3'))).toBe(true);
  });

  it('OOM without a recent deploy: restart first, no rollback', () => {
    const p = oomPacket();
    p.app!.lastDeployAgeMinutes = 5000;
    const top = evaluate(p, { plans: PLANS }).candidates[0]!;
    expect(top.fixes[0]!.tool).toBe('restart_app');
    expect(top.fixes.some((f) => f.tool === 'rollback_release')).toBe(false);
  });

  it('crash loop: stack trace + CrashLoopBackOff', () => {
    const p = withLogs(healthyPacket(), [
      'server starting',
      "TypeError: Cannot read properties of undefined (reading 'id')",
      '    at handler (/app/index.js:12:20)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ]);
    p.applets = [{ name: 'shop-1', state: 'CrashLoopBackOff', reason: 'Error' }];
    p.events = { windowMinutes: 120, byReason: { BackOff: 6 }, timeline: [] };
    p.health = { status: 503, ok: false, latencyMs: null, sampledAt: 'x' };
    const top = evaluate(p).candidates[0]!;
    expect(top.playbookId).toBe('crash_loop');
    expect(top.matchedSignals.some((s) => s.source === 'logs' && s.detail.includes("reading 'id'"))).toBe(true);
  });

  it('build failed: quotes the failing build line, no automatic fix', () => {
    const p = healthyPacket();
    p.releases = [{ id: 'r9', state: 'FAILED', tag: 'v9', createdAt: '2026-10-22T11:58:00Z', port: 3000 }, ...p.releases];
    p.logs.buildLog = ['Step 3/7 : RUN npm ci', 'npm ERR! code EJSONPARSE', 'npm ERR! JSON.parse Failed to parse json', 'npm ERR! Unexpected token } in JSON at position 120'];
    const top = evaluate(p).candidates[0]!;
    expect(top.playbookId).toBe('build_failed');
    expect(top.matchedSignals.find((s) => s.kind === 'build_log_regex')!.detail).toContain('npm ERR!');
    expect(top.fixes).toEqual([]);
    expect(top.manualStepsFa.length).toBeGreaterThan(0);
  });

  it('missing env: extracts the key and asks the user for its value', () => {
    const p = withLogs(healthyPacket(), ['GET / 500 2ms', 'Error: API_KEY is not set', 'GET / 500 1ms', 'Error: API_KEY is not set']);
    p.health = { status: 500, ok: false, latencyMs: 20, sampledAt: 'x' };
    const top = evaluate(p).candidates[0]!;
    expect(top.playbookId).toBe('missing_env');
    expect(top.causes_fa[0]).toContain('API_KEY');
    expect(top.manualStepsFa[0]).toContain('API_KEY');
    expect(top.fixes).toEqual([]);
  });

  it('port mismatch: redeploy with the port the app listens on', () => {
    const p = withLogs(healthyPacket(), ['Server listening on port 8080']);
    p.releases[0] = { ...p.releases[0]!, state: 'UNHEALTHY', port: 3000 };
    p.health = { status: 502, ok: false, latencyMs: 5, sampledAt: 'x' };
    const top = evaluate(p, { latestSourceID: 'src-1' }).candidates[0]!;
    expect(top.playbookId).toBe('port_mismatch');
    expect(top.fixes[0]).toMatchObject({ tool: 'deploy_release', args: { appName: 'shop', sourceID: 'src-1', port: 8080, platform: 'node' } });
  });

  it('stopped app: turn it on (risk 2)', () => {
    const p = healthyPacket();
    p.app!.scale = 0;
    p.health = { status: 0, ok: false, latencyMs: null, error: 'timeout', sampledAt: 'x' };
    const top = evaluate(p).candidates[0]!;
    expect(top.playbookId).toBe('app_stopped');
    expect(top.fixes[0]).toMatchObject({ tool: 'scale_app', args: { appName: 'shop', on: true }, risk: 2 });
  });

  it('healthy: no incident candidates, healthy fallback with watch suggestion', () => {
    const { candidates } = evaluate(healthyPacket());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ playbookId: 'healthy', score: 0.9 });
    expect(candidates[0]!.fixes[0]!.tool).toBe('set_app_watch');
  });
});
