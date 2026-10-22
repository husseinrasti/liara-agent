import type { LiaraClient } from '../client';
import { UPLOAD_TIMEOUT_MS } from '../client';
import { BuildLogsSchema, ReleaseCreatedSchema, ReleaseStatusSchema, SourceUploadSchema, type BuildLogs, type Release } from '../types';
import { getReleases } from './apps';

const v2 = (name: string) => `/v2/projects/${encodeURIComponent(name)}`;

/** Liara rejects source archives above 256 MiB (liara-cli MAX_SOURCE_SIZE). */
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

/** Uploads a `.tar.gz` source archive (multipart field `file`) → sourceID. */
export async function uploadSource(c: LiaraClient, name: string, archive: Uint8Array, filename = 'source.tar.gz'): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(archive)], { type: 'application/gzip' }), filename);
  const res = await c.request(SourceUploadSchema, { method: 'POST', path: `${v2(name)}/sources`, multipart: form, timeoutMs: UPLOAD_TIMEOUT_MS });
  return res.sourceID;
}

export interface DeployReleaseInput {
  sourceID: string;
  port: number;
  /** Liara platform, e.g. node | next | static | laravel | django | dotnet | docker */
  type: string;
  message?: string;
  /** Platform options as in liara.json (e.g. `{ version: "22" }` for node). */
  platformConfig?: Record<string, unknown>;
}

/** Creates a release from an uploaded source → releaseID. The build starts asynchronously. */
export async function deployRelease(c: LiaraClient, name: string, input: DeployReleaseInput): Promise<string> {
  const body: Record<string, unknown> = { sourceID: input.sourceID, port: input.port, type: input.type };
  if (input.message) body.message = input.message;
  if (input.platformConfig) body.platformConfig = input.platformConfig;
  const res = await c.request(ReleaseCreatedSchema, { method: 'POST', path: `${v2(name)}/releases`, body });
  return res.releaseID;
}

/** Lightweight release status: `{state, status, failReason?, queue?}`. */
export async function getReleaseStatus(c: LiaraClient, releaseID: string) {
  const res = await c.request(ReleaseStatusSchema, { path: `/v1/releases/${encodeURIComponent(releaseID)}` });
  return res.release;
}

/** Build output lines (`stream` STDOUT/STDERR) since an ISO `createdAt` cursor. */
export async function getBuildLogs(c: LiaraClient, releaseID: string, since?: string): Promise<BuildLogs> {
  return c.request(BuildLogsSchema, { path: `/v2/releases/${encodeURIComponent(releaseID)}/build-logs`, query: { since } });
}

/** Release states seen in liara-cli: BUILDING → PUSHING → DEPLOYING → READY | FAILED | CANCELED | TIMEDOUT | UNHEALTHY. */
export const RELEASE_READY = /^(READY|SUCCESS|DEPLOYED)$/i;
export const RELEASE_FAILED = /FAIL|CANCEL|ERROR|TIMEOUT|TIMEDOUT|UNHEALTHY/i;

export class ReleaseWaitError extends Error {
  override name = 'ReleaseWaitError';
  constructor(
    readonly reason: 'failed' | 'timeout',
    readonly state: string | undefined,
    readonly release: Release | undefined,
    readonly failReason?: string,
  ) {
    super(reason === 'failed' ? `release ended in state ${state}${failReason ? `: ${failReason}` : ''}` : `release did not finish in time (last state ${state ?? 'unknown'})`);
  }
}

export interface WaitForReleaseOptions {
  timeoutMs?: number;
  intervalMs?: number;
  onState?: (state: string, release: Release) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function failReasonText(v: unknown): string | undefined {
  if (!v) return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v).slice(0, 300);
}

/** Polls the releases list until `releaseID` is READY (resolves) or fails/times out (rejects with ReleaseWaitError). */
export async function waitForRelease(c: LiaraClient, name: string, releaseID: string, opts: WaitForReleaseOptions = {}): Promise<Release> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  let lastState: string | undefined;
  let last: Release | undefined;
  for (;;) {
    const page = await getReleases(c, name, 1, 10).catch(() => null);
    const release = page?.releases.find((r) => r._id === releaseID);
    if (release) {
      last = release;
      if (release.state !== lastState) {
        lastState = release.state;
        opts.onState?.(release.state, release);
      }
      if (RELEASE_READY.test(release.state)) return release;
      if (RELEASE_FAILED.test(release.state)) {
        const status = await getReleaseStatus(c, releaseID).catch(() => null);
        throw new ReleaseWaitError('failed', release.state, release, failReasonText(status?.failReason));
      }
    }
    if (now() - started >= timeoutMs) throw new ReleaseWaitError('timeout', lastState, last);
    await sleep(intervalMs);
  }
}
