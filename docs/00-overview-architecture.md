# 00 — Overview & Architecture

Project: **liara-agent** — "Your AI DevOps/SRE co-worker for Liara"
Audience of this doc: the coding agent (Claude Code) and the author. Everything here is binding unless a later PRD overrides it explicitly.

---

## 1. The challenge in one page

Hackathon challenge (Starcoach Agentic AI hackathon, Liara track): build an intelligent assistant that sets up, deploys and monitors websites on Liara's infrastructure. Key facts extracted from the challenge text **and** the intro video:

- **Persona (from the video):** "a developer who built a piece of software but knows nothing about deployment/DevOps." They have code and env vars; they do not know what a plan is, how domains/CNAME work, or how to read logs.
- **The current Liara flow that must be simplified (from the video):** charge account → choose a plan for the project → upload project or connect GitHub → set some env vars and a few fields → deploy → set up domain. Goal: "make this as short and simple as possible; the user should only do the steps the assistant cannot do."
- **The only step the user must do alone:** charge their Liara account. The assistant should detect insufficient balance and ask the user to top up.
- **Second role, said explicitly in the video: "we also want an SRE agent"** — watch the site, when it goes down or errors appear: investigate, report, read logs, suggest the fix, stay in touch with the user, and even fix it itself.
- **Deliverable is free-form:** "a full agent, an MCP, or both." **"UI is not that important, UX is."**
- **Demo video (~5 min) is mandatory**; projects without one are not judged. Show outputs and scenarios, not code. Present fully.
- **Human-in-the-loop:** sensitive operations (risky config changes, restart, plan/resource changes) require confirmation; low-risk operations may run automatically. Results and errors must be visible.
- **API limits must be declared:** when something is not available through Liara's API, say so clearly.

### Scoring (300 points) and what we do for each

| Criterion | Points | What earns it in our build |
|---|---|---|
| Technical function & Liara integration | 100 | Our own typed client over Liara's official OpenAPI; real deploy (upload source → release), env management, restart, resize, domains + SSL, logs/metrics/events; MCP server over the same tools |
| Intelligence & problem solving | 100 | Evidence Packet collector → rule engine (playbooks) + LLM structured diagnosis with ranked causes and cited evidence → fix proposal → **act → wait → verify** loop with explicit "fixed / not fixed" result |
| UX | 50 | Persian, plain language; Diagnosis Card, Approval Card, Operation Timeline, suggestion chips, status banner; user never needs to read raw JSON |
| Reliability, maintenance, security | 50 | Risk tiers enforced in code; audit log; background watcher with proactive alerts; explicit `limitation` events; secrets never in prompts |

---

## 2. Product scope (MVP, 24h, built by Claude Code)

### In scope
1. **Deploy Assistant** — from a local project folder (or a git URL the agent clones) to a running URL on Liara, with plan recommendation, env setup, build tracking, health check, and custom domain + IRNIC/CNAME guidance.
2. **SRE Agent** — on demand ("my site is slow / returns 500") and proactive (background watcher): collect evidence, diagnose, propose, confirm, execute, verify.
3. **Operations** — restart, start/stop, resize plan, update envs, redeploy/rollback, list releases, show metrics, show logs — via chat.
4. **Two interfaces over one tool registry:** Next.js chat UI (primary, for the demo) and an MCP stdio server (secondary, shown briefly in the demo inside Claude Desktop/Cursor).
5. **Chaos demo app** to produce reproducible incidents for testing and the video.

### Out of scope (explicitly)
- Multi-user auth, teams, billing UI
- Object storage, mail, IaaS/VMs, DNS zones (unless trivially needed for the domain flow)
- Full DBaaS management (only: optionally create a DB during first deploy if the project clearly needs one — stretch goal, last)
- CLI interface
- Vector database / embeddings (keyword search over curated markdown is enough)

---

## 3. Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Next.js App (app/)                                               │
│   • Chat page (RTL, Persian)  • App selector  • Cards & timeline   │
│   • /api/chat (SSE stream)  • /api/approve  • /api/apps  • /api/… │
└───────────────┬───────────────────────────────────────────────────┘
                │ typed events (src/events.ts) over SSE
