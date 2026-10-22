# PRD-02 — Agent core: providers, loop, policy gate, evidence, playbooks, diagnosis, verification, deploy assistant, domain flow, watcher, memory

Depends on: PRD-01 accepted. Read `docs/API-NOTES.md` produced by the probe before starting.
Outcome: a headless agent (`src/agent/`) callable from a Node API with an event stream, passing `npm run accept:prd02` without any UI.

---

## 1. Providers — `src/agent/providers.ts`

```ts
export type ModelTier = 'fast' | 'smart';
export function getModel(tier: ModelTier): LanguageModel   // Vercel AI SDK model
```
- `LLM_PROVIDER=openai` → `createOpenAI({ apiKey, baseURL? })(modelId)`
- `LLM_PROVIDER=gemini` → `createGoogleGenerativeAI({ apiKey })(modelId)`
- `LLM_PROVIDER=openrouter` → `createOpenRouter({ apiKey })(modelId)` (`@openrouter/ai-sdk-provider`)
- Model ids from `LLM_FAST_MODEL` / `LLM_SMART_MODEL`; defaults per provider if empty:
  - openai: fast `gpt-4.1-mini`, smart `gpt-4.1` (use `gpt-5` if available/accepted)
  - gemini: fast `gemini-2.5-flash`, smart `gemini-2.5-pro`
  - openrouter: fast `google/gemini-2.5-flash`, smart `anthropic/claude-sonnet-4.5`
- Expose `llmHealthCheck()` (one tiny `generateText`) used by `/api/health` and the acceptance script.
- Structured output: use `generateObject` with Zod schema. Gemini and some OpenRouter models are flaky with strict JSON schema → wrap in `safeGenerateObject()` that retries once with `mode: 'json'` and, on a second failure, falls back to `generateText` + `JSON.parse` of the first `{...}` block + Zod parse. Log which path was taken.

**Commit:** `feat(agent): provider switch (openai/gemini/openrouter) with structured-output fallback`

---

## 2. Event emitter & session — `src/agent/session.ts`
- `AgentSession { id, appName?, emit(event), history: CoreMessage[] }` persisted in `sessions`/`messages`/`events` tables.
- `emit()` validates against `src/events.ts` union, stores, and forwards to the SSE subscriber (PRD-03) via an in-process `EventEmitter` keyed by session id.
- History compaction: keep the last 20 messages verbatim; older ones summarized by the fast model into one `system` note ("Summary of earlier conversation…") when total tokens (estimated by chars/3.5) exceed 24k.

---

## 3. The loop — `src/agent/loop.ts`

```ts
export async function runTurn(session, userText, opts?): Promise<void>
```
1. Build messages: `[system(layered prompt), ...history, user(userText)]`.
2. `streamText({ model: getModel('fast'), tools: toAiSdkTools(ctx, {policy}), maxSteps: 10, temperature: 0.2 })`.
3. Stream text deltas → `assistant_text_delta`. Tool calls → `tool_start`; tool results → `tool_result` (with `raw` dropped from model context: the loop replaces large results with the compact form before passing back to the model; keep ≤ 2k tokens per tool result).
4. **Policy interception** (see §4) happens inside the `execute` wrapper of each tool.
5. **Special tools** the loop treats specially:
   - `diagnose_app` (defined here, risk 0): runs `collect_evidence` → rule engine → `diagnosis.ts` (smart model) → emits `diagnosis` event → returns the Diagnosis JSON to the model so it can narrate it in Persian and propose the first action.
   - `recommend_plan` (risk 0): deploy assistant helper → emits `plan_recommendation`.
   - `propose_fix` isn't a tool: the model just calls the mutating tool; policy turns it into an approval.
6. After the final text: run `suggestChips(lastAssistantText, context)` with the fast model (≤ 4 chips, Persian, each ≤ 6 words, actionable) → `suggestions` event. Then `done`.
7. Error handling: any throw → `error` event with a Persian message + `done`. Never leave a session without `done`.
8. Step budget: if `maxSteps` hit, the assistant says so in Persian and suggests continuing.

