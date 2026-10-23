'use client';

import { useEffect, useRef } from 'react';
import { fa } from '@/app/i18n/fa';
import type { AgentApi } from '@/app/lib/use-agent';
import type { AssistantTurn, TurnItem } from '@/app/lib/reducer';
import { ApprovalCard } from './ApprovalCard';
import { DeployProgress } from './DeployProgress';
import { DiagnosisCard } from './DiagnosisCard';
import { DomainStepsCard } from './DomainStepsCard';
import { Markdown } from './Markdown';
import { ErrorBubble, LimitationNotice, SuggestionChips, VerifyStrip } from './Notices';
import { OperationTimeline } from './OperationTimeline';
import { PlanCard } from './PlanCard';
import { Spinner } from './ui';
import { Welcome } from './Welcome';

function Item({ item, agent }: { item: TurnItem; agent: AgentApi }) {
  switch (item.kind) {
    case 'text':
      return <Markdown text={item.text} />;
    case 'approval':
      return <ApprovalCard item={item} onDecide={agent.approve} />;
    case 'diagnosis':
      return <DiagnosisCard diagnosis={item.event.diagnosis} source={item.event.source} onSend={agent.send} />;
    case 'plan':
      return <PlanCard plan={item.event.recommendation} onSend={agent.send} />;
    case 'domain':
      return <DomainStepsCard event={item.event} />;
    case 'deploy':
      return <DeployProgress stages={item.stages} url={item.url} />;
    case 'verify':
      return <VerifyStrip event={item.event} onSend={agent.send} />;
    case 'limitation':
      return <LimitationNotice message={item.message} />;
    case 'error':
      return <ErrorBubble message={item.message} />;
  }
}

function Turn({ turn, agent, isLast }: { turn: AssistantTurn; agent: AgentApi; isLast: boolean }) {
  const thinking = !turn.done && !turn.items.some((i) => i.kind === 'text');
  return (
    <div className="flex gap-3" data-testid="assistant-turn" data-done={turn.done ? 'true' : 'false'}>
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">ل</div>
      <div className="min-w-0 flex-1">
        <OperationTimeline rows={turn.timeline} />
        <div className="space-y-3">
          {turn.items.map((it) => (
            <Item key={it.id} item={it} agent={agent} />
          ))}
        </div>
        {thinking && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner className="h-3.5 w-3.5" /> {fa.composer.thinking}
          </div>
        )}
        {isLast && turn.done && <SuggestionChips chips={turn.suggestions} onSend={agent.send} disabled={agent.streaming} />}
      </div>
    </div>
  );
}

export function ChatThread({ agent, hasApps }: { agent: AgentApi; hasApps: boolean }) {
  const bottom = useRef<HTMLDivElement>(null);
  const { messages } = agent.state;
  const last = messages[messages.length - 1];
  const signature = `${messages.length}:${last && last.kind === 'assistant' ? last.items.length + last.timeline.length + (last.items.at(-1)?.kind === 'text' ? (last.items.at(-1) as { text: string }).text.length : 0) : 0}`;
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [signature]);

  if (!messages.length) return <Welcome onSend={agent.send} hasApps={hasApps} />;
  const lastAssistant = [...messages].reverse().find((m) => m.kind === 'assistant');
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      {messages.map((m) =>
        m.kind === 'user' ? (
          <div key={m.id} className="flex justify-end" data-testid="user-message">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-te-sm bg-blue-600 px-4 py-2.5 text-[15px] leading-7 text-white shadow-sm">{m.text}</div>
          </div>
        ) : (
          <Turn key={m.id} turn={m} agent={agent} isLast={m === lastAssistant} />
        ),
      )}
      <div ref={bottom} />
    </div>
  );
}
