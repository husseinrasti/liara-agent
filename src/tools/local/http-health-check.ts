import { z } from 'zod';
import { limitation, ok } from '../helpers';
import { defineTool } from '../registry';
import { healthLineFa, httpProbe, validatePublicUrl } from './http-probe';

export const httpHealthCheckTool = defineTool({
  name: 'http_health_check',
  title: 'HTTP health check',
  description:
    'GET a public URL (follows redirects) a few times and report status code, latency min/avg/max and a body snippet. Not part of the Liara API: this is how we observe real availability and 5xx errors, since Liara has no access logs.',
  input: z.object({
    url: z.string().min(1).describe('e.g. https://my-app.liara.run/'),
    timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
    samples: z.number().int().min(1).max(5).default(3),
  }),
  risk: 0,
  category: 'local',
  describeFa: ({ url }) => `بررسی در دسترس بودن ${url}`,
  run: async ({ url, timeoutMs, samples }, ctx) => {
    const valid = validatePublicUrl(url);
    if (!valid.ok) return limitation(`این آدرس را نمی‌توانم بررسی کنم (${valid.reason}). فقط آدرس‌های عمومی http/https مجازند.`, valid.reason);
    const res = await httpProbe(valid.url.toString(), { timeoutMs, samples, fetchImpl: ctx.httpFetch, now: ctx.now });
    return ok(res, res.ok ? `سایت سالم پاسخ داد؛ ${healthLineFa(res)}.` : `سایت درست پاسخ نداد؛ ${healthLineFa(res)}.`);
  },
});
