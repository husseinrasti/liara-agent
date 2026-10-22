import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { sanitize } from '../lib/sanitize';
import type { ArrSummary, MetricSummary, ProbeFacts } from './facts';

const HEADER = `# API-NOTES — facts discovered against the real Liara API

Append-only. Each \`npm run probe\` run appends a generated section below; curated
conclusions (what the code relies on) live in the "Decisions" section at the top
and are maintained by hand. Fixtures referenced here are in \`fixtures/liara/\`.
`;

const fmtArr = (s?: ArrSummary) => (s ? `status ${s.status ?? 'ERR'}, items ${s.count ?? '—'}${s.first ? `, first \`${s.first}\`` : ''}${s.last ? `, last \`${s.last}\`` : ''}` : '—');
const fmtMetric = (m?: MetricSummary) =>
  m ? `status ${m.status ?? 'ERR'}, series ${m.series ?? '—'}, points ${m.points ?? '—'}${m.firstTs ? `, ts ${m.firstTs} → ${m.lastTs}` : ''}` : '—';

export function writeProbeNotes(facts: ProbeFacts, file: string): void {
  if (!existsSync(file)) writeFileSync(file, HEADER);
  const f = sanitize(facts) as ProbeFacts;
  const lines: string[] = [];
  lines.push('', `## Probe run ${f.ranAt}`, '');
  lines.push(`- App: \`${f.appName}\`${f.appCreated ? ` (created by probe with \`${JSON.stringify(f.createBody)}\`)` : ' (existing DEMO_APP_NAME)'}`);
  for (const a of f.createAttempts) lines.push(`  - create attempt \`${JSON.stringify(a.body)}\` → ${a.status}${a.message ? ` (${a.message})` : ''}`);
  lines.push(`- \`/v1/me\` top-level keys: ${f.meTopKeys.map((k) => `\`${k}\``).join(', ') || '—'}`);
  lines.push(`- Plan object fields (\`plans.projects.<id>\`): ${f.planFieldNames.map((k) => `\`${k}\``).join(', ') || '—'}`);
  lines.push(`- Balance: ${f.balance.value ?? 'unknown'} (source: ${f.balance.source})`);
  lines.push(`- Project detail keys: ${f.projectDetailKeys.map((k) => `\`${k}\``).join(', ')}`);
  lines.push(`- Project planID \`${f.projectPlanID}\`, hourlyPrice ${f.projectHourlyPrice}`);
  lines.push('', '### Plan catalogue (parsed)', '', '| id | RAM MB | CPU | disk GB | monthly IRT | hourly IRT | available | region |', '|---|---|---|---|---|---|---|---|');
  for (const p of f.plans) lines.push(`| ${p.id} | ${p.ramMB} | ${p.cpu} | ${p.diskGB} | ${p.monthlyEstimateIRT ?? '—'} | ${p.hourlyPriceIRT ?? '—'} | ${p.available} | ${p.region ?? '—'} |`);
  if (f.bundlePlansSample) lines.push('', '<details><summary>projectBundlePlans sample</summary>', '', '```json', JSON.stringify(f.bundlePlansSample, null, 2).slice(0, 3000), '```', '</details>');
  lines.push('', '### Time formats', '');
  lines.push('| call | result |', '|---|---|');
  for (const [k, v] of Object.entries(f.logs)) lines.push(`| logs \`${k}\` | ${fmtArr(v)} |`);
  for (const [k, v] of Object.entries(f.buildLogs)) lines.push(`| build/release logs \`${k}\` | ${fmtArr(v)} |`);
  for (const [k, v] of Object.entries(f.events)) lines.push(`| events \`${k}\` | status ${v.status ?? 'ERR'}, rows ${v.rows ?? '—'} |`);
  for (const [k, v] of Object.entries(f.metrics)) lines.push(`| metrics \`${k}\` | ${fmtMetric(v)} |`);
  if (f.logLineSample) lines.push('', 'Log line sample:', '', '```json', JSON.stringify(f.logLineSample), '```');
  if (f.buildLogSample) lines.push('', 'Build log sample:', '', '```json', JSON.stringify(f.buildLogSample).slice(0, 800), '```');
  if (f.eventSample) lines.push('', 'Event sample (`data[i].metaData` and first `values` row):', '', '```json', JSON.stringify(f.eventSample).slice(0, 1500), '```');
  lines.push('', '### Deploy', '');
  lines.push(`- Release body accepted: \`${JSON.stringify(f.release.deployBodyAccepted)}\``);
  lines.push(`- Release states observed: **${f.release.states.join(' → ') || '—'}** (final \`${f.release.finalState}\`, ${f.release.durationSec}s)`);
  lines.push(`- Release object keys: ${(f.release.releaseKeys ?? []).map((k) => `\`${k}\``).join(', ')}`);
  lines.push(`- Health: \`${f.health.url}\` → ${f.health.status} in ${f.health.latencyMs}ms after ${f.health.attempts} attempt(s)`);
  lines.push('', '### update-envs', '');
  lines.push(`- Semantics: **${f.envs.semantics}** (before ${JSON.stringify(f.envs.keysBefore)}, after A ${JSON.stringify(f.envs.keysAfterA)}, after B ${JSON.stringify(f.envs.keysAfterB)})`);
  lines.push(`- Restore with full previous set → ${f.envs.restoreStatus ?? '—'}; keys after restore ${JSON.stringify(f.envs.keysAfterRestore ?? [])}${f.envs.note ? ` — ${f.envs.note}` : ''}`);
  lines.push('', '### Restart', '', `- restart → ${f.restart.status}; applets 10s later: ${f.restart.appletStates.join(', ') || '—'}`);
  lines.push('', '### Rollback discovery', '');
  lines.push(`- Re-release with an already used sourceID → ${f.rollback.sourceReuseStatus} (final state ${f.rollback.sourceReuseFinalState ?? '—'})`);
  for (const c of f.rollback.candidates) lines.push(`- \`${c.call}\` → ${c.status ?? 'ERR'}${c.message ? ` (${c.message})` : ''}`);
  lines.push(`- **Decision:** ${f.rollback.decision}`);
  lines.push('', '### Domains', '');
  lines.push(`- add \`${f.domain.name}\` → ${f.domain.createStatus}${f.domain.createMessage ? ` (${f.domain.createMessage})` : ''}; list → ${f.domain.listStatus}; check → ${f.domain.checkStatus}; delete → ${f.domain.deleteStatus}; CNAME target \`${f.domain.cname ?? '—'}\``);
  if (f.errors.length) lines.push('', '### Errors', '', ...f.errors.map((e) => `- ${e}`));
  appendFileSync(file, `${lines.join('\n')}\n`);
}
