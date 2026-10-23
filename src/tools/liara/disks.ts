import { z } from 'zod';
import { getApp } from '../../liara/endpoints/apps';
import { getDisks, resizeDisk } from '../../liara/endpoints/disks';
import { appNameSchema, ok } from '../helpers';
import { defineTool } from '../registry';

export const resizeDiskTool = defineTool({
  name: 'resize_disk',
  title: 'Resize disk',
  description: 'Grow a persistent disk attached to the app (e.g. when it is ≥ 90% full or logs show ENOSPC). Costs more per hour; disks cannot be shrunk.',
  input: z.object({
    appName: appNameSchema,
    diskName: z.string().min(1),
    sizeGB: z.number().int().min(1).max(1000).describe('New total size in GB (must be larger than the current size)'),
  }),
  risk: 2,
  category: 'ops',
  describeFa: (i) => `بزرگ کردن دیسک ${i.diskName} سرویس ${i.appName} به ${i.sizeGB} گیگابایت`,
  consequencesFa: async (i) => ({
    why: `دیسک ${i.diskName} به ${i.sizeGB} گیگابایت بزرگ می‌شود تا برنامه دوباره بتواند فایل بنویسد.`,
    reversible: false,
    costNote: 'هزینه‌ی ساعتی دیسک بیشتر می‌شود و دیسک را بعداً نمی‌توان کوچک کرد.',
  }),
  run: async (i, ctx) => {
    await resizeDisk(ctx.liara, i.appName, i.diskName, i.sizeGB);
    return ok({ diskName: i.diskName, sizeGB: i.sizeGB }, `درخواست بزرگ کردن دیسک ${i.diskName} ثبت شد.`);
  },
  verify: async (i, _before, ctx) => {
    const app = await getApp(ctx.liara, i.appName);
    const disk = (await getDisks(ctx.liara, app._id)).disks.find((d) => d.name === i.diskName);
    const size = disk?.size ?? null;
    return { ok: size !== null && size >= i.sizeGB, evidence: [`اندازه‌ی فعلی دیسک ${i.diskName}: ${size ?? 'نامشخص'} گیگابایت`] };
  },
  verifyDelayMs: 15_000,
});

export const diskTools = [resizeDiskTool];
