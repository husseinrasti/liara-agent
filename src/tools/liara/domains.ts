import { z } from 'zod';
import { addDomain, checkDomain, deleteDomain, enableSsl, isDomainVerified, isSslActive, listDomains } from '../../liara/endpoints/domains';
import type { Domain } from '../../liara/types';
import { appNameSchema, ok } from '../helpers';
import { defineTool, type ToolContext } from '../registry';

const domainSchema = z
  .string()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, 'a domain like example.ir or www.example.com')
  .describe('Domain name without protocol, e.g. "myshop.ir" or "www.myshop.ir"');

export function compactDomain(d: Domain) {
  return {
    id: d._id,
    name: d.name,
    status: d.status ?? null,
    certificatesStatus: d.certificatesStatus ?? null,
    cnameRecord: d.CNameRecord ?? null,
    verified: isDomainVerified(d),
    sslActive: isSslActive(d),
  };
}

/** Short Persian DNS guidance; the full IRNIC walkthrough lives in src/knowledge/irnic.md (search_docs). */
export function dnsGuideFa(domain: string, cname: string | null): string {
  const target = cname ?? '(مقداری که لیارا نشان می‌دهد)';
  const irnic = domain.endsWith('.ir')
    ? 'دامنه‌های ‎.ir در irnic.ir ثبت می‌شوند؛ اگر DNS دامنه دست ایرنیک است، ابتدا در بخش مدیریت دامنه، سرورهای نام (NS) را به سرویس DNS خود (مثلاً DNS لیارا) تغییر دهید و رکورد را آنجا بسازید.'
    : 'در پنل شرکتی که دامنه را از آن خریده‌اید (یا سرویس DNS آن) رکورد را بسازید.';
  return `یک رکورد CNAME برای ${domain} بسازید که به ${target} اشاره کند (برای دامنه‌ی اصلی بدون www، اگر CNAME مجاز نبود از ALIAS/ANAME استفاده کنید). ${irnic} اعمال تغییرات DNS معمولاً ۵ دقیقه تا ۲۴ ساعت طول می‌کشد.`;
}

export function domainHintFa(d: ReturnType<typeof compactDomain>): string {
  if (!d.verified) return dnsGuideFa(d.name, d.cnameRecord);
  if (!d.sslActive) return 'دامنه وصل شده است؛ حالا می‌توان گواهی SSL (https) را فعال کرد.';
  return 'دامنه وصل است و SSL فعال است.';
}

async function findDomain(ctx: ToolContext, appName: string, name: string) {
  return (await listDomains(ctx.liara, appName)).find((d) => d.name === name) ?? null;
}

export const listDomainsTool = defineTool({
  name: 'list_domains',
  title: 'List domains',
  description: 'Custom domains attached to the app with connection status, SSL certificate status and the CNAME target to set at the DNS provider.',
  input: z.object({ appName: appNameSchema }),
  risk: 0,
  category: 'read',
  describeFa: ({ appName }) => `بررسی دامنه‌های ${appName}`,
  run: async ({ appName }, ctx) => {
    const data = (await listDomains(ctx.liara, appName)).map(compactDomain);
    return ok(data, data.length ? `${data.length} دامنه متصل است؛ ${data.filter((d) => d.verified).length} مورد تأییدشده.` : 'هنوز دامنه‌ی اختصاصی به این سرویس وصل نشده است.');
  },
});

export const checkDomainTool = defineTool({
  name: 'check_domain',
  title: 'Check domain',
  description: 'Re-check a domain (by id from list_domains/add_domain): DNS verification, SSL status, CNAME target and a Persian hint about the next step.',
  input: z.object({ domainId: z.string().min(1) }),
  risk: 0,
  category: 'domain',
  describeFa: () => 'بررسی وضعیت اتصال دامنه',
  run: async ({ domainId }, ctx) => {
    const d = compactDomain(await checkDomain(ctx.liara, domainId));
    const hintFa = domainHintFa(d);
    return ok({ ...d, hintFa }, d.verified ? `دامنه‌ی ${d.name} تأیید شده است.` : `دامنه‌ی ${d.name} هنوز تأیید نشده است.`);
  },
});