┌───────────────▼───────────────────────────────────────────────────┐
│  Agent Core (src/agent/)                                          │
│   providers.ts   → openai | gemini | openrouter (Vercel AI SDK)   │
│   loop.ts        → tool-calling loop, maxSteps, event emitter     │
│   policy.ts      → risk gate: tier0 auto / tier1 confirm /        │
│                    tier2 confirm + typed app name                 │
│   evidence/      → log clustering, metric summary, event normalize│
│   playbooks/     → YAML incident playbooks + rule engine          │
│   diagnosis.ts   → generateObject(DiagnosisSchema)                │
│   verify.ts      → act → wait → re-check → report                 │
│   deploy/        → project analysis, liara.json, archive, release │
│   domain/        → add domain, CNAME, IRNIC guidance, SSL         │
│   watcher.ts     → periodic health/metrics/events poll → alerts   │
│   memory.ts      → per-app memory (last diagnosis, actions, base) │
└───────────────┬───────────────────────────────────────────────────┘
                │ calls tools by name
┌───────────────▼───────────────────────────────────────────────────┐
│  Tool Registry (src/tools/)  — single source of truth             │
│   defineTool({name, description, input(zod), risk, verify?, run}) │
│   liara/*  local/*  composite/collectEvidence                     │
└───────┬───────────────────────────────────────┬───────────────────┘
        │                                       │
┌───────▼───────────────┐              ┌────────▼──────────────────┐
│ Liara API client      │              │ MCP server (src/mcp/)      │
│ (src/liara/)          │              │ exposes the same registry  │
│ fetch + zod + retries │              │ over stdio; risk → MCP     │
└───────┬───────────────┘              │ annotations                │
        │ HTTPS                        └────────────────────────────┘
   https://api.liara.ir
```

### Key design decisions (do not re-litigate)
1. **No agent framework.** The loop is our own thin harness (`loop.ts`) on top of Vercel AI SDK `generateText`/`streamText` with `tools` and `maxSteps`. Reason: full control over approvals and events; less to debug in 24h.
2. **Evidence Packet pattern.** Diagnosis is not "LLM calls 8 tools in sequence". A composite tool `collect_evidence(app)` fetches everything in parallel, pre-processes it into a compact structured packet (≤ ~6k tokens), and the LLM reasons over that once. More reliable, faster, cheaper, easier to demo.
3. **Playbooks as data.** `src/agent/playbooks/*.yaml` describe signals → causes → fixes → verify. The rule engine uses them without an LLM (fallback path + deterministic hints), and they are also injected into the diagnosis prompt. This is the single biggest lever for the "intelligence" score.
4. **Risk is a property of the tool, enforced by `policy.ts`.** The prompt tells the model about it, but the code enforces it.
5. **Verification is mandatory** for every mutating action. The UI never shows "done" for a fix until `verify` returns.
6. **Structured outputs** (Zod + `generateObject`) for everything rendered as a card.
7. **Real API shapes beat the spec** — see PRD-01 step 0 (probe).

---

## 4. Liara API — what is available (from the official OpenAPI at https://developers.liara.ir)

Base URL: `https://api.liara.ir`. Auth: `Authorization: Bearer <LIARA_API_TOKEN>` (JWT). Team accounts: `teamID` query param (verify in probe). Other services have their own hosts (`dns-service.liara.ir`, `storage-service.liara.ir`, …) — not needed for MVP except possibly DNS.

| Capability | Method & path | Notes (from spec; verify in probe) |
|---|---|---|
| List apps | `GET /v1/projects` | `{projects:[{_id, project_id (=name), type (=platform), status, scale, planID, created_at, isDeployed}]}` |
| App details | `GET /v1/projects/{name}` | `{project:{_id, project_id, type, status, defaultSubdomain, readOnlyRootFilesystem, zeroDowntime, scale, envs:[{key,value,encrypted,_id}], planID, fixedIPStatus, created_at, node:{_id,IP}, hourlyPrice, isDeployed, reservedDiskSpace}}` |
| Create app | `POST /v1/projects` | body `{name, planID, platform, readOnlyRootFilesystem?, network?}` → 200; 409 if name taken |
| Delete app | `DELETE /v1/projects/{name}` | Tier 2 |
| Turn on/off | `POST /v1/projects/{name}/actions/scale` | body `{scale: 1|0}` |
| Restart | `POST /v1/projects/{name}/actions/restart` | |
| Change plan | `POST /v1/projects/{name}/resize` | body `{planID}` |
| Logs | `GET /v1/projects/{name}/logs?since=<ts>` | returns `[{type, datetime, message}]`. `since` is required. Container stdout/stderr only — **no HTTP access logs**. |
| Events | `GET /v1/projects/{name}/events?search=&start=&end=` | `{data:[{metaData, values:[[...]]}]}` — Kubernetes-style events (OOMKilled, BackOff, Scheduled, Pulled…). Gold for diagnosis. |
| Applets (pods) | `GET /v1/projects/{name}/applets` | `{applets:[{id,name,timestamp,state,reason,release:{releaseID,tag}}]}` |
| Releases | `GET /v1/projects/{name}/releases?page=1&count=10` | `{total, currentRelease, readyReleasesCount, releases:[{_id,type,imageName,projectType,state,port,gitInfo{...},client,finishedAt,createdAt,tag,sourceAvailable}], platform}` |
| Upload source | `POST /v2/projects/{name}/sources` | multipart, field `file` = `.tar.gz` → `{sourceID}` |
| Deploy release | `POST /v2/projects/{name}/releases` | body `{sourceID, port, type(=platform)}` → `{releaseID}` |
| Update envs | `POST /v1/projects/update-envs` | body `{project, variables:[{key,value}]}` (replaces the full set — verify) → triggers restart |
| Settings | `POST /v1/projects/{id}/zero-downtime/{enable\|disable}`, `default-subdomain`, `fixed-ip`, `read-only` | uses app `_id` |
| Metrics summary | `GET /v1/projects/{name}/metrics/summary` | `{cpuUsage:[{value:[ts,"v"],applet}], memoryUsage:[...], disksUsage:[{size,usage,reportedAt,name}]}` |
| Metrics series | `GET /v1/projects/{name}/metrics/{cpu\|memory\|network-receive\|network-transmit}?since=<n>` | `{end, result:[{values:[[ts,"v"],...], applet}]}` (Prometheus-like) |
| Domains | `GET /v1/domains?project={name}` / `POST /v1/domains {name, project, type:"PROJECT"}` / `POST /v1/domains/set-project {domainID, projectID}` / `GET /v1/domains/{id}/check` / `POST /v1/domains/provision-ssl-certs {domain}` / `DELETE /v1/domains/{id}` | check returns `status`, `certificatesStatus`, `CNameRecord`, `verificationCode` |
| Disks | `GET /v1/projects/{id}/disks`, `POST /v1/projects/{name}/disks {name,size}`, resize, backups | optional |
| Account / plans / balance | `/v1/me` (spec `me.yaml`), billing spec `billing.yaml` | **Plan catalogue is not in the PaaS spec.** Probe must find it (expected inside `/v1/me` → `plans`). |
| In-container shell | `wss://api.liara.ir?token=<token>&cmd=/bin/bash&project_id=<id>` | WebSocket; Tier 2; limited to read-only commands in MVP |
| DBaaS | `api.liara.ir` (spec `dbaas.yaml`) | stretch |

### Known limitations to declare to the user (via `limitation` events)
- No edge/HTTP access logs or status-code histograms → we run our own HTTP health check against the app URL and infer 5xx from app logs.
- No git-push deploy endpoint → the agent clones/archives and uploads source itself.
- No API control over IRNIC (or any external registrar) DNS → we give exact records and poll `check` until it verifies.
- No alerting/webhooks → our watcher polls.
- Rollback: the spec has no explicit "redeploy release X" endpoint. Strategy: (a) probe the console for the endpoint; if not found, (b) we keep every uploaded archive in `data/sources/<app>/<sourceID>.tar.gz` and rollback = re-upload the previous archive + new release. Both documented in `API-NOTES.md`.
- Events/logs retention is whatever Liara keeps; we snapshot metrics into SQLite to build baselines.

---

## 5. Risk tiers {#risk-tiers}

| Tier | Policy | Tools |
|---|---|---|
| **0 — auto** | Executed without asking; shown in timeline | all reads: list/get apps, logs, events, applets, releases, metrics, domains, billing; `http_health_check`, `collect_evidence`, `search_docs`, `analyze_project`, `build_source_archive` (local only) |
| **1 — confirm** | Approval Card: what/why/risk/reversible; one click | `restart_app`, `deploy_release` (new version), `rollback_release`, `update_envs` (non-secret keys or values provided by the user), `add_domain`, `enable_ssl`, `create_app`, `upload_source` |
| **2 — confirm + type app name** | Approval Card requires typing the app name; cost/irreversibility stated | `resize_app` (cost change), `scale_app` to 0 (downtime), `delete_app`, `delete_domain`, `create_disk`/`resize_disk`, `exec_shell` |

Rules:
- Tier is declared on the tool (`risk: 0|1|2`). `policy.ts` intercepts tool calls ≥1, emits `approval_required`, persists the pending action, and resumes only after `/api/approve` with the matching `approvalId`. The LLM cannot bypass this.
- `AUTO_APPROVE=true` env is allowed **only** for the acceptance scripts; the UI never sets it.
- Every executed tier≥1 action writes an audit row (who/when/tool/args/result/verify result).

---

## 6. Event protocol (shared by agent, API, UI) — `src/events.ts`

All events: `{ id, ts, sessionId, type, ...payload }`. Zod-typed discriminated union. Transport: SSE from `/api/chat`.

| type | payload | UI rendering |
|---|---|---|
| `assistant_text_delta` | `{delta}` | streaming markdown bubble |
| `tool_start` | `{callId, tool, argsSummary (Persian), risk}` | timeline row (spinner) |
| `tool_result` | `{callId, tool, ok, summary (Persian), durationMs, raw? (collapsed)}` | timeline row (✓/✗) |
| `approval_required` | `{approvalId, tool, args, title, why, risk, reversible, costNote?, requiresTypedName?}` | Approval Card (blocks) |
| `approval_resolved` | `{approvalId, approved, by}` | card state |
| `diagnosis` | `Diagnosis` object (see PRD-02) | Diagnosis Card |
| `plan_recommendation` | `PlanRecommendation` (PRD-02) | Plan Card |
| `deploy_progress` | `{stage, status, detail?}` stages: analyze, create, envs, archive, upload, release, build, health | Deploy Timeline |
| `verify_result` | `{action, fixed: boolean, evidence: string[], nextSuggestion?}` | green/red result strip |
| `limitation` | `{message}` | amber notice |
| `alert` | `{appName, severity, title, summary, suggestedPrompt}` | banner (from watcher) |
| `suggestions` | `{chips: string[]}` | clickable chips under the reply |
| `error` | `{message}` | red bubble |
| `done` | `{}` | end of turn |

---

## 7. Conventions

- **Naming:** tools are `snake_case` (`get_app_logs`), files `kebab-case.ts`, types `PascalCase`.
- **Persian copy** lives in `src/agent/prompts/` (system prompts) and `app/i18n/fa.ts` (UI strings). No hard-coded Persian in components.
- **Time:** all timestamps UTC ISO in code; UI shows Tehran time (`Asia/Tehran`) with Persian digits optional.
- **Errors:** `LiaraApiError {status, code?, message, endpoint}`; tools never throw raw fetch errors; they return `{ok:false, error, userMessage(Persian)}`.
- **Logging:** `pino` to stdout at `info`; `debug` includes request/response bodies **with headers redacted**.
- **Config:** `src/config.ts` validates env with Zod and fails fast with a readable message.

### `.env.example`
```
# Liara
LIARA_API_TOKEN=
LIARA_TEAM_ID=
LIARA_API_BASE_URL=https://api.liara.ir

# LLM provider: openai | gemini | openrouter
LLM_PROVIDER=gemini
LLM_FAST_MODEL=            # e.g. gemini-2.5-flash | gpt-4.1-mini | openai/gpt-4.1-mini (openrouter)
LLM_SMART_MODEL=           # e.g. gemini-2.5-pro | gpt-5 | anthropic/claude-sonnet-4.5 (openrouter)
OPENAI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
OPENROUTER_API_KEY=
OPENAI_BASE_URL=           # optional (proxy)

# App
DATABASE_PATH=./data/agent.db
WATCHER_ENABLED=true
WATCHER_INTERVAL_SEC=60
APP_PUBLIC_URL_SUFFIX=.liara.run
AUTO_APPROVE=false         # acceptance scripts only
LOG_LEVEL=info
```

---

## 8. Delivery checklist (what the judges receive)
- GitHub repo (public) with: code, `README.md` (architecture, Liara API connection, limitations, user interaction), `docs/`, `demo-app/`.
- Demo video (~5 min) following `docs/03-ui-demo-readme.md#demo-script`.
- The running UI deployed on Liara itself (nice-to-have; local run is acceptable for the video).
