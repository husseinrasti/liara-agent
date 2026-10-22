# CLAUDE.md — Project rules for `liara-agent`

This file is read by Claude Code at the start of every session. Follow it strictly.
The full specification lives in `docs/`. Read them in order before writing code:

1. `docs/00-overview-architecture.md` — vision, scoring, architecture, repo layout, conventions
2. `docs/01-liara-client-tools-mcp.md` — PRD-01
3. `docs/02-agent-core.md` — PRD-02
4. `docs/03-ui-demo-readme.md` — PRD-03
5. `docs/KICKOFF-PROMPT.md` — how the work is sequenced

## What we are building (one paragraph)

An AI "technical co-worker" for Liara (Iranian PaaS, https://liara.ir) that (a) takes a developer's project and deploys it to Liara with minimal questions, (b) monitors the app, (c) diagnoses incidents (HTTP 500, slowness, crashes, OOM, failed builds) from logs/events/metrics with ranked, evidence-backed causes, (d) proposes fixes, asks for confirmation on risky actions, executes them, and (e) verifies the fix actually worked. Delivered as a Next.js web chat **and** an MCP server over the same tool registry. Hackathon deliverable; judged on Liara integration (100), intelligence/troubleshooting (100), UX (50), reliability/safety (50). Demo video is mandatory.

## Hard rules

- **Language:** code, comments, commit messages, docs → English. **All user-facing text in the UI and in LLM responses → Persian (Farsi)**, simple and non-technical. UI is RTL.
- **Stack is fixed:** TypeScript (strict), Node 22, Next.js 15 (App Router), Vercel AI SDK (`ai` v4+), Zod, better-sqlite3, Tailwind, `@modelcontextprotocol/sdk`, Vitest. Do not add LangChain/LangGraph/CrewAI or any agent framework.
- **Never log, print, echo, or commit secrets.** `LIARA_API_TOKEN` and LLM keys live only in `.env` (gitignored) and are read via `src/config.ts`. Never pass the token into an LLM prompt or tool result. Redact `Authorization` headers in any debug output.
- **Every tool that mutates Liara state carries a `risk` annotation (0/1/2)** in its definition. The policy gate (not the prompt) decides whether confirmation is required. See `docs/00-overview-architecture.md#risk-tiers`.
- **Every mutating tool has a `verify` step.** After executing a fix, the agent waits and re-checks; "fixed" is only claimed after verification passes.
- **When the Liara API cannot provide something, say so explicitly** in the response (a `limitation` event), never fake it. Examples: no edge/HTTP access logs, no git-push deploy via API, no control over IRNIC DNS.
- **Real API shapes beat the OpenAPI spec.** PRD-01 step 0 records real responses into `fixtures/liara/*.json`. If the spec and a fixture disagree, the fixture wins; update types accordingly and note it in `docs/API-NOTES.md`.
- **Structured outputs for anything the UI renders as a card.** Diagnosis, plan recommendation, approval requests are Zod-validated JSON from `generateObject`, never free text parsed by regex.
- **Small, composable modules.** No file over ~400 lines. No God classes.
- **Git:** repo is initialized in PRD-01 step 0 (`git init`, branch `main`). Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Commit at every PRD milestone listed in the PRDs. Never commit `.env`, `data/`, `node_modules/`, `.next/`, `fixtures/liara/*.raw.json` (raw responses may contain IDs/emails — commit only the sanitized versions). GitHub: when asked (see `docs/KICKOFF-PROMPT.md`), create the public repo with `gh`, add the remote, and push `main`; before the first push, verify no secrets exist anywhere in the history.
- **Tests:** each PRD ends with an executable acceptance script (`npm run accept:prd01` etc.). Do not declare a PRD done until it passes. Unit tests with Vitest for pure logic (log analysis, metric summarization, rule engine, policy gate).
- **Do not use** anything from `../agent-liara-old` or any other sibling folder. Build from scratch in this repo.
- **Persian copy quality matters** (it is scored). Use natural, friendly, short sentences. Avoid raw technical jargon; when a technical term is unavoidable, add a 3–6 word plain explanation in parentheses the first time.

## Repo layout (authoritative)

```
liara-agent/
├── CLAUDE.md
├── README.md                      # written in PRD-03 (Persian + English summary)
├── docs/                          # PRDs (this spec) + API-NOTES.md (discovered facts)
├── package.json
├── .env.example
├── src/
│   ├── config.ts                  # env loading + validation (zod)
│   ├── liara/                     # PRD-01: typed Liara API client
│   │   ├── client.ts
│   │   ├── types.ts
│   │   ├── endpoints/*.ts         # apps, deploy, logs, metrics, events, domains, envs, billing, disks
│   │   └── errors.ts
│   ├── tools/                     # PRD-01: tool registry (shared by agent + MCP)
│   │   ├── registry.ts            # defineTool(), risk tiers, listing
│   │   ├── liara/*.ts             # one file per tool group
│   │   ├── local/*.ts             # analyzeProject, buildSourceArchive, httpHealthCheck, searchDocs
│   │   └── composite/collectEvidence.ts
│   ├── mcp/server.ts              # PRD-01: MCP stdio server exposing the registry
│   ├── agent/                     # PRD-02
│   │   ├── providers.ts           # openai | gemini | openrouter switch
│   │   ├── loop.ts                # tool-calling loop + event emitter
│   │   ├── policy.ts              # risk gate, approvals
│   │   ├── prompts/*.ts           # system prompts (Persian), layered
│   │   ├── evidence/*.ts          # log analysis, metric summarization, event normalization
│   │   ├── playbooks/*.yaml       # incident playbooks (data)
│   │   ├── playbooks/engine.ts    # rule engine
│   │   ├── diagnosis.ts           # generateObject → Diagnosis schema
│   │   ├── verify.ts              # act → wait → re-check
│   │   ├── deploy/*.ts            # deploy assistant flow
│   │   ├── domain/*.ts            # domain + IRNIC guidance flow
│   │   ├── watcher.ts             # background monitoring
│   │   └── memory.ts              # per-app memory (sqlite)
│   ├── db/                        # sqlite schema + migrations
│   ├── knowledge/*.md             # curated Liara docs for searchDocs
│   └── events.ts                  # typed event protocol (shared with UI)
├── app/                           # PRD-03: Next.js App Router (UI + API routes)
├── demo-app/                      # PRD-03: chaos demo app deployed to Liara for the video
├── scripts/
│   ├── probe-liara.ts             # PRD-01 step 0
│   └── acceptance/prd01.ts ...
├── fixtures/liara/*.json          # sanitized real API responses
└── data/                          # sqlite db, uploaded source archives (gitignored)
```

## Commands (must exist after PRD-01)

```
npm run dev            # next dev
npm run build
npm run test           # vitest
npm run probe          # scripts/probe-liara.ts → fixtures/
npm run mcp            # start MCP stdio server
npm run accept:prd01 | accept:prd02 | accept:prd03
npm run typecheck
```

## Definition of done for the whole project

- `npm run build` and `npm run typecheck` pass.
- All three acceptance scripts pass against the real Liara account.
- The three demo scenarios in `docs/03-ui-demo-readme.md#demo-script` run end-to-end from the UI.
- README.md covers: architecture, how we connect to Liara APIs, limitations, how the user interacts.
- Git history has clean milestone commits; no secrets.
