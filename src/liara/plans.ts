/**
 * Plan catalogue parsing. The PaaS spec does not document plans; they come from
 * `GET /v1/me` → `plans.projects[planID]` = {available, region, RAM:{amount GB},
 * CPU:{amount}, volume GB, price (Toman per HOUR), storageClass} and
 * `plans.projectBundlePlans[planID][bundle]` = {available, displayPrice (Toman per
 * month), maxLogsRetention (days), …}. Same reading as liara-cli `plan list`.
 * See docs/API-NOTES.md for the shapes observed by the probe.
 */

export interface BundleOption {
  id: string;
  available: boolean;
  monthlyIRT: number | null;
  maxLogsRetentionDays: number | null;
}

export interface Plan {
  id: string;
  label: string;
  ramMB: number;
  cpu: number;
  diskGB: number;
  hourlyPriceIRT: number | null;
  monthlyEstimateIRT: number | null;
  available: boolean;
  region?: string;
  storageClass?: string;
  isFree: boolean;
  /** Feature bundles (free / standard / pro) that can be combined with this plan. */
  bundles: BundleOption[];
}

export const HOURS_PER_MONTH = 720;

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof v === 'object' && 'amount' in v) return num((v as { amount: unknown }).amount);
  return null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** RAM in the catalogue is GB (0.5, 1, 2…); large values are treated as MB. */
function toRamMB(v: unknown): number {
  const n = num(v);
  if (n === null) return 0;
  return n <= 128 ? Math.round(n * 1024) : Math.round(n);
}

export function parseBundles(raw: unknown): BundleOption[] {
  return Object.entries(obj(raw)).map(([id, b]) => {
    const o = obj(b);
    return {
      id,
      available: o.available === undefined ? true : Boolean(o.available),
      monthlyIRT: num(o.displayPrice ?? o.price),
      maxLogsRetentionDays: num(o.maxLogsRetention),
    };
  });
}

export function parsePlan(id: string, raw: unknown, bundlesRaw?: unknown): Plan {
  const r = obj(raw);
  const ramMB = toRamMB(r.RAM ?? r.ram ?? r.memory);
  const cpu = num(r.CPU ?? r.cpu) ?? 0;
  const diskGB = num(r.volume ?? r.disk ?? r.storage) ?? 0;
  const hourly = num(r.price ?? r.hourlyPrice);
  const monthly = hourly === null ? null : Math.round(hourly * HOURS_PER_MONTH);
  const ramLabel = ramMB >= 1024 ? `${+(ramMB / 1024).toFixed(1)}GB` : `${ramMB}MB`;
  return {
    id,
    label: `${id} (${ramLabel} RAM, ${cpu} CPU)`,
    ramMB,
    cpu,
    diskGB,
    hourlyPriceIRT: hourly,
    monthlyEstimateIRT: monthly,
    available: r.available === undefined ? true : Boolean(r.available),
    region: typeof r.region === 'string' ? r.region : undefined,
    storageClass: typeof r.storageClass === 'string' ? r.storageClass : undefined,
    isFree: id === 'free' || hourly === 0,
    bundles: parseBundles(bundlesRaw),
  };
}

/** Extracts the PaaS plan catalogue (with bundles) from a `/v1/me` response body. */
export function extractProjectPlans(meBody: unknown): Plan[] {
  const plans = obj(obj(meBody).plans);
  const projects = obj(plans.projects);
  const bundles = obj(plans.projectBundlePlans);
  return Object.entries(projects)
    .map(([id, raw]) => parsePlan(id, raw, bundles[id]))
    .sort(byPrice);
}

function byPrice(a: Plan, b: Plan): number {
  return (a.hourlyPriceIRT ?? Infinity) - (b.hourlyPriceIRT ?? Infinity) || a.ramMB - b.ramMB;
}

/**
 * Plans a user can pick for a new app, cheapest first: available, Iran region
 * (when stated) and current generation (`free` or ids containing `g2`, as the CLI does).
 * Falls back to every available plan if that filter leaves nothing.
 */
export function purchasablePlans(plans: Plan[]): Plan[] {
  const available = plans.filter((p) => p.available && p.ramMB > 0);
  const current = available.filter((p) => (!p.region || p.region === 'iran') && (p.id === 'free' || p.id.includes('g2')));
  return (current.length ? current : available).sort(byPrice);
}

/** Cheapest available feature bundle for a plan (`free` for the free plan). */
export function cheapestBundle(plan: Plan): BundleOption | null {
  const options = plan.bundles.filter((b) => b.available);
  if (plan.isFree) return options.find((b) => b.id === 'free') ?? null;
  return options.sort((a, b) => (a.monthlyIRT ?? Infinity) - (b.monthlyIRT ?? Infinity))[0] ?? null;
}

/** Total monthly estimate: compute plan + chosen bundle. */
export function monthlyTotalIRT(plan: Plan, bundleId?: string | null): number | null {
  if (plan.monthlyEstimateIRT === null) return null;
  const bundle = plan.bundles.find((b) => b.id === bundleId);
  return plan.monthlyEstimateIRT + (bundle?.monthlyIRT ?? 0);
}

/** The next purchasable plan with strictly more RAM than `currentId` (for "upgrade plan" fixes). */
export function nextPlanUp(plans: Plan[], currentId: string): Plan | null {
  const current = plans.find((p) => p.id === currentId);
  if (!current) return null;
  return (
    purchasablePlans(plans)
      .filter((p) => p.ramMB > current.ramMB && !p.isFree)
      .sort((a, b) => a.ramMB - b.ramMB || byPrice(a, b))[0] ?? null
  );
}
