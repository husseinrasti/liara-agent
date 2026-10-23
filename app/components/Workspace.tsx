'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppStatus } from '@/src/server/status';
import { fa } from '@/app/i18n/fa';
import { useAgent } from '@/app/lib/use-agent';
import { useAlerts, useApps, useHealth, useStatus } from '@/app/lib/use-data';
import { AlertBanner, mergeAlerts } from './AlertBanner';
import { AppSelector } from './AppSelector';
import { ChatThread } from './ChatThread';
import { Composer, type ComposerHandle } from './Composer';
import { Header } from './Header';
import { StatusPanel } from './StatusPanel';

/** Single-page workspace: app list (start side) · chat · status panel (end side). */
export function Workspace() {
  const agent = useAgent();
  const health = useHealth();
  const apps = useApps();
  const status = useStatus(agent.appName);
  const [alertBump, setAlertBump] = useState(0);
  const alerts = useAlerts(agent.appName, alertBump);
  const composer = useRef<ComposerHandle>(null);

  // Refresh panels when a turn finishes or a live alert arrives.
  const doneCount = agent.state.messages.filter((m) => m.kind === 'assistant' && m.done).length;
  const { reload: reloadStatus } = status;
  const { reload: reloadApps } = apps;
  useEffect(() => {
    if (!doneCount) return;
    void reloadStatus(true);
    void reloadApps(true);
  }, [doneCount, reloadStatus, reloadApps]);
  useEffect(() => setAlertBump((b) => b + 1), [agent.state.alerts.length]);

  const appList = apps.data?.apps;
  useEffect(() => {
    if (!agent.appName && apps.data?.demoAppName && appList?.some((a) => a.name === apps.data?.demoAppName)) agent.selectApp(apps.data.demoAppName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps.data?.demoAppName, appList?.length]);

  const banner = useMemo(() => mergeAlerts(alerts.data?.alerts ?? [], agent.state.alerts, agent.appName), [alerts.data, agent.state.alerts, agent.appName]);
  const ack = useCallback(
    async (id: string) => {
      await fetch('/api/alerts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => undefined);
      setAlertBump((b) => b + 1);
    },
    [setAlertBump],
  );
  const toggleWatch = useCallback(
    async (on: boolean) => {
      if (!agent.appName) return;
      await fetch('/api/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appName: agent.appName, on }) }).catch(() => undefined);
      void reloadStatus(true);
    },
    [agent.appName, reloadStatus],
  );

  const st = status.data?.status as AppStatus | undefined;
  const mobileSelect = (
    <select
      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm lg:hidden"
      value={agent.appName ?? ''}
      onChange={(e) => agent.selectApp(e.target.value || null)}
      aria-label={fa.apps.heading}
    >
      <option value="">{fa.apps.none}</option>
      {appList?.map((a) => (
        <option key={a.name} value={a.name}>
          {a.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="flex h-dvh flex-col bg-slate-50">
      <Header health={health.data} onNewConversation={agent.newConversation} apps={mobileSelect} />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)_320px]">
        <aside className="hidden min-h-0 overflow-y-auto border-e border-slate-200 bg-white lg:block">
          <AppSelector
            apps={appList}
            loading={apps.loading}
            error={apps.error}
            selected={agent.appName}
            selectedLevel={st?.level ?? null}
            onSelect={agent.selectApp}
            onNewDeploy={() => composer.current?.seed(fa.apps.newDeploySeed)}
          />
        </aside>
        <main className="flex min-h-0 flex-col">
          <AlertBanner alerts={banner} onInvestigate={(p) => void agent.send(p)} onAck={(id) => void ack(id)} />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <ChatThread agent={agent} hasApps={Boolean(appList?.length)} />
          </div>
          <Composer ref={composer} onSend={(t) => void agent.send(t)} busy={agent.streaming} error={agent.error} />
        </main>
        <aside className="hidden min-h-0 overflow-y-auto border-s border-slate-200 bg-slate-50 lg:block">
          <StatusPanel status={st} loading={status.loading} appName={agent.appName} onToggleWatch={(on) => void toggleWatch(on)} />
        </aside>
      </div>
    </div>
  );
}
