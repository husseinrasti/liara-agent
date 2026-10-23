import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { linkSourceRelease, recordSource, sourceForRelease, sourcesFor } from '../../db/repo';
import type { DeployStage } from '../../events';
import { getReleases } from '../../liara/endpoints/apps';
import { deployRelease, MAX_SOURCE_BYTES, RELEASE_READY, ReleaseWaitError, uploadSource, waitForRelease } from '../../liara/endpoints/deploy';
import type { Release, ReleasesPage } from '../../liara/types';
import { appNameSchema, clip, limitation, ok } from '../helpers';
import { defaultPort, platformSchema } from '../local/platforms';
import { defineTool, type ToolContext, type ToolResult, type VerifyOutcome } from '../registry';
import { sinceOf } from './apps';
import { verifyAppHealthy } from './checks';

const RELEASE_STATE_FA: Record<string, string> = {
  QUEUED: 'در صف ساخت',
  BUILDING: 'در حال ساخت (بیلد)',
  PUSHING: 'در حال آماده‌سازی ایمیج',
  DEPLOYING: 'در حال اجرا روی سرور',
  READY: 'آماده و در حال اجرا',
  FAILED: 'ناموفق',
  CANCELED: 'لغو شده',
  TIMEDOUT: 'زمان ساخت تمام شد',
  UNHEALTHY: 'ناسالم (برنامه بالا نیامد)',
};
export const releaseStateFa = (s: string) => RELEASE_STATE_FA[s.toUpperCase()] ?? s;

export function progress(ctx: ToolContext, stage: DeployStage, status: 'pending' | 'running' | 'done' | 'failed', detail?: string) {
  ctx.emit?.({ type: 'deploy_progress', stage, status, detail });
}

/** Archives may only be read from `<data>/` (where build_source_archive writes them). */
export function resolveArchivePath(ctx: ToolContext, p: string): string {
  const abs = path.resolve(ctx.workdir, p);
  const dataDir = path.resolve(ctx.dataDir);
  if (!abs.startsWith(dataDir + path.sep)) throw new Error(`archive must be inside ${dataDir} (use build_source_archive)`);
  if (!/\.(tar\.gz|tgz)$/.test(abs)) throw new Error('archive must be a .tar.gz file');
  if (!existsSync(abs)) throw new Error(`archive not found: ${abs}`);
  return abs;
}

export const uploadSourceTool = defineTool({
  name: 'upload_source',
  title: 'Upload source archive',
  description:
    'Upload a .tar.gz source archive produced by build_source_archive to the app; returns a sourceID for deploy_release. The running site does not change until deploy_release.',
  input: z.object({ appName: appNameSchema, archivePath: z.string().min(1).describe('Path returned by build_source_archive') }),
  risk: 1,
  category: 'deploy',
  describeFa: ({ appName }) => `آپلود کد روی سرویس ${appName}`,
  consequencesFa: async ({ archivePath }, ctx) => {
    const sizeMB = +(statSync(resolveArchivePath(ctx, archivePath)).size / 1048576).toFixed(1);
    return { why: `بسته‌ی کد (${sizeMB} مگابایت) روی لیارا آپلود می‌شود. تا وقتی انتشار انجام نشود، سایت فعلی تغییری نمی‌کند.`, reversible: true };
  },
  snapshot: async (_i, ctx) => ({ at: ctx.now().toISOString() }),
  run: async ({ appName, archivePath }, ctx) => {
    const file = resolveArchivePath(ctx, archivePath);
    const size = statSync(file).size;
    if (size > MAX_SOURCE_BYTES) return limitation('حجم بسته‌ی کد بیشتر از ۲۵۶ مگابایت است و لیارا آن را نمی‌پذیرد؛ پوشه‌های اضافی را در .liaraignore بگذارید.', 'archive exceeds 256 MiB');
    const sourceID = await uploadSource(ctx.liara, appName, readFileSync(file), path.basename(file));
    recordSource(ctx.db, { appName, sourceID, archivePath: file, createdAt: ctx.now().toISOString() });
    const sizeMB = +(size / 1048576).toFixed(2);
    return ok({ sourceID, sizeMB }, `کد آپلود شد (${sizeMB} مگابایت).`);
  },
  verify: async ({ appName }, before, ctx, result) => {
    const id = result?.ok ? result.data.sourceID : undefined;
    const row = sourcesFor(ctx.db, appName).find((r) => (id ? r.sourceID === id : r.createdAt >= sinceOf(before, ctx).toISOString()));
    return { ok: Boolean(row), evidence: [row ? `کد با شناسه‌ی ${row.sourceID} روی لیارا ثبت شد` : 'شناسه‌ی آپلود پیدا نشد'] };
  },
  verifyDelayMs: 0,
});