**Verification integration:** when a mutating tool completes OK, the loop schedules `verify` (see §7) and the model is told (in the tool result) "verification pending; wait for verify_result before claiming success". The verify result is emitted as `verify_result` and appended as a tool message so the model can summarize it.

---

## 4. Policy gate — `src/agent/policy.ts`

```ts
export function wrapWithPolicy(tool: ToolDef, ctx): { execute(input): Promise<ToolResult> }
```
- `risk 0` → run immediately.
- `risk ≥ 1`:
  1. Compute `consequencesFa` (may call the API for cost/plan details).
  2. Insert `approvals(status='pending')`; emit `approval_required` with `requiresTypedName = risk===2`.
  3. **Suspend the turn**: return a tool result `{ok:false, pendingApproval:true, approvalId, userMessageFa:'منتظر تأیید شما هستم'}`; the loop then lets the model finish its text (it is instructed to stop and ask), emits `done`.
  4. On `/api/approve {approvalId, approved, typedName?}`: validate (typed name must equal appName for risk 2; approvals expire after 15 min), emit `approval_resolved`, then **start a new turn** `runApprovedAction(session, approvalId)` which executes the tool directly (bypassing the model), emits `tool_start/result`, schedules verification, and then calls the model with a synthetic user message `"[system] Action <tool> executed: <summary>. Verification: <pending|result>. Summarize for the user in Persian and suggest next step."` so the narration stays natural.
- `AUTO_APPROVE=true` → treat as approved immediately (acceptance only).
- Every executed risk≥1 action → `audit` row.
- Unit tests: risk 0 passes through; risk 1 creates pending approval and suspends; risk 2 rejects wrong typed name; expiry.

**Commit:** `feat(agent): tool-calling loop with policy gate and approvals`

---

## 5. Prompts — `src/agent/prompts/`

Layered system prompt, assembled per turn by `buildSystemPrompt(ctx)`:

1. `role.ts` — identity: *"You are «همکار فنی لیارا», an SRE/DevOps co-worker for a developer who knows little about infrastructure. Speak Persian, warm, short sentences, no jargon without a 3–6 word plain explanation. Never invent data; cite evidence from tools. If something is not available via Liara's API, say so explicitly (and call it out as a limitation)."*
2. `policy.ts` — the risk tiers in words: "Reads are automatic. Before any change (restart, deploy, env, plan, domain) you call the tool and the system will ask the user; you then stop and wait. Never claim a fix worked before `verify_result`."
3. `liara-knowledge.ts` — compact facts: platforms & default ports, what a plan is, `liara.json` keys, `*.liara.run` URL, how domains/CNAME/SSL work, IRNIC steps summary, common failure reasons (from playbooks index), what logs/events/metrics mean. Keep ≤ 1200 tokens; details are fetched via `search_docs`.
4. `format.ts` — response style: lead with the answer/status; use at most 3 bullets; numbers with units; when presenting a diagnosis, mention the top cause with confidence in words (خیلی محتمل / محتمل / کم‌احتمال), the evidence in one line each, and **one** recommended action; offer alternatives only if asked or if the top action is risk 2.
5. `context.ts` — dynamic: current app (if selected) summary from `get_app` (cached 60s), app memory (§10), active alerts, current Tehran time.

Also `prompts/diagnosis.ts` (used by `generateObject`, see §6.3) and `prompts/plan.ts` (§8.3).

Write all Persian copy carefully; it is scored. Keep a `prompts/__tests__/snapshot.test.ts` that renders the system prompt and asserts token budget ≤ 3500.

---

## 6. Intelligence: evidence → rule engine → LLM diagnosis

