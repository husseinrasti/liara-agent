import WebSocket from 'ws';
import { redactText } from '../../logger';
import type { LiaraClient } from '../client';
import { LiaraApiError } from '../errors';

/** Read-only commands allowed in the MVP console (exec_shell is risk 2 anyway). */
const ALLOWED: Record<string, (args: string[]) => boolean> = {
  ls: () => true,
  cat: (a) => a.length > 0,
  head: () => true,
  tail: () => true,
  wc: () => true,
  df: (a) => a.every((x) => x === '-h'),
  free: (a) => a.every((x) => x === '-m' || x === '-h'),
  ps: (a) => a.every((x) => /^(-?[a-zA-Z]+)$/.test(x)),
  env: (a) => a.length === 0,
  node: (a) => a.length === 1 && (a[0] === '-v' || a[0] === '--version'),
  npm: (a) => a.length === 2 && a[0] === 'ls' && a[1] === '--depth=0',
};

const SAFE_CHARS = /^[A-Za-z0-9 ._\-/=:@,+]+$/;
const SENSITIVE_PATH = /(^|\/)\.env|\.pem$|\.key$|id_rsa|id_ed25519|\/environ$|shadow$|\.npmrc$|credentials/i;
const SECRET_KEY = /secret|password|passwd|token|api[_-]?key|private|pass$|auth/i;
export const MAX_SHELL_OUTPUT = 4096;

export type ShellValidation = { ok: true; argv: string[] } | { ok: false; reason: string };

export function validateShellCommand(command: string): ShellValidation {
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: 'empty command' };
  if (cmd.length > 200) return { ok: false, reason: 'command too long' };
  if (!SAFE_CHARS.test(cmd)) return { ok: false, reason: 'shell operators, quotes, globs and variables are not allowed' };
  const argv = cmd.split(/\s+/);
  const [bin, ...args] = argv as [string, ...string[]];
  const rule = ALLOWED[bin];
  if (!rule) return { ok: false, reason: `"${bin}" is not in the read-only allow-list (${Object.keys(ALLOWED).join(', ')})` };
  if (!rule(args)) return { ok: false, reason: `arguments not allowed for "${bin}"` };
  if (args.some((a) => SENSITIVE_PATH.test(a))) return { ok: false, reason: 'reading secret files is not allowed' };
  return { ok: true, argv };
}

/** Strips terminal noise and redacts KEY=VALUE secrets (all values for `env`). */
export function cleanShellOutput(command: string, raw: string): string {
  const isEnv = command.trim() === 'env';
  return raw
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() !== command.trim() && l.trim() !== 'exit' && !/^[#$] ?$/.test(l.trim()))
    .map((l) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
      if (m && (isEnv || SECRET_KEY.test(m[1]!))) return `${m[1]}=••••`;
      return l;
    })
    .join('\n')
    .trim();
}

export interface ShellResult {
  output: string;
  truncated: boolean;
  exitedCleanly: boolean;
}

/**
 * Runs one allow-listed command in the app container over Liara's console
 * WebSocket, the same protocol liara-cli `app shell` uses:
 * `wss://api.iran.liara.ir/v1/exec?token=…&cmd=<command>&project_id=<app name>`,
 * then `{"action":"start",cols,rows}`; output arrives as raw frames until close.
 */
export async function execShell(
  c: LiaraClient,
  appName: string,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<ShellResult> {
  const check = validateShellCommand(command);
  if (!check.ok) throw new Error(`command rejected: ${check.reason}`);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const url = c.consoleSocketUrl({ cmd: check.argv.join(' '), project_id: appName });
  return new Promise<ShellResult>((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    let buf = '';
    let settled = false;
    const finish = (clean: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      const out = cleanShellOutput(command, buf);
      resolve({ output: out.slice(0, MAX_SHELL_OUTPUT), truncated: out.length > MAX_SHELL_OUTPUT, exitedCleanly: clean });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.on('open', () => {
      setTimeout(() => {
        if (!settled) ws.send(JSON.stringify({ action: 'start', cols: 160, rows: 48 }));
      }, 1000);
    });
    ws.on('message', (data) => {
      buf += data.toString();
      if (buf.length > 64_000) finish(false);
    });
    ws.on('close', () => finish(true));
    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LiaraApiError({ status: 0, endpoint: 'WS console', message: redactText(err.message), code: 'NETWORK' }));
    });
  });
}
