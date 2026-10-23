/**
 * Deterministic plan recommendation (the LLM only narrates it): platform sets the
 * RAM floor, heavy dependencies or a large project bump one step, prices come
 * from the real catalogue, plus a cheaper/bigger alternative and a balance check.
 */
import type { Balance } from '../../liara/endpoints/account';
import { cheapestBundle, monthlyTotalIRT, purchasablePlans, type Plan } from '../../liara/plans';
import { PLATFORM_FA } from '../../tools/local/analyze-project';
import { faNum } from '../../tools/helpers';
import { isStaticPlatform } from '../../tools/local/platforms';
import type { PlanRecommendation } from './plan-schema';

export interface PlanInput {
  platform: string;
  sizeMB?: number;
  needsDatabase?: string | null;
  needsDisk?: boolean;
  notableDeps?: string[];
}

export function planLabelFa(p: Plan): string {
  const ram = p.ramMB >= 1024 ? `${faNum(p.ramMB / 1024)} گیگابایت` : `${faNum(p.ramMB, { grouping: false })} مگابایت`;
  return `${p.id} — ${ram} رم، ${faNum(p.cpu)} هسته`;
}

const byRam = (a: Plan, b: Plan) => a.ramMB - b.ramMB || (a.hourlyPriceIRT ?? 0) - (b.hourlyPriceIRT ?? 0);

export function recommendPlan(input: PlanInput, catalogue: Plan[], balance?: Balance | null): PlanRecommendation | null {
  const pool = purchasablePlans(catalogue).filter((p) => !p.isFree).sort(byRam);
  if (!pool.length) return null;
  const light = isStaticPlatform(input.platform);
  const minRam = light ? 0 : 1024;
  let idx = pool.findIndex((p) => p.ramMB >= minRam);
  if (idx < 0) idx = pool.length - 1;
  const reasons: string[] = [
    light
      ? 'سایت ایستا و فرانت‌اند منابع کمی لازم دارد؛ کوچک‌ترین پلن کافی است.'
      : `برنامه‌های ${PLATFORM_FA[input.platform] ?? input.platform} برای اجرای پایدار حداقل ۱ گیگابایت رم لازم دارند.`,
  ];
  const heavy = input.notableDeps ?? [];
  if ((heavy.length || (input.sizeMB ?? 0) > 200) && idx < pool.length - 1) {
    idx++;
    reasons.push(heavy.length ? `وابستگی‌های سنگین (${heavy.slice(0, 2).join('، ')}) رم بیشتری مصرف می‌کنند؛ یک پله بزرگ‌تر انتخاب شد.` : 'حجم پروژه زیاد است؛ یک پله بزرگ‌تر انتخاب شد.');
  }
  if (input.needsDatabase) reasons.push(`به پایگاه داده‌ی ${input.needsDatabase} نیاز دارد که جداگانه ساخته می‌شود و هزینه‌اش جداست.`);
  else if (input.needsDisk) reasons.push('برنامه فایل ذخیره می‌کند؛ برای ماندگاری فایل‌ها بعداً یک دیسک لازم است.');

  const chosen = pool[idx]!;
  const bundle = cheapestBundle(chosen);
  const alternatives: PlanRecommendation['alternatives'] = [];
  const smaller = pool[idx - 1];
  const bigger = pool[idx + 1];
  if (smaller) alternatives.push({ planID: smaller.id, label: planLabelFa(smaller), monthlyEstimateIRT: smaller.monthlyEstimateIRT, whenFa: 'اگر ترافیک کم است و می‌خواهید ارزان‌تر شروع کنید' });
  if (bigger) alternatives.push({ planID: bigger.id, label: planLabelFa(bigger), monthlyEstimateIRT: bigger.monthlyEstimateIRT, whenFa: 'اگر ترافیک زیاد شد یا برنامه کند شد' });

  let balanceInfo: PlanRecommendation['balance'] = null;
  if (balance?.known && chosen.hourlyPriceIRT) {
    const daily = chosen.hourlyPriceIRT * 24;
    balanceInfo = { amountIRT: balance.amountIRT, enoughForDays: Math.floor(balance.amountIRT / daily), sufficient: balance.amountIRT >= daily };
  }
  return {
    planID: chosen.id,
    label: planLabelFa(chosen),
    ramMB: chosen.ramMB,
    cpu: chosen.cpu,
    diskGB: chosen.diskGB,
    hourlyPriceIRT: chosen.hourlyPriceIRT,
    monthlyEstimateIRT: chosen.monthlyEstimateIRT,
    bundlePlanID: bundle?.id ?? null,
    bundleMonthlyIRT: bundle?.monthlyIRT ?? null,
    totalMonthlyIRT: monthlyTotalIRT(chosen, bundle?.id),
    reasonsFa: reasons.slice(0, 3),
    alternatives,
    balance: balanceInfo,
  };
}
