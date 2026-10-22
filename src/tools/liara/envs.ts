import { z } from 'zod';
import { getApp } from '../../liara/endpoints/apps';
import { updateEnvs } from '../../liara/endpoints/envs';
import { appNameSchema, isSecretKey, ok } from '../helpers';
import { defineTool } from '../registry';
import { sinceOf } from './apps';
import { verifyAppHealthy } from './checks';

const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env names: letters, digits, underscore; not starting with a digit');

const input = z
  .object({
    appName: appNameSchema,
    set: z.record(envKey, z.string()).optional().describe('Variables to add/overwrite. Never invent secret values: ask the user.'),
    unset: z.array(envKey).optional().describe('Variable names to remove'),
  })
  .refine((v) => Object.keys(v.set ?? {}).length + (v.unset?.length ?? 0) > 0, 'nothing to change: give set and/or unset');

type Input = z.infer<typeof input>;

const keysOf = (i: Input) => [...Object.keys(i.set ?? {}), ...(i.unset ?? [])];

export const updateEnvsTool = defineTool({
  name: 'update_envs',
  title: 'Update environment variables',
  description:
    'Add, change (`set`) or remove (`unset`) environment variables of an app, keeping all other variables. Liara restarts the app to apply them. Only use values the user provided; never guess secrets.',
  input,
  risk: 1,
  category: 'ops',
  describeFa: (i) => `تنظیم متغیرهای محیطی ${i.appName}: ${keysOf(i).join('، ')}`,
  redactInput: (i) => ({ ...i, set: Object.fromEntries(Object.keys(i.set ?? {}).map((k) => [k, '••••'])) }),
  consequencesFa: async (i) => {
    const setKeys = Object.keys(i.set ?? {});
    const parts = [
      setKeys.length ? `متغیرهای ${setKeys.join('، ')} تنظیم می‌شوند` : '',
      i.unset?.length ? `متغیرهای ${i.unset.join('، ')} حذف می‌شوند` : '',
    ].filter(Boolean);
    const secret = setKeys.some(isSecretKey) ? ' مقدارهای محرمانه در گزارش‌ها نمایش داده نمی‌شوند.' : '';
    return { why: `${parts.join(' و ')}؛ برای اعمال تغییرات، برنامه یک بار ری‌استارت می‌شود.${secret}`, reversible: true };
  },
  snapshot: async ({ appName }, ctx) => ({ at: ctx.now().toISOString(), keys: ((await getApp(ctx.liara, appName)).envs ?? []).map((e) => e.key) }),
  run: async (i, ctx) => {
    const keys = await updateEnvs(ctx.liara, i.appName, i.set ?? {}, i.unset ?? []);
    return ok({ set: Object.keys(i.set ?? {}), unset: i.unset ?? [], totalKeys: keys.length }, 'متغیرها ذخیره شد؛ برنامه برای اعمال آن‌ها ری‌استارت می‌شود.');
  },
  verify: async (i, before, ctx) => {
    const app = await getApp(ctx.liara, i.appName);
    const present = new Set((app.envs ?? []).map((e) => e.key));
    const missing = Object.keys(i.set ?? {}).filter((k) => !present.has(k));
    const stillThere = (i.unset ?? []).filter((k) => present.has(k));
    const health = await verifyAppHealthy(ctx, i.appName, sinceOf(before, ctx));
    const evidence = [
      missing.length ? `این متغیرها ثبت نشده‌اند: ${missing.join('، ')}` : 'همه‌ی متغیرهای خواسته‌شده ثبت شده‌اند',
      ...(stillThere.length ? [`این متغیرها هنوز حذف نشده‌اند: ${stillThere.join('، ')}`] : []),
      ...health.evidence,
    ];
    return { ok: !missing.length && !stillThere.length && health.ok, evidence };
  },
  verifyDelayMs: 20_000,
});

export const envTools = [updateEnvsTool];