export const addDomainTool = defineTool({
  name: 'add_domain',
  title: 'Add custom domain',
  description:
    'Attach a custom domain to the app. Returns the CNAME target and DNS/IRNIC instructions. The user must create the DNS record themselves — the Liara API cannot change IRNIC or external registrar DNS.',
  input: z.object({ appName: appNameSchema, domain: domainSchema }),
  risk: 1,
  category: 'domain',
  describeFa: ({ appName, domain }) => `اتصال دامنه‌ی ${domain} به ${appName}`,
  consequencesFa: async ({ appName, domain }) => ({
    why: `دامنه‌ی ${domain} به سرویس ${appName} اضافه می‌شود. بعد از آن باید در پنل دامنه (مثلاً ایرنیک) یک رکورد DNS بسازید؛ آن بخش را من نمی‌توانم انجام دهم.`,
    reversible: true,
  }),
  run: async ({ appName, domain }, ctx) => {
    const created = await addDomain(ctx.liara, appName, domain);
    const d = created ? compactDomain(created) : null;
    const guideFa = dnsGuideFa(domain, d?.cnameRecord ?? null);
    return ok({ ...(d ?? { name: domain }), guideFa }, `دامنه‌ی ${domain} ثبت شد؛ حالا باید رکورد DNS را تنظیم کنید.`);
  },
  verify: async ({ appName, domain }, _before, ctx) => {
    const d = await findDomain(ctx, appName, domain);
    return {
      ok: Boolean(d),
      evidence: d ? [`دامنه در لیارا ثبت شد (وضعیت: ${d.status ?? 'نامشخص'})`, `هدف CNAME: ${d.CNameRecord ?? 'نامشخص'}`] : ['دامنه در فهرست دامنه‌های سرویس پیدا نشد'],
    };
  },
  verifyDelayMs: 2000,
});

export const enableSslTool = defineTool({
  name: 'enable_ssl',
  title: 'Enable SSL',
  description: 'Issue a free SSL certificate (https) for a domain already attached to the app. The DNS record must already point to Liara (check_domain verified=true).',
  input: z.object({ appName: appNameSchema, domain: domainSchema }),
  risk: 1,
  category: 'domain',
  describeFa: ({ domain }) => `فعال‌سازی SSL برای ${domain}`,
  consequencesFa: async ({ domain }) => ({
    why: `برای ${domain} گواهی SSL رایگان صادر می‌شود تا سایت با https باز شود. رکورد DNS دامنه باید از قبل درست تنظیم شده باشد.`,
    reversible: true,
  }),
  run: async ({ domain }, ctx) => {
    await enableSsl(ctx.liara, domain);
    return ok({ domain, requested: true }, `درخواست صدور گواهی SSL برای ${domain} ثبت شد.`);
  },
  verify: async ({ appName, domain }, _before, ctx) => {
    const deadline = ctx.now().getTime() + 120_000;
    let d = await findDomain(ctx, appName, domain);
    while (d && !isSslActive(d) && ctx.now().getTime() < deadline) {
      await ctx.sleep(10_000);
      d = await findDomain(ctx, appName, domain);
    }
    if (!d) return { ok: false, evidence: ['دامنه در فهرست سرویس پیدا نشد'] };
    const active = isSslActive(d);
    return { ok: active, evidence: [active ? 'گواهی SSL فعال شد' : `صدور گواهی هنوز کامل نشده (وضعیت: ${d.certificatesStatus ?? 'نامشخص'})`] };
  },
  verifyDelayMs: 10_000,
});

export const deleteDomainTool = defineTool({
  name: 'delete_domain',
  title: 'Remove domain',
  description: 'Detach and delete a custom domain from the app. The site stops answering on that domain.',
  input: z.object({ appName: appNameSchema, domainId: z.string().min(1) }),
  risk: 2,
  category: 'domain',
  describeFa: ({ appName }) => `حذف یک دامنه از ${appName}`,
  consequencesFa: async ({ appName, domainId }, ctx) => {
    const d = (await listDomains(ctx.liara, appName)).find((x) => x._id === domainId);
    return { why: `دامنه‌ی ${d?.name ?? domainId} از سرویس ${appName} جدا و حذف می‌شود و سایت روی آن آدرس دیگر باز نمی‌شود.`, reversible: true, costNote: 'برای برگرداندن، باید دوباره دامنه را اضافه و تأیید کنید.' };
  },
  run: async ({ domainId }, ctx) => {
    await deleteDomain(ctx.liara, domainId);
    return ok({ deleted: domainId }, 'دامنه حذف شد.');
  },
  verify: async ({ appName, domainId }, _before, ctx) => {
    const still = (await listDomains(ctx.liara, appName)).some((d) => d._id === domainId);
    return { ok: !still, evidence: [still ? 'دامنه هنوز در فهرست است' : 'دامنه دیگر در فهرست سرویس نیست'] };
  },
  verifyDelayMs: 2000,
});

export const domainTools = [listDomainsTool, checkDomainTool, addDomainTool, enableSslTool, deleteDomainTool];
