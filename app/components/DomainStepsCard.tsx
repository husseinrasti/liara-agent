'use client';

import { useState } from 'react';
import type { EventOf } from '@/src/events';
import { fa, faNum } from '@/app/i18n/fa';
import { Card, Icon } from './ui';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-blue-700 hover:bg-blue-50"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {Icon.copy('h-3.5 w-3.5')} {copied ? fa.domain.copied : fa.domain.copy}
    </button>
  );
}

/** DNS records the user must create at the registrar (we cannot), with the IRNIC/registrar steps. */
export function DomainStepsCard({ event }: { event: EventOf<'domain_steps'> }) {
  return (
    <Card className="space-y-3" testId="domain-steps">
      <h3 className="text-base font-semibold text-slate-900">
        {fa.domain.title} <span dir="ltr" lang="en">{event.domain}</span>
      </h3>
      {event.records.length > 0 && (
        <div>
          <div className="mb-1.5 text-sm font-medium text-slate-500">{fa.domain.records}</div>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table dir="ltr" lang="en" className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-1 py-2" />
                </tr>
              </thead>
              <tbody className="font-mono text-[13px] text-slate-800">
                {event.records.map((r) => (
                  <tr key={`${r.type}-${r.name}`} className="border-t border-slate-100">
                    <td className="whitespace-nowrap px-3 py-2">{r.type}</td>
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="break-all px-3 py-2">{r.value}</td>
                    <td className="px-1 py-1 text-end">
                      <CopyButton text={r.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div>
        <div className="mb-1.5 text-sm font-medium text-slate-500">{fa.domain.steps}</div>
        <ol className="space-y-1.5 text-sm leading-7 text-slate-700">
          {event.stepsFa.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">{faNum(i + 1)}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}
