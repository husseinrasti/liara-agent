import { describe, expect, it } from 'vitest';
import { cheapestBundle, extractProjectPlans, monthlyTotalIRT, nextPlanUp, purchasablePlans } from '../plans';

// Shape as read by liara-cli `plan list` / `app create` (RAM/CPU amounts, hourly price, bundles).
const me = {
  plans: {
    projects: {
      free: { available: true, region: 'iran', RAM: { amount: 0.25 }, CPU: { amount: 0.1 }, volume: 0.5, price: 0 },
      'small-g2': { available: true, region: 'iran', RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, volume: 3, price: 150 },
      'medium-g2': { available: true, region: 'iran', RAM: { amount: 1 }, CPU: { amount: 1 }, volume: 5, price: 300 },
      'large-g2': { available: true, region: 'iran', RAM: { amount: 2 }, CPU: { amount: 2 }, volume: 10, price: 600 },
      'old-plan': { available: true, region: 'iran', RAM: { amount: 1 }, CPU: { amount: 1 }, volume: 5, price: 100 },
      'germany-g2': { available: true, region: 'germany', RAM: { amount: 1 }, CPU: { amount: 1 }, volume: 5, price: 50 },
      'gone-g2': { available: false, region: 'iran', RAM: { amount: 4 }, CPU: { amount: 2 }, volume: 20, price: 900 },
    },
    projectBundlePlans: {
      free: { free: { available: true, displayPrice: 0 } },
      'small-g2': {
        free: { available: true, displayPrice: 0, maxLogsRetention: 1 },
        standard: { available: true, displayPrice: 99000, maxLogsRetention: 7 },
        pro: { available: false, displayPrice: 299000 },
      },
    },
  },
};

describe('plan catalogue', () => {
  const plans = extractProjectPlans(me);

  it('parses RAM (GB→MB), CPU, disk and hourly→monthly price', () => {
    const small = plans.find((p) => p.id === 'small-g2')!;
    expect(small).toMatchObject({ ramMB: 512, cpu: 0.5, diskGB: 3, hourlyPriceIRT: 150, monthlyEstimateIRT: 108_000, isFree: false });
    expect(small.bundles.map((b) => b.id)).toEqual(['free', 'standard', 'pro']);
    expect(plans.find((p) => p.id === 'free')!.isFree).toBe(true);
  });

  it('offers only current-generation Iran plans, cheapest first', () => {
    expect(purchasablePlans(plans).map((p) => p.id)).toEqual(['free', 'small-g2', 'medium-g2', 'large-g2']);
  });

  it('picks the cheapest available bundle and totals the monthly cost', () => {
    const small = plans.find((p) => p.id === 'small-g2')!;
    expect(cheapestBundle(small)?.id).toBe('free');
    expect(monthlyTotalIRT(small, 'standard')).toBe(108_000 + 99_000);
  });

  it('finds the next plan up by RAM', () => {
    expect(nextPlanUp(plans, 'small-g2')?.id).toBe('medium-g2');
    expect(nextPlanUp(plans, 'large-g2')).toBeNull();
  });

  it('returns [] when /v1/me has no plans', () => {
    expect(extractProjectPlans({})).toEqual([]);
  });
});
