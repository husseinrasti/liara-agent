import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Public git hosting URLs we are willing to clone (https only, no credentials in the URL). */
export const GIT_URL_RE = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/;

export class ProjectSourceError extends Error {
  override name = 'ProjectSourceError';
  constructor(
    message: string,
    readonly userMessageFa: string,
    readonly limitation = false,
  ) {
    super(message);
  }
}

/** Resolves a local folder or clones a public git URL (depth 1) into `<data>/clones/<hash>`. */
export async function resolveProjectPath(input: string, opts: { workdir: string; dataDir: string }): Promise<{ dir: string; gitUrl?: string }> {
  const trimmed = input.trim();
  if (/^https?:\/\//.test(trimmed) || trimmed.startsWith('git@')) {
    if (!GIT_URL_RE.test(trimmed)) {
      throw new ProjectSourceError(
        `unsupported git URL: ${trimmed}`,
        'فقط آدرس عمومی https از GitHub، GitLab یا Bitbucket را می‌توانم دریافت کنم (مثلاً https://github.com/user/repo).',
        true,
      );
    }
    const dir = path.join(opts.dataDir, 'clones', createHash('sha1').update(trimmed).digest('hex').slice(0, 12));
    if (!existsSync(path.join(dir, '.git'))) {
      mkdirSync(path.dirname(dir), { recursive: true });
      try {
        await run('git', ['clone', '--depth', '1', '--', trimmed, dir], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      } catch (err) {
        throw new ProjectSourceError(
          `git clone failed: ${(err as Error).message.split('\n')[0]}`,
          'دریافت مخزن ناموفق بود؛ احتمالاً مخزن خصوصی است یا در دسترس نیست. لطفاً مسیر پوشه‌ی پروژه روی همین سیستم را بدهید.',
          true,
        );
      }
    }
    return { dir, gitUrl: trimmed };
  }
  const expanded = trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  const dir = path.resolve(opts.workdir, expanded);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ProjectSourceError(`project folder not found: ${dir}`, `پوشه‌ی پروژه پیدا نشد: ${dir}`);
  }
  return { dir };
}
