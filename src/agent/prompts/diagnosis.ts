/** Prompt for the structured diagnosis (smart model). */
import { listTools } from '../../tools/registry';
import type { EvidencePacket } from '../evidence/packet';
import type { AppMemory } from '../memory';
import type { Candidate } from '../playbooks/engine';
import { loadPlaybooks } from '../playbooks/load';
import { ROLE_FA } from './role';

export const DIAGNOSIS_SYSTEM = `${ROLE_FA}

You are now diagnosing an app on Liara. You receive an evidence packet that was already collected, deterministic rule-engine candidates (incident playbooks that matched), a playbook index, the tools you may recommend, and this app's memory.

Rules:
- Rank 1–4 causes, most likely first. Each confidence (0..1) must be justified by evidence you cite from the packet. Never invent evidence, numbers or log lines; "raw" must be an exact quote from the packet or null.
- Each evidence item names its source (events, logs, metrics, applets, health, release, account, domain) and a short Persian text_fa.
- Prefer reversible, low-risk actions first unless the evidence is strong. If problems started right after a recent deploy (app.lastDeployAgeMinutes small and a previous READY release exists), rollback_release ranks above restart_app.
- If memory shows the same problem came back after a restart, recommend a lasting fix (rollback or plan upgrade) instead of another restart.
- recommendedAction must use a tool from availableActions with complete, valid arguments in argsJson (appName is required). Use rule-engine fixes when they fit. If the fix needs values only the user knows (secrets, env values) or a code change, set recommendedAction to null and explain it in manualStepsFa.
- If nothing is wrong: severity "healthy", one cause such as "مشکلی دیده نشد" with the healthy evidence, recommendedAction null or set_app_watch.
- severity: critical = site down or crashing; degraded = working but failing/slow for users; warning = risk ahead; healthy = fine.
- limitationsFa: mention what the Liara API could not show (e.g. no HTTP access logs), in simple Persian.
- Every *_fa / *Fa field: simple, natural Persian; summaryFa is one sentence.`;

export function playbookIndex() {
  return loadPlaybooks().map((p) => ({ id: p.id, title_fa: p.title_fa, causes_fa: p.causes_fa, fixes: p.fixes.map((f) => ({ tool: f.tool, title_fa: f.title_fa })) }));
}

export function availableActions() {
  return listTools()
    .filter((t) => t.risk > 0 || t.name === 'set_app_watch')
    .map((t) => ({ tool: t.name, risk: t.risk, description: t.description.slice(0, 160) }));
}

export function diagnosisUserPrompt(packet: EvidencePacket, candidates: Candidate[], memory?: Partial<AppMemory>): string {
  const compactCandidates = candidates.map((c) => ({
    playbookId: c.playbookId,
    title_fa: c.title_fa,
    score: c.score,
    signals: c.matchedSignals.map((s) => `[${s.source}] ${s.detail}`),
    fixes: c.fixes.map((f) => ({ tool: f.tool, args: f.args, title_fa: f.title_fa, risk: f.risk })),
    manualStepsFa: c.manualStepsFa,
  }));
  const mem = memory ? { lastDiagnosis: memory.lastDiagnosis, lastActions: memory.lastActions?.slice(0, 5), userNotes: memory.userNotes } : undefined;
  return JSON.stringify({ packet, candidates: compactCandidates, playbookIndex: playbookIndex(), availableActions: availableActions(), memory: mem });
}
