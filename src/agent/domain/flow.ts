/**
 * Domain flow: after add_domain the agent states the IRNIC limitation, remembers
 * the domain and the watcher polls check_domain every interval for up to 30
 * minutes; when DNS verifies it alerts and suggests enabling SSL.
 */
import type { Db } from '../../db';
import { checkDomain, isDomainVerified, isSslActive } from '../../liara/endpoints/domains';
import type { ToolContext } from '../../tools/registry';
import { getMemoryKey, setMemoryKey, type PendingDomain } from '../memory';
import type { AlertInput } from '../alerts';

export const DOMAIN_POLL_LIMIT_MS = 30 * 60_000;
export const IRNIC_LIMITATION_FA = 'من نمی‌توانم داخل پنل ایرنیک یا DNS شما تغییری بدهم؛ فقط می‌توانم بررسی کنم که درست انجام شده است.';

export function trackDomain(db: Db, appName: string, domain: { domainId: string; name: string }, now = new Date()): void {
  const pending = getMemoryKey(db, appName, 'pendingDomains').filter((d) => d.domainId !== domain.domainId);
  pending.push({ ...domain, since: now.toISOString() });
  setMemoryKey(db, appName, 'pendingDomains', pending, now);
}

export interface DomainPollOutcome {
  domain: PendingDomain;
  state: 'verified' | 'pending' | 'timed_out' | 'error';
  alert?: AlertInput;
}

/** One poll of every pending domain of an app; updates memory and returns alerts to raise. */
export async function pollPendingDomains(ctx: ToolContext, appName: string): Promise<DomainPollOutcome[]> {
  const pending = getMemoryKey(ctx.db, appName, 'pendingDomains');
  if (!pending.length) return [];
  const outcomes: DomainPollOutcome[] = [];
  const keep: PendingDomain[] = [];
  for (const d of pending) {
    try {
      const status = await checkDomain(ctx.liara, d.domainId);
      if (isDomainVerified(status)) {
        const ssl = isSslActive(status);
        outcomes.push({
          domain: d,
          state: 'verified',
          alert: {
            appName,
            severity: 'info',
            title: `دامنه‌ی ${d.name} وصل شد`,
            summary: ssl ? `رکورد DNS دامنه‌ی ${d.name} تأیید شد و SSL هم فعال است.` : `رکورد DNS دامنه‌ی ${d.name} تأیید شد؛ حالا می‌توان گواهی SSL (https) را فعال کرد.`,
            suggestedPrompt: ssl ? `دامنه‌ی ${d.name} را بررسی کن` : `SSL دامنه‌ی ${d.name} را فعال کن`,
          },
        });
        continue;
      }
      if (ctx.now().getTime() - Date.parse(d.since) > DOMAIN_POLL_LIMIT_MS) {
        outcomes.push({
          domain: d,
          state: 'timed_out',
          alert: {
            appName,
            severity: 'info',
            title: `دامنه‌ی ${d.name} هنوز تأیید نشده`,
            summary: `بعد از ۳۰ دقیقه هنوز رکورد DNS دامنه‌ی ${d.name} درست دیده نمی‌شود. گاهی تا ۲۴ ساعت طول می‌کشد؛ رکورد را یک بار دیگر بررسی کنید.`,
            suggestedPrompt: `وضعیت دامنه‌ی ${d.name} را بررسی کن و بگو رکورد DNS را درست گذاشته‌ام یا نه`,
          },
        });
        continue;
      }
      outcomes.push({ domain: d, state: 'pending' });
      keep.push(d);
    } catch {
      outcomes.push({ domain: d, state: 'error' });
      keep.push(d);
    }
  }
  setMemoryKey(ctx.db, appName, 'pendingDomains', keep, ctx.now());
  return outcomes;
}
