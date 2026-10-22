# PRD-03 — Chat UI, SSE API, approval UX, chaos demo app, README, demo script

Depends on: PRD-02 accepted.
Outcome: the product the judges see. UX is scored (50) and the video is mandatory, so polish the three demo scenarios end-to-end before anything else.

---

## 1. Next.js app — `app/`

### 1.1 Routes
| Route | Purpose |
|---|---|
| `/` | Chat workspace (single page): left/top app selector, main chat, right/bottom "وضعیت" panel |
| `/api/chat` | `POST {sessionId?, appName?, text}` → SSE stream of events (PRD-00 §6). Creates a session if missing. |
| `/api/approve` | `POST {approvalId, approved, typedName?}` → starts the approved-action turn; returns `{ok}`; events arrive on the session stream |
| `/api/events?sessionId=` | SSE subscription for a session (used after reloads, and for watcher alerts) |
| `/api/apps` | `GET` list apps (cached 30s) |
| `/api/apps/[name]/status` | `GET` compact status: health, plan, memory pct, last release, active alerts (for the side panel; polls every 30s) |
| `/api/alerts` | `GET` unacknowledged alerts; `POST {id}` acknowledge |
| `/api/health` | `GET` `{liara: ok, llm: ok, provider, watcher}` |

Server-side: a singleton `getAgentRuntime()` (in `src/runtime.ts`) holding the `LiaraClient`, db, registry, watcher, and the session event bus. Use `instrumentation.ts` to start the watcher once.

### 1.2 Look & feel (keep it simple, but intentional)
- RTL, Persian font **Vazirmatn** (self-host in `public/fonts`, no external CDN dependency at demo time).
- Light theme, one accent color (Liara-ish blue `#2563eb`), green/amber/red for status. Rounded cards, generous spacing, no clutter.
- Tailwind only; no component library needed. Mobile layout acceptable but desktop is the target (video).
- Persian digits optional (keep Latin digits inside code/URLs).
- Strings in `app/i18n/fa.ts`.

### 1.3 Chat components (`app/components/`)
- `ChatThread` — bubbles; assistant bubble renders markdown (use `react-markdown` + `remark-gfm`; sanitize) and inline cards in order of events.
- `OperationTimeline` — vertical list of tool calls for the current turn: icon + Persian `describeFa` + state (spinner / ✓ / ✗ / ⏸ waiting approval) + duration; collapsible "جزئیات" shows the compact JSON result. Group `collect_evidence` sub-calls under one row.
- `ApprovalCard` — title, what will happen, why (from `consequencesFa`), **risk badge** (کم‌ریسک / نیازمند تأیید / پرریسک), reversible yes/no, cost note; buttons «تأیید و اجرا» / «نه، فعلاً». For risk 2: text input "برای تأیید نام سرویس را بنویس: `my-app`"; button disabled until it matches. After resolution the card becomes a compact receipt (approved/rejected, by whom, time).
- `DiagnosisCard` — severity strip; one-line summary; causes list ranked with confidence shown as words + a small bar; each cause expandable to show evidence rows (source chip: لاگ / رویداد / متریک / سلامت / انتشار); **Recommended action** button (triggers the tool via a chat message like "اقدام پیشنهادی را اجرا کن" — the agent then calls the tool → approval); "گزینه‌های دیگر" expander; "کارهایی که فقط شما می‌توانید انجام دهید" list; limitations in amber.
- `PlanCard` — recommended plan with RAM/CPU/disk, monthly estimate (ریال/تومان — use تومان, format with thousands separators), reasons, alternative; button «با همین پلن ادامه بده».
- `DeployProgress` — stepper: تحلیل پروژه → ساخت سرویس → تنظیم متغیرها → بسته‌بندی → آپلود → انتشار → بیلد → بررسی سلامت; each with state + detail line; final step shows the URL as a big link with a copy button.
- `VerifyStrip` — green "تأیید شد: مشکل حل شد" or red "حل نشد" with evidence bullets and a "قدم بعدی" button.
- `LimitationNotice` — amber inline notice with ℹ️.
- `SuggestionChips` — up to 4 chips under the last assistant message; click = send as user message.
- `AlertBanner` — top of chat when the watcher raises an alert for the selected app: severity color, title, "بررسی کن" (sends `suggestedPrompt`), "باشه" (acknowledge).
- `AppSelector` — dropdown/list of apps with a status dot (green/amber/red from `/status`), "+ دیپلوی پروژه‌ی جدید" item which seeds the chat with a prompt asking for the path/URL.
- `StatusPanel` — for the selected app: health (status + latency), plan, RAM pct bar, CPU, last release (tag + age), domain state, watch toggle ("پایش خودکار"), last 3 actions from audit. Polls `/status`.
- `Composer` — textarea, send on Enter (Shift+Enter newline), disabled while a turn streams; small "در حال بررسی…" indicator from events.

