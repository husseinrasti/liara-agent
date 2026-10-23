'use client';

import { useState } from 'react';
import { fa } from '@/app/i18n/fa';
import type { TurnItem } from '@/app/lib/reducer';
import { Badge, Button, Card, Icon } from './ui';

type ApprovalItem = Extract<TurnItem, { kind: 'approval' }>;

const timeFa = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** Human-in-the-loop card: what, why, risk, reversibility, cost; risk 2 needs the typed app name. */
export function ApprovalCard({ item, onDecide }: { item: ApprovalItem; onDecide: (approvalId: string, approved: boolean, typedName?: string) => Promise<{ ok: boolean; error?: string }> }) {
  const e = item.event;
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsName = Boolean(e.requiresTypedName);
  const nameOk = !needsName || typed.trim() === e.requiresTypedName;

  if (item.resolved) {
    return (
      <Card tone={item.resolved.approved ? 'green' : 'plain'} className="py-3" testId="approval-receipt">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={item.resolved.approved ? 'text-emerald-700' : 'text-slate-500'}>{item.resolved.approved ? Icon.check() : Icon.cross()}</span>
          <span className="font-medium">{e.title}</span>
          <Badge tone={item.resolved.approved ? 'green' : 'slate'}>{item.resolved.approved ? fa.approval.approved : fa.approval.rejected}</Badge>
          <span className="text-xs text-slate-500">
            {fa.approval.by} {item.resolved.by === 'user' ? 'شما' : item.resolved.by} — {timeFa(item.resolved.ts)}
          </span>
        </div>
      </Card>
    );
  }

  const decide = async (approved: boolean) => {
    setPending(approved ? 'approve' : 'reject');
    setError(null);
    const res = await onDecide(e.approvalId, approved, needsName ? typed.trim() : undefined);
    if (!res.ok) setError(res.error ?? null);
    setPending(null);
  };

  const riskTone = e.risk >= 2 ? 'red' : e.risk === 1 ? 'amber' : 'green';
  return (
    <Card tone={e.risk >= 2 ? 'red' : 'amber'} className="space-y-3" testId="approval-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className={e.risk >= 2 ? 'text-red-700' : 'text-amber-700'}>{Icon.shield('h-5 w-5')}</span>
        <h3 className="text-base font-semibold text-slate-900">{e.title}</h3>
        <Badge tone={riskTone}>{fa.approval.risk[e.risk]}</Badge>
        <Badge tone={e.reversible ? 'green' : 'red'}>{e.reversible ? fa.approval.reversible : fa.approval.irreversible}</Badge>
      </div>
      <p className="whitespace-pre-line text-sm leading-7 text-slate-700">{e.why}</p>
      {e.costNote && <p className="rounded-lg bg-white/70 px-3 py-2 text-sm text-slate-700">{e.costNote}</p>}
      {needsName && (
        <label className="block space-y-1.5">
          <span className="text-sm text-slate-700">{fa.approval.typeName(e.requiresTypedName!)}</span>
          <input
            dir="ltr"
            value={typed}
            onChange={(ev) => setTyped(ev.target.value)}
            placeholder={e.requiresTypedName}
            className="w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-left font-mono text-sm outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
          />
        </label>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant={e.risk >= 2 ? 'danger' : 'primary'} disabled={!nameOk || pending !== null} onClick={() => void decide(true)}>
          {pending === 'approve' ? fa.approval.sending : fa.approval.approve}
        </Button>
        <Button variant="ghost" disabled={pending !== null} onClick={() => void decide(false)}>
          {fa.approval.reject}
        </Button>
      </div>
    </Card>
  );
}
