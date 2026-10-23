/**
 * Captures the README screenshots (docs/screenshots/*.png) from a RUNNING server.
 *
 *   npm run dev:sim & npm run shots                      simulator (prepares everything itself)
 *   npm run dev -- -p 3200 & npm run shots -- --url http://localhost:3200 --deploy ~/my-shop
 *                                                       live: run `npm run chaos -- leak --deploy` first;
 *                                                       --deploy creates a real app (costs money), optional
 *
 * Scenes: deploy wizard (stepper), incident (diagnosis + approval card), rollback (verify strip).
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { ROOT_DIR } from '../src/config';
import { count, getJson, sendAndWait, waitForMore } from './acceptance/prd03-helpers';

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const base = arg('--url') ?? 'http://localhost:3210';
const OUT = path.join(ROOT_DIR, 'docs', 'screenshots');

async function shot(page: Page, testId: string, name: string) {
  const el = page.locator(`[data-testid="${testId}"]`).last();
  await el.scrollIntoViewIfNeeded();
  await el.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  docs/screenshots/${name}.png`);
}

async function approveLast(page: Page) {
  const strips = await count(page, 'verify-strip');
  await page.locator('[data-testid="approval-card"]').last().getByRole('button', { name: 'تأیید و اجرا' }).click();
  await waitForMore(page, 'verify-strip', strips, 240_000);
}

async function waitDegraded(app: string) {
  for (let i = 0; i < 60; i++) {
    const { status } = await getJson<{ status: { level: string; memory: { pct: number | null } | null } }>(`${base}/api/apps/${app}/status?fresh=1`);
    if (status.level !== 'ok' || (status.memory?.pct ?? 0) >= 85) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${app} did not degrade within 5 minutes — is the chaos mode on?`);
}

async function main() {
  const health = await getJson<{ mode: string; demoAppName: string | null }>(`${base}/api/health`);
  const app = health.demoAppName;
  if (!app) throw new Error('no demo app (set DEMO_APP_NAME)');
  const sim = health.mode === 'simulated';
  let project = arg('--deploy');
  if (sim && !project) {
    project = path.join(ROOT_DIR, 'data', 'my-shop');
    rmSync(project, { recursive: true, force: true });
    cpSync(path.join(ROOT_DIR, 'demo-app'), project, { recursive: true });
    rmSync(path.join(project, 'liara.json'), { force: true });
  }
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: !args.includes('--headed') });
  // Tall viewport: cards live in the chat's scroll container and must fit in it to be captured whole.
  const page = await browser.newPage({ viewport: { width: 1280, height: 2400 }, deviceScaleFactor: 2, locale: 'fa-IR' });
  /** Fresh conversation about the demo app (the wizard may have switched the chat to the new app). */
  const freshChat = async () => {
    await page.evaluate((name) => {
      localStorage.removeItem('liara-agent:session');
      localStorage.setItem('liara-agent:app', name);
    }, app);
    await page.reload();
    await page.getByPlaceholder('پیامتان را بنویسید…').waitFor({ timeout: 30_000 });
  };
  try {
    await page.goto(base);
    await freshChat();

    if (project && existsSync(project)) {
      console.log(`deploy wizard: ${project}`);
      await sendAndWait(page, `این پروژه رو دیپلوی کن: ${project}`);
      await sendAndWait(page, 'PAYMENT_API_KEY=demo');
      if (await count(page, 'approval-card')) {
        await approveLast(page);
        await shot(page, 'deploy-progress', 'deploy');
      }
    }

    if (sim) await getJson(`${base}/api/dev/chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appName: app, mode: 'leak', deploy: true }) });
    console.log(`incident: waiting for ${app} to degrade…`);
    await waitDegraded(app);
    await freshChat();
    await sendAndWait(page, 'سایتم کند شده و گاهی ۵۰۰ می‌ده', 240_000);
    await shot(page, 'diagnosis-card', 'diagnosis');
    if (!(await count(page, 'approval-card'))) await sendAndWait(page, 'اقدام پیشنهادی را اجرا کن');
    await shot(page, 'approval-card', 'approval');
    await approveLast(page);
    await shot(page, 'verify-strip', 'verify');
  } finally {
    await browser.close();
    if (sim) await getJson(`${base}/api/dev/chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appName: app, mode: 'none' }) }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('shots failed:', (err as Error).message);
  process.exit(1);
});
