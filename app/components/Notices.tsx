'use client';

import type { EventOf } from '@/src/events';
import { fa } from '@/app/i18n/fa';
import { Button, Card, Icon } from './ui';

const DEPLOY_ACTIONS = new Set(['deploy_project', 'deploy_release', 'upload_source', 'create_app']);
const FIX_ACTIONS = new Set(['restart_app', 'rollback_release', 'update_envs', 'resize_app']);

function verifyTitle(action: string, ok: boolean): string {
  if (DEPLOY_ACTIONS.has(action)) return ok ? fa.verify.deployed : fa.verify.notDeployed;
  if (FIX_ACTIONS.has(action)) return ok ? fa.verify.fixed : fa.verify.notFixed;
  return ok ? fa.verify.changed : fa.verify.notChanged;
}

/** Green/red strip after every mutating action: only "fixed" when verification passed. */
export function VerifyStrip({ event, onSend }: { event: EventOf<'verify_result'>; onSend: (text: string) => void }) {
  return (
    <Card tone={event.fixed ? 'green' : 'red'} className="space-y-2" testId="verify-strip">
      <div className={`flex items-center gap-2 font-semibold ${event.fixed ? 'text-emerald-800' : 'text-red-800'}`}>
        {event.fixed ? Icon.check('h-5 w-5') : Icon.cross('h-5 w-5')}
        <span>{verifyTitle(event.action, event.fixed)}</span>
      </div>
      <div className="text-xs text-slate-500">{fa.verify.checked}</div>
      <ul className="list-disc space-y-0.5 ps-5 text-sm leading-7 text-slate-700">
        {event.evidence.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
      {!event.fixed && event.nextSuggestion && (
        <Button variant="soft" onClick={() => onSend(event.nextSuggestion!)}>
          {fa.verify.next}: {event.nextSuggestion}
        </Button>
      )}
    </Card>
  );
}

/** Amber notice for things the Liara API cannot do. */
export function LimitationNotice({ message }: { message: string }) {
  return (
    <div data-testid="limitation" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-7 text-amber-900">
      <span className="mt-1.5 shrink-0">{Icon.info()}</span>
      <span>{message}</span>
    </div>
  );
}

export function ErrorBubble({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm leading-7 text-red-800">
      <span className="mt-1.5 shrink-0">{Icon.alert()}</span>
      <span>{message}</span>
    </div>
  );
}

/** Up to 4 follow-up chips under the last reply; click = send. */
export function SuggestionChips({ chips, onSend, disabled }: { chips: string[]; onSend: (text: string) => void; disabled?: boolean }) {
  if (!chips.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {chips.slice(0, 4).map((c) => (
        <button
          key={c}
          type="button"
          disabled={disabled}
          onClick={() => onSend(c)}
          className="rounded-full border border-blue-200 bg-white px-3.5 py-1.5 text-sm text-blue-700 transition-colors hover:bg-blue-50 disabled:opacity-50"
        >
          {c}
        </button>
      ))}
    </div>
  );
}
