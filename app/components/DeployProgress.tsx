'use client';

import { useState } from 'react';
import { DEPLOY_STAGES } from '@/src/events';
import { fa } from '@/app/i18n/fa';
import type { DeployStageState } from '@/app/lib/reducer';
import { Card, Icon, Spinner, cx } from './ui';

function StageIcon({ state }: { state?: DeployStageState }) {
  if (!state || state.status === 'pending') return <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />;
  if (state.status === 'running') return <Spinner className="h-4 w-4" />;
  if (state.status === 'done') return <span className="text-emerald-600">{Icon.check('h-4 w-4')}</span>;
  return <span className="text-red-600">{Icon.cross('h-4 w-4')}</span>;
}

/** Deploy stepper: analyze → create → envs → archive → upload → release → build → health (from the first stage reached), then the URL. */
export function DeployProgress({ stages, url }: { stages: Partial<Record<string, DeployStageState>>; url?: string }) {
  const [copied, setCopied] = useState(false);
  const healthy = stages.health?.status === 'done';
  // A rollback or redeploy starts at "release"; hide the earlier wizard stages it never runs.
  const first = DEPLOY_STAGES.findIndex((s) => stages[s]);
  const visible = DEPLOY_STAGES.slice(Math.max(0, first));
  return (
    <Card className="space-y-3" testId="deploy-progress">
      <h3 className="text-base font-semibold text-slate-900">{fa.deploy.title}</h3>
      <ol className="space-y-2">
        {visible.map((stage) => {
          const st = stages[stage];
          return (
            <li key={stage} className="flex items-start gap-3">
              <span className="mt-1 flex h-4 w-4 items-center justify-center">
                <StageIcon state={st} />
              </span>
              <div className="min-w-0 flex-1">
                <div className={cx('text-sm', st?.status === 'failed' ? 'font-medium text-red-700' : st ? 'text-slate-800' : 'text-slate-400')}>{fa.deploy.stages[stage]}</div>
                {st?.detail && <div className="text-xs leading-6 text-slate-500">{st.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {healthy && url && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-emerald-50 p-3">
          <a href={url} target="_blank" rel="noreferrer" dir="ltr" lang="en" className="inline-flex items-center gap-2 text-lg font-semibold text-emerald-800 hover:underline">
            {url.replace(/^https?:\/\//, '')}
            {Icon.external('h-4 w-4')}
          </a>
          <button
            type="button"
            className="ms-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-emerald-800 hover:bg-emerald-100"
            onClick={() => {
              void navigator.clipboard?.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {Icon.copy()} {copied ? fa.deploy.copied : fa.deploy.copy}
          </button>
        </div>
      )}
    </Card>
  );
}
