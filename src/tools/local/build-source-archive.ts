import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { create } from 'tar';
import { z } from 'zod';
import { MAX_SOURCE_BYTES } from '../../liara/endpoints/deploy';
import { appNameSchema, limitation, ok } from '../helpers';
import { defineTool } from '../registry';
import { detectPlatform } from './analyze/detect';
import { snapshotOf } from './analyze-project';
import { walkProject } from './files';
import { ProjectSourceError, resolveProjectPath } from './project-source';

export interface ArchiveResult {
  archivePath: string;
  sizeMB: number;
  fileCount: number;
  topLevel: string[];
  excludedSecrets: string[];
  platform: string;
}

/** Packs `dir` into `outFile` (gzip) honouring liara-cli ignore rules; never includes `.env` secrets. */
export async function buildArchive(dir: string, outFile: string): Promise<ArchiveResult> {
  const platform = detectPlatform(snapshotOf(dir, walkProject(dir, { maxFiles: 5000, maxDepth: 2 }).files)).platform;
  const walk = walkProject(dir, { platform });
  if (!walk.files.length) throw new Error('every file is ignored; check .gitignore / .liaraignore');
  mkdirSync(path.dirname(outFile), { recursive: true });
  await create({ gzip: { level: 9 }, cwd: dir, file: outFile, portable: true }, walk.files);
  return {
    archivePath: outFile,
    sizeMB: Math.round((statSync(outFile).size / 1048576) * 100) / 100,
    fileCount: walk.files.length,
    topLevel: [...new Set(walk.files.map((f) => f.split('/')[0]!))].slice(0, 30),
    excludedSecrets: walk.excludedSecrets,
    platform,
  };
}

export const buildSourceArchiveTool = defineTool({
  name: 'build_source_archive',
  title: 'Build source archive',
  description:
    'Pack a local project folder (or public git URL) into data/sources/<app>/<timestamp>.tar.gz for upload_source. Honours .gitignore/.liaraignore like liara-cli, skips node_modules/.git and never includes .env secret files. Local only; uploads nothing.',
  input: z.object({ path: z.string().min(1), appName: appNameSchema }),
  risk: 0,
  writesLocal: true,
  category: 'local',
  describeFa: ({ appName }) => `بسته‌بندی کد پروژه برای ${appName}`,
  run: async ({ path: p, appName }, ctx) => {
    let dir: string;
    try {
      dir = (await resolveProjectPath(p, { workdir: ctx.workdir, dataDir: ctx.dataDir })).dir;
    } catch (err) {
      if (err instanceof ProjectSourceError) return err.limitation ? limitation(err.userMessageFa, err.message) : { ok: false, error: err.message, userMessageFa: err.userMessageFa };
      throw err;
    }
    const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
    const result = await buildArchive(dir, path.join(ctx.dataDir, 'sources', appName, `${stamp}.tar.gz`));
    if (result.sizeMB * 1048576 > MAX_SOURCE_BYTES) {
      return limitation('حجم بسته‌ی کد بیشتر از ۲۵۶ مگابایت شد و لیارا آن را نمی‌پذیرد؛ پوشه‌های بزرگ را در .liaraignore بگذارید.', 'archive exceeds 256 MiB');
    }
    const secrets = result.excludedSecrets.length ? `؛ فایل‌های محرمانه (${result.excludedSecrets.join('، ')}) کنار گذاشته شدند` : '';
    return ok(result, `بسته‌ی کد آماده شد: ${result.fileCount} فایل، ${result.sizeMB} مگابایت${secrets}.`);
  },
});