### 1.4 Event handling on the client
- `useSessionStream(sessionId)` opens `EventSource('/api/events?sessionId=')`; `/api/chat` also streams the same events for the current turn (either is fine — pick one path and make it robust: recommended = POST to `/api/chat` returning `text/event-stream`, plus the persistent `/api/events` only for alerts/approval resolution).
- Events reduce into a `turn` model: `{ textParts[], timeline[], cards[] }` in the order received. Cards (`approval_required`, `diagnosis`, `plan_recommendation`, `verify_result`, `deploy_progress`) are rendered inline at their position in the stream.
- On reload: fetch last 50 events of the session from the db (`/api/events?sessionId&replay=1`) to re-render.

### 1.5 Empty state / onboarding
First visit: a short welcome card in Persian: what the assistant can do (3 bullets) + two primary chips: «پروژه‌ام را دیپلوی کن» and «وضعیت سرویس‌هایم را بررسی کن». If no apps exist, only the first.

**Commit:** `feat(ui): chat workspace with timeline, approval, diagnosis, deploy cards` (split into 2–3 commits as you go)

---

## 2. Chaos demo app — `demo-app/`
A tiny Node (Express or plain `http`) app deployed to Liara as the subject of the demo. Behaviour controlled by env `CHAOS_MODE`:
| CHAOS_MODE | Behaviour |
|---|---|
| `none` (default) | `/` returns a small HTML page "فروشگاه نمونه" with the current time; `/health` → 200 JSON; `/api/products` → JSON list |
| `leak` | every second allocate and retain ~20 MB (`Buffer.alloc`) → OOM within ~1–2 min on a 512 MB plan; requests still served until then; logs `memory usage: X MB` every 5s |
| `crash` | after 3s `throw new Error("Unhandled: cannot read properties of undefined (reading 'id')")` → CrashLoopBackOff |
| `slow` | each request `setTimeout` 2500–4000 ms + CPU busy loop 300 ms (so CPU rises) |
| `missing-env` | on request handler: `if (!process.env.PAYMENT_API_KEY) { console.error("Error: PAYMENT_API_KEY is not set"); res.status(500)...}` → 500s with clear log lines |
| `error500` | `/` throws inside handler → 500 with a stack trace in logs |

Also: `package.json` with `start`, `liara.json` `{app, port: 3000, platform: "node"}`, listens on `process.env.PORT || 3000`, logs one line per request (`GET / 200 12ms`).
Switching modes during the demo = `update_envs` (which restarts the app) — the agent can do that too ("حالت آزمایشی را روی leak بذار" — but in the video, trigger it from the Liara console or a second chat to keep the story clean).

Add `scripts/chaos.ts` → `npm run chaos -- <mode>` which calls `update_envs` directly (no LLM) for quick switching while recording.

**Commit:** `feat(demo-app): chaos demo app with switchable failure modes`

---

## 3. README.md (required by the challenge: architecture, Liara API connection, limitations, user interaction)
Write in **Persian** with an English TL;DR at the top. Sections:
1. چی ساختیم (۳ خط) + لینک ویدیو دمو + اسکرین‌شات کارت تشخیص
2. معماری (the ASCII diagram from 00 + 8 lines of explanation: tool registry, policy gate, evidence packet, playbooks, verify loop, watcher, MCP)
3. اتصال به APIهای لیارا — table of endpoints used (from 00 §4) + auth + how we discovered real shapes (probe + fixtures) + link to `docs/API-NOTES.md`
4. نحوه‌ی تعامل کاربر — screenshots/gifs: chat, approval card, diagnosis card, deploy progress; the three risk tiers in a table; MCP usage in Claude Desktop/Cursor (`docs/MCP.md`)
5. محدودیت‌ها — the list from 00 §4 + anything found in API-NOTES
6. اجرا — `.env`, `npm i`, `npm run dev`, `npm run mcp`, `npm run chaos -- leak`
7. سناریوهای دمو (link to §4 below)
8. ساختار پوشه‌ها + تست‌ها

Also `docs/MCP.md` (from PRD-01) and keep `docs/API-NOTES.md` current.

**Commit:** `docs: README with architecture, Liara API integration, limitations, UX`

---

