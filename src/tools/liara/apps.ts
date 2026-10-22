import { z } from 'zod';
import { createApp, deleteApp, getApp, listApps, resizeApp, restartApp, scaleApp } from '../../liara/endpoints/apps';
import { getPlans } from '../../liara/endpoints/account';
import { LiaraApiError } from '../../liara/errors';
import { cheapestBundle, monthlyTotalIRT, type Plan } from '../../liara/plans';
import type { ProjectDetails } from '../../liara/types';
import { appNameSchema, appUrlFor, formatIRT, maskEnvValue, ok } from '../helpers';
import { platformSchema } from '../local/platforms';
import { defineTool, type ToolContext } from '../registry';
import { appletsState, healthOf, verifyAppHealthy } from './checks';

export function statusFa(status?: string | null, scale?: number | null): string {
  if (scale === 0) return 'خاموش';
  if (!status) return 'نامشخص';
  if (/^(active|running|up|deployed)$/i.test(status)) return 'روشن';
  if (/stop|deactive|off/i.test(status)) return 'خاموش';
  if (/frozen|suspend/i.test(status)) return 'مسدود (احتمالاً به‌خاطر موجودی)';
  return status;
}

export async function planInfo(ctx: ToolContext, planID?: string | null): Promise<Plan | null> {
  if (!planID) return null;
  const plans = await getPlans(ctx.liara).catch(() => [] as Plan[]);
  return plans.find((p) => p.id === planID) ?? null;
}

function planText(p: Plan | null, id?: string | null): string {
  if (!p) return id ? `${id}` : 'نامشخص';
  const ram = p.ramMB >= 1024 ? `${+(p.ramMB / 1024).toFixed(1)} گیگ` : `${p.ramMB} مگ`;
  return `${p.id} (${ram} رم، ${p.cpu} هسته)`;
}

export function compactApp(ctx: ToolContext, app: ProjectDetails, plan: Plan | null) {
  return {
    id: app._id,
    name: app.project_id,
    platform: app.type,
    status: app.status ?? null,
    scale: app.scale ?? null,
    isDeployed: app.isDeployed ?? null,
    url: appUrlFor(ctx, app.project_id),
    createdAt: app.created_at ?? null,
    plan: plan
      ? { id: plan.id, ramMB: plan.ramMB, cpu: plan.cpu, diskGB: plan.diskGB, monthlyEstimateIRT: plan.monthlyEstimateIRT, hourlyPriceIRT: plan.hourlyPriceIRT }
      : { id: app.planID ?? null, unknown: true },
    hourlyPriceIRT: app.hourlyPrice ?? null,
    zeroDowntime: app.zeroDowntime ?? null,
    envs: (app.envs ?? []).map((e) => ({ key: e.key, value: e.encrypted ? '••••' : maskEnvValue(e.key, e.value) })),
  };
}

const appInput = z.object({ appName: appNameSchema });

export const listAppsTool = defineTool({
  name: 'list_apps',
  title: 'List apps',
  description: 'List every Liara app on the account: name, platform, status, scale (1 = on, 0 = off), plan id and whether a release is deployed. Use when the user has not named an app or asks what they have.',
  input: z.object({}),
  risk: 0,
  category: 'read',
  describeFa: () => 'دریافت فهرست سرویس‌ها',
  run: async (_input, ctx) => {
    const apps = await listApps(ctx.liara);
    const data = apps.map((p) => ({
      name: p.project_id,
      platform: p.type,
      status: p.status ?? null,
      scale: p.scale ?? null,
      planID: p.planID ?? null,
      isDeployed: p.isDeployed ?? null,
      createdAt: p.created_at ?? null,
    }));
    return ok(data, data.length ? `${data.length} سرویس در حساب لیارا پیدا شد.` : 'هنوز هیچ سرویسی در حساب لیارا ندارید.');
  },
});

export const getAppTool = defineTool({
  name: 'get_app',
  title: 'Get app details',
  description: 'Details of one app: platform, status, scale, plan joined with the catalogue (RAM/CPU/price), public URL and env var keys (secret-looking values masked).',
  input: appInput,
  risk: 0,
  category: 'read',
  describeFa: ({ appName }) => `دریافت مشخصات سرویس ${appName}`,
  run: async ({ appName }, ctx) => {
    const app = await getApp(ctx.liara, appName);
    const plan = await planInfo(ctx, app.planID);
    const data = compactApp(ctx, app, plan);
    return ok(data, `سرویس ${appName}: ${statusFa(app.status, app.scale)}، پلن ${planText(plan, app.planID)}، ${data.envs.length} متغیر محیطی.`);
  },
});

