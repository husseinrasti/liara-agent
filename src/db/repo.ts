import type { Db } from './index';

/* Small typed helpers over the tables PRD-01 tools write to. PRD-02 adds more. */

export interface SourceRow {
  appName: string;
  sourceID: string;
  archivePath: string;
  releaseID: string | null;
  createdAt: string;
}

export function recordSource(db: Db, row: Omit<SourceRow, 'releaseID'> & { releaseID?: string | null }): void {
  db.prepare(
    `INSERT INTO sources (appName, sourceID, archivePath, releaseID, createdAt) VALUES (@appName, @sourceID, @archivePath, @releaseID, @createdAt)
     ON CONFLICT(appName, sourceID) DO UPDATE SET archivePath = excluded.archivePath`,
  ).run({ releaseID: null, ...row });
}

export function linkSourceRelease(db: Db, appName: string, sourceID: string, releaseID: string): void {
  db.prepare('UPDATE sources SET releaseID = ? WHERE appName = ? AND sourceID = ?').run(releaseID, appName, sourceID);
}

export function sourcesFor(db: Db, appName: string): SourceRow[] {
  return db.prepare('SELECT * FROM sources WHERE appName = ? ORDER BY createdAt DESC').all(appName) as SourceRow[];
}

export function sourceForRelease(db: Db, appName: string, releaseID: string): SourceRow | undefined {
  return db.prepare('SELECT * FROM sources WHERE appName = ? AND releaseID = ?').get(appName, releaseID) as SourceRow | undefined;
}

/** Releases this assistant rolled back FROM; a later rollback never returns to them. */
export function badReleases(db: Db, appName: string): string[] {
  const row = db.prepare("SELECT value FROM app_memory WHERE appName = ? AND key = 'badReleases'").get(appName) as { value: string } | undefined;
  try {
    const v: unknown = row ? JSON.parse(row.value) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function markReleaseBad(db: Db, appName: string, releaseID: string, now = new Date()): void {
  const ids = [...new Set([...badReleases(db, appName), releaseID])].slice(-20);
  db.prepare(
    `INSERT INTO app_memory (appName, key, value, updatedAt) VALUES (?, 'badReleases', ?, ?)
     ON CONFLICT(appName, key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
  ).run(appName, JSON.stringify(ids), now.toISOString());
}

export interface AuditStart {
  sessionId?: string | null;
  tool: string;
  args: unknown;
  risk: number;
}

export function startAudit(db: Db, a: AuditStart, now = new Date()): number {
  const res = db
    .prepare('INSERT INTO audit (sessionId, tool, args, risk, startedAt) VALUES (?, ?, ?, ?, ?)')
    .run(a.sessionId ?? null, a.tool, JSON.stringify(a.args), a.risk, now.toISOString());
  return Number(res.lastInsertRowid);
}

export function finishAudit(db: Db, id: number, r: { ok: boolean; resultSummary: string }, now = new Date()): void {
  db.prepare('UPDATE audit SET finishedAt = ?, ok = ?, resultSummary = ? WHERE id = ?').run(now.toISOString(), r.ok ? 1 : 0, r.resultSummary, id);
}

export function recordVerify(db: Db, id: number, v: { ok: boolean; evidence: string[] }): void {
  db.prepare('UPDATE audit SET verifyOk = ?, verifyEvidence = ? WHERE id = ?').run(v.ok ? 1 : 0, JSON.stringify(v.evidence), id);
}
