/** Shared UI primitives and inline icons (no component library). */
import type { ReactNode } from 'react';

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

export function Card({ children, className, tone = 'plain', testId }: { children: ReactNode; className?: string; tone?: 'plain' | 'green' | 'red' | 'amber' | 'blue'; testId?: string }) {
  const tones = {
    plain: 'border-slate-200 bg-white',
    green: 'border-emerald-200 bg-emerald-50',
    red: 'border-red-200 bg-red-50',
    amber: 'border-amber-200 bg-amber-50',
    blue: 'border-blue-200 bg-blue-50',
  };
  return (
    <div data-testid={testId} className={cx('rounded-2xl border p-4 shadow-sm', tones[tone], className)}>
      {children}
    </div>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'blue' | 'green' | 'amber' | 'red' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-emerald-100 text-emerald-700',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  className,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger' | 'soft';
  className?: string;
  type?: 'button' | 'submit';
}) {
  const variants = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
    soft: 'bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50',
    ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 disabled:opacity-50',
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cx('inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed', variants[variant], className)}>
      {children}
    </button>
  );
}

export function Dot({ level }: { level: 'ok' | 'degraded' | 'down' | 'off' | 'unknown' }) {
  const colors = { ok: 'bg-emerald-500', degraded: 'bg-amber-500', down: 'bg-red-500', off: 'bg-slate-400', unknown: 'bg-slate-300' };
  return <span className={cx('inline-block h-2.5 w-2.5 shrink-0 rounded-full', colors[level])} aria-hidden />;
}

const svg = (path: ReactNode, className = 'h-4 w-4') => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    {path}
  </svg>
);

export const Icon = {
  check: (c?: string) => svg(<path d="M20 6 9 17l-5-5" />, c),
  cross: (c?: string) => svg(<path d="M18 6 6 18M6 6l12 12" />, c),
  pause: (c?: string) => svg(<path d="M9 5v14M15 5v14" />, c),
  info: (c?: string) => svg(<><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>, c),
  alert: (c?: string) => svg(<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></>, c),
  external: (c?: string) => svg(<><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6M10 14 21 3" /></>, c),
  copy: (c?: string) => svg(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>, c),
  chevron: (c?: string) => svg(<path d="m6 9 6 6 6-6" />, c),
  plus: (c?: string) => svg(<path d="M12 5v14M5 12h14" />, c),
  send: (c?: string) => svg(<path d="m22 2-7 20-4-9-9-4z" />, c),
  shield: (c?: string) => svg(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />, c),
};

/** RTL-aware toggle switch (knob starts on the right). */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-blue-600' : 'bg-slate-300')}
    >
      <span className={cx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? '-translate-x-5.5' : '-translate-x-0.5')} />
    </button>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <span className={cx('inline-block animate-spin rounded-full border-2 border-blue-600 border-t-transparent', className)} aria-label="loading" />;
}