## 4. Demo script (~5 minutes) {#demo-script}
Record at 1080p, desktop, browser zoom 110–125% so text is readable. Narrate in Persian. Preparation: demo app deployed and healthy as `DEMO_APP_NAME`; a second, **undeployed** copy of `demo-app` in a folder named `my-shop` for scenario 1; watcher on; chaos mode `none`.

| t | Scene | What to show / say |
|---|---|---|
| 0:00–0:35 | Intro | "من یک برنامه‌نویسم و می‌خوام سایتم روی لیارا بالا بیاد ولی دواپس بلد نیستم." Show the empty chat with the two chips. One sentence on the architecture (agent + MCP over Liara's official API). |
| 0:35–2:00 | **Scenario 1 — first deploy** | Type: «این پروژه رو دیپلوی کن: ~/my-shop». Show analysis summary → PlanCard (reason + cost) → balance check line → env question (type `PAYMENT_API_KEY=demo`) → ApprovalCard for create+envs → approve → DeployProgress stepper live → URL → open the site in a new tab. Then: «دامنه‌ی myshop.ir رو وصل کن» → ApprovalCard → CNAME + IRNIC steps card + "خودم هر دقیقه چک می‌کنم" (limitation: can't touch IRNIC). Don't wait for DNS; move on. |
| 2:00–3:50 | **Scenario 2 — incident** | Beforehand (cut or a quick second tab): `npm run chaos -- leak`. Wait ~90s off-camera. In chat: «سایتم کند شده و گاهی ۵۰۰ می‌ده». Show the timeline collecting evidence (events/logs/metrics/health), then the DiagnosisCard: top cause "پر شدن حافظه" with evidence rows (OOMKilled ×N, RAM 96%, log lines). Recommended: rollback to previous version (because it started right after the last deploy) — click it → ApprovalCard → approve → tool runs → VerifyStrip green: "سایت برگشت، ۲۰۰، ۲۱۰ms، OOMKilled در ۵ دقیقه‌ی اخیر: ۰". Mention alternatives (restart / upgrade plan) and that it did not act without permission. |
| 3:50–4:30 | **Scenario 3 — proactive + limits** | Show the AlertBanner the watcher raised earlier (or trigger `crash` mode and wait for the banner). Click «بررسی کن» → diagnosis "کرش هنگام استارت" with the stack trace line + "این را فقط شما می‌توانید در کد درست کنید" + offer rollback. Then ask «لاگ‌های دسترسی HTTP رو نشون بده» → LimitationNotice: Liara API doesn't expose access logs; here's what we can do instead. |
| 4:30–5:00 | MCP + wrap-up | 10 seconds of the same tools inside Claude Desktop/Cursor via MCP (`list_apps`, `diagnose_app`). Close: risk tiers, verify loop, what's next. |

Record with the real account. If something flakes, re-record that scene; no editing skills required beyond cuts.

---

## 5. Acceptance — `scripts/acceptance/prd03.ts` (`npm run accept:prd03`) + manual checklist
Automated (Playwright is available in the environment; keep it light):
1. `npm run build` passes; `GET /api/health` → liara ok, llm ok.
2. `GET /api/apps` lists the demo app.
3. Open `/`, select the demo app, send «وضعیت این سرویس چطوره؟» → assistant bubble appears with Persian text; timeline shows ≥ 1 tool row.
4. Send «ری‌استارت کن» → ApprovalCard appears; click «نه، فعلاً» → receipt shows rejected; no audit row.
5. Send «ری‌استارت کن» → approve → timeline shows restart ✓ → VerifyStrip appears within 60s.
6. `npm run chaos -- leak` → within 3 watcher intervals `/api/alerts` has a critical alert; banner visible after reload.
7. `npm run chaos -- none` restore.
Manual checklist (do before recording): all three scenarios pass twice in a row; no raw JSON visible unless expanded; every tier≥1 action shows an ApprovalCard; every fix shows a VerifyStrip; limitation notice appears for access logs; Persian copy proofread.

**Commit:** `test(prd03): UI acceptance + demo checklist`

---

## 6. Deliverables checklist for PRD-03
- [ ] Next.js chat workspace with all components and API routes
- [ ] SSE streaming + replay on reload
- [ ] Approval UX incl. typed-name for risk 2
- [ ] Chaos demo app + `npm run chaos`
- [ ] README.md (Persian, with the 4 required sections) + docs/MCP.md
- [ ] `npm run accept:prd03` passes; manual checklist done
- [ ] (nice-to-have) deploy the agent UI itself to Liara (`platform: next`) and mention it in README
