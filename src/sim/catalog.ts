/** Simulated plan catalogue (same shape as GET /v1/me → plans, per liara-cli). */

const bundles = (standard: number, pro: number) => ({
  free: { available: true, displayPrice: 0, maxLogsRetention: 1 },
  standard: { available: true, displayPrice: standard, maxLogsRetention: 7 },
  pro: { available: true, displayPrice: pro, maxLogsRetention: 30 },
});

export const SIM_PLANS = {
  projects: {
    free: { available: true, region: 'iran', RAM: { amount: 0.25 }, CPU: { amount: 0.1 }, volume: 0.5, price: 0, storageClass: 'SSD' },
    'small-g2': { available: true, region: 'iran', RAM: { amount: 0.5 }, CPU: { amount: 0.5 }, volume: 3, price: 150, storageClass: 'SSD' },
    'medium-g2': { available: true, region: 'iran', RAM: { amount: 1 }, CPU: { amount: 1 }, volume: 5, price: 300, storageClass: 'SSD' },
    'large-g2': { available: true, region: 'iran', RAM: { amount: 2 }, CPU: { amount: 2 }, volume: 10, price: 600, storageClass: 'SSD' },
    'xlarge-g2': { available: true, region: 'iran', RAM: { amount: 4 }, CPU: { amount: 2 }, volume: 20, price: 1100, storageClass: 'SSD' },
  },
  projectBundlePlans: {
    free: { free: { available: true, displayPrice: 0, maxLogsRetention: 1 } },
    'small-g2': bundles(49_000, 149_000),
    'medium-g2': bundles(99_000, 249_000),
    'large-g2': bundles(149_000, 349_000),
    'xlarge-g2': bundles(199_000, 449_000),
  },
} as const;

export type SimPlanId = keyof typeof SIM_PLANS.projects;

export function planSpec(planID: string): { ramMB: number; cpu: number; hourly: number } | null {
  const p = (SIM_PLANS.projects as Record<string, { RAM: { amount: number }; CPU: { amount: number }; price: number }>)[planID];
  return p ? { ramMB: p.RAM.amount * 1024, cpu: p.CPU.amount, hourly: p.price } : null;
}
