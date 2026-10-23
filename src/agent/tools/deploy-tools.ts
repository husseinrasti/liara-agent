/** recommend_plan (risk 0) and deploy_project (risk 1, one approval for the whole wizard). */
import { z } from 'zod';
import { getBalance, getPlans } from '../../liara/endpoints/account';
import { listApps } from '../../liara/endpoints/apps';
import { cheapestBundle, monthlyTotalIRT } from '../../liara/plans';
import { faNum, formatIRT, limitation, ok } from '../../tools/helpers';
import { verifyRelease } from '../../tools/liara/deploy';
import { analyzeDir } from '../../tools/local/analyze-project';
import { platformSchema } from '../../tools/local/platforms';
import { resolveProjectPath } from '../../tools/local/project-source';
import { defineTool } from '../../tools/registry';
import { planLabelFa, recommendPlan } from '../deploy/plan';
import { suggestAppName } from '../deploy/project-files';
import { deployProject, DeployProjectInputSchema } from '../deploy/wizard';

export const recommendPlanTool = defineTool({
  name: 'recommend_plan',
  title: 'Recommend a plan',
  description:
    'Recommend a Liara plan for a project (deterministic: platform RAM floor, heavy dependencies, real prices) with monthly cost, reasons, a cheaper/bigger alternative and whether the balance covers it. With the project path it also returns suggestedAppName (liara.json app, else a free name from the folder) to use as deploy_project appName. Give the project path (preferred) or its platform.',
  input: z
    .object({
      path: z.string().optional(),
      platform: platformSchema.optional(),
      sizeMB: z.number().optional(),
      needsDatabase: z.string().nullable().optional(),
      notableDeps: z.array(z.string()).optional(),
    })
    .refine((v) => v.path || v.platform, 'give path or platform'),
  risk: 0,
  category: 'deploy',
  describeFa: () => 'پیشنهاد پلن مناسب',
  run: async (input, ctx) => {
    let facts = { platform: input.platform ?? 'node', sizeMB: input.sizeMB, needsDatabase: input.needsDatabase ?? null, needsDisk: false, notableDeps: input.notableDeps ?? [] };
    let suggestedAppName: string | undefined;
    if (input.path) {
      const src = await resolveProjectPath(input.path, { workdir: ctx.workdir, dataDir: ctx.dataDir });
      const a = analyzeDir(src.dir);
      facts = { platform: input.platform ?? (a.platform === 'unknown' ? 'node' : a.platform), sizeMB: a.sizeMB, needsDatabase: a.needsDatabase, needsDisk: a.needsDisk, notableDeps: a.notableDeps };
      const configured = a.existingLiaraJson?.app;
      const taken = (await listApps(ctx.liara).catch(() => [])).map((x) => x.project_id);
      suggestedAppName = typeof configured === 'string' && configured ? configured : suggestAppName(src.gitUrl ?? src.dir, taken);
    }
    const [plans, balance] = await Promise.all([getPlans(ctx.liara), getBalance(ctx.liara).catch(() => null)]);
    const rec = recommendPlan(facts, plans, balance);
    if (!rec) return limitation('فهرست پلن‌های لیارا الان در دسترس نیست؛ کمی بعد دوباره امتحان می‌کنم.', 'plan catalogue empty');
    ctx.emit?.({ type: 'plan_recommendation', recommendation: rec });
    const balanceFa = rec.balance ? (rec.balance.sufficient ? `؛ موجودی برای حدود ${faNum(rec.balance.enoughForDays ?? 0)} روز کافی است` : '؛ موجودی حساب برای این پلن کافی نیست') : '';
    const nameFa = suggestedAppName ? ` نام سرویس: ${suggestedAppName}.` : '';
    return ok({ ...rec, ...(suggestedAppName ? { suggestedAppName } : {}) }, `پیشنهاد: ${rec.label}، ماهانه حدود ${formatIRT(rec.totalMonthlyIRT)}${balanceFa}.${nameFa}`);
  },
});

export const deployProjectTool = defineTool({
  name: 'deploy_project',
  title: 'Deploy a project (wizard)',
  description:
    'Deploy a local project folder or public git URL to Liara in one approved step: create the app if needed (planID required then), set env vars the USER provided, write liara.json if missing, archive, upload, release, wait for the build and check health. Run analyze_project and recommend_plan first; ask the user for required env values before calling.',
  input: DeployProjectInputSchema,
  risk: 1,
  category: 'deploy',
  describeFa: (i) => `دیپلوی پروژه روی سرویس ${i.appName}`,
  redactInput: (i) => ({ ...i, envs: Object.fromEntries(Object.keys(i.envs ?? {}).map((k) => [k, '••••'])) }),
  consequencesFa: async (i, ctx) => {
    const exists = (await listApps(ctx.liara)).some((a) => a.project_id === i.appName);
    const plan = exists || !i.planID ? undefined : (await getPlans(ctx.liara)).find((p) => p.id === i.planID);
    const keys = Object.keys(i.envs ?? {});
    const steps = [
      exists ? `انتشار نسخه‌ی جدید روی سرویس موجود ${i.appName}` : `ساخت سرویس ${i.appName}${plan ? ` با پلن ${planLabelFa(plan)}` : ''}`,
      keys.length ? `تنظیم ${faNum(keys.length)} متغیر محیطی (${keys.join('، ')})` : '',
      'بسته‌بندی و ارسال کد، ساخت نسخه و انتشار آن، و بررسی سلامت سایت',
    ].filter(Boolean);
    const total = plan ? monthlyTotalIRT(plan, i.bundlePlanID ?? cheapestBundle(plan)?.id) : null;
    return {
      why: steps.map((s, n) => `${faNum(n + 1)}. ${s}`).join('\n'),
      reversible: true,
      ...(plan ? { costNote: `هزینه‌ی تقریبی سرویس: ماهانه ${formatIRT(total)} (ساعتی از موجودی کم می‌شود).` } : {}),
    };
  },
  snapshot: async (_i, ctx) => ({ at: ctx.now().toISOString() }),
  run: async (i, ctx) => deployProject(ctx, i),
  verify: async (i, before, ctx, result) => verifyRelease(ctx, i.appName, before, result?.ok ? result.data.releaseID : undefined),
  verifyDelayMs: 10_000,
});

export const deployTools = [recommendPlanTool, deployProjectTool];
