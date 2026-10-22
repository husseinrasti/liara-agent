/** Pure project detection over a ProjectSnapshot (testable without a filesystem). */
import { defaultPort, type Platform } from '../platforms';

export interface ProjectSnapshot {
  /** posix paths relative to the project root (already filtered by ignore rules) */
  files: string[];
  /** reads a small text file relative to the root, or null */
  read: (rel: string) => string | null;
}

export type DetectedPlatform = Platform | 'unknown';

export interface PlatformDetection {
  platform: DetectedPlatform;
  confidence: number;
  evidence: string[];
}

export function readJson<T = Record<string, unknown>>(snap: ProjectSnapshot, rel: string): T | null {
  const text = snap.read(rel);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

export function allDeps(pkg: PackageJson | null): Record<string, string> {
  return { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
}

const has = (snap: ProjectSnapshot, rel: string) => snap.files.includes(rel);
const PLATFORM_IDS = new Set(['node', 'next', 'react', 'vue', 'angular', 'static', 'laravel', 'php', 'django', 'flask', 'python', 'dotnet', 'go', 'docker']);

/** Detection order follows PRD-01 §2.3: liara.json → Dockerfile → package.json → composer → python → .NET → Go → static. */
export function detectPlatform(snap: ProjectSnapshot): PlatformDetection {
  const liara = readJson<{ platform?: string }>(snap, 'liara.json');
  if (liara?.platform && PLATFORM_IDS.has(liara.platform)) {
    return { platform: liara.platform as Platform, confidence: 0.95, evidence: [`liara.json says platform "${liara.platform}"`] };
  }
  if (has(snap, 'Dockerfile')) return { platform: 'docker', confidence: 0.85, evidence: ['Dockerfile at project root'] };

  const pkg = readJson<PackageJson>(snap, 'package.json');
  if (pkg) {
    const deps = allDeps(pkg);
    if (deps.next) return { platform: 'next', confidence: 0.9, evidence: ['package.json has the "next" dependency'] };
    if (deps['@angular/core']) return { platform: 'angular', confidence: 0.85, evidence: ['package.json has "@angular/core"'] };
    if (deps.nuxt) return { platform: 'node', confidence: 0.7, evidence: ['package.json has "nuxt" (server-rendered → node)'] };
    if (deps.vue && (deps.vite || deps['@vue/cli-service'])) return { platform: 'vue', confidence: 0.8, evidence: ['package.json has "vue" with a bundler'] };
    if (deps['react-scripts']) return { platform: 'react', confidence: 0.85, evidence: ['package.json has "react-scripts" (Create React App)'] };
    if (deps.react && deps.vite && !deps.express) return { platform: 'react', confidence: 0.8, evidence: ['package.json has "react" + "vite" (single-page app)'] };
    const evidence = ['package.json present'];
    if (pkg.scripts?.start) evidence.push(`start script: "${pkg.scripts.start}"`);
    for (const fw of ['express', 'fastify', 'koa', '@nestjs/core', 'hapi', '@hapi/hapi']) if (deps[fw]) evidence.push(`uses ${fw}`);
    return { platform: 'node', confidence: pkg.scripts?.start || evidence.length > 1 ? 0.8 : 0.55, evidence };
  }

  const composer = readJson<{ require?: Record<string, string> }>(snap, 'composer.json');
  if (composer) {
    if (composer.require?.['laravel/framework'] || has(snap, 'artisan')) return { platform: 'laravel', confidence: 0.9, evidence: ['composer.json requires laravel/framework'] };
    return { platform: 'php', confidence: 0.75, evidence: ['composer.json present'] };
  }

  const requirements = (snap.read('requirements.txt') ?? '') + (snap.read('pyproject.toml') ?? '') + (snap.read('Pipfile') ?? '');
  if (has(snap, 'manage.py')) return { platform: 'django', confidence: 0.85, evidence: ['manage.py present (Django)'] };
  if (/^\s*flask\b/im.test(requirements) || /["']flask/i.test(requirements)) return { platform: 'flask', confidence: 0.8, evidence: ['Flask in Python requirements'] };
  if (requirements.trim()) return { platform: 'python', confidence: 0.65, evidence: ['Python requirements/pyproject present'] };

  if (snap.files.some((f) => f.endsWith('.csproj'))) return { platform: 'dotnet', confidence: 0.85, evidence: ['.csproj project file present'] };
  if (has(snap, 'go.mod')) return { platform: 'go', confidence: 0.85, evidence: ['go.mod present'] };
  if (snap.files.some((f) => f.endsWith('.php'))) return { platform: 'php', confidence: 0.6, evidence: ['PHP files present'] };
  if (has(snap, 'index.html')) return { platform: 'static', confidence: 0.7, evidence: ['index.html at root and no server code'] };
  return { platform: 'unknown', confidence: 0.2, evidence: ['no known project markers found'] };
}

/** Port: liara.json → Dockerfile EXPOSE → literal default in the node entry file → platform default. */
export function detectPort(snap: ProjectSnapshot, platform: DetectedPlatform): { port: number | null; evidence: string } {
  const liara = readJson<{ port?: number }>(snap, 'liara.json');
  if (liara?.port) return { port: Number(liara.port), evidence: `liara.json port ${liara.port}` };
  const docker = snap.read('Dockerfile');
  const expose = docker ? /^\s*EXPOSE\s+(\d{2,5})/im.exec(docker) : null;
  if (expose) return { port: Number(expose[1]), evidence: `Dockerfile EXPOSE ${expose[1]}` };
  if (platform === 'node') {
    const pkg = readJson<PackageJson>(snap, 'package.json');
    const startFile = /node\s+([\w./-]+\.[cm]?js)/.exec(pkg?.scripts?.start ?? '')?.[1];
    for (const f of [startFile, pkg?.main, 'index.js', 'server.js', 'app.js', 'src/index.js', 'src/server.js', 'src/app.js', 'src/index.ts', 'src/main.ts'].filter(Boolean) as string[]) {
      const code = snap.read(f.replace(/^\.\//, ''));
      if (!code) continue;
      const m =
        /PORT\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/.exec(code) ?? /\.listen\(\s*(\d{2,5})\b/.exec(code) ?? /port\s*[:=]\s*(\d{2,5})\b/i.exec(code);
      if (m) return { port: Number(m[1]), evidence: `${f} listens on ${m[1]} by default` };
    }
  }
  if (platform === 'unknown') return { port: null, evidence: 'platform unknown' };
  return { port: defaultPort(platform), evidence: `default port for ${platform}` };
}

export function detectVersions(snap: ProjectSnapshot): { nodeVersion?: string; pythonVersion?: string } {
  const pkg = readJson<PackageJson>(snap, 'package.json');
  const nodeVersion = pkg?.engines?.node ?? snap.read('.nvmrc')?.trim() ?? snap.read('.node-version')?.trim() ?? undefined;
  const runtime = snap.read('runtime.txt')?.trim();
  const pythonVersion = runtime?.replace(/^python-/, '') ?? snap.read('.python-version')?.trim() ?? undefined;
  return { nodeVersion: nodeVersion || undefined, pythonVersion: pythonVersion || undefined };
}

export function detectCommands(snap: ProjectSnapshot): { startCommand?: string; buildCommand?: string } {
  const pkg = readJson<PackageJson>(snap, 'package.json');
  if (pkg) return { startCommand: pkg.scripts?.start, buildCommand: pkg.scripts?.build };
  const procfile = snap.read('Procfile');
  const web = procfile ? /^web:\s*(.+)$/m.exec(procfile)?.[1] : undefined;
  return { startCommand: web };
}
