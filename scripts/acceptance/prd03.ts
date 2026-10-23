/**
 * PRD-03 acceptance — the web UI end to end in a real browser (system Chrome via playwright-core).
 *
 *   npm run accept:prd03              live: real Liara account + LLM; needs DEMO_APP_NAME
 *   npm run accept:prd03 -- --sim     same checks against the opt-in simulator (LIARA_FAKE=1);
 *                                     useful offline, NOT a substitute for the live run
 *   flags: --no-build (reuse .next), --port <n> (default 3230), --headed
 *
 * Builds, starts `next start`, drives the chat (status turn, reject + approve a restart,
 * access-log limitation), triggers `npm run chaos -- leak`, waits for the watcher's
 * critical alert and the banner, then restores with `npm run chaos -- none`.
 * Screenshots: data/accept-prd03/.
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { ConfigError, getConfig, ROOT_DIR } from '../../src/config';
import { createLogger } from '../../src/logger';
import { createRuntime } from '../../src/tools';
import { Acceptance, assert, runCommand } from './harness';
import { count, getJson, PERSIAN, screenshot, sendAndWait, SHOTS_DIR, startServer, waitForMore, type Server } from './prd03-helpers';

const args = process.argv.slice(2);
const sim = args.includes('--sim');
const port = Number(args[args.indexOf('--port') + 1]) || 3230;
const WATCH_SEC = sim ? 15 : undefined;

interface Health {
  ok: boolean;
  mode: string;
  liara: { ok: boolean; status: number };
  llm: { ok: boolean; model?: string; error?: string };
  demoAppName: string | null;
}

async function main(): Promise<Acceptance> {
  if (sim) process.env.LIARA_API_TOKEN ||= 'simulated';
  let cfg;
  try {
    cfg = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (!sim) {
    const deps = createRuntime({ logger: createLogger({ level: 'warn', name: 'accept03' }) });
    const pre = await deps.liara.requestRaw({ path: '/v1/me', retries: 0, timeoutMs: 15_000 }).catch((e: Error) => e);
    if (pre instanceof Error || pre.status >= 400) {
      console.error(`Liara API not usable from this process (${pre instanceof Error ? pre.message : `HTTP ${pre.status}`}). Nothing was run.`);
      process.exit(3);
    }
  }
  const watchSec = WATCH_SEC ?? cfg.watcher.intervalSec;
  const dbPath = sim ? path.join(cfg.dataDir, 'agent-sim.db') : cfg.databasePath;
  const t = new Acceptance(`PRD-03 acceptance — ${sim ? 'SIMULATOR (LIARA_FAKE=1, not the real Liara API)' : 'live Liara'}, port ${port}`);
  let server = null as Server | null;
  let browser: Browser | null = null;
  let app = '';
  let chaosOn = false;

  const chaos = async (mode: string) => {
    const env = sim ? { LIARA_FAKE: '1', CHAOS_URL: `http://localhost:${port}/api/dev/chaos` } : { LIARA_FAKE: '0' };
    Object.assign(process.env, env);
    const res = await runCommand('npm', ['run', '--silent', 'chaos', '--', mode, '--app', app], ROOT_DIR, 180_000);
    assert(res.code === 0 && !/failed|HTTP [45]\d\d/i.test(res.output), `chaos ${mode}: ${res.output.trim().slice(-200)}`);
    return res.output.trim().split('\n').pop() ?? '';
  };

  try {
    if (!args.includes('--no-build')) {
      const ok = await t.check('npm run build', async () => {
        const res = await runCommand('npm', ['run', 'build'], ROOT_DIR, 600_000);
        assert(res.code === 0, res.output.trim().split('\n').slice(-5).join(' | '));
        return 'build passed';
      });
      if (!ok) return t;
    }

    const started = await t.check('server starts (next start)', async () => {
      server = await startServer(port, {
        LIARA_FAKE: sim ? '1' : '0',
        AUTO_APPROVE: 'false',
        ...(WATCH_SEC ? { WATCHER_INTERVAL_SEC: String(WATCH_SEC) } : {}),
      });
      return server.url;
    });
    if (!started || !server) return t;
    const base = server.url;

    const healthy = await t.check('GET /api/health → liara ok, llm ok', async () => {
      const h = await getJson<Health>(`${base}/api/health`);
      assert(h.liara.ok, `liara not ok (HTTP ${h.liara.status})`);
      assert(h.llm.ok, `llm not ok: ${h.llm.error ?? ''}`);
      app = h.demoAppName ?? '';
      return `mode=${h.mode}, llm=${h.llm.model ?? '?'}`;
    });
    if (!healthy) return t;

    await t.check('GET /api/apps lists the demo app', async () => {
      assert(app, 'DEMO_APP_NAME is not set (run `npm run probe` or set it in .env)');
      const r = await getJson<{ apps: { name: string }[] }>(`${base}/api/apps`);
      assert(r.apps.some((a) => a.name === app), `${app} not in ${r.apps.map((a) => a.name).join(', ')}`);
      return `${r.apps.length} apps, demo app "${app}" present`;
    });

    browser = await chromium.launch({ channel: 'chrome', headless: !args.includes('--headed') });
    const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'fa-IR' });
    await page.goto(base);
    await page.evaluate((name) => {
      localStorage.removeItem('liara-agent:session');
      localStorage.setItem('liara-agent:app', name);
    }, app);
    await page.reload();
    await page.getByPlaceholder('پیامتان را بنویسید…').waitFor({ timeout: 30_000 });

    await t.check('status question → Persian reply + tool timeline', async () => {
      const text = await sendAndWait(page, 'وضعیت این سرویس چطوره؟');
      const rows = await page.locator('[data-testid="assistant-turn"]').last().locator('[data-testid="timeline-row"]').count();
      await screenshot(page, 'status');
      assert(PERSIAN.test(text), 'reply has no Persian text');
      assert(rows >= 1, 'no tool rows in the timeline');
      const visible = await page.locator('main').innerText();
      assert(!/\{\s*"[a-zA-Z_]+"\s*:/.test(visible), 'raw JSON visible without expanding');
      return `${rows} tool row(s), ${text.length} chars`;
    });

    const audits = () => {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        return (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE tool = 'restart_app'").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };

    await t.check('«ری‌استارت کن» → approval card → reject → receipt, no audit row', async () => {
      const before = audits();
      const cards = await count(page, 'approval-card');
      await sendAndWait(page, 'ری‌استارت کن');
      assert((await count(page, 'approval-card')) > cards, 'no approval card');
      const receipts = await count(page, 'approval-receipt');
      await page.locator('[data-testid="approval-card"]').last().getByRole('button', { name: 'نه، فعلاً' }).click();
      await waitForMore(page, 'approval-receipt', receipts, 20_000);
      const receipt = await page.locator('[data-testid="approval-receipt"]').last().innerText();
      await screenshot(page, 'rejected');
      assert(receipt.includes('رد شد'), `receipt: ${receipt.slice(0, 80)}`);
      assert(audits() === before, 'an audit row was written for a rejected action');
      return 'rejected, audit unchanged';
    });

    await t.check('«ری‌استارت کن» → approve → restart ✓ → verify strip ≤ 60s', async () => {
      const okRows = await page.locator('[data-testid="timeline-row"][data-tool="restart_app"][data-status="ok"]').count();
      const strips = await count(page, 'verify-strip');
      const cards = await count(page, 'approval-card');
      const reply = await sendAndWait(page, 'ری‌استارت کن');
      assert((await count(page, 'approval-card')) > cards, `no new approval card; reply: ${reply.replace(/\s+/g, ' ').slice(-120)}`);
      const clicked = Date.now();
      await page.locator('[data-testid="approval-card"]').last().getByRole('button', { name: 'تأیید و اجرا' }).click();
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="timeline-row"][data-tool="restart_app"][data-status="ok"]').length > n,
        okRows,
        { timeout: 120_000, polling: 500 },
      );
      const ranAt = Date.now();
      await waitForMore(page, 'verify-strip', strips, 60_000);
      const strip = await page.locator('[data-testid="verify-strip"]').last().innerText();
      await screenshot(page, 'verified');
      return `restart ${Math.round((ranAt - clicked) / 1000)}s, verify +${Math.round((Date.now() - ranAt) / 1000)}s: ${strip.split('\n')[0]}`;
    });

    await t.check('access logs → limitation notice', async () => {
      const notices = await count(page, 'limitation');
      await sendAndWait(page, 'لاگ‌های دسترسی HTTP رو نشون بده');
      assert((await count(page, 'limitation')) > notices, 'no limitation notice');
      await screenshot(page, 'limitation');
      return (await page.locator('[data-testid="limitation"]').last().innerText()).slice(0, 70);
    });

    const alerted = await t.check(`chaos leak → critical alert within 3 watcher intervals (${watchSec}s each)`, async () => {
      await getJson(`${base}/api/watch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appName: app, on: true }) });
      chaosOn = true;
      const line = await chaos('leak');
      const limitMs = (3 * watchSec + 180) * 1000;
      const start = Date.now();
      while (Date.now() - start < limitMs) {
        const r = await getJson<{ alerts: { severity: string; title: string }[] }>(`${base}/api/alerts?appName=${app}`);
        const critical = r.alerts.find((a) => a.severity === 'critical');
        if (critical) return `${Math.round((Date.now() - start) / 1000)}s: ${critical.title} (${line.slice(0, 60)})`;
        await new Promise((res) => setTimeout(res, 5000));
      }
      throw new Error(`no critical alert after ${limitMs / 1000}s`);
    });

    if (alerted) {
      await t.check('alert banner visible after reload', async () => {
        await page.reload();
        await page.locator('[data-testid="alert-banner"]').waitFor({ timeout: 30_000 });
        await screenshot(page, 'alert-banner');
        return (await page.locator('[data-testid="alert-banner"]').innerText()).split('\n')[0]!;
      });
    } else {
      t.skip('alert banner visible after reload', 'no alert was raised');
    }
  } finally {
    if (chaosOn) {
      await t.check('chaos none → demo app restored', async () => chaos('none'));
    }
    await browser?.close().catch(() => undefined);
    await server?.stop();
  }
  return t;
}

function finish(t: Acceptance): void {
  const ok = t.print();
  console.log(`screenshots: ${path.relative(ROOT_DIR, SHOTS_DIR)}/`);
  process.exit(ok ? 0 : 1);
}

main()
  .then(finish)
  .catch((err) => {
    console.error('accept:prd03 crashed:', (err as Error).message);
    process.exit(1);
  });