### 6.1 Playbooks as data — `src/agent/playbooks/*.yaml`
Schema (`playbooks/schema.ts`, Zod):
```yaml
id: oom_kill
title_fa: "پر شدن حافظه (RAM)"
category: resources           # resources | crash | build | config | network | domain | account | performance
signals:                      # any matching signal adds `weight` to this playbook's score
  - { kind: event_reason, match: "OOMKilled", weight: 0.6 }
  - { kind: metric, field: memory.pctOfLimit, op: ">=", value: 90, weight: 0.3 }
  - { kind: applet_reason, match: "OOMKilled|CrashLoopBackOff", weight: 0.3 }
  - { kind: log_regex, match: "JavaScript heap out of memory|MemoryError|Killed process", weight: 0.4 }
  - { kind: health, status_in: [502, 503, 504, 0], weight: 0.1 }
causes_fa:
  - "برنامه بیشتر از حافظه‌ی پلن مصرف می‌کند (نشت حافظه یا ترافیک بالا)"
  - "پلن انتخاب‌شده برای این برنامه کوچک است"
checks_fa:                    # what evidence the LLM should cite
  - "رویداد OOMKilled در ساعت‌های اخیر"
  - "نمودار RAM نزدیک سقف پلن"
fixes:
  - { id: rollback_if_recent_deploy, when: "app.lastDeployAgeMinutes < 180", tool: rollback_release, args_template: { appName: "{{app.name}}" }, title_fa: "برگشت به نسخه‌ی قبلی", why_fa: "مشکل بعد از آخرین دیپلوی شروع شده؛ نسخه‌ی قبلی سالم بود", priority: 1 }
  - { id: restart, tool: restart_app, args_template: { appName: "{{app.name}}" }, title_fa: "ری‌استارت برنامه", why_fa: "حافظه آزاد می‌شود؛ راه‌حل موقت", priority: 2 }
  - { id: upgrade_plan, tool: resize_app, args_template: { appName: "{{app.name}}", planID: "{{plan.nextUp}}" }, title_fa: "ارتقای پلن به {{plan.nextUpLabel}}", why_fa: "اگر مصرف واقعی بالاست، حافظه بیشتر لازم است", priority: 3 }
verify:
  - { kind: no_event, match: "OOMKilled", withinMinutes: 5 }
  - { kind: health, status: 200 }
  - { kind: metric, field: memory.pctOfLimit, op: "<", value: 85 }
advice_fa: "اگر بعد از ری‌استارت دوباره تکرار شد، احتمالاً نشت حافظه در کد است؛ بخش‌هایی که داده را در حافظه نگه می‌دارند (کش، آرایه‌های بزرگ) را بررسی کنید."
```
Write these playbooks (all with real signals from fixtures/API-NOTES):
1. `oom_kill` (above)
2. `crash_loop` — applet `CrashLoopBackOff`/`BackOff` events, logs with stack trace near start, exit codes; fixes: rollback if recent deploy, show stack trace + advice, restart (low priority)
3. `build_failed` — latest release `FAILED`; signals from build log regex (`npm ERR!`, `ModuleNotFoundError`, `pip install` errors, `Dockerfile` errors, `ENOSPC`); fixes: none automatic — produce a precise explanation + the exact failing line; suggest `search_docs` platform requirements; offer rollback to last READY
4. `port_mismatch` — release READY but health 502/timeout, logs show server listening on a different port than release `port`; fix: `deploy_release` with corrected port (risk 1) or advise `liara.json`
5. `missing_env` — logs match `undefined|is not defined|Missing .* env|KeyError: '([A-Z_]+)'|Environment variable .* not set|ECONNREFUSED .*(localhost|127.0.0.1)` → extract key names; fix: `update_envs` with keys the user supplies (agent asks for values; never guesses secrets)
6. `app_stopped` — `scale === 0` or status stopped; fix: `scale_app on` (risk 2 → confirm)
7. `insufficient_balance` — account `lowBalance` / status like `frozen|suspended` / 402 from API; fix: none — tell user to top up (limitation + exact amount if known)
8. `db_unreachable` — logs `ECONNREFUSED|ETIMEDOUT|Connection refused|could not connect to server|MongoNetworkError|Authentication failed` with db-ish hostnames; fixes: check env for DB URL, advise checking DBaaS status; (stretch: `get_database` tool)
9. `disk_full` — disks pct ≥ 90 or logs `ENOSPC|No space left`; fix: `resize_disk` (risk 2) / cleanup advice
10. `cpu_saturation_slow` — cpu.max ≥ 90% sustained and latency high but health 200; fixes: `resize_app` (risk 2), advice on caching
11. `high_latency_unknown` — health slow (> 2000ms) without resource signals; investigate: recent deploy? external dependency? advice + offer to watch
12. `domain_not_verified` — domain status not verified / certificatesStatus pending; fix: show exact CNAME record + IRNIC steps (`search_docs`), poll `check_domain`
13. `recent_deploy_regression` — generic: errors started within N minutes after `currentRelease.createdAt` → rollback first
14. `healthy` — no signals: say so, show key numbers, offer to enable watching

