# Kickoff prompts for Claude Code

Run Claude Code from the repo root (`~/Code/hackathon/liara-agent`). Use **one session per PRD**, in order. Paste the prompt for the current PRD. Between PRDs, start a fresh session (or `/clear`) so context stays sharp; `CLAUDE.md` and `docs/` carry everything forward.

Before the first prompt: create `.env` from `.env.example` and fill `LIARA_API_TOKEN` and at least one LLM key (`GOOGLE_GENERATIVE_AI_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`) with `LLM_PROVIDER` set accordingly. Claude Code must never see the values; it only reads them via code.

---

## Prompt 1 — PRD-01 (bootstrap, probe, client, tools, MCP)

```
You are implementing a hackathon project from a written spec. Work autonomously and carefully; do not ask me questions unless a decision is truly blocking (a wrong guess that cannot be undone). Prefer making a reasonable decision, recording it in docs/API-NOTES.md, and moving on.

Read, in this order, before writing any code:
1. CLAUDE.md
2. docs/00-overview-architecture.md
3. docs/01-liara-client-tools-mcp.md

Then execute PRD-01 completely, in the order written, including step 0 (git init, bootstrap, and the probe script that records REAL Liara API responses into fixtures/ and docs/API-NOTES.md). A valid LIARA_API_TOKEN is in .env. Never print, log, or commit secrets.

Rules that matter most:
- Real API responses (fixtures) beat the OpenAPI spec. Adjust Zod schemas to what the probe actually returns and document differences in docs/API-NOTES.md.
- Every mutating tool has a risk tier (1 or 2) and a verify() implementation; every read tool is risk 0.
- Results returned to the LLM must be compact (caps in the PRD).
- Write unit tests (Vitest) for pure logic and the acceptance script scripts/acceptance/prd01.ts.
- Commit at each milestone listed in the PRD with conventional commit messages. Do not commit .env, data/, or fixtures/liara/*.raw.json.

Definition of done: `npm run typecheck`, `npm run test`, and `npm run accept:prd01` all pass against the real Liara account, and the milestone commits exist. When done, print: (a) the PASS/FAIL table from the acceptance script, (b) the key facts discovered in docs/API-NOTES.md (time formats, plan catalogue, update-envs semantics, release states, rollback strategy), (c) anything you had to deviate from in the PRD and why.
```

---

## Prompt 2 — PRD-02 (agent core)

```
Continue the project. Read, in this order: CLAUDE.md, docs/00-overview-architecture.md, docs/API-NOTES.md, docs/02-agent-core.md. Skim docs/01-liara-client-tools-mcp.md and the existing src/liara and src/tools code so you build on it rather than duplicating it.

Execute PRD-02 completely, in order: providers → session/events → loop + policy gate → prompts (Persian, carefully written) → playbooks (all 14, as YAML data) + rule engine → structured diagnosis with fallback → verification → deploy assistant + plan recommendation → domain/IRNIC flow + knowledge files → memory → watcher → acceptance script.

Rules that matter most:
- No agent frameworks; the loop is ours on top of the Vercel AI SDK with maxSteps.
- The policy gate is enforced in code: risk ≥ 1 tools suspend the turn with an approval_required event; AUTO_APPROVE=true is only for acceptance scripts.
- Diagnosis is a Zod-validated object from generateObject; confidence must be backed by cited evidence from the packet; never invent evidence.
- Never claim a fix worked before verify_result.
- All user-facing text is natural, simple Persian. All code/comments/commits are English.
- Create the minimal incident fixture apps (fixtures/apps/healthy, leak, crash, missing-env, broken-build) needed by the acceptance script.
- Commit at each PRD milestone.

Definition of done: typecheck, unit tests, and `npm run accept:prd02` pass against the real account with the configured LLM_PROVIDER. When done, print the acceptance table, a sample Diagnosis JSON from the OOM scenario, and any deviations from the PRD with reasons. Restore the demo app to the healthy source before finishing.
```

---

## Prompt 3 — PRD-03 (UI, demo app, README)

```
Continue the project. Read: CLAUDE.md, docs/00-overview-architecture.md (esp. §6 event protocol), docs/03-ui-demo-readme.md, and skim src/agent to understand the event stream, approvals API, and session model.

Execute PRD-03 completely: Next.js App Router UI (RTL, Persian, Vazirmatn self-hosted, Tailwind), SSE API routes, all components (OperationTimeline, ApprovalCard with typed-name for risk 2, DiagnosisCard, PlanCard, DeployProgress, VerifyStrip, LimitationNotice, SuggestionChips, AlertBanner, AppSelector, StatusPanel, Composer), replay on reload, the chaos demo-app with `npm run chaos -- <mode>`, README.md in Persian with the four required sections (architecture, Liara API connection, limitations, user interaction) plus docs/MCP.md, and the acceptance script.

UX rules: the user should never need to read raw JSON (keep it behind "جزئیات"); every risk≥1 action shows an ApprovalCard; every fix shows a VerifyStrip; limitations are visible amber notices; the three demo scenarios in docs/03 §4 must run end-to-end smoothly. Keep the design clean and calm: one accent color, generous spacing, readable at 125% zoom for video.

Definition of done: `npm run build`, `npm run accept:prd03` pass; the manual checklist in docs/03 §5 is satisfied (tell me exactly what to click to verify each scenario). Commit at milestones. Finally print: how to run everything, the demo-day command sequence (including chaos modes), and any known rough edges.
```

---

## Follow-up prompts you will likely need

- **Bug during demo rehearsal:** `Scenario 2 (OOM) failed at step X with this output: <paste>. Diagnose from logs/code, fix root cause (not a patch over the symptom), add a regression test if it is pure logic, re-run npm run accept:prd02, commit.`
- **Persian polish pass:** `Review every Persian string in app/i18n/fa.ts and src/agent/prompts for naturalness, consistency of terms (سرویس/برنامه, انتشار/دیپلوی — pick one each), and brevity. Do not change behavior. Commit as docs/i18n.`
- **Deploy the agent itself to Liara (optional):** `Deploy this Next.js app to Liara as app "liara-agent-ui" (platform next) using our own tools via a script, set env vars from .env except secrets which I will add in the console, and document it in README.`
- **Pre-push secret check (you push manually):** `Verify the git history contains no secrets: run git log -p | grep -iE "token|api_key|secret" and inspect; confirm .env and fixtures/liara/*.raw.json were never committed. Report findings; do not push.`

---

## Order of operations for the 24 hours (author's view)

1. Fill `.env` → Prompt 1 → read the acceptance table + API-NOTES (10 min of your attention).
2. Prompt 2 → while it runs, write the video narration in Persian from `docs/03 §4`.
3. Prompt 3 → rehearse the three scenarios twice → record.
4. Create the GitHub repo yourself, `git remote add origin …`, `git push -u origin main` → add the video link to README → submit.
