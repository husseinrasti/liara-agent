/**
 * Project file walking with the same ignore semantics as liara-cli's archive:
 * defaults + platform ignores + per-directory `.liaraignore` > `.dockerignore` > `.gitignore`.
 * Additionally excludes `.env*` secrets files (values belong in update_envs, not in the upload).
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export const DEFAULT_IGNORES = ['.git', '.idea', '.vscode', '.next', '.dockerignore', '*.*~', 'liara.json', 'node_modules', 'bower_components', '.DS_Store'];

const PYTHON_IGNORES = ['venv', '/venv', '.venv', 'ENV', '.python-version', '.cache', '__pycache__', 'lib', 'lib64', '*.py[cod]', '*$py.class', 'pip-log.txt', 'celerybeat-schedule'];

export const PLATFORM_IGNORES: Record<string, string[]> = {
  django: [...PYTHON_IGNORES, '*.log', 'local_settings.py', 'staticfiles'],
  flask: [...PYTHON_IGNORES, 'instance', '.webassets-cache'],
  python: PYTHON_IGNORES,
  laravel: ['/vendor'],
  php: ['/vendor'],
  dotnet: ['Debug', 'debug', 'Release', 'release', 'x64', 'x86', 'build', 'bld', 'Bin', 'bin', 'Obj', 'obj'],
};

/** Secret-bearing files never included in uploads (examples/templates are kept). */
export const SECRET_FILE = /^\.env(\..+)?$/;
const SECRET_FILE_KEEP = /^\.env\.(example|sample|template|dist)$/;

export interface WalkResult {
  /** posix paths relative to root */
  files: string[];
  totalBytes: number;
  truncated: boolean;
  /** secret files that were present and excluded */
  excludedSecrets: string[];
}

function loadIgnoreFile(ig: Ignore, root: string, dirRel: string): void {
  for (const name of ['.liaraignore', '.dockerignore', '.gitignore']) {
    const file = path.join(root, dirRel, name);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    // Patterns of nested ignore files are rebased onto the project root (like liara-cli).
    const rebased = lines.map((p) => {
      const neg = p.startsWith('!');
      let body = neg ? p.slice(1) : p;
      const anchored = body.startsWith('/');
      if (anchored) body = body.slice(1);
      const rel = dirRel ? `${dirRel}/${body}` : body;
      return `${neg ? '!' : ''}${anchored || dirRel ? '/' : ''}${rel}`;
    });
    ig.add(rebased);
    return; // only the highest-priority ignore file per directory, as the CLI does
  }
}

export function walkProject(root: string, opts: { platform?: string; maxFiles?: number; maxDepth?: number } = {}): WalkResult {
  const ig = ignore({ ignorecase: false }).add(DEFAULT_IGNORES).add(PLATFORM_IGNORES[opts.platform ?? ''] ?? []);
  const maxFiles = opts.maxFiles ?? 50_000;
  const maxDepth = opts.maxDepth ?? 30;
  const files: string[] = [];
  const excludedSecrets: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const visit = (dirRel: string, depth: number) => {
    if (truncated) return;
    loadIgnoreFile(ig, root, dirRel);
    let entries: string[];
    try {
      entries = readdirSync(path.join(root, dirRel)).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const rel = dirRel ? `${dirRel}/${name}` : name;
      const st = lstatSync(path.join(root, rel));
      if (st.isSymbolicLink()) continue;
      const isDir = st.isDirectory();
      if (ig.ignores(isDir ? `${rel}/` : rel)) continue;
      if (!isDir && SECRET_FILE.test(name) && !SECRET_FILE_KEEP.test(name)) {
        excludedSecrets.push(rel);
        continue;
      }
      if (isDir) {
        if (depth < maxDepth) visit(rel, depth + 1);
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(rel);
      totalBytes += st.size;
    }
  };
  visit('', 0);
  return { files, totalBytes, truncated, excludedSecrets };
}
