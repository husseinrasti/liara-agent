'use client';

import { fa } from '@/app/i18n/fa';
import type { AppSummary } from '@/app/lib/use-data';
import { Dot, Icon, Spinner, cx } from './ui';

type Level = 'ok' | 'degraded' | 'down' | 'off' | 'unknown';

/** App list with a status dot (selected app from its live status), plus "new deploy". */
export function AppSelector({
  apps,
  loading,
  error,
  selected,
  selectedLevel,
  onSelect,
  onNewDeploy,
}: {
  apps: AppSummary[] | undefined;
  loading: boolean;
  error: boolean;
  selected: string | null;
  selectedLevel: Level | null;
  onSelect: (name: string | null) => void;
  onNewDeploy: () => void;
}) {
  return (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className="mb-1 flex items-center justify-between px-2 text-xs font-semibold text-slate-500">
        <span>{fa.apps.heading}</span>
        {loading && <Spinner className="h-3 w-3" />}
      </div>
      {error && <div className="px-2 text-sm text-red-700">{fa.apps.error}</div>}
      {apps?.length === 0 && <div className="px-2 text-sm text-slate-500">{fa.apps.empty}</div>}
      {apps?.map((a) => {
        const active = a.name === selected;
        const level: Level = active && selectedLevel ? selectedLevel : a.scale === 0 ? 'off' : a.isDeployed === false ? 'unknown' : 'unknown';
        return (
          <button
            key={a.name}
            type="button"
            onClick={() => onSelect(active ? null : a.name)}
            className={cx('flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-start text-sm transition-colors', active ? 'bg-blue-50 font-semibold text-blue-800' : 'text-slate-700 hover:bg-slate-100')}
          >
            <Dot level={level} />
            <span dir="ltr" lang="en" className="min-w-0 flex-1 truncate text-left">
              {a.name}
            </span>
            <span className="text-[11px] text-slate-400">{a.platform}</span>
          </button>
        );
      })}
      <button type="button" onClick={onNewDeploy} className="mt-2 flex items-center gap-2 rounded-xl border border-dashed border-blue-300 px-3 py-2.5 text-sm text-blue-700 hover:bg-blue-50">
        {Icon.plus()} {fa.apps.newDeploy}
      </button>
    </nav>
  );
}
