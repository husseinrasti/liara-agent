/**
 * Deploy wizard (deterministic rails behind the deploy_project tool): analyze →
 * create app (if needed, with balance check) → envs → liara.json → archive →
 * upload → release → build, emitting deploy_progress for every stage.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { linkSourceRelease, recordSource } from '../../db/repo';
import type { DeployStage } from '../../events';
import { getBalance, getPlans } from '../../liara/endpoints/account';
import { createApp, listApps } from '../../liara/endpoints/apps';
import { deployRelease, MAX_SOURCE_BYTES, uploadSource } from '../../liara/endpoints/deploy';
import { updateEnvs } from '../../liara/endpoints/envs';
import { cheapestBundle } from '../../liara/plans';
import { appUrlFor, fail, formatIRT, limitation, ok } from '../../tools/helpers';
import { progress, waitAndReport } from '../../tools/liara/deploy';
import { analyzeDir, PLATFORM_FA } from '../../tools/local/analyze-project';
import { buildArchive } from '../../tools/local/build-source-archive';
import { defaultPort, platformSchema } from '../../tools/local/platforms';
import { ProjectSourceError, resolveProjectPath } from '../../tools/local/project-source';
import type { ToolContext, ToolResult } from '../../tools/registry';
import { ensureLiaraJson, versionConfig } from './project-files';

export const DeployProjectInputSchema = z.object({
  path: z.string().min(1).describe('Local project folder or public git URL (same as analyze_project)'),
  appName: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/, '3–31 chars: lowercase letters, digits, dashes; starts with a letter'),
  platform: platformSchema.optional().describe('Defaults to the detected platform'),
  port: z.number().int().min(1).max(65_535).optional().describe('Defaults to the detected port'),
  planID: z.string().optional().describe('Required when the app does not exist yet (use recommend_plan)'),
  bundlePlanID: z.string().optional(),
  envs: z.record(z.string(), z.string()).optional().describe('Env vars with values the USER provided; never invent secrets'),
});
export type DeployProjectInput = z.infer<typeof DeployProjectInputSchema>;

export interface DeployOutcome {
  appName: string;
  url: string;
  releaseID: string;
  created: boolean;
  platform: string;
  port: number;
  envKeys: string[];
  wroteLiaraJson: boolean;
  archive: { sizeMB: number; fileCount: number; excludedSecrets: string[] };
}

export async function deployProject(ctx: ToolContext, input: DeployProjectInput): Promise<ToolResult<DeployOutcome>> {
  let current: DeployStage = 'analyze';
  const stage = (s: DeployStage, status: 'running' | 'done' | 'failed', detail?: string) => {
    current = s;
    progress(ctx, s, status, detail);
  };
  try {
    stage('analyze', 'running');
    const { dir } = await resolveProjectPath(input.path, { workdir: ctx.workdir, dataDir: ctx.dataDir });
    const analysis = analyzeDir(dir);
    const platform = input.platform ?? (analysis.platform !== 'unknown' ? analysis.platform : null);
    if (!platform) {
      stage('analyze', 'failed', 'نوع پروژه مشخص نشد');
      return limitation('نوع پروژه را نتوانستم تشخیص بدهم؛ بگویید پروژه با چه زبان یا فریم‌ورکی نوشته شده است.', 'unknown platform');
    }
    const port = input.port ?? analysis.port ?? defaultPort(platform);
    stage('analyze', 'done', `${PLATFORM_FA[platform] ?? platform}، پورت ${port}`);

    stage('create', 'running');
    const exists = (await listApps(ctx.liara)).some((a) => a.project_id === input.appName);
    if (!exists) {
      if (!input.planID) {
        stage('create', 'failed', 'پلن انتخاب نشده');
        return { ok: false, error: 'planID is required to create a new app', userMessageFa: 'برای ساخت سرویس جدید اول باید پلن انتخاب شود.' };
      }
      const plan = (await getPlans(ctx.liara).catch(() => [])).find((p) => p.id === input.planID);
      const balance = await getBalance(ctx.liara).catch(() => ({ known: false as const, reason: 'error' }));
      if (balance.known && plan?.hourlyPriceIRT && balance.amountIRT < plan.hourlyPriceIRT * 24) {
        stage('create', 'failed', 'موجودی کافی نیست');
        return limitation(
          `موجودی حساب لیارا (${formatIRT(balance.amountIRT)}) از هزینه‌ی یک روز این پلن کمتر است. لطفاً از پنل لیارا حساب را شارژ کنید؛ این تنها کاری است که فقط خودتان می‌توانید انجام دهید. بعد بگویید تا ادامه بدهم.`,
          'insufficient balance',
        );
      }
      const bundlePlanID = input.bundlePlanID ?? (plan ? cheapestBundle(plan)?.id : undefined) ?? 'free';
      await createApp(ctx.liara, { name: input.appName, planID: input.planID, platform, bundlePlanID });
    }
    stage('create', 'done', exists ? 'سرویس از قبل وجود داشت' : 'سرویس ساخته شد');

    const envKeys = Object.keys(input.envs ?? {});
    stage('envs', 'running');
    if (envKeys.length) await updateEnvs(ctx.liara, input.appName, input.envs ?? {}, []);
    stage('envs', 'done', envKeys.length ? `${envKeys.length} متغیر تنظیم شد` : 'متغیری لازم نبود');

    const liaraJson = ensureLiaraJson(dir, { app: input.appName, platform, port, versions: analysis });

    stage('archive', 'running');
    const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
    const archive = await buildArchive(dir, path.join(ctx.dataDir, 'sources', input.appName, `${stamp}.tar.gz`));
    if (archive.sizeMB * 1048576 > MAX_SOURCE_BYTES) {
      stage('archive', 'failed', 'حجم بیش از ۲۵۶ مگابایت');
      return limitation('حجم کد فشرده بیشتر از ۲۵۶ مگابایت است و لیارا آن را نمی‌پذیرد؛ پوشه‌های بزرگ را در .liaraignore بگذارید.', 'archive too large');
    }
    stage('archive', 'done', `${archive.fileCount} فایل، ${archive.sizeMB} مگابایت`);

    stage('upload', 'running');
    const sourceID = await uploadSource(ctx.liara, input.appName, readFileSync(archive.archivePath), path.basename(archive.archivePath));
    recordSource(ctx.db, { appName: input.appName, sourceID, archivePath: archive.archivePath, createdAt: ctx.now().toISOString() });
    stage('upload', 'done');

    stage('release', 'running');
    const releaseID = await deployRelease(ctx.liara, input.appName, { sourceID, port, type: platform, platformConfig: versionConfig(platform, analysis), message: 'deployed by liara-agent' });
    linkSourceRelease(ctx.db, input.appName, sourceID, releaseID);
    stage('release', 'done');

    current = 'build';
    const built = await waitAndReport(ctx, input.appName, releaseID);
    if (!built.ok) return built;
    const url = appUrlFor(ctx, input.appName);
    return ok(
      {
        appName: input.appName,
        url,
        releaseID,
        created: !exists,
        platform,
        port,
        envKeys,
        wroteLiaraJson: liaraJson.written,
        archive: { sizeMB: archive.sizeMB, fileCount: archive.fileCount, excludedSecrets: archive.excludedSecrets },
      },
      `نسخه‌ی جدید ساخته و روی ${url} منتشر شد.${liaraJson.written ? ' فایل liara.json را هم در پروژه ساختم.' : ''}`,
    );
  } catch (err) {
    if (err instanceof ProjectSourceError) {
      stage(current, 'failed', err.userMessageFa);
      return err.limitation ? limitation(err.userMessageFa, err.message) : { ok: false, error: err.message, userMessageFa: err.userMessageFa };
    }
    const f = fail(err);
    stage(current, 'failed', f.userMessageFa);
    return f;
  }
}