export async function waitAndReport(ctx: ToolContext, appName: string, releaseID: string): Promise<ToolResult<{ releaseID: string; state: string; tag: string | null }>> {
  progress(ctx, 'build', 'running');
  try {
    const rel = await waitForRelease(ctx.liara, appName, releaseID, {
      timeoutMs: 15 * 60_000,
      sleep: ctx.sleep,
      onState: (s) => progress(ctx, 'build', 'running', releaseStateFa(s)),
    });
    progress(ctx, 'build', 'done', releaseStateFa(rel.state));
    return ok({ releaseID, state: rel.state, tag: rel.tag ?? null }, `نسخه‌ی ${rel.tag ?? releaseID} ساخته و منتشر شد.`);
  } catch (err) {
    if (!(err instanceof ReleaseWaitError)) throw err;
    progress(ctx, 'build', 'failed', err.failReason ?? releaseStateFa(err.state ?? ''));
    const userMessageFa =
      err.reason === 'timeout'
        ? 'ساخت نسخه‌ی جدید بیش از حد طول کشید؛ وضعیتش را دوباره بررسی می‌کنم.'
        : err.state === 'UNHEALTHY'
          ? 'نسخه‌ی جدید ساخته شد ولی برنامه بالا نیامد (ناسالم). احتمالاً پورت یا دستور اجرا درست نیست؛ لاگ‌ها را بررسی می‌کنم.'
          : `ساخت (بیلد) نسخه‌ی جدید ناموفق بود${err.failReason ? `: ${clip(err.failReason, 160)}` : ''}. لاگ بیلد را بررسی می‌کنم.`;
    return { ok: false, error: `release ${releaseID}: ${err.message}`, userMessageFa };
  }
}

export async function verifyRelease(ctx: ToolContext, appName: string, before: unknown, releaseID?: string): Promise<VerifyOutcome> {
  progress(ctx, 'health', 'running');
  const page = await getReleases(ctx.liara, appName, 1, 10);
  const rel = releaseID ? page.releases.find((r) => r._id === releaseID) : page.releases[0];
  const ready = Boolean(rel && RELEASE_READY.test(rel.state));
  const health = await verifyAppHealthy(ctx, appName, sinceOf(before, ctx));
  const ok = ready && health.ok;
  progress(ctx, 'health', ok ? 'done' : 'failed', health.evidence[health.evidence.length - 1]);
  return { ok, evidence: [`وضعیت نسخه: ${rel ? releaseStateFa(rel.state) : 'پیدا نشد'}`, ...health.evidence] };
}