export const createAppTool = defineTool({
  name: 'create_app',
  title: 'Create app',
  description: 'Create a new empty Liara app with a platform and plan. Costs money from the moment it exists (hourly billing). Does not deploy code; follow with build_source_archive → upload_source → deploy_release.',
  input: z.object({
    appName: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/, '3–31 chars: lowercase letters, digits, dashes; starts with a letter'),
    platform: platformSchema,
    planID: z.string().min(1).describe('Plan id from get_account.plansAvailable'),
    bundlePlanID: z.string().optional().describe('Feature bundle: free | standard | pro. Default: cheapest available for the plan'),
  }),
  risk: 1,
  category: 'deploy',
  describeFa: (i) => `ساخت سرویس جدید ${i.appName} (${i.platform}) با پلن ${i.planID}`,
  consequencesFa: async (i, ctx) => {
    const plan = await planInfo(ctx, i.planID);
    const bundleId = i.bundlePlanID ?? (plan ? cheapestBundle(plan)?.id : undefined);
    const total = plan ? monthlyTotalIRT(plan, bundleId) : null;
    return {
      why: `یک سرویس تازه به نام ${i.appName} با پلن ${planText(plan, i.planID)} ساخته می‌شود تا کد شما روی آن اجرا شود.`,
      reversible: true,
      costNote: plan
        ? `هزینه‌ی تقریبی: ماهانه ${formatIRT(total)} (منابع ساعتی ${formatIRT(plan.hourlyPriceIRT)}${bundleId ? `، بسته‌ی امکانات ${bundleId}` : ''}).`
        : 'قیمت این پلن در فهرست پلن‌ها پیدا نشد.',
    };
  },
  run: async (i, ctx) => {
    const plan = await planInfo(ctx, i.planID);
    const bundlePlanID = i.bundlePlanID ?? (plan ? cheapestBundle(plan)?.id : undefined) ?? 'free';
    await createApp(ctx.liara, { name: i.appName, planID: i.planID, platform: i.platform, bundlePlanID });
    return ok({ appName: i.appName, platform: i.platform, planID: i.planID, bundlePlanID, url: appUrlFor(ctx, i.appName) }, `سرویس ${i.appName} ساخته شد.`);
  },
  verify: async (i, _before, ctx) => {
    const app = await getApp(ctx.liara, i.appName);
    return { ok: app.project_id === i.appName, evidence: [`سرویس ${i.appName} در لیارا وجود دارد (پلن ${app.planID ?? 'نامشخص'})`] };
  },
  verifyDelayMs: 2000,
});

export const deleteAppTool = defineTool({
  name: 'delete_app',
  title: 'Delete app',
  description: 'Permanently delete an app, its releases and env vars. Irreversible. Only when the user explicitly asks to delete.',
  input: appInput,
  risk: 2,
  category: 'ops',
  describeFa: ({ appName }) => `حذف کامل سرویس ${appName}`,
  consequencesFa: async ({ appName }) => ({
    why: `سرویس ${appName} با همه‌ی نسخه‌ها و متغیرهایش برای همیشه حذف می‌شود و سایت از دسترس خارج می‌شود.`,
    reversible: false,
    costNote: 'بعد از حذف، هزینه‌ی این سرویس دیگر محاسبه نمی‌شود.',
  }),
  run: async ({ appName }, ctx) => {
    await deleteApp(ctx.liara, appName);
    return ok({ deleted: appName }, `سرویس ${appName} حذف شد.`);
  },
  verify: async ({ appName }, _before, ctx) => {
    try {
      await getApp(ctx.liara, appName);
      return { ok: false, evidence: [`سرویس ${appName} هنوز وجود دارد`] };
    } catch (err) {
      const gone = err instanceof LiaraApiError && err.status === 404;
      return { ok: gone, evidence: [gone ? `سرویس ${appName} دیگر وجود ندارد` : 'وضعیت حذف قابل بررسی نبود'] };
    }
  },
  verifyDelayMs: 3000,
});

export const restartAppTool = defineTool({
  name: 'restart_app',
  title: 'Restart app',
  description: 'Restart the app containers. Frees memory and clears stuck state; a temporary fix for leaks/hangs. Causes a few seconds of downtime unless zero-downtime is on.',
  input: appInput,
  risk: 1,
  category: 'ops',
  describeFa: ({ appName }) => `ری‌استارت سرویس ${appName}`,
  consequencesFa: async ({ appName }) => ({
    why: `برنامه‌ی ${appName} دوباره راه‌اندازی می‌شود؛ حافظه آزاد می‌شود و ممکن است چند ثانیه سایت در دسترس نباشد.`,
    reversible: true,
  }),
  snapshot: async ({ appName }, ctx) => ({ at: ctx.now().toISOString(), applets: (await appletsState(ctx, appName)).states }),
  run: async ({ appName }, ctx) => {
    await restartApp(ctx.liara, appName);
    return ok({ restarted: appName }, `دستور ری‌استارت ${appName} ارسال شد؛ چند ثانیه طول می‌کشد.`);
  },
  verify: async ({ appName }, before, ctx) => verifyAppHealthy(ctx, appName, sinceOf(before, ctx)),
  verifyDelayMs: 20_000,
});

