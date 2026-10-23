/** Resolving approvals (the `/api/approve` entry point). */
import { getTool } from '../tools/registry';
import { runApprovedAction, runDeclinedNarration, type ApprovalRow } from './loop';
import { APPROVAL_TTL_MS } from './policy';
import type { AgentRuntime } from './runtime';
import { AgentSession } from './session';

export interface ApproveInput {
  approvalId: string;
  approved: boolean;
  typedName?: string;
  by?: string;
}

export type ApproveOutcome =
  | { ok: true; status: 'approved' | 'rejected'; done: Promise<void> }
  | { ok: false; code: 'not_found' | 'not_pending' | 'expired' | 'typed_name_mismatch'; messageFa: string };

export function getApproval(rt: AgentRuntime, id: string): ApprovalRow | undefined {
  return rt.deps.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
}

export function expireStaleApprovals(rt: AgentRuntime): number {
  const cutoff = new Date(rt.now().getTime() - APPROVAL_TTL_MS).toISOString();
  return rt.deps.db.prepare("UPDATE approvals SET status = 'expired', resolvedAt = ? WHERE status = 'pending' AND createdAt < ?").run(rt.now().toISOString(), cutoff).changes;
}

/**
 * Validates and resolves an approval. On success the action (or the decline
 * narration) runs in the background; await `done` to wait for it.
 */
export function approve(rt: AgentRuntime, input: ApproveInput): ApproveOutcome {
  const row = getApproval(rt, input.approvalId);
  if (!row) return { ok: false, code: 'not_found', messageFa: 'این درخواست تأیید پیدا نشد.' };
  if (row.status !== 'pending') return { ok: false, code: 'not_pending', messageFa: 'این درخواست قبلاً بررسی شده است.' };
  const now = rt.now();
  if (now.getTime() - Date.parse(row.createdAt) > APPROVAL_TTL_MS) {
    rt.deps.db.prepare("UPDATE approvals SET status = 'expired', resolvedAt = ? WHERE id = ?").run(now.toISOString(), row.id);
    return { ok: false, code: 'expired', messageFa: 'مهلت این تأیید (۱۵ دقیقه) تمام شده است؛ دوباره درخواست بدهید.' };
  }
  if (input.approved && row.risk >= 2) {
    const def = getTool(row.tool);
    const expected = String((JSON.parse(row.args) as Record<string, unknown>)[def?.confirmField ?? 'appName'] ?? '');
    if ((input.typedName ?? '').trim() !== expected) {
      return { ok: false, code: 'typed_name_mismatch', messageFa: `برای تأیید باید دقیقاً «${expected}» را بنویسید.` };
    }
  }
  const status = input.approved ? 'approved' : 'rejected';
  const by = input.by ?? 'user';
  rt.deps.db.prepare('UPDATE approvals SET status = ?, resolvedAt = ?, resolvedBy = ? WHERE id = ?').run(status, now.toISOString(), by, row.id);
  const session = AgentSession.load(rt, row.sessionId) ?? AgentSession.create(rt, { id: row.sessionId });
  session.emit({ type: 'approval_resolved', approvalId: row.id, approved: input.approved, by });
  const done = (input.approved ? runApprovedAction(rt, session, row).then(() => undefined) : runDeclinedNarration(rt, session, row)).catch((err) =>
    rt.deps.logger.error({ err: (err as Error).message }, 'post-approval turn failed'),
  );
  return { ok: true, status, done };
}
