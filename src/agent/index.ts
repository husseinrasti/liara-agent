/** Public surface of the headless agent (used by the Next.js API routes and the acceptance scripts). */
import './tools';

export { acknowledgeAlert, activeAlerts, raiseAlert, type AlertRow } from './alerts';
export { approve, expireStaleApprovals, getApproval, type ApproveOutcome } from './approvals';
export { DiagnosisSchema, type Diagnosis } from './diagnosis-schema';
export { PlanRecommendationSchema, type PlanRecommendation } from './deploy/plan-schema';
export { runApprovedAction, runTurn, type TurnResult } from './loop';
export { getMemory, setMemoryKey } from './memory';
export { getModel, llmHealthCheck } from './providers';
export { createAgentRuntime, toolContextFor, type AgentRuntime } from './runtime';
export { AgentSession } from './session';
export { startWatcher, Watcher } from './watcher';
