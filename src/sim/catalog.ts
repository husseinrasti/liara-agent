/** Simulated plan catalogue (same shape as GET /v1/me → plans, per liara-cli). */

/** g2 feature bundles: `free` is not offered on g2 plans; Toman per month [probe 01-me]. */
const bundles = (basic: number, standard: number, pro: number) => ({
  free: { available: false, displayPrice: 0, maxLogsRetention: 0.05 },
  basic: { available: true, displayPrice: basic, maxLogsRetention: 7 },
  standard: { available: true, displayPrice: standard, maxLogsRetention: 30 },
  pro: { available: true, displayPrice: pro, maxLogsRetention: 60 },
});

/** Real ids, sizes and prices from the probe (price = Toman/hour, displayPrice = Toman/month). */
const g2 = (ram: number, cpu: number, volume: number, price: number, displayPrice: number) => ({
  available: true,
  region: 'iran',
  RAM: { amount: ram },
  CPU: { amount: cpu },
  volume,
  price,
  displayPrice,
  storageClass: 'SSD',
});

export const SIM_PLANS = {
  projects: {
    free: { available: false, region: 'iran', RAM: { amount: 0.25 }, CPU: { amount: 0.1 }, volume: 0.5, price: 0, displayPrice: 0, storageClass: 'SSD' },
    'small-g2': g2(0.5, 0.5, 5, 659.72, 475_000),
    'medium-g2': g2(1, 1, 10, 1145.83, 825_000),
    'standard-base-g2': g2(2, 1, 20, 2048.61, 1_475_000),
    'standard-plus-g2': g2(4, 2, 40, 3680.55, 2_650_000),
    'pro-g2': g2(8, 4, 80, 6388.88, 4_600_000),
  },
  projectBundlePlans: {
    free: { free: { available: true, displayPrice: 0, maxLogsRetention: 0.05 } },
    'small-g2': bundles(275_000, 475_000, 825_000),
    'medium-g2': bundles(475_000, 825_000, 1_475_000),
    'standard-base-g2': bundles(825_000, 1_475_000, 2_650_000),
    'standard-plus-g2': bundles(1_475_000, 2_650_000, 4_600_000),
    'pro-g2': bundles(2_650_000, 4_600_000, 8_000_000),
  },
} as const;

export type SimPlanId = keyof typeof SIM_PLANS.projects;

export function planSpec(planID: string): { ramMB: number; cpu: number; hourly: number } | null {
  const p = (SIM_PLANS.projects as Record<string, { RAM: { amount: number }; CPU: { amount: number }; price: number }>)[planID];
  return p ? { ramMB: p.RAM.amount * 1024, cpu: p.CPU.amount, hourly: p.price } : null;
}
