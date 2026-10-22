# PRD-01 — Repo bootstrap, Liara API probe, typed client, tool registry, MCP server

Depends on: `docs/00-overview-architecture.md` (read first).
Outcome: a tested, typed foundation that every later PRD builds on. Nothing in this PRD uses an LLM.

---

## 0. Step 0 — Bootstrap & probe the real API (do this before any other code)

### 0.1 Repo bootstrap
1. `git init`, default branch `main`.
2. `npm init -y`; set `"type": "module"`, `"engines": {"node": ">=22"}`.
3. Install:
   - runtime: `next@15 react react-dom ai @ai-sdk/openai @ai-sdk/google @openrouter/ai-sdk-provider zod better-sqlite3 @modelcontextprotocol/sdk pino yaml tar ignore ws undici`
   - dev: `typescript @types/node @types/react @types/better-sqlite3 @types/ws vitest tsx tailwindcss postcss autoprefixer eslint eslint-config-next pino-pretty`
   (If a package name/version fails, pick the closest maintained equivalent and note it in `docs/API-NOTES.md`.)
4. `tsconfig.json` strict, `moduleResolution: bundler`, path alias `@/* → ./*`.
5. `.gitignore`: `node_modules/ .next/ .env .env.* !.env.example data/ fixtures/liara/*.raw.json *.log .DS_Store`
6. Create `.env.example` exactly as in `docs/00-overview-architecture.md#7`. Copy to `.env` if absent (the author fills `LIARA_API_TOKEN`).
7. `src/config.ts`: load `.env` (use `dotenv` or Next's built-in for app code; for scripts use `dotenv/config`), validate with Zod, export `config`. Fail fast with a Persian+English message if `LIARA_API_TOKEN` is missing.
8. Scripts in `package.json` (see CLAUDE.md "Commands").
9. **Commit:** `chore: bootstrap repo, tooling, config`

### 0.2 Probe script — `scripts/probe-liara.ts` (`npm run probe`)
Purpose: record **real** response shapes so types and fixtures are true, and discover the few things the spec does not document.

Behaviour:
1. Read token from config. Print nothing secret.
2. Call, in order, catching and recording every error (status + body):
   1. `GET /v1/me` → save. **Inspect for a plan catalogue** (look for keys like `plans`, `plans.projects`, each plan having RAM/CPU/disk/price). Also look for `balance`/`credit`.
   2. Billing: try `GET /v1/billing` and any path found in `https://developers.liara.ir/spec/billing.yaml` (fetch the YAML at runtime if network allows; otherwise try `/v1/billing`, `/v1/me/billing`). Record what works.
   3. `GET /v1/projects`.
   4. If no app exists, **create one**: `POST /v1/projects {name: "<DEMO_APP_NAME or liara-agent-probe-<4 random chars>>", platform: "node", planID: <cheapest non-free plan found in step 1, else "free">}`. Record the response and the exact `planID` accepted. If creation fails on planID, print the plan list and stop with a clear message.
   5. `GET /v1/projects/{name}`.
   6. `GET /v1/projects/{name}/logs?since=<now-1h unix seconds>` — also try `since` as milliseconds and as ISO if the first form errors; record which works.
   7. `GET /v1/projects/{name}/events?start=<now-24h>&end=<now>` (try seconds; then ms).
   8. `GET /v1/projects/{name}/applets`.
   9. `GET /v1/projects/{name}/releases?page=1&count=10`.
   10. `GET /v1/projects/{name}/metrics/summary`.
   11. `GET /v1/projects/{name}/metrics/cpu?since=<now-1h>` (try seconds; then ms) and `/memory`.
   12. `GET /v1/domains?project={name}`.
   13. Upload a minimal source: build a tar.gz in memory containing `package.json` (`{"name":"probe","scripts":{"start":"node index.js"}}`), `index.js` (HTTP server on `process.env.PORT || 3000` responding `ok`), and `liara.json` (`{"app":"<name>","port":3000,"platform":"node"}`); `POST /v2/projects/{name}/sources` multipart field `file`. Record `{sourceID}`.
   14. `POST /v2/projects/{name}/releases {sourceID, port: 3000, type: "node"}`. Record `{releaseID}`.
   15. Poll `GET /v1/projects/{name}/releases` every 5s up to 4 min; record the sequence of `state` values seen (e.g. `PENDING → BUILDING → READY` or `FAILED`). Record the final release object.
   16. `GET /v1/projects/{name}/logs?since=<release createdAt>` — this gives **build logs** shape too.
   17. `GET https://{name}.liara.run/` plain HTTP — record status and latency.
   18. `POST /v1/projects/update-envs {project, variables:[{key:"PROBE_KEY", value:"1"}]}` then `GET /v1/projects/{name}` — **determine whether update-envs replaces the whole set or merges** (compare envs before/after). Record the answer in API-NOTES.
   19. `POST /v1/projects/{name}/actions/restart` → then applets after 10s.
   20. **Rollback discovery:** look in `https://developers.liara.ir/llms.txt` and the PaaS spec for any "redeploy"/"rollback"/"releases/{id}" endpoint; try `POST /v2/projects/{name}/releases {releaseID:<previous>}` and `POST /v1/projects/{name}/releases/{id}/redeploy`. Record outcome (even if 404). Decide and write the rollback strategy into API-NOTES (see 00 §4).
   21. Do **not** delete the app; it is reused by acceptance tests and the demo (`DEMO_APP_NAME` in `.env`; write it there if created).
3. Save each response as `fixtures/liara/<step>.raw.json` (gitignored) and a **sanitized** copy `fixtures/liara/<step>.json` (replace emails, phone numbers, tokens, `_id` of user with placeholders; keep structure and app ids).
4. Generate `docs/API-NOTES.md` (append-only, human-readable) with: working time formats for `since/start/end`, plan catalogue (id → RAM/CPU/disk/hourly price), update-envs semantics, release state machine observed, log line shape, event `values` layout, rollback decision, health URL pattern, any 4xx/5xx surprises.
5. Print a summary table to stdout.

**Commit:** `feat(probe): record real Liara API fixtures and notes`

> If the token is missing, the probe exits with instructions. Do not fabricate fixtures. Later steps may be developed against the OpenAPI shapes but must be re-validated against fixtures before PRD-01 is accepted.

---

## 1. Liara API client — `src/liara/`

### 1.1 `client.ts`
```ts
export class LiaraClient {
  constructor(opts: { token: string; baseUrl?: string; teamId?: string; fetch?: typeof fetch; logger?: Logger })
  request<T>(schema: ZodType<T>, init: { method; path; query?; body?; multipart?: FormData; timeoutMs? }): Promise<T>
}
```
- Adds `Authorization: Bearer`, `Accept: application/json`; `teamID` query when configured.
- Timeouts (default 20s; uploads 180s). Retries: GET only, 2 retries on 429/502/503/504 with jittered backoff.
- Parses JSON; validates with the given Zod schema in **non-strict** mode (`.passthrough()` on objects) so unknown fields never break us; logs a `warn` on validation mismatch with the path, and returns the raw value cast (never throw on extra/missing optional fields).
- Errors → `LiaraApiError { status, endpoint, message, body? }` with a `userMessage` in Persian for common codes: 401 (توکن نامعتبر/منقضی), 402/payment (موجودی کافی نیست), 403, 404 (اپ پیدا نشد), 409 (نام تکراری), 429 (محدودیت نرخ), 5xx (خطای سمت لیارا).
- Redacts headers in logs.

### 1.2 `types.ts`
Zod schemas + inferred types for every response in 00 §4, adjusted to fixtures: `Project`, `ProjectDetails`, `LogLine`, `AppEvent` (normalized, see below), `Applet`, `Release`, `ReleasesPage`, `MetricsSummary`, `MetricSeries`, `Domain`, `DomainCheck`, `Plan`, `Me`, `Billing`.

**Normalized event** (`events` endpoint returns `{data:[{metaData, values:[[...]]}]}`): write `normalizeEvents(raw): AppEvent[]` where `AppEvent = { ts: string; type?: string; reason?: string; message: string; count?: number; applet?: string; severity: 'info'|'warning'|'error' }`. Determine column meaning from the fixture; severity map: reasons containing `OOMKilled|BackOff|Failed|Error|Unhealthy|Evicted` → error; `Killing|Scaling|Resize` → warning; else info.

### 1.3 `endpoints/*.ts` — thin typed functions (one per endpoint group)
`apps.ts`: `listApps`, `getApp`, `createApp`, `deleteApp`, `scaleApp(name, 0|1)`, `restartApp`, `resizeApp(name, planID)`, `getApplets`, `getReleases(name, page, count)`
`logs.ts`: `getLogs(name, sinceTs)` — accepts a `Date`, converts to the format discovered in probe; returns `LogLine[]` sorted ascending.
`events.ts`: `getEvents(name, start?, end?, search?)` → `AppEvent[]` (normalized)
`metrics.ts`: `getMetricsSummary`, `getCpu(name, since)`, `getMemory`, `getNetRx`, `getNetTx` → `MetricSeries`
`deploy.ts`: `uploadSource(name, tarGzBuffer|stream, filename)`, `deployRelease(name, {sourceID, port, type})`, `waitForRelease(name, releaseID, {timeoutMs, onState})` (polls releases every 5s; resolves with final release; rejects on FAILED/timeout)
`envs.ts`: `updateEnvs(name, variables)` — implements **merge semantics** on top of the API: fetch current envs, merge, send the full set if the API replaces (per API-NOTES). Also `deleteEnvs(name, keys)`.
`domains.ts`: `listDomains(name)`, `addDomain(name, domain)`, `setDomainProject`, `checkDomain(id)`, `enableSsl(domain)`, `deleteDomain(id)`
`account.ts`: `getMe()`, `getPlans()` (from wherever probe found them; cached 10 min), `getBalance()` (from billing/me; return `{amount, currency:'IRT', raw}` or `{unknown:true}` if not exposed)
`shell.ts`: `execShell(projectId, command, {timeoutMs=15000})` over WebSocket (`ws`); captures stdout; **allow-list** of commands in MVP: `ls, cat, head, tail, df -h, free -m, ps, env (values redacted), node -v, npm ls --depth=0, wc`. Anything else is rejected with a limitation message.
`settings.ts`: `setZeroDowntime`, `setDefaultSubdomain`, `setFixedIp`, `setReadOnly` (optional, low priority)

Unit tests (`src/liara/__tests__/`): parse every fixture with its schema; `normalizeEvents` on the events fixture; `updateEnvs` merge logic with a mocked client; `waitForRelease` state machine with a fake clock.

**Commit:** `feat(liara): typed API client with fixtures-backed schemas`

---

## 2. Tool registry — `src/tools/`

### 2.1 `registry.ts`
```ts
export type Risk = 0 | 1 | 2;
export interface ToolDef<I, O> {
  name: string;                       // snake_case
  description: string;                // English, for the LLM; precise about when to use
  input: ZodType<I>;
  risk: Risk;
  category: 'read'|'deploy'|'ops'|'domain'|'local'|'composite';
  // Persian one-liner shown in the timeline / approval card. May use input fields.
  describeFa: (input: I) => string;
  // For risk>=1: Persian explanation of consequences, reversibility, cost.
  consequencesFa?: (input: I, ctx: ToolContext) => Promise<{ why: string; reversible: boolean; costNote?: string }>;
  run: (input: I, ctx: ToolContext) => Promise<ToolResult<O>>;
  // For mutating tools: how to verify success after a delay. Returns evidence strings.
  verify?: (input: I, before: unknown, ctx: ToolContext) => Promise<{ ok: boolean; evidence: string[] }>;
  // Optional: capture state before running (used by verify + audit)
  snapshot?: (input: I, ctx: ToolContext) => Promise<unknown>;
}
export type ToolResult<O> = { ok: true; data: O; summaryFa: string } | { ok: false; error: string; userMessageFa: string; limitation?: boolean };
export interface ToolContext { liara: LiaraClient; db: Db; logger; now: () => Date; appName?: string; workdir: string }
export function defineTool<I,O>(def: ToolDef<I,O>): ToolDef<I,O>
export const registry: Map<string, ToolDef<any,any>>
export function toAiSdkTools(ctx, opts?: {only?: string[]}) // → Vercel AI SDK `tools` object (execute wired through policy in PRD-02)
export function toMcpTools() // → MCP tool list with annotations {readOnlyHint, destructiveHint, title}
```
Every `run` must catch errors and return `{ok:false,...}`; never throw. Results must be **compact**: cap arrays (logs ≤ 300 lines, events ≤ 100) and strip fields the LLM doesn't need; put the full payload in `raw` only when necessary (the loop will drop `raw` from the model context but keep it for the UI).

### 2.2 Tools (names are final; the LLM sees these)

**Read (risk 0)**
| name | input | output (compact) |
|---|---|---|
| `list_apps` | `{}` | `[{name, platform, status, scale, planID, isDeployed, createdAt}]` |
| `get_app` | `{appName}` | details incl. envs (values masked as `••••` if key matches `/secret|password|token|key/i`), plan (joined with catalogue: RAM/CPU/price), url `https://{name}.liara.run` |
| `get_app_logs` | `{appName, sinceMinutes?=30, filter?: 'all'\|'errors'}` | `{lines:[{t, type, msg}], truncated, stats:{total, errors}}` — `errors` filter keeps lines matching `/error|exception|fatal|unhandled|traceback|ENOENT|ECONN|OOM|killed/i` |
| `get_app_events` | `{appName, sinceMinutes?=120}` | `AppEvent[]` normalized + `counts` by reason |
| `get_app_applets` | `{appName}` | `[{name, state, reason, releaseTag, ts}]` |
| `get_app_releases` | `{appName, count?=10}` | `{current, releases:[{id, state, tag, createdAt, finishedAt, commitMessage?, sourceAvailable}]}` |
| `get_app_metrics` | `{appName, sinceMinutes?=60}` | **summarized** (PRD-02 `evidence/metrics.ts` lives here as a pure util): `{cpu:{avg,max,last,trend}, memory:{avgMB,maxMB,lastMB,limitMB,pctOfLimit,trend}, network:{rxKBps, txKBps}, disks:[{name, pctUsed}]}` |
| `list_domains` | `{appName}` | `[{id, name, status, certificatesStatus, cnameRecord}]` |
| `check_domain` | `{domainId}` | `{status, certificatesStatus, cnameRecord, verified: boolean, hintFa}` |
| `get_account` | `{}` | `{balanceIRT?, balanceUnknown?, plansAvailable:[{id, ramMB, cpu, diskGB, hourlyPriceIRT, monthlyEstimateIRT}]}` |
| `http_health_check` | `{url, timeoutMs?=8000, samples?=3}` | `{status, ok, latencyMs:{min,avg,max}, bodySnippet, error?}` — **not Liara API**; GET with `User-Agent: liara-agent/1.0`; follows redirects |
| `search_docs` | `{query, limit?=5}` | keyword search over `src/knowledge/*.md` (split by `##` headings; score by term frequency; return heading+snippet+path) |
| `analyze_project` | `{path}` (local folder or git URL — if URL, `git clone --depth 1` into `data/clones/<hash>`) | `ProjectAnalysis` (see 2.3) |
| `build_source_archive` | `{path, appName}` | creates `data/sources/<app>/<timestamp>.tar.gz` honoring `.gitignore` + `.liaraignore` + default excludes (`node_modules, .git, .next, dist?` — **do not exclude dist/build for static platforms**); returns `{archivePath, sizeMB, fileCount, topLevel:[...]}` |
| `collect_evidence` | `{appName, windowMinutes?=60}` | composite (see 2.4) |

**Deploy / ops (risk 1)**
| name | input | notes |
|---|---|---|
| `create_app` | `{appName, platform, planID}` | validates name `^[a-z][a-z0-9-]{2,30}$`; `consequencesFa` states hourly/monthly cost from catalogue |
| `upload_source` | `{appName, archivePath}` | returns `{sourceID}`; stores mapping in db `sources(app, sourceID, archivePath, createdAt)` |
| `deploy_release` | `{appName, sourceID, port, platform, waitForReady?=true}` | emits progress via `ctx.emit('deploy_progress')` if provided; `verify`: release READY + applets running + health check 200 |
| `rollback_release` | `{appName, toReleaseId?}` | per API-NOTES strategy; default target = latest READY release before current; `verify` same as deploy |
| `restart_app` | `{appName}` | `snapshot`: applets; `verify` (after 20s): applets all `Running`, no new `BackOff` events, health 200 |
| `update_envs` | `{appName, set?: Record<string,string>, unset?: string[]}` | masks values in timeline; `verify`: app restarted and healthy |
| `add_domain` | `{appName, domain}` | returns CNAME target + `irnicGuideFa` (from knowledge) |
| `enable_ssl` | `{domain}` | `verify`: `check_domain.certificatesStatus` becomes active within 2 min (or report pending) |

**High risk (risk 2)**
| name | input | notes |
|---|---|---|
| `resize_app` | `{appName, planID}` | `consequencesFa`: old→new RAM/CPU and price delta; `verify`: `get_app.planID` updated + healthy |
| `scale_app` | `{appName, on: boolean}` | off = downtime; `verify` via applets/health |
| `delete_app` | `{appName}` | irreversible |
| `delete_domain` | `{domainId}` | |
| `exec_shell` | `{appName, command}` | allow-listed; returns stdout ≤ 4KB |

### 2.3 `ProjectAnalysis` (output of `analyze_project`)
```ts
{
  path, isGit, defaultBranch?,
  platform: 'node'|'next'|'react'|'vue'|'angular'|'static'|'laravel'|'php'|'django'|'flask'|'python'|'dotnet'|'go'|'docker'|'unknown',
  confidence: number,            // 0..1
  evidence: string[],            // e.g. "package.json has next dependency"
  port: number|null,             // from Dockerfile EXPOSE / liara.json / framework default
  startCommand?: string, buildCommand?: string,
  nodeVersion?: string, pythonVersion?: string,
  envKeys: { key: string; required: boolean; example?: string; isSecret: boolean }[],  // from .env.example/.env.sample/README/process.env usage scan (grep `process.env.X`, `os.environ`, `env(`)
  needsDatabase?: 'postgres'|'mysql'|'mongo'|'redis'|null,   // from deps: pg/prisma→postgres, mysql2, mongoose, ioredis…
  needsDisk?: boolean,            // writes to filesystem (uploads/, sqlite file)
  existingLiaraJson?: object,
  sizeMB, fileCount,
  warnings: string[]              // e.g. "no start script", "dist folder missing for static"
}
```
Detection order: `liara.json.platform` → `Dockerfile` → `package.json` deps (`next`→next, `react-scripts|vite`+react→react, `vue`, `@angular/core`) → `composer.json` (`laravel/framework`→laravel else php) → `manage.py`→django, `flask` in requirements→flask, `requirements.txt|pyproject`→python → `*.csproj`→dotnet → `go.mod`→go → `index.html` only→static. Framework default ports: node/next 3000, react/vue/angular/static 80 (Liara serves static), laravel/php 80, django/flask 8000, dotnet 80, go 8080 (verify against `src/knowledge/platforms.md`).

### 2.4 `collect_evidence` (composite, risk 0) — the heart of diagnosis
Runs **in parallel** (Promise.allSettled; partial results allowed, each part has `ok`):
`get_app`, `get_app_applets`, `get_app_releases(count=5)`, `get_app_events(window)`, `get_app_logs(window, all)`, `get_app_metrics(window)`, `http_health_check(appUrl)`, `list_domains`, `get_account` (balance only).
Then builds an **EvidencePacket**:
```ts
{
  app: { name, platform, status, scale, plan:{id, ramMB, cpu}, isDeployed, url, currentRelease:{id, tag, createdAt, ageMinutes}, lastDeployAgeMinutes },
  health: { status, ok, latencyMs, error? , sampledAt },
  applets: [{name, state, reason, restarts?}],
  events: { window, byReason: Record<string, number>, timeline: [{ts, reason, message}] /* ≤ 40 most relevant: errors first, then warnings, newest first */ },
  logs: {
    window, totalLines, errorLines,
    clusters: [{ signature, count, firstTs, lastTs, sample }]  /* ≤ 12; signature = line with digits/ids/paths normalized */,
    lastLines: string[] /* last 30 */,
    stackTraces: string[] /* ≤ 3, each ≤ 25 lines */,
    buildLog?: string[]  /* if latest release FAILED: lines between its createdAt and finishedAt */
  },
  metrics: { cpu:{avg,max,last,trend}, memory:{avgMB,maxMB,lastMB,limitMB,pctOfLimit,trend, nearLimit: boolean}, network:{...}, disks:[...] },
  domains: [{name, status, certificatesStatus}],
  account: { balanceIRT?, lowBalance?: boolean },
  signals: Signal[],          // produced by PRD-02 rule engine; empty in PRD-01
  limitations: string[],      // e.g. "metrics endpoint returned 500", "no access logs available"
  collectedAt, durationMs
}
```
Pure helpers live in `src/agent/evidence/` but have no LLM dependency: `clusterLogs(lines)`, `extractStackTraces(lines)`, `summarizeSeries(series, limit)`, `trendOf(values)` ('rising'|'falling'|'flat' via first-third vs last-third mean, ±15%). Unit-test them with synthetic data (OOM pattern, crash loop pattern, normal).

Packet size budget: serialize ≤ ~6000 tokens (≈ 20KB). Enforce by trimming `lastLines` then `timeline` then `clusters`.

**Commit:** `feat(tools): tool registry with risk tiers, local tools, evidence collector`

---

## 3. MCP server — `src/mcp/server.ts` (`npm run mcp`)
- stdio transport via `@modelcontextprotocol/sdk`. Server name `liara-agent`, version from package.json.
- Registers every tool in the registry. MCP annotations: `readOnlyHint: risk===0`, `destructiveHint: risk===2`, `title`. Description gets a prefix `[risk 1 — confirm]` / `[risk 2 — dangerous]` so MCP hosts show it.
- In MCP mode there is no UI approval; the server enforces: risk 2 tools require an extra input `confirmAppName` equal to `appName`, otherwise return an error explaining it. Risk 1 tools require `confirm: true`.
- Tool results returned as JSON text content; `summaryFa` first line.
- Add `docs/MCP.md` with the config snippet for Claude Desktop / Cursor:
  ```json
  { "mcpServers": { "liara-agent": { "command": "npx", "args": ["tsx", "/abs/path/src/mcp/server.ts"], "env": { "LIARA_API_TOKEN": "..." } } } }
  ```
  (also a built `dist/mcp.js` variant via `tsx build` or `esbuild` if simple).

**Commit:** `feat(mcp): expose tool registry over MCP stdio`

---

## 4. Database — `src/db/`
better-sqlite3, WAL mode, migrations in `src/db/migrations/*.sql` applied at startup.
Tables (PRD-01 creates all; PRD-02/03 use them):
```
sessions(id, appName, createdAt, lastActiveAt)
messages(id, sessionId, role, content, createdAt)
events(id, sessionId, type, payload JSON, ts)
approvals(id, sessionId, tool, args JSON, risk, status: pending|approved|rejected|expired, createdAt, resolvedAt, resolvedBy)
audit(id, sessionId, tool, args JSON (secrets masked), risk, startedAt, finishedAt, ok, resultSummary, verifyOk, verifyEvidence JSON)
sources(appName, sourceID, archivePath, releaseID, createdAt)
app_memory(appName, key, value JSON, updatedAt)        -- last diagnosis, actions, baseline
metric_snapshots(appName, ts, cpu, memMB, latencyMs, healthStatus)
alerts(id, appName, severity, title, summary, createdAt, acknowledgedAt)
```

---

## 5. Acceptance — `scripts/acceptance/prd01.ts` (`npm run accept:prd01`)
Runs against the real account with `DEMO_APP_NAME`:
1. `list_apps` includes the demo app.
2. `get_app` returns plan info joined with the catalogue (ramMB > 0).
3. `get_app_logs` returns lines (or empty with `ok:true`), `get_app_events`, `get_app_applets`, `get_app_releases`, `get_app_metrics` all `ok:true`.
4. `http_health_check` on the demo app URL returns a status.
5. `analyze_project` on `demo-app/` (create a placeholder `demo-app/` with `package.json` + `index.js` now; PRD-03 replaces it) → platform `node`, port 3000.
6. `build_source_archive` → tar.gz exists, excludes node_modules.
7. With `AUTO_APPROVE=true`: `upload_source` → `deploy_release` (wait) → READY → health 200. Prints release state sequence.
8. `collect_evidence` returns a packet ≤ 20KB with `health.ok === true`.
9. `update_envs set {PROBE_KEY: '2'}` → `get_app` shows it; `unset` removes it.
10. MCP: spawn `npm run mcp`, perform `tools/list` via the SDK client, assert ≥ 20 tools and that `delete_app` has `destructiveHint`.
11. `npm run test` (unit) passes; `npm run typecheck` passes.

Print a PASS/FAIL table. Exit non-zero on any failure.

**Commit:** `test(prd01): acceptance script passes against real Liara account`

---

## 6. Deliverables checklist for PRD-01
- [ ] repo bootstrapped, scripts, config, `.env.example`
- [ ] `fixtures/liara/*.json` + `docs/API-NOTES.md` from the probe
- [ ] `src/liara/*` client + schemas + unit tests
- [ ] `src/tools/*` registry, all tools above, evidence collector + unit tests
- [ ] `src/mcp/server.ts` + `docs/MCP.md`
- [ ] `src/db/*` schema
- [ ] `npm run accept:prd01` passes
- [ ] milestone commits present