export const scaleAppTool = defineTool({
  name: 'scale_app',
  title: 'Turn app on/off',
  description: 'Turn an app on (scale 1) or off (scale 0). Turning off takes the site down (no traffic served) but stops compute usage.',
  input: z.object({ appName: appNameSchema, on: z.boolean().describe('true = turn on, false = turn off') }),
  risk: 2,
  category: 'ops',
  describeFa: ({ appName, on }) => (on ? `روشن کردن سرویس ${appName}` : `خاموش کردن سرویس ${appName}`),
  consequencesFa: async ({ appName, on }) =>
    on
      ? { why: `سرویس ${appName} روشن می‌شود و دوباره به درخواست‌ها پاسخ می‌دهد.`, reversible: true }
      : { why: `سرویس ${appName} خاموش می‌شود و تا وقتی دوباره روشنش کنید سایت در دسترس نیست.`, reversible: true },
  snapshot: async (_i, ctx) => ({ at: ctx.now().toISOString() }),
  run: async ({ appName, on }, ctx) => {
    await scaleApp(ctx.liara, appName, on ? 1 : 0);
    return ok({ appName, scale: on ? 1 : 0 }, on ? `سرویس ${appName} در حال روشن شدن است.` : `سرویس ${appName} خاموش شد.`);
  },
  verify: async ({ appName, on }, before, ctx) => {
    if (on) return verifyAppHealthy(ctx, appName, sinceOf(before, ctx));
    const app = await getApp(ctx.liara, appName);
    const health = await healthOf(ctx, appName, 5_000);
    return { ok: app.scale === 0, evidence: [`مقدار scale در لیارا: ${app.scale ?? 'نامشخص'}`, `پاسخ سایت: ${health.status || 'بدون پاسخ'}`] };
  },
  verifyDelayMs: 20_000,
});

export const resizeAppTool = defineTool({
  name: 'resize_app',
  title: 'Change plan',
  description: 'Move the app to another plan (more/less RAM and CPU). Changes the hourly cost and restarts the app.',
  input: z.object({ appName: appNameSchema, planID: z.string().min(1).describe('Target plan id from get_account.plansAvailable') }),
  risk: 2,
  category: 'ops',
  describeFa: ({ appName, planID }) => `تغییر پلن سرویس ${appName} به ${planID}`,
  consequencesFa: async ({ appName, planID }, ctx) => {
    const app = await getApp(ctx.liara, appName);
    const [from, to] = await Promise.all([planInfo(ctx, app.planID), planInfo(ctx, planID)]);
    const delta = from?.monthlyEstimateIRT != null && to?.monthlyEstimateIRT != null ? to.monthlyEstimateIRT - from.monthlyEstimateIRT : null;
    return {
      why: `منابع ${appName} از ${planText(from, app.planID)} به ${planText(to, planID)} تغییر می‌کند و برنامه یک بار ری‌استارت می‌شود.`,
      reversible: true,
      costNote:
        delta === null
          ? 'تفاوت هزینه قابل محاسبه نبود.'
          : `هزینه‌ی ماهانه ${delta >= 0 ? 'حدود ' + formatIRT(delta) + ' بیشتر' : 'حدود ' + formatIRT(-delta) + ' کمتر'} می‌شود (از ${formatIRT(from!.monthlyEstimateIRT)} به ${formatIRT(to!.monthlyEstimateIRT)}).`,
    };
  },
  snapshot: async ({ appName }, ctx) => ({ at: ctx.now().toISOString(), planID: (await getApp(ctx.liara, appName)).planID }),
  run: async ({ appName, planID }, ctx) => {
    await resizeApp(ctx.liara, appName, planID);
    return ok({ appName, planID }, `درخواست تغییر پلن ${appName} به ${planID} ثبت شد.`);
  },
  verify: async ({ appName, planID }, before, ctx) => {
    const app = await getApp(ctx.liara, appName);
    const health = await verifyAppHealthy(ctx, appName, sinceOf(before, ctx));
    const planOk = app.planID === planID;
    return { ok: planOk && health.ok, evidence: [`پلن فعلی در لیارا: ${app.planID ?? 'نامشخص'}`, ...health.evidence] };
  },
  verifyDelayMs: 45_000,
});

/** Start of the verification window: the snapshot time, or 1 minute ago. */
export function sinceOf(before: unknown, ctx: ToolContext): Date {
  const at = (before as { at?: string } | undefined)?.at;
  return at ? new Date(at) : new Date(ctx.now().getTime() - 60_000);
}

export const appTools = [listAppsTool, getAppTool, createAppTool, deleteAppTool, restartAppTool, scaleAppTool, resizeAppTool];