export const deployReleaseTool = defineTool({
  name: 'deploy_release',
  title: 'Deploy release',
  description:
    'Create a new release from an uploaded sourceID (build + run). With waitForReady=true (default) waits until READY or FAILED and reports the build result. Port must be the port the app listens on.',
  input: z.object({
    appName: appNameSchema,
    sourceID: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    platform: platformSchema,
    waitForReady: z.boolean().default(true),
    message: z.string().max(200).optional(),
    platformConfig: z
      .object({})
      .catchall(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Runtime version as in liara.json, e.g. {"version":"22"} (node/next), {"pythonVersion":"3.12"}, {"phpVersion":"8.3"}'),
  }),
  risk: 1,
  category: 'deploy',
  describeFa: ({ appName }) => `انتشار نسخه‌ی جدید روی ${appName}`,
  consequencesFa: async ({ appName, port }) => ({
    why: `نسخه‌ی جدید کد روی ${appName} ساخته و منتشر می‌شود (پورت ${port}). بعد از ساخت موفق، جای نسخه‌ی فعلی را می‌گیرد.`,
    reversible: true,
    costNote: 'در صورت مشکل می‌توان به نسخه‌ی قبلی برگشت.',
  }),
  snapshot: async ({ appName }, ctx) => ({ at: ctx.now().toISOString(), currentRelease: (await getReleases(ctx.liara, appName, 1, 1).catch(() => null))?.currentRelease ?? null }),
  run: async (i, ctx) => {
    progress(ctx, 'release', 'running');
    const releaseID = await deployRelease(ctx.liara, i.appName, {
      sourceID: i.sourceID,
      port: i.port,
      type: i.platform,
      message: i.message,
      platformConfig: i.platformConfig,
    });
    linkSourceRelease(ctx.db, i.appName, i.sourceID, releaseID);
    progress(ctx, 'release', 'done');
    if (!i.waitForReady) return ok({ releaseID, state: 'PENDING', tag: null }, 'انتشار شروع شد؛ ساخت (بیلد) چند دقیقه طول می‌کشد.');
    return waitAndReport(ctx, i.appName, releaseID);
  },
  verify: async ({ appName }, before, ctx, result) => verifyRelease(ctx, appName, before, result?.ok ? result.data.releaseID : undefined),
  verifyDelayMs: 15_000,
});

/** Latest READY release older than the current one (or `toReleaseId` if given). */
export function pickRollbackTarget(page: Pick<ReleasesPage, 'releases' | 'currentRelease'>, toReleaseId?: string): Release | null {
  if (toReleaseId) return page.releases.find((r) => r._id === toReleaseId) ?? null;
  const sorted = [...page.releases].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const currentId = page.currentRelease ?? sorted.find((r) => RELEASE_READY.test(r.state))?._id;
  const current = sorted.find((r) => r._id === currentId);
  return sorted.find((r) => r._id !== currentId && RELEASE_READY.test(r.state) && (!current?.createdAt || (r.createdAt ?? '') < current.createdAt)) ?? null;
}

export const rollbackReleaseTool = defineTool({
  name: 'rollback_release',
  title: 'Roll back to previous release',
  description:
    'Return the app to a previous healthy release (default: the latest READY release before the current one). Best first fix when problems started right after a deploy. Re-deploys that release\'s source (Liara has no native rollback endpoint; see API-NOTES).',
  input: z.object({ appName: appNameSchema, toReleaseId: z.string().optional() }),
  risk: 1,
  category: 'deploy',
  describeFa: ({ appName }) => `برگرداندن ${appName} به نسخه‌ی قبلی`,
  consequencesFa: async ({ appName, toReleaseId }, ctx) => {
    const target = pickRollbackTarget(await getReleases(ctx.liara, appName, 1, 20), toReleaseId);
    return {
      why: target
        ? `سرویس ${appName} به نسخه‌ی ${target.tag ?? target._id} (منتشرشده در ${target.createdAt ?? 'زمان نامشخص'}) برمی‌گردد. نسخه‌ی فعلی پاک نمی‌شود.`
        : `نسخه‌ی سالم قبلی برای ${appName} پیدا نشد.`,
      reversible: true,
    };
  },
  snapshot: async (_i, ctx) => ({ at: ctx.now().toISOString() }),
  run: async ({ appName, toReleaseId }, ctx) => {
    const page = await getReleases(ctx.liara, appName, 1, 20);
    const target = pickRollbackTarget(page, toReleaseId);
    if (!target) return limitation('نسخه‌ی سالم قبلی برای برگشت پیدا نشد.', 'no READY release before the current one');
    const platform = target.type ?? target.projectType ?? page.platform ?? 'node';
    const port = target.port ?? defaultPort(platform);
    const row = sourceForRelease(ctx.db, appName, target._id);
    const sourceID = row?.sourceID ?? target.sourceID ?? undefined;
    if (!sourceID && !row) {
      return limitation(
        `نسخه‌ی ${target.tag ?? target._id} از طریق این دستیار منتشر نشده و کد آن نزد ما نیست. API لیارا دکمه‌ی «برگشت به نسخه‌ی قبلی» ندارد؛ می‌توانیم کد سالم را دوباره دیپلوی کنیم.`,
        'rollback target source not available locally',
      );
    }
    progress(ctx, 'release', 'running', `برگشت به ${target.tag ?? target._id}`);
    let releaseID: string;
    try {
      releaseID = await deployRelease(ctx.liara, appName, { sourceID: sourceID!, port, type: platform, message: `rollback to ${target.tag ?? target._id}` });
    } catch (err) {
      if (!row?.archivePath || !existsSync(row.archivePath)) throw err;
      const newSource = await uploadSource(ctx.liara, appName, readFileSync(row.archivePath), path.basename(row.archivePath));
      recordSource(ctx.db, { appName, sourceID: newSource, archivePath: row.archivePath, createdAt: ctx.now().toISOString() });
      releaseID = await deployRelease(ctx.liara, appName, { sourceID: newSource, port, type: platform, message: `rollback to ${target.tag ?? target._id}` });
      linkSourceRelease(ctx.db, appName, newSource, releaseID);
    }
    progress(ctx, 'release', 'done');
    const res = await waitAndReport(ctx, appName, releaseID);
    return res.ok ? ok({ ...res.data, rolledBackTo: target._id }, `سرویس به نسخه‌ی ${target.tag ?? target._id} برگشت.`) : res;
  },
  verify: async ({ appName }, before, ctx, result) => verifyRelease(ctx, appName, before, result?.ok ? result.data.releaseID : undefined),
  verifyDelayMs: 15_000,
});

export const deployTools = [uploadSourceTool, deployReleaseTool, rollbackReleaseTool];
