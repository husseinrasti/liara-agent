/** Small deploy helpers: app-name suggestion, liara.json writer, runtime version config. */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SUPPORTED_NODE = [18, 20, 22, 24];
const SUPPORTED_PYTHON = ['3.9', '3.10', '3.11', '3.12', '3.13'];

/** Liara app name from a folder/package name: lowercase [a-z0-9-], starts with a letter, 3–30 chars. */
export function suggestAppName(source: string, taken: string[] = [], random: () => number = Math.random): string {
  let base = path
    .basename(source.replace(/\.git$/, '').replace(/\/+$/, ''))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!/^[a-z]/.test(base)) base = `app-${base}`.replace(/-$/, '');
  if (base.length < 3) base = `${base}-app`;
  base = base.slice(0, 27).replace(/-$/, '');
  if (!taken.includes(base)) return base;
  for (let i = 0; i < 20; i++) {
    const suffix = Math.floor(random() * 1296).toString(36).padStart(2, '0');
    const name = `${base}-${suffix}`;
    if (!taken.includes(name)) return name;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

/** platformConfig for the release body, only when the detected version is one Liara supports. */
export function versionConfig(platform: string, versions: { nodeVersion?: string; pythonVersion?: string }): Record<string, string | number> | undefined {
  if ((platform === 'node' || platform === 'next') && versions.nodeVersion) {
    const major = Number(/(\d{1,2})/.exec(versions.nodeVersion)?.[1]);
    return SUPPORTED_NODE.includes(major) ? { version: major } : undefined;
  }
  if (['python', 'django', 'flask'].includes(platform) && versions.pythonVersion) {
    const minor = /(\d)\.(\d{1,2})/.exec(versions.pythonVersion)?.slice(1, 3).join('.');
    return minor && SUPPORTED_PYTHON.includes(minor) ? { pythonVersion: minor } : undefined;
  }
  return undefined;
}

/** Writes liara.json into the project when it is missing. Never overwrites an existing one. */
export function ensureLiaraJson(
  dir: string,
  cfg: { app: string; platform: string; port: number; versions?: { nodeVersion?: string; pythonVersion?: string } },
): { written: boolean; path: string } {
  const file = path.join(dir, 'liara.json');
  if (existsSync(file)) return { written: false, path: file };
  const body: Record<string, unknown> = { app: cfg.app, platform: cfg.platform, port: cfg.port };
  const version = cfg.versions ? versionConfig(cfg.platform, cfg.versions) : undefined;
  if (version) body[cfg.platform === 'next' ? 'next' : cfg.platform] = version;
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return { written: true, path: file };
}
