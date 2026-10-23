/** Server + browser helpers for the PRD-03 UI acceptance. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { ROOT_DIR } from '../../src/config';

export const SHOTS_DIR = path.join(ROOT_DIR, 'data', 'accept-prd03');

export interface Server {
  url: string;
  proc: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

/** Starts `next start` on the given port and waits for /api/health to answer. */
export async function startServer(port: number, env: Record<string, string>, timeoutMs = 90_000): Promise<Server> {
  const proc = spawn('npx', ['next', 'start', '-p', String(port)], { cwd: ROOT_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout?.on('data', (d) => (out = (out + d).slice(-20_000)));
  proc.stderr?.on('data', (d) => (out = (out + d).slice(-20_000)));
  const url = `http://localhost:${port}`;
  const stop = () =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
    });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`next start exited (${proc.exitCode}): ${out.slice(-300)}`);
    const ok = await fetch(`${url}/api/apps`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.status < 500)
      .catch(() => false);
    if (ok) return { url, proc, output: () => out, stop };
    await new Promise((r) => setTimeout(r, 1000));
  }
  await stop();
  throw new Error(`server did not start within ${timeoutMs / 1000}s: ${out.slice(-300)}`);
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

let shot = 0;
export async function screenshot(page: Page, name: string): Promise<string> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${String(++shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return path.relative(ROOT_DIR, file);
}

export const PERSIAN = /[\u0600-\u06FF]/;

const count = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`).count();

/** Waits until no turn is streaming (the composer refuses to send while busy). */
export async function waitIdle(page: Page, timeoutMs = 180_000): Promise<void> {
  await page.locator('[data-testid="composer"][data-busy="false"]').waitFor({ timeout: timeoutMs });
}

/** Sends a message once the chat is idle and waits for the reply turn that follows it to finish. */
export async function sendAndWait(page: Page, text: string, timeoutMs = 150_000): Promise<string> {
  await waitIdle(page);
  const users = await count(page, 'user-message');
  const box = page.getByPlaceholder('پیامتان را بنویسید…');
  await box.fill(text);
  await box.press('Enter');
  await page.waitForFunction(
    (n) => {
      if (document.querySelectorAll('[data-testid="user-message"]').length <= n) return false;
      const items = document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-turn"]');
      const last = items[items.length - 1];
      return last?.getAttribute('data-testid') === 'assistant-turn' && last.getAttribute('data-done') === 'true';
    },
    users,
    { timeout: timeoutMs, polling: 500 },
  );
  return page.locator('[data-testid="assistant-turn"]').last().innerText();
}

/** Waits until more elements with the test id exist than `before`. */
export async function waitForMore(page: Page, testId: string, before: number, timeoutMs: number): Promise<void> {
  await page.waitForFunction(([id, n]) => document.querySelectorAll(`[data-testid="${id}"]`).length > (n as number), [testId, before] as const, { timeout: timeoutMs, polling: 500 });
}

export { count };
