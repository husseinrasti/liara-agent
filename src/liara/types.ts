/**
 * Zod schemas for Liara API responses. Objects are loose (unknown keys kept) and
 * most fields optional: real responses beat the OpenAPI spec, and the client
 * never fails on extra/missing optional fields. Shapes are verified against
 * fixtures/liara/*.json (see docs/API-NOTES.md).
 */
import { z } from 'zod';

const str = z.string();
const optStr = z.string().nullish();
const optNum = z.number().nullish();
const optBool = z.boolean().nullish();

export const ProjectSchema = z.looseObject({
  _id: str,
  project_id: str,
  type: str,
  status: optStr,
  scale: optNum,
  planID: optStr,
  bundlePlanID: optStr,
  created_at: optStr,
  isDeployed: optBool,
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectsResponseSchema = z.looseObject({ projects: z.array(ProjectSchema) });

export const EnvVarSchema = z.looseObject({
  key: str,
  value: optStr,
  encrypted: optBool,
  _id: optStr,
});
export type EnvVar = z.infer<typeof EnvVarSchema>;

export const ProjectDetailsSchema = ProjectSchema.extend({
  defaultSubdomain: optBool,
  readOnlyRootFilesystem: optBool,
  zeroDowntime: optBool,
  envs: z.array(EnvVarSchema).nullish(),
  fixedIPStatus: optStr,
  node: z.looseObject({ _id: optStr, IP: optStr }).nullish(),
  hourlyPrice: optNum,
  reservedDiskSpace: optNum,
});
export type ProjectDetails = z.infer<typeof ProjectDetailsSchema>;

export const ProjectDetailsResponseSchema = z.looseObject({ project: ProjectDetailsSchema });

export const LogLineSchema = z.looseObject({
  type: optStr,
  datetime: str,
  message: str,
  releaseId: optStr,
});
export type LogLine = z.infer<typeof LogLineSchema>;
/** v1 logs (old infrastructure): `[{type, datetime, message}]` */
export const LogsResponseSchema = z.array(LogLineSchema);

/** Loki-like streams used by v2 logs and by events: `{data:[{metaData, values:[[ts, line], …]}]}` */
export const LokiStreamsSchema = z.looseObject({
  data: z
    .array(z.looseObject({ metaData: z.record(z.string(), z.unknown()).nullish(), values: z.array(z.array(z.unknown())).nullish() }))
    .nullish(),
});
export type LokiStreams = z.infer<typeof LokiStreamsSchema>;

/** `GET /v2/releases/{id}/build-logs?since=` → `{release:{state,status,failReason,queue}, buildOutput:[…]}` */
export const BuildLogsSchema = z.looseObject({
  release: z.looseObject({ state: optStr, status: optStr, failReason: z.unknown().optional(), queue: optNum }).nullish(),
  buildOutput: z.array(z.looseObject({ _id: optStr, line: str, stream: optStr, releaseID: optStr, createdAt: optStr })).nullish(),
});
export type BuildLogs = z.infer<typeof BuildLogsSchema>;

/** `GET /v1/releases/{id}` → `{release:{state,status,failReason,queue}}` */
export const ReleaseStatusSchema = z.looseObject({
  release: z.looseObject({ state: optStr, status: optStr, failReason: z.unknown().optional(), queue: optNum }),
});

export const AppletSchema = z.looseObject({
  id: optStr,
  name: str,
  timestamp: optStr,
  state: optStr,
  reason: optStr,
  release: z.looseObject({ releaseID: optStr, tag: optStr }).nullish(),
});
export type Applet = z.infer<typeof AppletSchema>;
export const AppletsResponseSchema = z.looseObject({ applets: z.array(AppletSchema) });

export const GitInfoSchema = z.looseObject({
  branch: optStr,
  message: optStr,
  commit: optStr,
  committedAt: optStr,
  remote: optStr,
  author: z.looseObject({ email: optStr, name: optStr }).nullish(),
});

export const ReleaseSchema = z.looseObject({
  _id: str,
  type: optStr,
  imageName: optStr,
  projectType: optStr,
  state: str,
  port: optNum,
  gitInfo: GitInfoSchema.nullish(),
  client: optStr,
  finishedAt: optStr,
  createdAt: optStr,
  tag: optStr,
  sourceAvailable: optBool,
  sourceID: optStr,
});
export type Release = z.infer<typeof ReleaseSchema>;

export const ReleasesPageSchema = z.looseObject({
  total: optNum,
  currentRelease: optStr,
  readyReleasesCount: optNum,
  releases: z.array(ReleaseSchema),
  platform: optStr,
});
export type ReleasesPage = z.infer<typeof ReleasesPageSchema>;

export const SourceUploadSchema = z.looseObject({ sourceID: str });
export const ReleaseCreatedSchema = z.looseObject({ releaseID: str });

const scalar = z.union([z.number(), z.string()]);

/** Prometheus-like range series: `{end, result:[{values:[[ts,"v"],...], applet}]}` */
export const MetricRangeSchema = z.looseObject({
  end: optNum,
  result: z.array(z.looseObject({ values: z.array(z.array(scalar)), applet: optStr })),
});
export type MetricRange = z.infer<typeof MetricRangeSchema>;

export const MetricsSummarySchema = z.looseObject({
  cpuUsage: z.array(z.looseObject({ value: z.array(scalar), applet: optStr })).nullish(),
  memoryUsage: z.array(z.looseObject({ value: z.array(scalar), applet: optStr })).nullish(),
  disksUsage: z.array(z.looseObject({ size: scalar.nullish(), usage: scalar.nullish(), reportedAt: optStr, name: optStr })).nullish(),
});
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>;

/** Raw events: same Loki-like stream layout as v2 logs. */
/**
 * `GET /v1/projects/{app}/events` → `{data:[…]}`. The new infrastructure returns flat container
 * events `{id, status, action, time: "<unix s>", release, tag}` [probe 07a]; Loki-like streams
 * `{metaData, values}` (spec) are still accepted.
 */
export const EventsRawSchema = z.looseObject({
  data: z
    .array(
      z.looseObject({
        metaData: z.record(z.string(), z.unknown()).nullish(),
        values: z.array(z.array(z.unknown())).nullish(),
        id: optStr,
        status: optStr,
        action: optStr,
        time: z.union([z.string(), z.number()]).nullish(),
        release: optStr,
        tag: optStr,
      }),
    )
    .nullish(),
});
export type EventsRaw = z.infer<typeof EventsRawSchema>;

export type EventSeverity = 'info' | 'warning' | 'error';
export interface AppEvent {
  ts: string;
  type?: string;
  reason?: string;
  message: string;
  count?: number;
  applet?: string;
  severity: EventSeverity;
}

export const DomainSchema = z.looseObject({
  _id: str,
  name: str,
  type: optStr,
  project: z.union([z.looseObject({ _id: optStr, project_id: optStr }), z.string()]).nullish(),
  status: optStr,
  certificatesStatus: optStr,
  redirectTo: optStr,
  redirectStatus: optNum,
  created_at: optStr,
  CNameRecord: optStr,
});
export type Domain = z.infer<typeof DomainSchema>;
export const DomainsResponseSchema = z.looseObject({ domains: z.array(DomainSchema) });

export const DomainCheckSchema = z.looseObject({
  domain: DomainSchema.extend({ verificationCode: optStr, punycodeName: optStr, issuedAt: optStr, updated_at: optStr }),
});
export type DomainCheck = z.infer<typeof DomainCheckSchema>;

export const BillingSchema = z.looseObject({
  user: z.looseObject({ balance: optNum, accountType: optStr, minCreditAmount: optNum }).nullish(),
  /** present in team mode (teamID query); the money of a team account lives here, user.balance is 0 [probe] */
  team: z.looseObject({ balance: optNum, accountType: optStr, minCreditAmount: optNum }).nullish(),
});
export type Billing = z.infer<typeof BillingSchema>;

/** GET /v1/networks — private networks; g2 (new infrastructure) apps must be created inside one [cli][probe]. */
export const NetworksSchema = z.looseObject({
  networks: z.array(z.looseObject({ _id: str, name: str })).nullish(),
});

export const MeSchema = z.looseObject({
  user: z.looseObject({ _id: optStr, isTeam: optBool }).nullish(),
  team: z.looseObject({ balance: optNum }).nullish(),
  plans: z.looseObject({ projects: z.record(z.string(), z.unknown()).nullish() }).nullish(),
});
export type Me = z.infer<typeof MeSchema>;

export const DisksResponseSchema = z.looseObject({
  disks: z.array(z.looseObject({ _id: optStr, name: str, size: optNum, createdAt: optStr })).nullish(),
  mounts: z.array(z.looseObject({ name: optStr, mountedTo: optStr })).nullish(),
});

/** Any JSON body; used for endpoints whose success body we do not rely on. */
export const AnyBodySchema = z.unknown();
