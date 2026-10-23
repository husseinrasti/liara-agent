'use client';

import { useState } from 'react';
import type { Diagnosis } from '@/src/agent/diagnosis-schema';
import { fa, faNum } from '@/app/i18n/fa';
import { Badge, Button, Card, Icon, cx } from './ui';

const severityStyle: Record<string, { bar: string; tone: 'red' | 'amber' | 'green' | 'blue' }> = {
  critical: { bar: 'bg-red-500', tone: 'red' },
  degraded: { bar: 'bg-amber-500', tone: 'amber' },
  warning: { bar: 'bg-amber-400', tone: 'amber' },
  healthy: { bar: 'bg-emerald-500', tone: 'green' },
};

function Cause({ cause, defaultOpen }: { cause: Diagnosis['causes'][number]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const pct = Math.round(cause.confidence * 100);
  return (
    <li className="rounded-xl border border-slate-200 bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-3 py-2.5 text-start">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-900">{cause.title_fa}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
              <div className={cx('h-full rounded-full', pct >= 70 ? 'bg-blue-600' : pct >= 40 ? 'bg-blue-400' : 'bg-slate-300')} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-slate-500">{fa.confidence(cause.confidence)}</span>
          </div>
        </div>
        <span className={cx('text-slate-400 transition-transform', open && 'rotate-180')}>{Icon.chevron()}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-slate-100 px-3 py-2.5">
          <p className="text-sm leading-7 text-slate-600">{cause.explanation_fa}</p>
          <ul className="space-y-1.5">
            {cause.evidence.map((ev, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Badge tone="blue">{fa.diagnosis.sources[ev.source] ?? ev.source}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="leading-7 text-slate-700">{ev.text_fa}</div>
                  {ev.raw && (
                    <code dir="ltr" lang="en" className="mt-0.5 block truncate rounded bg-slate-50 px-2 py-0.5 text-left font-mono text-[11px] text-slate-500" title={ev.raw}>
                      {ev.raw}
                    </code>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** Diagnosis Card: severity, summary, ranked causes with evidence, one recommended action. */
export function DiagnosisCard({ diagnosis, source, onSend }: { diagnosis: Diagnosis; source: 'llm' | 'rules'; onSend: (text: string) => void }) {
  const [showAlt, setShowAlt] = useState(false);
  const s = severityStyle[diagnosis.severity] ?? severityStyle.warning!;
  const action = diagnosis.recommendedAction;
  return (
    <Card className="overflow-hidden p-0" testId="diagnosis-card">
      <div className={cx('h-1.5', s.bar)} />
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-slate-900">{fa.diagnosis.title}</h3>
          <Badge tone={s.tone}>{fa.diagnosis.severity[diagnosis.severity]}</Badge>
          {source === 'rules' && <Badge>{fa.diagnosis.rulesOnly}</Badge>}
        </div>
        <p className="text-[15px] leading-7 text-slate-800">{diagnosis.summaryFa}</p>
        <div>
          <div className="mb-2 text-sm font-medium text-slate-500">{fa.diagnosis.causes}</div>
          <ol className="space-y-2">
            {diagnosis.causes.map((c, i) => (
              <Cause key={i} cause={c} defaultOpen={i === 0} />
            ))}
          </ol>
        </div>
        {action && (
          <div className="rounded-xl bg-blue-50 p-3">
            <div className="text-sm font-medium text-blue-900">
              {fa.diagnosis.recommended}: {action.title_fa}
            </div>
            <p className="mt-1 text-sm leading-7 text-blue-900/80">{action.why_fa}</p>
            <Button className="mt-2" onClick={() => onSend(fa.diagnosis.runPrompt(action.title_fa))}>
              {fa.diagnosis.run}
            </Button>
          </div>
        )}
        {diagnosis.alternatives.length > 0 && (
          <div>
            <button type="button" onClick={() => setShowAlt((x) => !x)} className="text-sm text-blue-700 hover:underline">
              {fa.diagnosis.alternatives} ({faNum(diagnosis.alternatives.length)})
            </button>
            {showAlt && (
              <ul className="mt-2 space-y-1.5">
                {diagnosis.alternatives.map((a, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium text-slate-800">{a.title_fa}</div>
                      <div className="text-slate-500">{a.why_fa}</div>
                    </div>
                    <Button variant="soft" className="shrink-0 px-3 py-1" onClick={() => onSend(fa.diagnosis.runPrompt(a.title_fa))}>
                      {fa.diagnosis.runShort}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {diagnosis.manualStepsFa.length > 0 && (
          <div>
            <div className="mb-1 text-sm font-medium text-slate-500">{fa.diagnosis.manual}</div>
            <ul className="list-disc space-y-1 ps-5 text-sm leading-7 text-slate-700">
              {diagnosis.manualStepsFa.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {diagnosis.limitationsFa.length > 0 && (
          <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm leading-7 text-amber-900">
            <span className="mt-1.5">{Icon.info()}</span>
            <div>{diagnosis.limitationsFa.join(' ')}</div>
          </div>
        )}
      </div>
    </Card>
  );
}
