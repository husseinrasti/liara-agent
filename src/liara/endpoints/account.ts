import type { LiaraClient } from '../client';
import { extractProjectPlans, type Plan } from '../plans';
import { BillingSchema, MeSchema, type Me } from '../types';

const PLAN_CACHE_MS = 10 * 60_000;
const planCache = new WeakMap<LiaraClient, { at: number; plans: Plan[] }>();

export async function getMe(c: LiaraClient): Promise<Me> {
  return c.request(MeSchema, { path: '/v1/me' });
}

/** PaaS plan catalogue from `/v1/me` → `plans.projects`, cached for 10 minutes per client. */
export async function getPlans(c: LiaraClient, opts: { fresh?: boolean; now?: () => number } = {}): Promise<Plan[]> {
  const now = opts.now ?? Date.now;
  const hit = planCache.get(c);
  if (hit && !opts.fresh && now() - hit.at < PLAN_CACHE_MS) return hit.plans;
  const plans = extractProjectPlans(await getMe(c));
  planCache.set(c, { at: now(), plans });
  return plans;
}

export type Balance =
  | { known: true; amountIRT: number; source: string }
  | { known: false; reason: string };

/** Account balance in Toman. `/v1/billing` → user.balance; team accounts → `/v1/me` → team.balance. */
export async function getBalance(c: LiaraClient): Promise<Balance> {
  try {
    const billing = await c.request(BillingSchema, { path: '/v1/billing' });
    // Team mode (teamID): the team pays and user.balance is 0 [probe].
    const amount = c.teamId ? (billing.team?.balance ?? billing.user?.balance) : (billing.user?.balance ?? billing.team?.balance);
    if (typeof amount === 'number') return { known: true, amountIRT: amount, source: 'billing' };
  } catch {
    // fall through to /v1/me (team mode)
  }
  try {
    const me = await getMe(c);
    const amount = me.team?.balance;
    if (typeof amount === 'number') return { known: true, amountIRT: amount, source: 'me.team' };
  } catch {
    // ignore
  }
  return { known: false, reason: 'balance is not exposed for this account via the API' };
}
