import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { limitation, ok } from '../helpers';
import { defineTool } from '../registry';
import { detectCommands, detectPlatform, detectPort, detectVersions, readJson, type DetectedPlatform, type ProjectSnapshot } from './analyze/detect';
import { detectDatabase, detectDiskNeed, scanEnvKeys, type DatabaseKind, type EnvKey } from './analyze/env-scan';
import { walkProject } from './files';
import { isStaticPlatform } from './platforms';
import { ProjectSourceError, resolveProjectPath } from './project-source';

export interface ProjectAnalysis {
  path: string;
  isGit: boolean;
  defaultBranch?: string;
  platform: DetectedPlatform;
  confidence: number;
  evidence: string[];
  port: number | null;
  startCommand?: string;
  buildCommand?: string;
  nodeVersion?: string;
  pythonVersion?: string;
  envKeys: EnvKey[];
  needsDatabase: DatabaseKind | null;
  needsDisk: boolean;
  existingLiaraJson?: Record<string, unknown>;
  sizeMB: number;
  fileCount: number;
  warnings: string[];
}

export const PLATFORM_FA: Record<string, string> = {
  node: 'Node.js',
  next: 'Next.js',
  react: 'React',
  vue: 'Vue',
  angular: 'Angular',
  static: 'سایت ایستا (HTML)',
  laravel: 'Laravel',
  php: 'PHP',
  django: 'Django',
  flask: 'Flask',
  python: 'Python',
  dotnet: '.NET',
  go: 'Go',
  docker: 'Docker',
  unknown: 'ناشناخته',
};

const MAX_READ_BYTES = 512 * 1024;

export function snapshotOf(dir: string, files: string[]): ProjectSnapshot {
  return {
    files,
    read: (rel) => {
      const abs = path.join(dir, rel);
      if (!abs.startsWith(dir) || !existsSync(abs)) return null;
      try {
        if (statSync(abs).size > MAX_READ_BYTES) return null;
        return readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Full local analysis of a project folder (no network). */
export function analyzeDir(dir: string): ProjectAnalysis {
  const walk = walkProject(dir, { maxFiles: 20_000 });
  const snap = snapshotOf(dir, walk.files);
  const detection = detectPlatform(snap);
  const { port, evidence: portEvidence } = detectPort(snap, detection.platform);
  const db = detectDatabase(snap);
  const disk = detectDiskNeed(snap);
  const head = existsSync(path.join(dir, '.git/HEAD')) ? readFileSync(path.join(dir, '.git/HEAD'), 'utf8') : '';
  const warnings: string[] = [];
  const pkg = readJson<{ scripts?: Record<string, string> }>(snap, 'package.json');
  if ((detection.platform === 'node' || detection.platform === 'next') && !pkg?.scripts?.start) warnings.push('package.json has no "start" script; Liara runs `npm start`');
  if (isStaticPlatform(detection.platform) && detection.platform !== 'static' && !pkg?.scripts?.build) warnings.push('no "build" script for a front-end project');
  if (detection.platform === 'static' && !walk.files.includes('index.html')) warnings.push('no index.html at the project root');
  if (detection.platform === 'docker' && port === null) warnings.push('Dockerfile has no EXPOSE; the port must be set explicitly');
  if (detection.platform === 'unknown') warnings.push('could not recognise the project type');
  if (walk.excludedSecrets.length) warnings.push(`${walk.excludedSecrets.join(', ')} will NOT be uploaded; set those values as environment variables instead`);
  if (walk.totalBytes > 200 * 1024 * 1024) warnings.push('project is larger than 200MB; Liara accepts at most 256MB per upload');
  if (walk.truncated) warnings.push('project has too many files; analysis used the first 20,000');
  if (db.kind) warnings.push(`needs a ${db.kind} database (${db.evidence})`);
  const liaraJson = readJson(snap, 'liara.json') ?? undefined;
  return {
    path: dir,
    isGit: existsSync(path.join(dir, '.git')),
    defaultBranch: /ref: refs\/heads\/(.+)/.exec(head)?.[1]?.trim(),
    platform: detection.platform,
    confidence: detection.confidence,
    evidence: [...detection.evidence, portEvidence, ...(disk.evidence ? [disk.evidence] : [])],
    port,
    ...detectCommands(snap),
    ...detectVersions(snap),
    envKeys: scanEnvKeys(snap),
    needsDatabase: db.kind,
    needsDisk: disk.needsDisk,
    existingLiaraJson: liaraJson,
    sizeMB: Math.round((walk.totalBytes / 1048576) * 100) / 100,
    fileCount: walk.files.length,
    warnings,
  };
}

export function analysisSummaryFa(a: ProjectAnalysis): string {
  const required = a.envKeys.filter((k) => k.required).map((k) => k.key);
  const parts = [`پروژه‌ی ${PLATFORM_FA[a.platform] ?? a.platform}`];
  if (a.port) parts.push(`پورت ${a.port}`);
  if (required.length) parts.push(`${required.length} متغیر محیطی لازم دارد: ${required.slice(0, 6).join('، ')}${required.length > 6 ? '…' : ''}`);
  if (a.needsDatabase) parts.push(`به پایگاه داده‌ی ${a.needsDatabase} نیاز دارد`);
  if (a.needsDisk) parts.push('به دیسک ماندگار (برای ذخیره‌ی فایل) نیاز دارد');
  return `${parts.join('، ')}.`;
}

export const analyzeProjectTool = defineTool({
  name: 'analyze_project',
  title: 'Analyze project',
  description:
    'Inspect a local project folder or a public git URL (cloned depth 1): platform (+confidence and evidence), port, start/build commands, runtime versions, required env vars, database/disk needs, size and warnings. Run first in every deploy.',
  input: z.object({ path: z.string().min(1).describe('Local folder path (absolute, relative or ~/…) or https://github.com/user/repo') }),
  risk: 0,
  category: 'local',
  describeFa: ({ path: p }) => `تحلیل پروژه (${p})`,
  run: async ({ path: p }, ctx) => {
    try {
      const { dir } = await resolveProjectPath(p, { workdir: ctx.workdir, dataDir: ctx.dataDir });
      const analysis = analyzeDir(dir);
      return ok(analysis, analysisSummaryFa(analysis));
    } catch (err) {
      if (err instanceof ProjectSourceError) return err.limitation ? limitation(err.userMessageFa, err.message) : { ok: false, error: err.message, userMessageFa: err.userMessageFa };
      throw err;
    }
  },
});
