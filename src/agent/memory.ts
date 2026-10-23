/**
 * Per-app memory in `app_memory` (key → JSON): last diagnosis, last actions,
 * metric baseline, user notes, watch flag, pending domain checks. Injected into
 * the system prompt as a ≤ 300-token Persian summary.
 */
import type { Db } from '../db';

export interface LastDiagnosis {
  ts: string;
  summaryFa: string;
  severity: string;
  topCause?: { title_fa: string; playbookId?: string; confidence: number };
  recommendedTool?: string;
}

export interface ActionRecord {
  tool: string;
  ts: string;
  ok: boolean;
  fixed?: boolean;
  summaryFa?: string;
}

export interface Baseline {
  computedAt: string;
  samples: number;
  avgCpu: number | null;
  avgMemMB: number | null;
  p50LatencyMs: number | null;
}

export interface PendingDomain {
  domainId: string;
  name: string;
  since: string;
}

export interface AppMemory {
  lastDiagnosis?: LastDiagnosis;
  lastActions: ActionRecord[];
  baseline?: Baseline;
  userNotes: string[];
  watch: boolean;
  pendingDomains: PendingDomain[];
  /** Releases this assistant rolled back from (written by db/repo markReleaseBad). */
  badReleases: string[];
}

const DEFAULTS: AppMemory = { lastActions: [], userNotes: [], watch: false, pendingDomains: [], badReleases: [] };

export function getMemoryKey<K extends keyof AppMemory>(db: Db, appName: string, key: K): AppMemory[K] {
  const row = db.prepare('SELECT value FROM app_memory WHERE appName = ? AND key = ?').get(appName, key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as AppMemory[K]) : structuredClone(DEFAULTS[key]);
}

/** True when the key was ever written for the app (an explicit `false` counts). */
export function hasMemoryKey(db: Db, appName: string, key: keyof AppMemory): boolean {
  return Boolean(db.prepare('SELECT 1 FROM app_memory WHERE appName = ? AND key = ?').get(appName, key));
}

export function setMemoryKey<K extends keyof AppMemory>(db: Db, appName: string, key: K, value: AppMemory[K], now = new Date()): void {
  db.prepare(
    `INSERT INTO app_memory (appName, key, value, updatedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(appName, key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
  ).run(appName, key, JSON.stringify(value), now.toISOString());
}

export function getMemory(db: Db, appName: string): AppMemory {
  const rows = db.prepare('SELECT key, value FROM app_memory WHERE appName = ?').all(appName) as { key: keyof AppMemory; value: string }[];
  const mem: AppMemory = structuredClone(DEFAULTS);
  for (const r of rows) (mem as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
  return mem;
}

export function pushAction(db: Db, appName: string, action: ActionRecord, now = new Date()): void {
  const list = [action, ...getMemoryKey(db, appName, 'lastActions')].slice(0, 10);
  setMemoryKey(db, appName, 'lastActions', list, now);
}

export function addUserNote(db: Db, appName: string, note: string, now = new Date()): string[] {
  const notes = [...getMemoryKey(db, appName, 'userNotes'), note.trim()].filter(Boolean).slice(-10);
  setMemoryKey(db, appName, 'userNotes', notes, now);
  return notes;
}

/** Apps with monitoring enabled. */
export function watchedApps(db: Db): string[] {
  return (db.prepare("SELECT appName, value FROM app_memory WHERE key = 'watch'").all() as { appName: string; value: string }[])
    .filter((r) => JSON.parse(r.value) === true)
    .map((r) => r.appName);
}

/** 7-day rolling baseline from the watcher's metric snapshots. */
export function computeBaseline(db: Db, appName: string, now = new Date()): Baseline {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = db
    .prepare('SELECT cpu, memMB, latencyMs FROM metric_snapshots WHERE appName = ? AND ts >= ?')
    .all(appName, since) as { cpu: number | null; memMB: number | null; latencyMs: number | null }[];
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const lat = rows.map((r) => r.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  return {
    computedAt: now.toISOString(),
    samples: rows.length,
    avgCpu: avg(rows.map((r) => r.cpu).filter((x): x is number => x !== null)),
    avgMemMB: avg(rows.map((r) => r.memMB).filter((x): x is number => x !== null)),
    p50LatencyMs: lat.length ? lat[Math.floor(lat.length / 2)]! : null,
  };
}

const minutesAgoFa = (iso: string, now: Date) => {
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m} دقیقه پیش` : m < 1440 ? `${Math.round(m / 60)} ساعت پیش` : `${Math.round(m / 1440)} روز پیش`;
};

/** Compact Persian summary for the system prompt (≤ ~300 tokens). */
export function memorySummaryFa(db: Db, appName: string, now = new Date()): string {
  const m = getMemory(db, appName);
  const lines: string[] = [];
  if (m.lastDiagnosis) {
    const c = m.lastDiagnosis.topCause;
    lines.push(`آخرین تشخیص (${minutesAgoFa(m.lastDiagnosis.ts, now)}): ${m.lastDiagnosis.summaryFa}${c ? ` — علت اصلی: ${c.title_fa}` : ''}`);
  }
  for (const a of m.lastActions.slice(0, 3)) {
    const result = a.fixed === undefined ? (a.ok ? 'انجام شد' : 'ناموفق') : a.fixed ? 'مشکل حل شد' : 'مشکل حل نشد';
    lines.push(`اقدام ${a.tool} (${minutesAgoFa(a.ts, now)}): ${result}`);
  }
  if (m.baseline?.samples) {
    lines.push(`حالت عادی ۷ روز اخیر: رم حدود ${m.baseline.avgMemMB ?? '?'} مگابایت، زمان پاسخ میانه حدود ${m.baseline.p50LatencyMs ?? '?'} میلی‌ثانیه`);
  }
  for (const n of m.userNotes.slice(-3)) lines.push(`یادداشت کاربر: ${n}`);
  if (m.pendingDomains.length) lines.push(`دامنه‌های در انتظار تأیید DNS: ${m.pendingDomains.map((d) => d.name).join('، ')}`);
  lines.push(`پایش خودکار: ${m.watch ? 'روشن' : 'خاموش'}`);
  return lines.join('\n').slice(0, 900);
}
