/**
 * Deterministic rule engine: matches playbook signals against an EvidencePacket,
 * scores candidates (sum of matched weights, capped at 1), resolves fix templates
 * into validated tool calls. Used as LLM input and as the no-LLM fallback.
 */
import { getTool } from '../../tools/registry';
import type { EvidencePacket, Signal } from '../evidence/packet';
import { buildContext, logText, type EngineContext, type EngineExtras } from './context';
import { evaluateExpr, hasUnresolved, renderTemplate, resolvePath } from './expr';
import { loadPlaybooks } from './load';
import type { Playbook, SignalRule } from './schema';

export interface ResolvedFix {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  title_fa: string;
  why_fa: string;
  priority: number;
  risk: 0 | 1 | 2;
}

export interface Candidate {
  playbookId: string;
  title_fa: string;
  category: string;
  score: number;
  matchedSignals: Signal[];
  causes_fa: string[];
  checks_fa: string[];
  fixes: ResolvedFix[];
  manualStepsFa: string[];
  advice_fa?: string;
}

export interface Evaluation {
  signals: Signal[];
  candidates: Candidate[];
}

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const stripPlaceholders = (s: string) => s.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').trim();

function renderText(text: string, ctx: EngineContext): string {
  const r = renderTemplate(text, ctx);
  return typeof r === 'string' ? r : stripPlaceholders(text);
}

/** Tests one signal rule; returns the matched Signal or null. */
export function matchSignal(rule: SignalRule, p: EvidencePacket, ctx: EngineContext): Signal | null {
  const ci = (pattern: string) => new RegExp(pattern, 'i');
  switch (rule.kind) {
    case 'event_reason': {
      const re = ci(rule.match);
      const hits = Object.entries(p.events.byReason).filter(([r]) => re.test(r));
      if (!hits.length) return null;
      return { kind: rule.kind, source: 'events', weight: rule.weight, detail: hits.map(([r, n]) => `${r} ×${n}`).join('، ') };
    }
    case 'applet_reason': {
      const re = ci(rule.match);
      const a = p.applets.find((x) => re.test(`${x.state ?? ''} ${x.reason ?? ''}`));
      return a ? { kind: rule.kind, source: 'applets', weight: rule.weight, detail: `${a.name}: ${a.state ?? '?'}${a.reason ? ` (${a.reason})` : ''}` } : null;
    }
    case 'log_regex': {
      const re = ci(rule.match);
      const cluster = p.logs.clusters.find((c) => re.test(c.sample));
      if (cluster) return { kind: rule.kind, source: 'logs', weight: rule.weight, detail: `${clip(cluster.sample)}${cluster.count > 1 ? ` (×${cluster.count})` : ''}`, ts: cluster.lastTs };
      const line = [...p.logs.stackTraces, ...p.logs.lastLines].find((l) => re.test(l));
      return line ? { kind: rule.kind, source: 'logs', weight: rule.weight, detail: clip(line.split('\n')[0]!) } : null;
    }
    case 'build_log_regex': {
      const re = ci(rule.match);
      const line = (p.logs.buildLog ?? []).find((l) => re.test(l));
      return line ? { kind: rule.kind, source: 'release', weight: rule.weight, detail: clip(line) } : null;
    }
    case 'metric': {
      const v = resolvePath(p.metrics, rule.field) ?? resolvePath(ctx, rule.field);
      if (typeof v !== 'number') return null;
      return evaluateExpr(`v ${rule.op} ${rule.value}`, { v }) ? { kind: rule.kind, source: 'metrics', weight: rule.weight, detail: `${rule.field} = ${v}` } : null;
    }
    case 'health': {
      const h = p.health;
      if (!h) return null;
      if (rule.status_in?.includes(h.status)) return { kind: rule.kind, source: 'health', weight: rule.weight, detail: h.status ? `پاسخ سایت ${h.status}` : `سایت پاسخ نداد (${h.error ?? 'بدون پاسخ'})` };
      if (rule.latency_over_ms && (h.latencyMs ?? 0) > rule.latency_over_ms) return { kind: rule.kind, source: 'health', weight: rule.weight, detail: `زمان پاسخ ${h.latencyMs}ms` };
      return null;
    }
    case 'release_state': {
      const latest = p.releases[0];
      return latest && ci(rule.match).test(latest.state)
        ? { kind: rule.kind, source: 'release', weight: rule.weight, detail: `آخرین انتشار ${latest.tag ?? latest.id}: ${latest.state}${latest.failReason ? ` — ${clip(latest.failReason, 120)}` : ''}` }
        : null;
    }
    case 'expr':
      return evaluateExpr(rule.when, ctx) ? { kind: rule.kind, source: rule.source, weight: rule.weight, detail: renderText(rule.detail, ctx) } : null;
  }
}

