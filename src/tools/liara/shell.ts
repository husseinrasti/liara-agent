import { z } from 'zod';
import { execShell, validateShellCommand } from '../../liara/endpoints/shell';
import { appNameSchema, limitation, ok } from '../helpers';
import { defineTool } from '../registry';

export const execShellTool = defineTool({
  name: 'exec_shell',
  title: 'Run read-only command in container',
  description:
    'Run ONE read-only diagnostic command inside the app container (allow-list: ls, cat, head, tail, wc, df -h, free -m, ps, env (values masked), node -v, npm ls --depth=0). No pipes, redirects or variables. Output ≤ 4KB.',
  input: z.object({ appName: appNameSchema, command: z.string().min(1).max(200) }),
  risk: 2,
  category: 'ops',
  describeFa: ({ appName, command }) => `اجرای فرمان «${command}» داخل سرویس ${appName}`,
  consequencesFa: async ({ command }) => ({
    why: `فرمان «${command}» داخل کانتینر برنامه اجرا می‌شود. فقط فرمان‌های خواندنی مجازند و چیزی تغییر نمی‌کند، ولی دسترسی مستقیم به سرور حساس است.`,
    reversible: true,
  }),
  run: async ({ appName, command }, ctx) => {
    const check = validateShellCommand(command);
    if (!check.ok) {
      return limitation(
        `این فرمان مجاز نیست (${check.reason}). فقط فرمان‌های فقط‌خواندنی مثل ls، df -h، free -m و node -v را اجرا می‌کنم.`,
        `command rejected: ${check.reason}`,
      );
    }
    const res = await execShell(ctx.liara, appName, command);
    return ok(res, res.output ? 'فرمان اجرا شد.' : 'فرمان اجرا شد ولی خروجی‌ای برنگرداند.');
  },
  verify: async () => ({ ok: true, evidence: ['فرمان فقط‌خواندنی بود و تغییری در سرویس ایجاد نکرد'] }),
  verifyDelayMs: 0,
});

export const shellTools = [execShellTool];
