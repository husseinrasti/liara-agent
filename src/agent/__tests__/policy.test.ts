import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../events';
import { fakeAgent, healthyAppRoutes, TEST_NOW } from '../../test-utils/fake-agent';
import { scriptedStreamModel } from '../../test-utils/mock-model';
import '../../tools';
import { getTool } from '../../tools/registry';
import { approve } from '../approvals';
import { APPROVAL_TTL_MS, policyExecutor } from '../policy';
import { AgentSession } from '../session';

function setup(opts: { autoApprove?: boolean; now?: () => Date } = {}) {
  const agent = fakeAgent({ routes: { ...healthyAppRoutes(), 'GET /v1/projects/shop': { body: { project: { _id: 'p1', project_id: 'shop', type: 'node', status: 'ACTIVE', scale: 0, planID: 'small-g2', envs: [] } } } }, fast: scriptedStreamModel([{ text: 'باشه.' }]), ...opts });
  const session = AgentSession.create(agent.rt, { appName: 'shop' });
  const events: AgentEvent[] = [];
  agent.rt.bus.subscribe(session.id, (e) => events.push(e));
  const exec = policyExecutor(agent.rt, session, { pendingApprovals: [] });
  const audits = () => agent.rt.deps.db.prepare('SELECT * FROM audit').all() as { tool: string; ok: number; verifyOk: number | null }[];
  return { ...agent, session, events, exec, audits };
}

describe('policy gate', () => {
  it('runs risk-0 tools immediately and records the timeline', async () => {
    const { exec, events, audits } = setup();
    const out = await exec(getTool('get_app_applets')!, { appName: 'shop' }, { toolCallId: 'c1' });
    expect(out.ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_result']);
    expect(audits()).toHaveLength(0);
  });

  it('suspends risk-1 tools with a pending approval and no audit row', async () => {
    const { exec, events, audits, rt } = setup();
    const out = await exec(getTool('restart_app')!, { appName: 'shop' }, { toolCallId: 'c1' });
    expect(out).toMatchObject({ ok: false, pendingApproval: true });
    const card = events.find((e) => e.type === 'approval_required');
    expect(card).toMatchObject({ tool: 'restart_app', risk: 1, reversible: true });
    expect(card && 'requiresTypedName' in card ? card.requiresTypedName : undefined).toBeUndefined();
    expect(audits()).toHaveLength(0);
    expect(rt.deps.db.prepare("SELECT status FROM approvals").get()).toEqual({ status: 'pending' });
  });

  it('requires the typed app name for risk 2, then executes, audits and verifies', async () => {
    const { exec, events, audits, rt } = setup();
    const out = await exec(getTool('scale_app')!, { appName: 'shop', on: false }, { toolCallId: 'c1' });
    const approvalId = out.approvalId as string;
    const card = events.find((e) => e.type === 'approval_required');
    expect(card && 'requiresTypedName' in card ? card.requiresTypedName : undefined).toBe('shop');

    const wrong = approve(rt, { approvalId, approved: true, typedName: 'shopp' });
    expect(wrong).toMatchObject({ ok: false, code: 'typed_name_mismatch' });

    const ok = approve(rt, { approvalId, approved: true, typedName: 'shop' });
    expect(ok.ok).toBe(true);
    if (ok.ok) await ok.done;
    expect(audits()).toMatchObject([{ tool: 'scale_app', ok: 1, verifyOk: 1 }]);
    const types = events.map((e) => e.type);
    expect(types).toContain('approval_resolved');
    expect(types).toContain('verify_result');
    expect(types[types.length - 1]).toBe('done');
  });

  it('rejecting runs nothing and leaves no audit row', async () => {
    const { exec, audits, rt } = setup();
    const out = await exec(getTool('restart_app')!, { appName: 'shop' }, { toolCallId: 'c1' });
    const res = approve(rt, { approvalId: out.approvalId as string, approved: false });
    if (res.ok) await res.done;
    expect(audits()).toHaveLength(0);
    expect(rt.deps.db.prepare('SELECT status FROM approvals').get()).toEqual({ status: 'rejected' });
  });

  it('expires approvals after 15 minutes', async () => {
    let now = TEST_NOW;
    const { exec, rt } = setup({ now: () => now });
    const out = await exec(getTool('restart_app')!, { appName: 'shop' }, { toolCallId: 'c1' });
    now = new Date(TEST_NOW.getTime() + APPROVAL_TTL_MS + 1000);
    expect(approve(rt, { approvalId: out.approvalId as string, approved: true })).toMatchObject({ ok: false, code: 'expired' });
    expect(approve(rt, { approvalId: out.approvalId as string, approved: true })).toMatchObject({ ok: false, code: 'not_pending' });
  });

  it('AUTO_APPROVE executes immediately with audit and verification', async () => {
    const { exec, audits, events } = setup({ autoApprove: true });
    const out = await exec(getTool('restart_app')!, { appName: 'shop' }, { toolCallId: 'c1' });
    expect(out.ok).toBe(true);
    expect(out.verification).toMatchObject({ fixed: true });
    expect(audits()).toMatchObject([{ tool: 'restart_app', ok: 1, verifyOk: 1 }]);
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
  });
});