export function resolveFixes(pb: Playbook, ctx: EngineContext): ResolvedFix[] {
  const out: ResolvedFix[] = [];
  for (const fix of [...pb.fixes].sort((a, b) => a.priority - b.priority)) {
    if (fix.when && !evaluateExpr(fix.when, ctx)) continue;
    const def = getTool(fix.tool);
    if (!def) continue;
    const args = renderTemplate(fix.args_template, ctx);
    if (hasUnresolved(args) || !def.input.safeParse(args).success) continue;
    out.push({ id: fix.id, tool: fix.tool, args: args as Record<string, unknown>, title_fa: renderText(fix.title_fa, ctx), why_fa: renderText(fix.why_fa, ctx), priority: fix.priority, risk: def.risk });
  }
  return out;
}

function toCandidate(pb: Playbook, score: number, matched: Signal[], ctx: EngineContext): Candidate {
  return {
    playbookId: pb.id,
    title_fa: pb.title_fa,
    category: pb.category,
    score: Math.round(Math.min(1, score) * 100) / 100,
    matchedSignals: matched,
    causes_fa: pb.causes_fa.map((c) => renderText(c, ctx)),
    checks_fa: pb.checks_fa,
    fixes: resolveFixes(pb, ctx),
    manualStepsFa: pb.manual_steps_fa.map((s) => renderText(s, ctx)).filter(Boolean),
    ...(pb.advice_fa ? { advice_fa: renderText(pb.advice_fa, ctx) } : {}),
  };
}

export function evaluate(packet: EvidencePacket, extras: EngineExtras = {}, playbooks: Playbook[] = loadPlaybooks()): Evaluation {
  const ctx = buildContext(packet, extras);
  const signals = new Map<string, Signal>();
  const candidates: Candidate[] = [];
  for (const pb of playbooks) {
    if (pb.id === 'healthy') continue;
    const matched: Signal[] = [];
    let score = 0;
    for (const rule of pb.signals) {
      const s = matchSignal(rule, packet, ctx);
      if (!s) continue;
      matched.push(s);
      score += s.weight;
      signals.set(`${s.kind}|${s.detail}`, s);
    }
    if (matched.length && score >= pb.threshold) candidates.push(toCandidate(pb, score, matched, ctx));
  }
  candidates.sort((a, b) => b.score - a.score || b.matchedSignals.length - a.matchedSignals.length);
  const top = candidates.slice(0, 3);
  const healthy = playbooks.find((p) => p.id === 'healthy');
  if (!top.length && healthy) {
    const detail = packet.health ? `پاسخ سایت ${packet.health.status}${packet.health.latencyMs ? ` در ${packet.health.latencyMs}ms` : ''}` : 'نشانه‌ی خرابی دیده نشد';
    top.push(toCandidate(healthy, packet.health?.ok ? 0.9 : 0.4, [{ kind: 'expr', source: 'health', weight: 0.9, detail }], ctx));
  }
  return { signals: [...signals.values()], candidates: top };
}

/** Exposed for diagnosis prompts and tests. */
export { buildContext, logText };
