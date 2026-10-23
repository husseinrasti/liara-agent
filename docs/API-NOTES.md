# API-NOTES — facts discovered against the real Liara API

Append-only. Each `npm run probe` run appends a generated section at the bottom; the
curated conclusions the code relies on live in **Decisions** and are maintained by hand.
Fixtures referenced here are in `fixtures/liara/` (sanitized; `*.raw.json` is gitignored).

Sources, in order of trust: probe fixtures → liara-cli source (github.com/liara-cloud/cli,
the official CLI, read via the GitHub API on 2026-10-22) → OpenAPI spec (developers.liara.ir/spec/*.yaml).

## Decisions (what the code relies on)

Status legend: **[cli]** = taken from liara-cli source, **[spec]** = OpenAPI only,
**[probe]** = confirmed by a probe fixture (2026-10-23). Items without [probe] are not yet
confirmed live.

| Topic | Decision | Where in code |
|---|---|---|
| Plan catalogue | `GET /v1/me` → `plans.projects[planID] = {available, region, RAM.amount (GB), CPU.amount, volume (GB), price (Toman/**hour**), displayPrice (Toman/**month**), storageClass, …}`. Monthly = `displayPrice` (fallback price × 720). On the probed account only g2 plans are purchasable (`small-g2` 475 000/month … `pro-max-g2`); `free` and `mini-g2` have `available: false`; ids without `-g2` are legacy. **[probe][cli]** | `src/liara/plans.ts` |
| Feature bundles | `plans.projectBundlePlans[planID][free\|basic\|standard\|pro] = {available, price, displayPrice (Toman/month), maxLogsRetention (days), rollback, zeroDowntime, …}`. On g2 plans `free` is unavailable; `basic` is the cheapest (small-g2: 275 000/month, 7-day logs). `POST /v1/projects` needs `bundlePlanID`. **[probe]** | `plans.ts`, `create_app` |
| Balance | `GET /v1/billing` → `{user:{balance,…}, team:{balance,…}}`; with `teamID` the money is in `team.balance` and `user.balance` is 0. Also `GET /v1/me/subscription` → `{currentSubscriptionPlan}`, `GET /v1/me/free-credit` → `{remainingFreeCredit}`. **[probe]** | `endpoints/account.ts` |
| Create app | `POST /v1/projects {name, planID, platform, bundlePlanID, network}`; `network` is a private network `_id` from `GET /v1/networks` → `{networks:[{_id,name}]}` (create one with `POST /v1/networks {networkName}`). Without it a g2 plan fails with 400 `g2_plan_unavailable` (probe 04a). liara-cli `app:create` always sends a network. `GET /v1/projects` items carry `network:{_id,name}`. **[probe][cli]** | `endpoints/networks.ts`, `create_app`, `deploy_project` |
| Logs | `GET /v2/projects/{app}/logs?start=<unix s>&direction=forward\|backward[&releaseId=]` → `{data:[{metaData:{releaseId}, values:[[tsNs, '{"type":"stdout","_entry":…}']]}]}`, one stream per release (several releases in one answer). v1 `GET /v1/projects/{app}/logs?since=<number>` (ISO → 400) is deprecated on the new infrastructure: it only returns the line "Please upgrade your client…" (filtered out). **[probe]** | `endpoints/logs.ts` |
| Log retention | `start` older than `maxLogsRetention` days of the app's bundle is rejected. **[cli]** | — |
| Events | `GET /v1/projects/{app}/events?start=<unix s>&end=<unix s>` (ms → empty; no params → recent) → **flat container events** `{data:[{id, status, action, time:"<unix s>", release, tag}]}`, actions `create, start, kill, die, stop, destroy` (Docker-style; `oom` confirmed live: one every ~14 s while a leaking app is OOM-restarted). No exit codes. Restart/deploy = `kill → die → stop` + `create → start`; the old container's `destroy` comes ~3 min later. **At most 12 rows per call, newest first**; `limit`/`count`/`size`/`page`/`skip` → 400 `"x" is not allowed`; `end` is exclusive; `search=<action>` filters (e.g. `die`). We page backwards (`end` = oldest row + 1 s, deduped, ≤ 4 pages). The container `start` comes **~30–40 s after the release turns READY** (v8 READY 15:05:39 → start 15:06:07; v12 READY 15:09:29 → start 15:10:07), so health checks right after READY can still hit the old container. Normalized: oom→OOMKilled, die after kill→Stopped, die then start of the same container (or after oom)→**Exited** (crash), other die→neutral. Loki-shaped events (spec) still accepted. **[probe]** | `endpoints/events.ts` (paging), `normalize.ts` (`normalizeEvents`), crash_loop playbook, watcher |
| Release states | `PENDING → BUILDING → DEPLOYING → READY` observed (21–32 s); re-releasing an existing sourceID skips the build: `PENDING → DEPLOYING → READY` in ~3 s; failures `FAILED` (+`failReason`), `CANCELED`, `TIMEDOUT`, `UNHEALTHY` per CLI. Release `type` is the **kind** (`DEPLOY`, `ENV_UPDATE`), the platform is `projectType`. Every update-envs adds a READY `ENV_UPDATE` release on the same image; rollback and "last deploy" use `DEPLOY` releases only. `ENV_UPDATE` releases have no `finishedAt`/`client`; `GET /v1/projects/{app}/releases` → `{total, currentRelease, readyReleasesCount, releases, platform}`. **[probe][cli]** | `endpoints/deploy.ts` (`isCodeRelease`), `rollback_release`, `collect_evidence` |
| Release status | `GET /v1/releases/{id}` → `{release:{_id,type,projectType,state,disks,platformConfig,createdAt}, platformConfig}`. **[probe]** | `getReleaseStatus` |
| Build logs | `GET /v2/releases/{id}/build-logs[?since=<createdAt ISO>]` → `{release:{_id,state}, buildOutput:[{_id,line,stream:STDOUT\|STDERR,releaseID,createdAt}]}`. **[probe]** | `getBuildLogs` |
| Deploy | `POST /v2/projects/{app}/sources` (multipart `file`, ≤ 256 MiB) → `{sourceID:"<uuid>.tar.gz"}`; `POST /v2/projects/{app}/releases {sourceID, port, type, message?, platformConfig?, disks?}` → 201 `{releaseID}`. A sourceID can be released again (201). **[probe]** | `endpoints/deploy.ts` |
| Platforms | `node, next, react, vue, angular, static, laravel, php, django, flask, python, dotnet, go, docker` (.NET is `dotnet`). Default ports: node/next/docker 3000; go 8080; others 80 (django/flask too). **[cli]** | `local/platforms.ts` |
| Archive ignores | defaults (`.git .idea .vscode .next .dockerignore *.*~ liara.json node_modules bower_components .DS_Store`) + platform ignores + per-dir `.liaraignore` > `.dockerignore` > `.gitignore`. We additionally never upload `.env*` (except examples). **[cli]** | `local/files.ts` |
| update-envs | `POST /v1/projects/update-envs {project, variables}` → 201 `{message:"success"}`; **replaces** the full set (sending only PROBE_A removed PORT and NODE_ENV) and creates an `ENV_UPDATE` release. We merge client-side. New apps start with `PORT` and `NODE_ENV` set by Liara. **[probe]** | `endpoints/envs.ts` |
| Public URL | `https://<app>.liara.run`; apps on the old infrastructure without `network`: `<app>.iran.liara.run`. **[cli]** — not reachable from this machine's route yet (`*.liara.run` must bypass the VPN). | `appUrlFor` |
| Console shell | `wss://api.iran.liara.ir/v1/exec?token=…&cmd=<cmd>&project_id=<app name>&teamID=`; after open send `{"action":"start","cols","rows"}`; output = raw frames. **[cli]** — unverified: `api.iran.liara.ir` is not reachable from this machine's route. | `endpoints/shell.ts` |
| Rollback | No native endpoint: `POST /v2/projects/{app}/releases {releaseID}` → 400 "port is required"; `…/releases/{id}/redeploy\|rollback` (v1, v2) → 404. Re-releasing an earlier sourceID works (201 → READY in ~3 s, the image is reused), so rollback = re-release the target DEPLOY release's recorded sourceID, else re-upload the stored archive. Releases not deployed through this agent cannot be rolled back automatically (limitation). A release we rolled back FROM is never picked again. **[probe]** | `rollback_release` |
| Access logs | None in the API (container stdout/stderr only). Health comes from our own HTTP probe. **[spec]** | `limits.md` |
| Disks | Create: `POST /v1/projects/{app}/disks {name, size}` (name in the path, size as a number or numeric string). List: `GET /v1/projects/{_id}/disks` (app **_id**). Mount: the release body carries `disks: [{name, mountTo}]` taken from liara.json `disks` (liara-cli `deploy`). **[cli][spec]** | `create_disk`, `deploy_project`, `scripts/deploy-self.ts` |
| Applets | `GET /v1/projects/{app}/applets` → **500** on the new infrastructure (every call, also after a restart). `get_app_applets` reports a limitation; verification uses crash events + HTTP health instead. **[probe]** | `get_app_applets`, `checks.ts` |
| Metrics | `GET /v1/projects/{app}/metrics/{cpu\|memory\|network-receive\|network-transmit}?since=<unix s>` (absolute, ≤ 7 days old; ms → 503, a relative 3600 → 428) → `{end, result:[{values:[[ts,"v"]]}]}` every 30 s; cpu in cores, memory in bytes. **One unlabeled series per container** (6–9 series after a few deploys); a replaced container keeps reporting ~3–4 min after the new one starts. Window stats merge series by max per timestamp; the *current* value comes from the newest container still reporting, so verification after a rollback is not fooled by the old one. `metrics/summary` → `{cpuUsage, memoryUsage, disksUsage}`. **[probe]** | `endpoints/metrics.ts`, `evidence/metrics.ts` (`currentValue`) |
| Domains | `POST /v1/domains {name, project, type:"PROJECT"}` → 201 `{domain:{_id}}`; `GET /v1/domains?project=` → `{domains, total}`; `GET /v1/domains/{id}/check` → `{domain:{status:"PENDING", certificatesStatus:"DEACTIVE", CNameRecord:"INVALID", acmeRecord, project:{network:{node:{host, IP}}}}}` — `CNameRecord`/`acmeRecord` are **statuses**; DNS must point to the app's node (`CNAME → node.host`, apex `A → node.IP`). `DELETE /v1/domains/{id}` → 200. **[probe]** | `endpoints/domains.ts` (`dnsTargetOf`), `add_domain` |
| New apps | Created with `readOnlyRootFilesystem: true` (writes outside disks and /tmp fail with EROFS → `readonly_fs` playbook), `defaultSubdomain: true`, `network:{_id,name}`. **[probe]** | `readonly_fs.yaml` |
| Daily deploy cap | Each feature bundle caps **deploys per app per day** (`projectBundlePlans[plan][bundle].maxDeploymentCountInDay`: free 10, basic 20, standard 50, pro infinite). Over the cap `POST /v2/projects/{app}/releases` → **428** `{"message":"Max deployment count in day."}`; rollback (a re-release) is blocked too. Mapped to a plain Persian message (wait until tomorrow or upgrade the bundle). Live acceptance runs deploy ~10 times each, so a basic-bundle probe app allows about two runs per day. **[probe]** | `errors.ts` (`userMessageFor`) |
| Release scoping | Every log stream (`metaData.releaseId`) and container event (`release`) names its release. After a deploy, rollback or env change the replaced container keeps running — and a leaking one keeps OOM-ing — for a minute or more (live acceptance: v20 OOMs until ~1 min after the rollback to v21). `currentRelease` in the releases page = newest READY release. Diagnosis, verification and the watcher therefore only count rows of the running release (current READY one) **and newer attempts** (e.g. an UNHEALTHY deploy); older releases' rows are dropped. Without this a successful rollback was reported "not fixed" and a broken build was diagnosed as the previous release's missing env. **[probe]** | `runningRelease`/`liveReleaseIds` (`endpoints/deploy.ts`), `ofRelease` (`observe.ts`), `collect_evidence`, `checks.ts`, `verify.ts`, watcher |
| Clock | `api.liara.ir`'s HTTP `Date` header ran ~3 min ahead of real time; resource ids, event and log timestamps matched real time. Never derive server time from `Date`. **[probe]** | — |

## Environment notes

- `api.liara.ir` / `*.liara.run` resolve to Iranian IPs (185.208.181.x). From a non-Iranian egress
  (e.g. a VPN exit abroad) TCP connections time out; run the probe/acceptance with a direct route
  to Liara (split-tunnel `*.liara.ir`, `*.liara.run`). developers.liara.ir is reachable from anywhere.
- 2026-10-23: the first probe run (from the user's terminal; Claude's processes still had no route)
  recorded 01–03 and stopped at create app (`g2_plan_unavailable`, fixed by sending `network`).
  After `api.liara.ir` was added to the VPN bypass the full probe ran (app `liara-agent-probe-u875`).
  `*.liara.run` (health checks) and `api.iran.liara.ir` (console shell) still time out from this route.
  A second full run from the user's terminal (15:05, same app) confirmed everything above and the
  12-row event cap; its health check (8 tries) and shell test also timed out, so those two hosts need
  the same bypass on the user's side too.
- 2026-10-23 evening: with `*.liara.run` and `api.iran.liara.ir` bypassed too, `accept:prd01` passed
  live 12/12. The first live `accept:prd02` exposed the release-scoping issue above (8/10). The rerun
  hit the daily deploy cap (428) on the basic-bundle probe app, and the LLM gateway key ran out of
  budget (`Spending limit reached`), so PRD-02/03 live are pending on both.
- `npm run mcp` prints npm's banner on stdout; MCP hosts must use `npm run --silent mcp` or `npx tsx src/mcp/server.ts`.

## Probe run 2026-10-23T15:05:04.089Z

- App: `liara-agent-probe-u875` (existing DEMO_APP_NAME)
- `/v1/me` top-level keys: `user`, `team`, `databaseVersions`, `defaultDatabaseVersions`, `featureFlags`, `plans`
- Plan object fields (`plans.projects.<id>`): `available`, `price`, `volume`, `RAM`, `CPU`, `sourceCodeSpace`
- Balance: 1000000 (source: GET /v1/billing → team.balance)
- Project detail keys: `_id`, `project_id`, `type`, `status`, `readOnlyRootFilesystem`, `defaultSubdomain`, `defaultSubdomainExpired`, `keepDefaultSubdomain`, `zeroDowntime`, `scale`, `envs`, `planID`, `bundlePlanID`, `network`, `dns`, `created_at`, `hourlyPrice`, `bundleHourlyPrice`, `isDeployed`, `reservedDiskSpace`
- Project planID `small-g2`, hourlyPrice 659.72

### Plan catalogue (parsed)

| id | RAM MB | CPU | disk GB | monthly IRT | hourly IRT | available | region |
|---|---|---|---|---|---|---|---|
| free | 128 | 0.125 | 0 | 0 | 0 | false | iran |
| database-control-panel | 1024 | 0.5 | 0 | 0 | 0 | false | — |
| shared | 512 | 1 | 1 | 36000 | 50 | false | — |
| 512mb | 512 | 1 | 5 | 72000 | 100 | false | — |
| nano | 512 | 1 | 2 | 72000 | 100 | false | — |
| small | 512 | 0.25 | 2.5 | 72000 | 100 | false | germany |
| 1g | 1024 | 1 | 10 | 144000 | 200 | false | — |
| micro | 1024 | 1 | 5 | 144000 | 200 | false | — |
| medium | 1024 | 0.5 | 5 | 144000 | 200 | false | germany |
| mini-g2 | 256 | 0.25 | 2.5 | 275000 | 381.94 | false | iran |
| 2g | 2048 | 2 | 20 | 288000 | 400 | false | — |
| standard-1x | 2048 | 2 | 10 | 288000 | 400 | false | — |
| standard | 2048 | 1 | 10 | 288000 | 400 | false | germany |
| small-g2 | 512 | 0.5 | 5 | 475000 | 659.72 | true | iran |
| ir-mini | 256 | 0.25 | 2.5 | 549994 | 763.88 | false | iran |
| 4g | 4096 | 2 | 40 | 576000 | 800 | false | — |
| standard-2x | 4096 | 2 | 20 | 576000 | 800 | false | germany |
| medium-g2 | 1024 | 1 | 10 | 825000 | 1145.83 | true | iran |
| performance-1x | 6144 | 4 | 40 | 864000 | 1200 | false | — |
| large | 6144 | 3 | 30 | 864000 | 1200 | false | — |
| ir-small | 512 | 0.5 | 5 | 949997 | 1319.44 | true | iran |
| 8g | 8192 | 4 | 80 | 1152000 | 1600 | false | — |
| performance-2x | 8192 | 4 | 60 | 1152000 | 1600 | false | — |
| large-2x | 8192 | 4 | 40 | 1152000 | 1600 | false | germany |
| standard-base-g2 | 2048 | 1 | 20 | 1475000 | 2048.61 | true | iran |
| ir-medium | 1024 | 1 | 10 | 1649995 | 2291.66 | true | iran |
| large-3x | 16384 | 8 | 80 | 2304000 | 3200 | false | germany |
| standard-plus-g2 | 4096 | 2 | 40 | 2650000 | 3680.55 | true | iran |
| ir-standard | 2048 | 2 | 20 | 2949998 | 4097.22 | false | iran |
| standard-base | 2048 | 1 | 20 | 2949998 | 4097.22 | true | iran |
| pro-g2 | 8192 | 4 | 80 | 4600000 | 6388.88 | true | iran |
| ir-large | 6144 | 6 | 60 | 5199998 | 7222.22 | false | — |
| ir-standard-2x | 4096 | 4 | 40 | 5299999 | 7361.11 | false | iran |
| standard-plus | 4096 | 2 | 40 | 5299999 | 7361.11 | true | iran |
| pro-plus-g2 | 16384 | 8 | 160 | 8000000 | 11111.11 | true | iran |
| ir-large-2x | 8192 | 8 | 80 | 9199994 | 12777.77 | false | iran |
| pro | 8192 | 4 | 80 | 9199994 | 12777.77 | true | iran |
| pro-max-g2 | 32768 | 16 | 320 | 14000000 | 19444.44 | true | iran |
| ir-large-3x | 16384 | 16 | 160 | 15999998 | 22222.22 | false | iran |
| pro-plus | 16384 | 8 | 160 | 15999998 | 22222.22 | true | iran |
| express-g2 | 65536 | 32 | 640 | 24600000 | 34166.66 | true | iran |
| pro-max | 32768 | 16 | 320 | 27999994 | 38888.88 | true | iran |

<details><summary>projectBundlePlans sample</summary>

```json
{
  "g1": {
    "default": {
      "available": true,
      "price": 0,
      "displayHourlyPrice": 0,
      "displayPrice": 0,
      "availableBackupInterval": [
        "daily",
        "manual"
      ],
      "backupRetention": {
        "manual": 3,
        "daily": 7,
        "weekly": 0,
        "monthly": 0,
        "hourly": 0
      },
      "buildTimeout": 60,
      "maxLogsRetention": 7,
      "maxReleaseRetention": 10,
      "maxDestinationsBackup": 0,
      "maxDomainsCount": "infinite",
      "maxDeploymentCountInDay": "infinite",
      "maxReportRetention": 7,
      "maxFTPAccountsPerDisk": 10,
      "maxDiskPerProject": 8,
      "manualBackupRateLimit": 5,
      "rollback": true,
      "zeroDowntime": true,
      "setDNS": false,
      "setReadOnly": false,
      "maxSourceSize": 256,
      "germanyBuilder": true,
      "vipBuilder": false,
      "antiBoycott": false,
      "freeSSL": true,
      "backupSpace": 0,
      "maxImageLayerSize": 500
    }
  },
  "free": {
    "free": {
      "available": false,
      "price": 0,
      "displayHourlyPrice": 0,
      "displayPrice": 0,
      "availableBackupInterval": [],
      "backupRetention": {
        "manual": 0,
        "daily": 0,
        "weekly": 0,
        "monthly": 0,
        "hourly": 0
      },
      "buildTimeout": 5,
      "maxLogsRetention": 0.05,
      "maxReleaseRetention": 1,
      "maxDestinationsBackup": 0,
      "maxDomainsCount": 1,
      "maxDeploymentCountInDay": 10,
      "maxReportRetention": 0.05,
      "maxFTPAccountsPerDisk": 1,
      "maxDiskPerProject": 1,
      "manualBackupRateLimit": 0,
      "rollback": false,
      "zeroDowntime": false,
      "setDNS": false,
      "setReadOnly": false,
      "maxSourceSize": 128,
      "germanyBuilder": false,
      "vipBuilder": false,
      "antiBoycott": false,
      "freeSSL": true,
      "backupSpace": 0
    },
    "basic": {
      "available": false,
      "price": 0,
      "displayHourlyPrice": 0,
      "displayPrice": 0,
      "availableBackupInterval": [],
      "backupRetention": {
        "manual": 0,
        "daily": 0,
        "weekly": 0,
        "monthly": 0,
        "hourly": 0
      },
      "buildTimeout": 5,
      "maxLogsRetention": 0.05,
      "maxReleaseRetention": 1,
      "maxDestinationsBackup": 0,
      "maxDomainsCount": 1,
      "maxDeploymentCountInDay": 10,
      "maxReportRetention": 0.05,
      "maxFTPAccountsPerDisk": 1,
      "maxDiskPerProject": 1,
      "manualBackupRateLimit": 0,
      "rollback": false,
      "zeroDowntime": false,
      "setDNS": false,
      "setReadOnly": false,
      "maxSourceSize": 128,
      "germanyBuilder": false,
      "vipBuilder": false,
      "antiBoycott": false,
      "freeSSL": true,
      "backupSpace": 0,
      "maxImageLayerSize": 200
    },
    "standard": {
      "available": false,
      "price": 0,
      "displayHourlyPrice": 0,
      "displayPrice": 0,
      "availableBackupInterval": [],
      "backupRetention": {
        "manual": 0,
 
```
</details>

### Time formats

| call | result |
|---|---|
| logs `v2Forward_initial` | status 200, items 30, first `1792765519661429383`, last `1792766023402222524` |
| logs `v2Backward_initial` | status 200, items 30, first `1792765519661429383`, last `1792766023402222524` |
| logs `v1Seconds_initial` | status 200, items 1, first `2026-10-23T15:05:10.642Z`, last `2026-10-23T15:05:10.642Z` |
| logs `v1Ms_initial` | status 200, items 1, first `2026-10-23T15:05:10.750Z`, last `2026-10-23T15:05:10.750Z` |
| logs `v1Iso_initial` | status 400, items — |
| logs `v2Forward_afterDeploy` | status 200, items 0 |
| logs `v2Backward_afterDeploy` | status 200, items 0 |
| logs `v1Seconds_afterDeploy` | status 200, items 1, first `2026-10-23T15:05:46.250Z`, last `2026-10-23T15:05:46.250Z` |
| logs `v2Forward_late` | status 200, items 15, first `1792767968354692705`, last `1792768135356475465` |
| logs `v2Backward_late` | status 200, items 15, first `1792767968354692705`, last `1792768135356475465` |
| logs `v1Seconds_late` | status 200, items 1, first `2026-10-23T15:09:42.764Z`, last `2026-10-23T15:09:42.764Z` |
| build/release logs `v2` | status 200, items 20, first `2026-10-23T15:05:13.560Z`, last `2026-10-23T15:05:20.287Z` |
| build/release logs `v2Since` | status 200, items — |
| events `initialSeconds` | status 200, rows 12 |
| events `initialMs` | status 200, rows 0 |
| events `initialNoParams` | status 200, rows 12 |
| events `lateSeconds` | status 200, rows 12 |
| events `lateMs` | status 200, rows 0 |
| events `lateNoParams` | status 200, rows 12 |
| metrics `cpu_seconds_initial` | status 200, series 6, points 80, ts 1792765537 → 1792767907 |
| metrics `cpu_ms_initial` | status 503, series —, points — |
| metrics `cpu_relative3600_initial` | status 428, series —, points — |
| metrics `memory_seconds_initial` | status 200, series 6, points 127, ts 1792765537 → 1792767907 |
| metrics `cpu_seconds_late` | status 200, series 8, points 88, ts 1792765539 → 1792768179 |
| metrics `cpu_ms_late` | status 503, series —, points — |
| metrics `cpu_relative3600_late` | status 428, series —, points — |
| metrics `memory_seconds_late` | status 200, series 9, points 148, ts 1792765539 → 1792768179 |
| metrics `netRx` | status 200, series 8, points 141, ts 1792765539 → 1792768179 |
| metrics `netTx` | status 200, series 8, points 141, ts 1792765539 → 1792768179 |

Log line sample:

```json
{"metaData":{"releaseId":"6adb786a417e33237e006492"},"firstRow":["1792768135356475465","{\"type\":\"stdout\",\"_entry\":\"probe app listening on port 3000\"}"]}
```

Build log sample:

```json
[{"_id":"6adb77a938253e6cdf52125d","line":"\n","stream":"STDOUT","releaseID":"6adb77a9ce14a814507a3de5","createdAt":"2026-10-23T15:05:13.560Z","__v":0},{"_id":"6adb77a938253e6cdf52125f","line":"> Fetching the source code: 100%\n","stream":"STDOUT","releaseID":"6adb77a9ce14a814507a3de5","createdAt":"2026-10-23T15:05:13.566Z","__v":0}]
```

Event sample (`data[i].metaData` and first `values` row):

```json
{"metaData":null,"firstRow":{"id":"a89451e017390dd92631093b19a758c7fbdfb01b3eef19985303addd1f3eb316","status":"start","action":"start","time":"1792768134","release":"6adb786a417e33237e006492","tag":"v11"}}
```

### Deploy

- Release body accepted: `{"sourceID":"<sourceID>","port":3000,"type":"node"}`
- Release states observed: **PENDING → BUILDING → DEPLOYING → READY** (final `READY`, 32s)
- Release object keys: `_id`, `type`, `imageName`, `projectType`, `state`, `port`, `buildArgs`, `buildLocation`, `buildTimeout`, `client`, `disks`, `finishedAt`, `platformConfig`, `createdAt`, `tag`, `sourceAvailable`
- Health: `https://liara-agent-probe-u875.liara.run` → null in 10001ms after 8 attempt(s)

### update-envs

- Semantics: **replace** (before ["NODE_ENV","PORT"], after A ["PROBE_A"], after B ["PROBE_B"])
- Restore with full previous set → 201; keys after restore ["NODE_ENV","PORT"]

### Restart

- restart → 200; applets 10s later: —

### Rollback discovery

- Re-release with an already used sourceID → 201 (final state READY)
- `POST /v2/projects/liara-agent-probe-u875/releases` → 400 ("port" is required)
- `POST /v1/projects/liara-agent-probe-u875/releases/{releaseID}/redeploy` → 404
- `POST /v1/projects/liara-agent-probe-u875/releases/{releaseID}/rollback` → 404
- `POST /v2/projects/liara-agent-probe-u875/releases/{releaseID}/rollback` → 404
- `POST /v2/projects/liara-agent-probe-u875/releases/{releaseID}/redeploy` → 404
- **Decision:** no native endpoint; re-release a previous sourceID (sourceIDs are reusable), fall back to re-uploading the stored archive

### Domains

- add `probe-pdjap8.liara-agent-test.ir` → 201; list → 200; check → 200; delete → 200; CNAME target `sabalan.liara.cloud`
