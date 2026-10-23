/** Alerts: persisted in `alerts`, deduped per app+title for 30 minutes, pushed to open sessions of the app. */
import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from './runtime';
import { AgentSession } from './session';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface AlertInput {
  appName: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  suggestedPrompt: string;
  /** dedupe key; defaults to the title */
  rule?: string;
}

export interface AlertRow {
  id: string;
  appName: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

export const ALERT_DEDUPE_MS = 30 * 60_000;

/** Inserts the alert unless the same rule fired for the app in the last 30 min; returns the row or null (deduped). */
export function raiseAlert(rt: AgentRuntime, alert: AlertInput, extraSessionIds: string[] = []): AlertRow | null {
  const db = rt.deps.db;
  const now = rt.now();
  const title = alert.title;
  const recent = db
    .prepare('SELECT id FROM alerts WHERE appName = ? AND title = ? AND createdAt >= ? LIMIT 1')
    .get(alert.appName, title, new Date(now.getTime() - ALERT_DEDUPE_MS).toISOString());
  if (recent) return null;
  const row: AlertRow = { id: randomUUID(), appName: alert.appName, severity: alert.severity, title, summary: alert.summary, createdAt: now.toISOString(), acknowledgedAt: null };
  db.prepare('INSERT INTO alerts (id, appName, severity, title, summary, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, row.appName, row.severity, row.title, row.summary, row.createdAt);
  const targets = new Set([...rt.bus.sessionsForApp(alert.appName), ...extraSessionIds]);
  for (const id of targets) {
    const s = AgentSession.load(rt, id);
    s?.emit({ type: 'alert', appName: alert.appName, severity: alert.severity, title, summary: alert.summary, suggestedPrompt: alert.suggestedPrompt });
  }
  rt.deps.logger.info({ appName: alert.appName, severity: alert.severity, title }, 'alert raised');
  return row;
}

export function activeAlerts(rt: AgentRuntime, appName?: string): AlertRow[] {
  const db = rt.deps.db;
  return (
    appName
      ? db.prepare('SELECT * FROM alerts WHERE appName = ? AND acknowledgedAt IS NULL ORDER BY createdAt DESC LIMIT 20').all(appName)
      : db.prepare('SELECT * FROM alerts WHERE acknowledgedAt IS NULL ORDER BY createdAt DESC LIMIT 50').all()
  ) as AlertRow[];
}

export function acknowledgeAlert(rt: AgentRuntime, id: string): boolean {
  return rt.deps.db.prepare('UPDATE alerts SET acknowledgedAt = ? WHERE id = ? AND acknowledgedAt IS NULL').run(rt.now().toISOString(), id).changes > 0;
}
