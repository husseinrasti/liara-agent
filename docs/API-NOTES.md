# API-NOTES — facts discovered against the real Liara API

Append-only. Each `npm run probe` run appends a generated section at the bottom; the
curated conclusions the code relies on live in **Decisions** and are maintained by hand.
Fixtures referenced here are in `fixtures/liara/` (sanitized; `*.raw.json` is gitignored).

Sources, in order of trust: probe fixtures → liara-cli source (github.com/liara-cloud/cli,
the official CLI, read via the GitHub API on 2026-10-22) → OpenAPI spec (developers.liara.ir/spec/*.yaml).

## Decisions (what the code relies on)

Status legend: **[cli]** = taken from liara-cli source, **[spec]** = OpenAPI only,
**[probe]** = confirmed by a probe fixture. Items without [probe] must be re-checked by
the probe before PRD-01 is accepted.

| Topic | Decision | Where in code |
|---|---|---|
| Plan catalogue | `GET /v1/me` → `plans.projects[planID] = {available, region, RAM.amount (GB), CPU.amount, volume (GB), price (Toman/**hour**), displayPrice (Toman/**month**), storageClass, …}`. Monthly = `displayPrice` (fallback price × 720). On the probed account only g2 plans are purchasable (`small-g2` 475 000/month … `pro-max-g2`); `free` and `mini-g2` have `available: false`; ids without `-g2` are legacy. **[probe][cli]** | `src/liara/plans.ts` |
| Feature bundles | `plans.projectBundlePlans[planID][free\|basic\|standard\|pro] = {available, price, displayPrice (Toman/month), maxLogsRetention (days), rollback, zeroDowntime, …}`. On g2 plans `free` is unavailable; `basic` is the cheapest (small-g2: 275 000/month, 7-day logs). `POST /v1/projects` needs `bundlePlanID`. **[probe]** | `plans.ts`, `create_app` |
| Balance | `GET /v1/billing` → `{user:{balance,…}, team:{balance,…}}`; with `teamID` the money is in `team.balance` and `user.balance` is 0. Also `GET /v1/me/subscription` → `{currentSubscriptionPlan}`, `GET /v1/me/free-credit` → `{remainingFreeCredit}`. **[probe]** | `endpoints/account.ts` |
| Create app | `POST /v1/projects {name, planID, platform, bundlePlanID, network}`; `network` is a private network `_id` from `GET /v1/networks` → `{networks:[{_id,name}]}` (create one with `POST /v1/networks {networkName}`). Without it a g2 plan fails with 400 `g2_plan_unavailable` (probe 04a). liara-cli `app:create` always sends a network. `GET /v1/projects` items carry `network:{_id,name}`. **[probe][cli]** | `endpoints/networks.ts`, `create_app`, `deploy_project` |
| Logs | New infrastructure: `GET /v2/projects/{app}/logs?start=<unix s>&direction=forward\|backward[&releaseId=]` → `{data:[{metaData:{releaseId}, values:[[tsNs, '{"_entry":…,"type":"stdout\|stderr"}']]}]}`. Old infra only `GET /v1/projects/{app}/logs?since=`. We call v2 (backward = newest first) and fall back to v1 on 400/404. **[cli]** | `endpoints/logs.ts` |
| Log retention | `start` older than `maxLogsRetention` days of the app's bundle is rejected. **[cli]** | — |
| Events | `GET /v1/projects/{app}/events?start=&end=` (unix seconds per spec example) → Loki-like streams; row layout to confirm. **[spec]** | `normalize.ts` |
| Release states | `BUILDING → PUSHING → DEPLOYING → READY`; failures `FAILED` (+`failReason`), `CANCELED`, `TIMEDOUT`, `UNHEALTHY`. **[cli]** | `endpoints/deploy.ts` |
| Release status | `GET /v1/releases/{id}` → `{release:{state,status,failReason,queue}}`. **[cli]** | `getReleaseStatus` |
| Build logs | `GET /v2/releases/{id}/build-logs?since=<createdAt ISO>` → `{release, buildOutput:[{line, stream: STDOUT\|STDERR, createdAt}]}`. **[cli]** | `getBuildLogs` |
| Deploy | `POST /v2/projects/{app}/sources` (multipart `file`, ≤ 256 MiB) → `{sourceID}`; `POST /v2/projects/{app}/releases {sourceID, port, type, message?, platformConfig?}` → `{releaseID}`. The CLI refuses to deploy when `project.scale` is 0. **[cli]** | `endpoints/deploy.ts` |
| Platforms | `node, next, react, vue, angular, static, laravel, php, django, flask, python, dotnet, go, docker` (.NET is `dotnet`). Default ports: node/next/docker 3000; go 8080; others 80 (django/flask too). **[cli]** | `local/platforms.ts` |
| Archive ignores | defaults (`.git .idea .vscode .next .dockerignore *.*~ liara.json node_modules bower_components .DS_Store`) + platform ignores + per-dir `.liaraignore` > `.dockerignore` > `.gitignore`. We additionally never upload `.env*` (except examples). **[cli]** | `local/files.ts` |
| update-envs | `POST /v1/projects/update-envs {project, variables}` replaces the full set (liara-cli `env:set` re-sends existing + new; `env:unset` sends the filtered set) and restarts the app. We merge client-side. **[cli]** | `endpoints/envs.ts` |
| Public URL | `https://<app>.liara.run`; apps on the old infrastructure without `network`: `<app>.iran.liara.run`. **[cli]** | `appUrlFor` |
| Console shell | `wss://api.iran.liara.ir/v1/exec?token=…&cmd=<cmd>&project_id=<app name>&teamID=`; after open send `{"action":"start","cols","rows"}`; output = raw frames. **[cli]** | `endpoints/shell.ts` |
| Rollback | No native endpoint in spec or CLI. Strategy: re-release the target release's stored `sourceID`; if refused, re-upload the archive kept in `data/sources/<app>/` and release it. Releases not deployed through this agent cannot be rolled back automatically (declared as a limitation). A release we rolled back FROM is remembered (`badReleases` in app memory) and never chosen as a later rollback target. **[spec][cli]** — probe tests sourceID reuse and candidate endpoints. | `rollback_release` |
| Access logs | None in the API (container stdout/stderr only). Health comes from our own HTTP probe. **[spec]** | `limits.md` |
| Disks | Create: `POST /v1/projects/{app}/disks {name, size}` (name in the path, size as a number or numeric string). List: `GET /v1/projects/{_id}/disks` (app **_id**). Mount: the release body carries `disks: [{name, mountTo}]` taken from liara.json `disks` (liara-cli `deploy`). **[cli][spec]** | `create_disk`, `deploy_project`, `scripts/deploy-self.ts` |

## Environment notes

- `api.liara.ir` / `*.liara.run` resolve to Iranian IPs (185.208.181.x). From a non-Iranian egress
  (e.g. a VPN exit abroad) TCP connections time out; run the probe/acceptance with a direct route
  to Liara (split-tunnel `*.liara.ir`, `*.liara.run`). developers.liara.ir is reachable from anywhere.
- 2026-10-23: the first probe run (from the user's terminal; Claude's processes still had no route)
  recorded 01–03 and stopped at create app (`g2_plan_unavailable`, fixed by sending `network`).
- `npm run mcp` prints npm's banner on stdout; MCP hosts must use `npm run --silent mcp` or `npx tsx src/mcp/server.ts`.