### 6.2 Rule engine — `src/agent/playbooks/engine.ts`
```ts
export function evaluate(packet: EvidencePacket): { signals: Signal[]; candidates: Candidate[] }
// Signal = { kind, detail, weight, source: 'events'|'logs'|'metrics'|'applets'|'health'|'release'|'account', ts? }
// Candidate = { playbookId, score (0..1, sum of matched weights capped), matchedSignals: Signal[], fixes: ResolvedFix[] }
```
- `args_template` rendered with a tiny `{{path}}` replacer against `{app, plan, packet}`; `plan.nextUp` computed from the plan catalogue (next larger RAM).
- `when` expressions: support `<, <=, >, >=, ==, !=, &&, ||` over packet paths — implement a tiny safe evaluator (no `eval`).
- Sort candidates by score; keep top 3. Attach `signals` to the packet.
- Unit tests with synthetic packets for each playbook (at least OOM, crash loop, build failed, missing env, healthy).

### 6.3 LLM diagnosis — `src/agent/diagnosis.ts`
```ts
export const DiagnosisSchema = z.object({
  summaryFa: z.string(),                       // one sentence, plain Persian
  severity: z.enum(['critical','degraded','warning','healthy']),
  causes: z.array(z.object({
    title_fa: z.string(),
    playbookId: z.string().optional(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.object({ source: z.enum(['events','logs','metrics','applets','health','release','account','domain']), text_fa: z.string(), raw: z.string().optional() })).min(1),
    explanation_fa: z.string()                 // 1–3 sentences, why this evidence implies this cause
  })).min(1).max(4),
  recommendedAction: z.object({
    tool: z.string(), args: z.record(z.any()), title_fa: z.string(), why_fa: z.string(), risk: z.number().int().min(0).max(2), reversible: z.boolean()
  }).nullable(),
  alternatives: z.array(/* same shape as recommendedAction */).max(3),
  manualStepsFa: z.array(z.string()).max(5),  // things only the user can do (code fix, top up, IRNIC)
  limitationsFa: z.array(z.string()),
  followUpQuestionsFa: z.array(z.string()).max(2)
});
```
Prompt (`prompts/diagnosis.ts`): system = role + "You are given an evidence packet and rule-engine candidates. Rank causes; confidence must be justified by cited evidence; prefer reversible low-risk actions first unless evidence is strong; never invent evidence; if a recent deploy correlates with the problem, rollback ranks above restart; if nothing is wrong, severity=healthy". User = JSON of `{packet (trimmed), candidates, playbooksIndex (id,title,causes,fixes)}`.
Model: `smart`. Post-process: ensure `recommendedAction.tool` exists in registry and args validate against its input schema (else move to `manualStepsFa`); clamp confidence; if rule engine top score ≥ 0.8 and LLM disagrees, keep LLM order but add the rule candidate if missing (log it).
Fallback (LLM failure): build a Diagnosis directly from rule-engine candidates (template Persian text).

`diagnose_app` tool (risk 0) = collect → evaluate → diagnose → emit `diagnosis` → store in `app_memory.lastDiagnosis` → return.

**Commit:** `feat(agent): playbooks, rule engine, structured LLM diagnosis`

