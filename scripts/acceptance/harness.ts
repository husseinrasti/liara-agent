/** Tiny PASS/FAIL harness shared by the acceptance scripts. */
import { spawn } from 'node:child_process';

export interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export class Acceptance {
  readonly results: CheckResult[] = [];

  constructor(readonly title: string) {}

  /** Runs one check; `fn` returns a detail string (or throws / returns false-ish detail via AssertionError). */
  async check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
    const started = Date.now();
    process.stderr.write(`… ${name}\n`);
    try {
      const detail = (await fn()) ?? '';
      this.results.push({ name, ok: true, ms: Date.now() - started, detail });
      return true;
    } catch (err) {
      this.results.push({ name, ok: false, ms: Date.now() - started, detail: (err as Error).message.split('\n')[0]!.slice(0, 160) });
      return false;
    }
  }

  skip(name: string, reason: string): void {
    this.results.push({ name, ok: false, ms: 0, detail: `SKIPPED: ${reason}` });
  }

  print(): boolean {
    const rows = this.results.map((r, i) => [String(i + 1), r.ok ? 'PASS' : 'FAIL', r.name, `${(r.ms / 1000).toFixed(1)}s`, r.detail]);
    const header = ['#', 'result', 'check', 'time', 'detail'];
    const widths = header.map((h, i) => Math.min(70, Math.max(h.length, ...rows.map((r) => r[i]!.length))));
    const fmt = (cols: string[]) => cols.map((c, i) => c.slice(0, widths[i]).padEnd(widths[i]!)).join('  ');
    console.log(`\n${this.title}\n`);
    console.log(fmt(header));
    console.log(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const r of rows) console.log(fmt(r));
    const failed = this.results.filter((r) => !r.ok).length;
    console.log(`\n${this.results.length - failed}/${this.results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
    return failed === 0;
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** Runs a command, capturing output; resolves with exit code. */
export function runCommand(cmd: string, args: string[], cwd: string, timeoutMs = 300_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}
