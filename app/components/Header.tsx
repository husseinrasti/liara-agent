'use client';

import { fa } from '@/app/i18n/fa';
import type { HealthInfo } from '@/app/lib/use-data';
import { Badge, Icon, cx } from './ui';

function Pill({ label, ok }: { label: string; ok: boolean | null }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-600">
      <span className={cx('h-2 w-2 rounded-full', ok === null ? 'bg-slate-300' : ok ? 'bg-emerald-500' : 'bg-red-500')} />
      {label}
    </span>
  );
}

export function Header({ health, onNewConversation, apps }: { health: HealthInfo | null; onNewConversation: () => void; apps?: React.ReactNode }) {
  const simulated = health?.mode === 'simulated';
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 font-bold text-white">ل</div>
        <div>
          <h1 className="text-base font-bold leading-tight text-slate-900">{fa.app.title}</h1>
          <p className="text-xs text-slate-500">{fa.app.tagline}</p>
        </div>
      </div>
      {simulated && (
        <span title={fa.app.simulatedHint}>
          <Badge tone="amber">{fa.app.simulatedBadge}</Badge>
        </span>
      )}
      <div className="ms-auto flex items-center gap-4">
        {apps}
        <Pill label={fa.health.liara} ok={health ? health.liara.ok : null} />
        <Pill label={fa.health.llm} ok={health ? health.llm.ok : null} />
        <button type="button" onClick={onNewConversation} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100">
          {Icon.plus('h-3.5 w-3.5')} گفت‌وگوی جدید
        </button>
      </div>
    </header>
  );
}
