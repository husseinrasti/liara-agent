/** Builds the evaluation context the rule engine, templates and `when` expressions see. */
import type { EvidencePacket } from '../evidence/packet';
import { nextPlanUp, type Plan } from '../../liara/plans';

export interface EngineExtras {
  plans?: Plan[];
  /** Latest uploaded sourceID for the app (from the `sources` table), for redeploy fixes. */
  latestSourceID?: string | null;
}

const LISTEN_PORT = /(?:listen(?:ing)?|started|running|serving|bound)[^\n]{0,60}?(?:port\s*[:=]?\s*|:)(\d{2,5})\b/i;
const MISSING_ENV = [
  /\b([A-Z][A-Z0-9_]{2,})\s+(?:is not set|is missing|is not defined|is undefined|not set|is required)/g,
  /KeyError: '([A-Z_][A-Z0-9_]*)'/g,
  /Missing (?:required )?env(?:ironment)?(?: variable| var)?s?:?\s*"?([A-Z_][A-Z0-9_]*)/gi,
  /Environment variable "?([A-Z_][A-Z0-9_]*)"? (?:is )?not (?:set|defined)/gi,
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
];
const NOT_ENV = new Set(['NODE_ENV', 'PORT', 'HOME', 'PATH', 'ERROR', 'WARN', 'INFO', 'FATAL', 'GET', 'POST', 'HTTP']);

export function logText(p: EvidencePacket): string {
  return [...p.logs.clusters.map((c) => c.sample), ...p.logs.stackTraces, ...p.logs.lastLines].join('\n');
}

export function extractMissingEnvKeys(text: string): string[] {
  const found = new Set<string>();
  for (const re of MISSING_ENV) for (const m of text.matchAll(re)) if (m[1] && !NOT_ENV.has(m[1].toUpperCase())) found.add(m[1].toUpperCase());
  return [...found].slice(0, 5);
}

function ramLabelFa(mb: number): string {
  return mb >= 1024 ? `${+(mb / 1024).toFixed(1)} گیگابایت رم` : `${mb} مگابایت رم`;
}

export function buildContext(p: EvidencePacket, extras: EngineExtras = {}) {
  const latest = p.releases[0];
  const previousReady = p.releases.find((r, i) => i > 0 && /^READY$/i.test(r.state));
  const plan = extras.plans?.find((x) => x.id === p.app?.plan.id);
  const next = plan && extras.plans ? nextPlanUp(extras.plans, plan.id) : null;
  const text = logText(p);
  const listenPort = Number(LISTEN_PORT.exec(text)?.[1]) || null;
  const disks = p.metrics?.disks ?? [];
  const fullest = [...disks].sort((a, b) => (b.pctUsed ?? 0) - (a.pctUsed ?? 0))[0];
  const unverified = p.domains.filter((d) => !/^(ACTIVE|VERIFIED|OK|CONNECTED)$/i.test(d.status ?? ''));
  const sslPending = p.domains.filter((d) => /^(ACTIVE|VERIFIED|OK|CONNECTED)$/i.test(d.status ?? '') && !/^(ACTIVE|ISSUED|VALID|OK)$/i.test(d.certificatesStatus ?? ''));
  const firstError = p.logs.clusters.filter((c) => c.isError).map((c) => c.firstTs).sort()[0];
  const missingEnvKeys = extractMissingEnvKeys(text);
  return {
    app: p.app ? { ...p.app } : null,
    plan: { id: p.app?.plan.id ?? null, ramMB: p.app?.plan.ramMB ?? null, nextUp: next?.id ?? null, nextUpLabel: next ? ramLabelFa(next.ramMB) : null },
    health: p.health,
    logs: p.logs,
    metrics: p.metrics,
    events: p.events,
    account: p.account,
    applets: p.applets,
    domains: p.domains,
    release: { latest: latest ?? null, previousReady: previousReady ?? null, latestState: latest?.state ?? null, latestPort: latest?.port ?? null },
    source: { latest: extras.latestSourceID ?? null },
    derived: {
      listenPort,
      portMismatch: Boolean(listenPort && latest?.port && listenPort !== latest.port),
      missingEnvKeys,
      missingEnvKey: missingEnvKeys[0] ?? null,
      maxDiskPct: fullest?.pctUsed ?? null,
      fullestDisk: fullest?.name ?? null,
      unverifiedDomains: unverified.length,
      firstUnverifiedDomain: unverified[0]?.name ?? null,
      sslPendingDomain: sslPending[0]?.name ?? null,
      appFrozen: /frozen|suspend|block/i.test(p.app?.status ?? ''),
      errorsAfterDeploy: Boolean(firstError && latest?.createdAt && firstError >= latest.createdAt),
      crashing: p.applets.some((a) => /CrashLoop|BackOff|Error/i.test(`${a.state ?? ''} ${a.reason ?? ''}`)),
    },
  };
}

export type EngineContext = ReturnType<typeof buildContext>;
