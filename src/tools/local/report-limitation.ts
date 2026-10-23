/** Explicit answers for things the Liara API cannot do; the UI renders them as a limitation notice. */
import { z } from 'zod';
import { limitation } from '../helpers';
import { defineTool } from '../registry';

export const LIMITATIONS_FA = {
  access_logs:
    'API لیارا لاگ دسترسی HTTP (فهرست درخواست‌ها و کد وضعیت هرکدام) ندارد؛ فقط خروجی خود برنامه (stdout/stderr) در دسترس است. به‌جایش سایت را مستقیم بررسی می‌کنم و خطاهای لاگ برنامه را نشانت می‌دهم.',
  registrar_dns:
    'تغییر رکورد DNS در ایرنیک یا هر ثبت‌کننده‌ی دیگر از طریق API لیارا ممکن نیست؛ رکورد را باید خودت در پنل دامنه بسازی. من دقیق می‌گویم چه رکوردی لازم است و هر دقیقه بررسی می‌کنم.',
  top_up: 'شارژ حساب لیارا از طریق API ممکن نیست؛ باید خودت از پنل لیارا (بخش صورت‌حساب) حساب را شارژ کنی.',
  git_push: 'API لیارا انتشار با git push ندارد؛ من خودم کد را بسته‌بندی و آپلود می‌کنم و نسخه‌ی جدید می‌سازم.',
  webhooks: 'API لیارا هشدار خودکار یا وب‌هوک (اعلان به آدرس شما) ندارد؛ برای همین خودم سرویس را دوره‌ای بررسی می‌کنم.',
} as const;

export const reportLimitationTool = defineTool({
  name: 'report_limitation',
  title: 'Report a Liara API limitation',
  description:
    'Call when the user asks for something the Liara API cannot do, so the limitation is shown explicitly instead of improvised: access_logs (HTTP access logs, request lists, status-code stats), registrar_dns (changing DNS at IRNIC or another registrar), top_up (charging the account), git_push (git-push deploys), webhooks (alerts/webhooks from Liara). Returns the plain-Persian limitation and what we do instead; then offer that alternative.',
  input: z.object({ topic: z.enum(['access_logs', 'registrar_dns', 'top_up', 'git_push', 'webhooks']) }),
  risk: 0,
  category: 'local',
  describeFa: () => 'بررسی امکانات API لیارا',
  run: async ({ topic }) => limitation(LIMITATIONS_FA[topic], `not available via the Liara API: ${topic}`),
});
