'use client';

import type { AlertRow } from '@/src/agent/alerts';
import { fa } from '@/app/i18n/fa';
import type { AlertEvent } from '@/app/lib/reducer';
import { Button, Icon, cx } from './ui';

export interface BannerAlert {
  id?: string;
  appName: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  summary: string;
  suggestedPrompt?: string;
}

const tones = {
  critical: 'border-red-200 bg-red-50 text-red-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  info: 'border-blue-200 bg-blue-50 text-blue-900',
};

/** Merges persisted alerts (with ids, for acknowledge) and live alert events (with suggested prompts). */
export function mergeAlerts(rows: AlertRow[], live: AlertEvent[], appName: string | null): BannerAlert[] {
  const byKey = new Map<string, BannerAlert>();
  for (const r of rows) byKey.set(`${r.appName}|${r.title}`, { id: r.id, appName: r.appName, severity: r.severity, title: r.title, summary: r.summary });
  for (const e of live) {
    const k = `${e.appName}|${e.title}`;
    const prev = byKey.get(k);
    if (prev) prev.suggestedPrompt = e.suggestedPrompt;
  }
  return [...byKey.values()].filter((a) => !appName || a.appName === appName);
}

/** Watcher alerts for the selected app: investigate (sends the suggested prompt) or acknowledge. */
export function AlertBanner({ alerts, onInvestigate, onAck }: { alerts: BannerAlert[]; onInvestigate: (prompt: string) => void; onAck: (id: string) => void }) {
  if (!alerts.length) return null;
  return (
    <div data-testid="alert-banner" className="space-y-2 border-b border-slate-200 bg-white px-4 py-3">
      {alerts.slice(0, 3).map((a) => (
        <div key={`${a.appName}|${a.title}`} className={cx('mx-auto flex max-w-3xl flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5', tones[a.severity])}>
          <span className="shrink-0">{Icon.alert('h-5 w-5')}</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">
              {fa.alert.severity[a.severity]}: {a.title}
            </div>
            <div className="text-sm leading-6 opacity-90">{a.summary}</div>
          </div>
          <div className="flex gap-2">
            <Button className="px-3 py-1.5" onClick={() => onInvestigate(a.suggestedPrompt ?? `${a.title} — بررسی کن`)}>
              {fa.alert.investigate}
            </Button>
            {a.id && (
              <Button variant="ghost" className="px-3 py-1.5" onClick={() => onAck(a.id!)}>
                {fa.alert.ack}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