---

## 7. Verification — `src/agent/verify.ts`
```ts
export async function verifyAction(session, tool, input, snapshotBefore, playbookVerify?): Promise<VerifyResult>
```
- Wait: `restart_app` 20s, `deploy_release/rollback` until release READY + 15s, `update_envs` 20s, `resize_app` 45s, `scale_app` 20s, `enable_ssl` poll up to 120s.
- Run the tool's own `verify` **and** the playbook `verify` checks (if the action came from a diagnosis). Combine: `fixed = all critical checks pass`; collect `evidence: string[]` in Persian (e.g. "وضعیت سایت: 200 (۲۱۰ms)", "رویداد OOMKilled در ۵ دقیقه‌ی اخیر: ۰").
- If not fixed: `nextSuggestion` = next fix in the playbook priority list (or "collect evidence again").
- Emit `verify_result`; write to `audit`; store `app_memory.lastActions[]` (tool, ts, fixed).
- Also schedule a **second check** at +3 min for restart-type fixes (OOM often recurs): if the problem returns, emit an `alert` ("مشکل دوباره برگشت؛ ری‌استارت کافی نبود") with a suggested prompt.

**Commit:** `feat(agent): act→wait→verify loop with follow-up re-check`

---

## 8. Deploy Assistant — `src/agent/deploy/`

### 8.1 Flow (tools orchestrated by the model, but with a deterministic helper `deployWizard` to keep it on rails)
User says things like "این پروژه رو دیپلوی کن: /path" or pastes a git URL, or "می‌خوام سایتم رو بالا بیارم".
1. `analyze_project(path)` → show a short Persian summary ("پروژه‌ی Next.js، پورت ۳۰۰۰، ۳ متغیر محیطی لازم دارد: …"). If platform `unknown` or confidence < 0.6 → ask one question with choices.
2. `recommend_plan({analysis})` (risk 0) → `PlanRecommendation` (see 8.3) → emit `plan_recommendation` → the model states the recommendation + monthly cost in one line and asks "ادامه بدم؟".
3. `get_account` → if `balanceIRT` known and `< 24h × hourlyPrice` → **limitation + manual step**: "موجودی حساب کافی نیست؛ لطفاً از پنل لیارا شارژ کنید، بعد بگویید ادامه بدهم." (This is the only step the user must do alone — say that explicitly.)
4. Env vars: for each `envKeys.required` ask the user for values **in one message** (list them); secrets are entered by the user; the agent never invents. Offer sensible non-secret defaults (`NODE_ENV=production`, `PORT` is set by Liara — explain that).
5. `create_app` (risk 1, approval) → `update_envs` (bundle into the same approval text if possible: the approval card lists "create app + set N env vars") → `build_source_archive` → `upload_source` → `deploy_release(waitForReady)` with `deploy_progress` events for each stage → verify (release READY, applets Running, health 200) → show URL `https://<name>.liara.run` + 3 quick next steps as chips ("دامنه‌ی خودم را وصل کن", "پایش را فعال کن", "لاگ‌ها را نشان بده").
6. If build fails: automatically run `diagnose_app` with `buildLog` focus → explain the failing line in Persian → propose fix (often a code/config change the user must do, or a `liara.json` tweak the agent can write locally and redeploy).
7. Write `liara.json` into the project if missing (`{app, port, platform, ...}`) — local file write is risk 0 but tell the user.

### 8.2 Name suggestion
Derive from folder/package name: lowercase, `[a-z0-9-]`, ≤ 30 chars, append `-<2 random chars>` if `create_app` returns 409.

