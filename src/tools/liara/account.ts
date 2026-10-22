import { z } from 'zod';
import { getBalance, getPlans } from '../../liara/endpoints/account';
import { purchasablePlans } from '../../liara/plans';
import { formatIRT, ok } from '../helpers';
import { defineTool } from '../registry';

export const getAccountTool = defineTool({
  name: 'get_account',
  title: 'Account balance and plans',
  description:
    'Account balance (Toman) and the plans available for new apps, cheapest first, with RAM/CPU/disk and hourly/monthly prices plus feature bundles. Use before creating an app or recommending a plan; topping up balance is the one step only the user can do.',
  input: z.object({}),
  risk: 0,
  category: 'read',
  describeFa: () => 'بررسی موجودی حساب و پلن‌ها',
  run: async (_i, ctx) => {
    const [balance, plans] = await Promise.allSettled([getBalance(ctx.liara), getPlans(ctx.liara)]);
    const b = balance.status === 'fulfilled' ? balance.value : { known: false as const, reason: 'balance request failed' };
    const list = plans.status === 'fulfilled' ? purchasablePlans(plans.value) : [];
    const plansAvailable = list.slice(0, 15).map((p) => ({
      id: p.id,
      ramMB: p.ramMB,
      cpu: p.cpu,
      diskGB: p.diskGB,
      hourlyPriceIRT: p.hourlyPriceIRT,
      monthlyEstimateIRT: p.monthlyEstimateIRT,
      bundles: p.bundles.filter((x) => x.available).map((x) => ({ id: x.id, monthlyIRT: x.monthlyIRT })),
    }));
    const data = b.known ? { balanceIRT: b.amountIRT, plansAvailable } : { balanceUnknown: true, plansAvailable };
    const balanceFa = b.known ? `موجودی حساب: ${formatIRT(b.amountIRT)}` : 'موجودی حساب از طریق API در دسترس نیست';
    return ok(data, `${balanceFa}؛ ${plansAvailable.length} پلن قابل انتخاب.`);
  },
});

export const accountTools = [getAccountTool];
