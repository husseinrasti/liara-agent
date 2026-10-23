import { z } from 'zod';
import { getApp } from '../../liara/endpoints/apps';
import { createDisk, getDisks, resizeDisk } from '../../liara/endpoints/disks';
import { appNameSchema, ok } from '../helpers';
import { defineTool } from '../registry';

export const createDiskTool = defineTool({
  name: 'create_disk',
  title: 'Create disk',
  description:
    'Create a persistent disk for the app (files that must survive restarts and deploys, e.g. an SQLite database or uploads). Mount it by adding {"name","mountTo"} to the project liara.json `disks` and deploying. Costs per hour.',
  input: z.object({
    appName: appNameSchema,
    diskName: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/, 'lowercase letters, digits and dashes'),
    sizeGB: z.number().int().min(1).max(1000),
  }),
  risk: 2,
  category: 'ops',
  describeFa: (i) => `ساخت دیسک ${i.diskName} (${i.sizeGB} گیگابایت) برای سرویس ${i.appName}`,
  consequencesFa: async (i) => ({
    why: `یک دیسک ماندگار ${i.sizeGB} گیگابایتی با نام ${i.diskName} ساخته می‌شود تا فایل‌های برنامه با ری‌استارت و انتشار دوباره پاک نشوند.`,
    reversible: true,
    costNote: 'هزینه‌ی دیسک ساعتی از موجودی حساب کم می‌شود.',
  }),
  run: async (i, ctx) => {
    await createDisk(ctx.liara, i.appName, { name: i.diskName, sizeGB: i.sizeGB });
    return ok({ diskName: i.diskName, sizeGB: i.sizeGB }, `دیسک ${i.diskName} ساخته شد.`);
  },
  verify: async (i, _before, ctx) => {
    const app = await getApp(ctx.liara, i.appName);
    const disk = (await getDisks(ctx.liara, app._id)).disks.find((d) => d.name === i.diskName);
    return { ok: Boolean(disk), evidence: [disk ? `دیسک ${i.diskName} در فهرست دیسک‌های سرویس هست (${disk.size ?? i.sizeGB} گیگابایت)` : `دیسک ${i.diskName} پیدا نشد`] };
  },
  verifyDelayMs: 3000,
});

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

export const diskTools = [createDiskTool, resizeDiskTool];