### 8.3 Plan recommendation — `deploy/plan.ts`
```ts
PlanRecommendation = { planID, label, ramMB, cpu, diskGB, hourlyPriceIRT, monthlyEstimateIRT, reasonsFa: string[], alternatives: [{planID,label,monthlyEstimateIRT,whenFa}] }
```
Heuristic (deterministic; LLM only phrases it):
- Base by platform: static/react/vue/angular → smallest plan; node/next/laravel/django/flask/go/dotnet → smallest plan with ≥ 1 GB RAM (next/laravel prefer ≥ 1 GB; `next` with `output: standalone` can use 512 MB); docker → ≥ 1 GB.
- Bump one step if: `needsDatabase` in-process (sqlite) + uploads, or `sizeMB > 200`, or deps include `puppeteer|playwright|sharp|tensorflow|torch`.
- Use the real catalogue from `get_account.plansAvailable` (ids/prices from API-NOTES). Never hardcode plan ids except as fallback labels.
- Always explain in ≤ 3 Persian bullets and give the next-cheaper alternative "if traffic is low".

### 8.4 Git URL support
`analyze_project` accepts `https://github.com/...` (public) → clone depth 1 to `data/clones/`. Private repos: limitation message (ask the user to provide a local path or a token-embedded URL — do not store it).

**Commit:** `feat(agent): deploy assistant with plan recommendation and progress events`

---

