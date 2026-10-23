'use client';

import { fa } from '@/app/i18n/fa';
import { Button, Card, Icon } from './ui';

/** First-visit card: what the assistant does + the two primary actions. */
export function Welcome({ onSend, hasApps }: { onSend: (text: string) => void; hasApps: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-10">
      <Card className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-lg font-bold text-white">ل</div>
          <h2 className="text-xl font-bold text-slate-900">{fa.welcome.title}</h2>
        </div>
        <ul className="space-y-2.5">
          {fa.welcome.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2 text-[15px] leading-7 text-slate-700">
              <span className="mt-1.5 text-blue-600">{Icon.check()}</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onSend(fa.welcome.deployPrompt)}>{fa.welcome.deployChip}</Button>
          {hasApps && (
            <Button variant="soft" onClick={() => onSend(fa.welcome.statusPrompt)}>
              {fa.welcome.statusChip}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
