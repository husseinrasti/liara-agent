/** PlanRecommendation (pure Zod; shared with events and the UI Plan Card). */
import { z } from 'zod';

export const PlanRecommendationSchema = z.object({
  planID: z.string(),
  label: z.string(),
  ramMB: z.number(),
  cpu: z.number(),
  diskGB: z.number(),
  hourlyPriceIRT: z.number().nullable(),
  monthlyEstimateIRT: z.number().nullable(),
  bundlePlanID: z.string().nullable(),
  bundleMonthlyIRT: z.number().nullable(),
  totalMonthlyIRT: z.number().nullable(),
  reasonsFa: z.array(z.string()).max(3),
  alternatives: z.array(z.object({ planID: z.string(), label: z.string(), monthlyEstimateIRT: z.number().nullable(), whenFa: z.string() })).max(2),
  balance: z.object({ amountIRT: z.number(), enoughForDays: z.number().nullable(), sufficient: z.boolean() }).nullable(),
});
export type PlanRecommendation = z.infer<typeof PlanRecommendationSchema>;