## 9. Domain flow — `src/agent/domain/`
1. User: "دامنه‌ی example.ir رو وصل کن".
2. `add_domain(appName, domain)` (risk 1) → response includes `CNameRecord` (or A record/IP if that's what Liara returns — handle both per fixture).
3. Reply with a **step card** (`manualStepsFa`) specific to the registrar: if domain ends with `.ir` → IRNIC steps from `src/knowledge/irnic.md` (login to irnic.ir → domain → DNS/nameserver settings → if using Liara DNS: set NS to Liara's; else at the current DNS host add `CNAME www → <CNameRecord>` and for the apex use Liara's recommended method (ALIAS/ANAME or A record per docs); TTL note; propagation 5 min–24 h). For other TLDs → generic registrar steps.
4. Offer "وقتی تنظیم کردی بگو تا بررسی کنم" and also **auto-poll** `check_domain` every 60s for up to 30 min (via the watcher) → when verified: `enable_ssl` (risk 1 approval, or bundle "فعال‌سازی SSL" into the original approval) → `verify` SSL → final message with https URL.
5. Limitation to state: "من نمی‌توانم داخل پنل ایرنیک/DNS شما تغییری بدهم؛ فقط می‌توانم بررسی کنم که درست انجام شده."

Knowledge files to write in `src/knowledge/`: `platforms.md` (each platform: requirements, default port, build notes, liara.json keys, common errors), `plans.md` (generated from API-NOTES), `domains.md`, `irnic.md`, `liara-json.md`, `envs.md`, `common-errors.md`, `limits.md`. Source: Liara docs (docs.liara.ir) — write concise, accurate summaries; cite URLs at the bottom of each file.

**Commit:** `feat(agent): domain + IRNIC guidance flow and knowledge base`

---

## 10. Memory — `src/agent/memory.ts`
Per app in `app_memory`: `lastDiagnosis` (summary + top cause + ts), `lastActions[]` (≤ 10), `baseline` (7-day rolling: avg cpu, avg memMB, p50 latency from `metric_snapshots`), `userNotes` (free text the user asked to remember, e.g. "این اپ شب‌ها ترافیک بالا دارد"), `watch: boolean`.
Injected into the system prompt (§5 item 5) as ≤ 300 tokens. Used by diagnosis ("same OOM as 2 hours ago after restart → recommend plan upgrade, not another restart").

---

## 11. Watcher — `src/agent/watcher.ts`
- Started with the Next.js server (instrumentation hook) if `WATCHER_ENABLED`. Interval `WATCHER_INTERVAL_SEC` (default 60).
- For every app with `app_memory.watch = true` (default true for apps the agent deployed; user can toggle): run cheap checks: `http_health_check` (1 sample), `get_app_metrics(15m)`, `get_app_events(10m)`, `get_app_applets`. Store `metric_snapshots`.
- Alert rules (dedupe per app+rule for 30 min; severity): health status ≠ 200 for 2 consecutive checks (critical); latency > 3× baseline p50 and > 1500ms for 3 checks (warning); memory pct ≥ 90 for 3 checks (warning); any `OOMKilled|BackOff` event (critical); app `scale=0` unexpectedly (critical); domain check pending > 30 min (info); low balance (warning).
- On alert: insert `alerts` row, emit `alert` to all open sessions for that app, with `suggestedPrompt` ("سایت my-shop از دقیقه‌ی ۱۴:۲۰ پاسخ نمی‌دهد — بررسی کن"). **No automatic fixes** from the watcher (safety); it only diagnoses if the user clicks.
- Optional: if `WATCHER_AUTO_DIAGNOSE=true`, run `diagnose_app` on critical alerts and attach the diagnosis to the alert (nice for the demo).

**Commit:** `feat(agent): background watcher with proactive alerts`

---

## 12. Acceptance — `scripts/acceptance/prd02.ts` (`npm run accept:prd02`)
Headless, `AUTO_APPROVE=true`, uses `DEMO_APP_NAME` and the chaos demo app from PRD-03 **if present**; otherwise it uses the probe app and simulates incidents by deploying tiny variants (`fixtures/apps/leak`, `fixtures/apps/crash`, `fixtures/apps/missing-env` — create these minimal Node apps here: leak = allocate 50MB/sec arrays; crash = `throw` on startup after 2s; missing-env = require `process.env.API_KEY` else exit 1).
1. LLM health check OK for the configured provider.
2. `runTurn("وضعیت اپ <name> چطوره؟")` → gets `tool_start(get_app)` … `done`; the assistant text is Persian and mentions the plan.
3. Deploy `leak` variant → wait until an `OOMKilled` event or memory ≥ 90% (≤ 6 min) → `runTurn("سایتم کند شده و گاهی ۵۰۰ می‌ده")` → a `diagnosis` event with top cause playbookId `oom_kill` (confidence ≥ 0.6) and `recommendedAction` ∈ {rollback_release, restart_app, resize_app}.
4. Approve path: with AUTO_APPROVE the recommended action runs → `verify_result` emitted; assert `fixed === true` when action is rollback (to the healthy probe source) — rollback must restore health 200.
5. Deploy `missing-env` variant → `runTurn("چرا سایتم بالا نمیاد؟")` → diagnosis top cause `missing_env`, `manualStepsFa` or `recommendedAction.tool === 'update_envs'` with the extracted key `API_KEY`.
6. Build failure: deploy a variant with a broken `package.json` (invalid JSON) → `runTurn("دیپلوی کردم ولی خطا می‌ده")` → diagnosis `build_failed` with the failing line quoted in evidence.
7. Deploy assistant: `runTurn("این پروژه رو دیپلوی کن: fixtures/apps/healthy")` → events `plan_recommendation`, `deploy_progress` for all stages, final text contains `.liara.run`, health 200.
8. Watcher: enable watch; break the app (leak) → within 3 intervals an `alert` row exists with severity critical.
9. Policy: with `AUTO_APPROVE=false`, `runTurn("ری‌استارت کن")` emits `approval_required` and no `restart_app` audit row; then `approve()` → audit row + `verify_result`.
10. Unit tests + typecheck pass.

Print PASS/FAIL table; exit non-zero on failure. Restore the demo app to the healthy source at the end.

**Commit:** `test(prd02): headless agent acceptance (diagnosis, verify, deploy, watcher, policy)`

---

## 13. Deliverables checklist for PRD-02
- [ ] providers + structured-output fallback
- [ ] session/events persistence + history compaction
- [ ] loop with policy gate, approvals API-ready (`approve(approvalId, …)` function), suggestion chips
- [ ] layered Persian prompts within token budget
- [ ] 14 playbooks + rule engine + tests
- [ ] diagnosis (structured) + fallback
- [ ] verification with follow-up re-check
- [ ] deploy assistant + plan recommendation + liara.json writer
- [ ] domain/IRNIC flow + knowledge base files
- [ ] memory + watcher + alerts
- [ ] `npm run accept:prd02` passes; milestone commits present
