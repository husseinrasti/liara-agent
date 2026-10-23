'use client';

import type { PlanRecommendation } from '@/src/agent/deploy/plan-schema';
import { fa, faMoney, faNum } from '@/app/i18n/fa';
import { Badge, Button, Card } from './ui';

const ramFa = (mb: number) => (mb >= 1024 ? `${faNum(+(mb / 1024).toFixed(1))} ${fa.plan.gb}` : `${faNum(mb)} ${fa.plan.mb}`);

/** Plan Card: recommended plan, monthly estimate (Toman), reasons, alternatives, balance. */
export function PlanCard({ plan, onSend }: { plan: PlanRecommendation; onSend: (text: string) => void }) {
  return (
    <Card className="space-y-3" testId="plan-card">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-slate-900">{fa.plan.title}</h3>
        <Badge tone="blue">
          <span dir="ltr" lang="en">{plan.planID}</span>
        </Badge>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          [fa.plan.ram, ramFa(plan.ramMB)],
          [fa.plan.cpu, `${faNum(plan.cpu)} ${fa.plan.core}`],
          [fa.plan.disk, `${faNum(plan.diskGB)} ${fa.plan.gb}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl bg-slate-50 px-2 py-2.5">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="mt-0.5 font-semibold text-slate-800">{value}</div>
          </div>
        ))}
      </div>
      <div className="flex items-baseline justify-between rounded-xl bg-blue-50 px-3 py-2.5">
        <span className="text-sm text-blue-900">{fa.plan.monthly}</span>
        <span className="text-lg font-bold text-blue-700">{faMoney(plan.totalMonthlyIRT ?? plan.monthlyEstimateIRT)}</span>
      </div>
      <div>
        <div className="mb-1 text-sm font-medium text-slate-500">{fa.plan.reasons}</div>
        <ul className="list-disc space-y-1 ps-5 text-sm leading-7 text-slate-700">
          {plan.reasonsFa.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>
      {plan.alternatives.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm font-medium text-slate-500">{fa.plan.alternatives}</div>
          {plan.alternatives.map((a) => (
            <div key={a.planID} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm">
              <div>
                <div className="text-slate-800">{a.label}</div>
                <div className="text-xs text-slate-500">{a.whenFa}</div>
              </div>
              <span className="shrink-0 text-slate-600">{faMoney(a.monthlyEstimateIRT)}</span>
            </div>
          ))}
        </div>
      )}
      {plan.balance && (
        <p className={plan.balance.sufficient ? 'text-sm text-emerald-700' : 'rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900'}>
          {plan.balance.sufficient ? fa.plan.balanceOk(plan.balance.enoughForDays ?? 0) : fa.plan.balanceLow}
        </p>
      )}
      <Button onClick={() => onSend(fa.plan.proceedPrompt(plan.planID))}>{fa.plan.proceed}</Button>
    </Card>
  );
}
