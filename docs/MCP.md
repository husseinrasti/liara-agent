# MCP server — use the Liara co-worker tools from Claude Desktop, Cursor or any MCP host

`src/mcp/server.ts` exposes the **same tool registry** the web agent uses (36 tools, including the agent-level
`diagnose_app`, `recommend_plan` and `deploy_project`) over MCP stdio. When an LLM key is configured,
`diagnose_app` uses it for the structured diagnosis; otherwise it returns the rule-engine diagnosis.
Server name: `liara-agent`. All logs go to stderr; stdout carries only JSON-RPC.

## Run

```bash
npm run --silent mcp
```

Use `--silent`: plain `npm run mcp` makes npm print a banner on stdout, which breaks strict MCP clients.
The server reads `.env` from the repo root (wherever it is started from); `LIARA_API_TOKEN` is required.

## Claude Desktop / Cursor config

```json
{
  "mcpServers": {
    "liara-agent": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/liara-agent/src/mcp/server.ts"],
      "env": { "LIARA_API_TOKEN": "..." }
    }
  }
}
```

- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).
- Cursor: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).
- If `.env` in the repo already has the token, the `env` block can be omitted (env from the host wins over `.env`).

## Safety model (enforced by the server, not by the prompt)

| Risk | Tools | What the host must send |
|---|---|---|
| 0 — read / local | `list_apps`, `get_app`, `get_app_logs`, `get_app_events`, `get_app_applets`, `get_app_releases`, `get_app_metrics`, `list_domains`, `check_domain`, `get_account`, `http_health_check`, `search_docs`, `report_limitation`, `analyze_project`, `build_source_archive`, `collect_evidence`, `diagnose_app`, `recommend_plan`, `set_app_watch`, `save_app_note` | nothing extra |
| 1 — confirm | `create_app`, `upload_source`, `deploy_release`, `deploy_project`, `rollback_release`, `restart_app`, `update_envs`, `add_domain`, `enable_ssl` | `"confirm": true` after the user approved |
| 2 — dangerous | `resize_app`, `scale_app`, `delete_app`, `delete_domain`, `create_disk`, `resize_disk`, `exec_shell` | `"confirmAppName": "<appName>"` typed by the user |

- Calls without the confirmation are refused with a Persian explanation of what would happen (consequences, cost, reversibility).
- Tool descriptions carry a `[risk 1 — confirm]` / `[risk 2 — dangerous]` prefix; MCP annotations set `readOnlyHint` (risk 0) and `destructiveHint` (risk 2).
- Every executed risk ≥ 1 call is written to the `audit` table (secret env values masked) and then **verified** (e.g. restart → instances running, no new crash events, HTTP 200). The result includes `verification: {ok, evidence[]}`; hosts should only claim success when `ok` is true.
- Long operations (`deploy_release`) send MCP progress notifications when the host provides a `progressToken`.

## Result format

Text content: first line is a short Persian summary for the end user (plus a verification line for mutating tools), followed by the compact JSON result (`raw` payloads are dropped).

## Try it

```bash
npx @modelcontextprotocol/inspector npx tsx src/mcp/server.ts
```

Then call `list_apps`, `collect_evidence {"appName": "<your app>"}` or `search_docs {"query": "IRNIC"}`.
