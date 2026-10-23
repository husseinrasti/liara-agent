'use client';

import type { AppStatus } from '@/src/server/status';
import { fa, faMoney, faNum } from '@/app/i18n/fa';
import { Badge, Dot, Spinner, Switch, cx } from './ui';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-sm">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 text-end text-slate-800">{children}</span>
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={cx('h-full rounded-full', p >= 90 ? 'bg-red-500' : p >= 75 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${p}%` }} />
    </div>
  );
}

const levelText: Record<AppStatus['level'], string> = { ok: 'سالم', degraded: 'نیازمند توجه', down: 'از دسترس خارج', off: 'خاموش', unknown: 'نامشخص' };

/** Side panel for the selected app; polled every 30s. */
export function StatusPanel({ status, loading, appName, onToggleWatch }: { status: AppStatus | undefined; loading: boolean; appName: string | null; onToggleWatch: (on: boolean) => void }) {
  if (!appName) return <div className="p-5 text-sm leading-7 text-slate-500">{fa.status.pick}</div>;
  if (!status) {
    return (
      <div className="flex items-center gap-2 p-5 text-sm text-slate-500">
        <Spinner className="h-3.5 w-3.5" /> {fa.status.refreshing}
      </div>
    );
  }
  const s = status;
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Dot level={s.level} />
        <h2 dir="ltr" lang="en" className="flex-1 truncate text-left text-base font-semibold text-slate-900">
          {s.appName}
        </h2>
        <Badge tone={s.level === 'ok' ? 'green' : s.level === 'degraded' ? 'amber' : s.level === 'down' ? 'red' : 'slate'}>{levelText[s.level]}</Badge>
        {loading && <Spinner className="h-3 w-3" />}
      </div>
      <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-3">
        <Row label={fa.status.site}>
          {s.health ? (
            s.health.status ? (
              <span className={s.health.ok ? 'text-emerald-700' : 'text-red-700'}>
                {faNum(s.health.status)}
                {s.health.latencyMs !== null && <span className="text-slate-500"> · {faNum(s.health.latencyMs)} میلی‌ثانیه</span>}
              </span>
            ) : (
              <span className="text-red-700">{fa.status.noResponse}</span>
            )
          ) : (
            '—'
          )}
        </Row>
        <Row label={fa.status.plan}>
          {s.plan ? (
            <span>
              <span dir="ltr" lang="en">{s.plan.id}</span>
              {s.plan.monthlyEstimateIRT !== null && <span className="block text-xs text-slate-500">{faMoney(s.plan.monthlyEstimateIRT)} در ماه</span>}
            </span>
          ) : (
            '—'
          )}
        </Row>
        <div className="py-2 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">{fa.status.ram}</span>
            <span className="text-slate-800">{s.memory?.pct !== null && s.memory ? `${faNum(Math.round(s.memory.pct ?? 0))}٪ · ${faNum(Math.round(s.memory.lastMB))} مگابایت` : '—'}</span>
          </div>
          {s.memory?.pct !== null && s.memory && <Bar pct={s.memory.pct ?? 0} />}
        </div>
        <Row label={fa.status.cpu}>{s.cpu ? (s.cpu.unit === 'percent_of_plan' ? `${faNum(Math.round(s.cpu.value))}٪` : `${faNum(s.cpu.value.toFixed(2))} هسته`) : '—'}</Row>
        <Row label={fa.status.release}>
          {s.release ? (
            <span>
              <span dir="ltr" lang="en">{s.release.tag ?? '—'}</span> · {s.release.stateFa}
              {s.release.ageMinutes !== null && <span className="block text-xs text-slate-500">{fa.status.minutesAgo(s.release.ageMinutes)}</span>}
            </span>
          ) : (
            '—'
          )}
        </Row>
        <Row label={fa.status.domains}>
          {s.domains.length ? (
            <span className="space-y-0.5">
              {s.domains.map((d) => (
                <span key={d.name} className="block">
                  <span dir="ltr" lang="en">{d.name}</span> · {d.verified ? fa.status.verified : fa.status.pending}
                  {d.verified && <span className="text-xs text-slate-500"> · {fa.status.ssl} {d.sslActive ? '✓' : '…'}</span>}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-slate-400">{fa.status.noDomains}</span>
          )}
        </Row>
      </div>
      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm">
        <span className="text-slate-700">{fa.status.watch}</span>
        <span className="flex items-center gap-2">
          <span className="text-xs text-slate-500">{s.watch ? fa.status.watchOn : fa.status.watchOff}</span>
          <Switch checked={s.watch} onChange={onToggleWatch} label={fa.status.watch} />
        </span>
      </div>
      <div>
        <div className="mb-1.5 text-xs font-semibold text-slate-500">{fa.status.actions}</div>
        {s.lastActions.length ? (
          <ul className="space-y-1.5">
            {s.lastActions.map((a) => (
              <li key={`${a.tool}-${a.ts}`} className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm">
                <span className="text-slate-700">{fa.toolNames[a.tool] ?? a.tool}</span>
                <Badge tone={a.fixed === undefined ? 'slate' : a.fixed ? 'green' : 'red'}>{a.fixed === undefined ? fa.status.done : a.fixed ? fa.status.fixed : fa.status.notFixed}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-slate-400">{fa.status.noActions}</div>
        )}
      </div>
    </div>
  );
}
