'use client';

import { useState } from 'react';
import { fa, faNum } from '@/app/i18n/fa';
import type { TimelineRow } from '@/app/lib/reducer';
import { Icon, Spinner, cx } from './ui';

function StatusIcon({ status }: { status: TimelineRow['status'] }) {
  if (status === 'running') return <Spinner className="h-3.5 w-3.5" />;
  if (status === 'ok') return <span className="text-emerald-600">{Icon.check('h-4 w-4')}</span>;
  if (status === 'waiting') return <span className="text-amber-600">{Icon.pause('h-4 w-4')}</span>;
  if (status === 'approved') return <span className="text-emerald-600">{Icon.check('h-4 w-4')}</span>;
  if (status === 'rejected') return <span className="text-slate-400">{Icon.cross('h-4 w-4')}</span>;
  if (status === 'limited') return <span className="text-amber-600">{Icon.info('h-4 w-4')}</span>;
  return <span className="text-red-600">{Icon.cross('h-4 w-4')}</span>;
}

function Row({ row }: { row: TimelineRow }) {
  const [open, setOpen] = useState(false);
  const hasRaw = row.raw !== undefined && row.raw !== null;
  return (
    <li className="py-1.5" data-testid="timeline-row" data-tool={row.tool} data-status={row.status}>
      <div className="flex items-start gap-2 text-sm">
        <span className="mt-0.5">
          <StatusIcon status={row.status} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-slate-700">
            <span className="font-medium">{row.argsSummary}</span>
            {row.durationMs !== undefined && row.durationMs >= 100 && row.status !== 'running' && (
              <span className="text-xs text-slate-400">{faNum((row.durationMs / 1000).toFixed(1)).replace('.', '٫')} ثانیه</span>
            )}
            {row.status === 'waiting' && <span className="text-xs text-amber-700">{fa.timeline.waiting}</span>}
            {row.status === 'approved' && <span className="text-xs text-emerald-700">{fa.timeline.approved}</span>}
            {row.status === 'rejected' && <span className="text-xs text-slate-500">{fa.timeline.rejected}</span>}
          </div>
          {row.summary && !['waiting', 'approved', 'rejected', 'limited'].includes(row.status) && <div className={cx('text-xs leading-6', row.status === 'failed' ? 'text-red-700' : 'text-slate-500')}>{row.summary}</div>}
          {hasRaw && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 text-xs text-blue-700 hover:underline">
              {open ? fa.timeline.hide : fa.timeline.details}
            </button>
          )}
          {open && (
            <pre dir="ltr" lang="en" className="mt-1 max-h-64 overflow-auto rounded-lg bg-slate-50 p-2 text-left text-[11px] leading-5 text-slate-600">
              {JSON.stringify(row.raw, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </li>
  );
}

/** Tool calls of one turn, with collapsible raw results ("جزئیات"). */
export function OperationTimeline({ rows }: { rows: TimelineRow[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!rows.length) return null;
  const running = rows.some((r) => r.status === 'running');
  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
      <button type="button" onClick={() => setCollapsed((c) => !c)} className="flex w-full items-center gap-2 text-xs font-medium text-slate-500">
        {running ? <Spinner className="h-3 w-3" /> : Icon.check('h-3.5 w-3.5 text-emerald-600')}
        <span>{fa.timeline.steps(rows.length)}</span>
        <span className={cx('ms-auto transition-transform', collapsed && 'rotate-90')}>{Icon.chevron('h-3.5 w-3.5')}</span>
      </button>
      {!collapsed && <ul className="mt-1 divide-y divide-slate-100">{rows.map((r) => <Row key={r.callId} row={r} />)}</ul>}
    </div>
  );
}
