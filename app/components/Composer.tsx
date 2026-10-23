'use client';

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { fa } from '@/app/i18n/fa';
import { Icon, Spinner } from './ui';

export interface ComposerHandle {
  /** Puts text in the box (used by "+ new deploy" to seed a prompt). */
  seed(text: string): void;
}

/** Message box: Enter sends, Shift+Enter adds a line; disabled while a turn streams. */
export const Composer = forwardRef<ComposerHandle, { onSend: (text: string) => void; busy: boolean; error: string | null }>(function Composer({ onSend, busy, error }, ref) {
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    seed(t: string) {
      setText(t);
      requestAnimationFrame(() => {
        area.current?.focus();
        area.current?.setSelectionRange(t.length, t.length);
      });
    },
  }));
  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText('');
  };
  return (
    <div className="border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur" data-testid="composer" data-busy={busy ? 'true' : 'false'}>
      <div className="mx-auto max-w-3xl">
        {(busy || error) && (
          <div className="mb-2 flex items-center gap-2 text-xs">
            {busy && (
              <span className="flex items-center gap-1.5 text-slate-500">
                <Spinner className="h-3 w-3" /> {fa.composer.thinking}
              </span>
            )}
            {error && <span className="text-red-700">{error}</span>}
          </div>
        )}
        {!busy && !error && <div className="mb-1.5 hidden text-[11px] text-slate-400 sm:block">{fa.composer.hint}</div>}
        <div className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white p-2 shadow-sm focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
          <textarea
            ref={area}
            value={text}
            rows={Math.min(6, Math.max(1, text.split('\n').length))}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={fa.composer.placeholder}
            className="max-h-48 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-7 outline-none placeholder:text-slate-400"
            aria-label={fa.composer.placeholder}
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !text.trim()}
            aria-label={fa.composer.send}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:bg-slate-300"
          >
            <span className="-scale-x-100">{Icon.send('h-4 w-4')}</span>
          </button>
        </div>
      </div>
    </div>
  );
});
