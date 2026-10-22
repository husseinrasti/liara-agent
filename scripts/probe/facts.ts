import type { RawResponse } from '../../src/liara/client';
import type { Plan } from '../../src/liara/plans';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyJson = any;

export interface ArrSummary {
  status: number | null;
  count: number | null;
  first?: string;
  last?: string;
}

export interface MetricSummary {
  status: number | null;
  series: number | null;
  points: number | null;
  firstTs?: number;
  lastTs?: number;
}

export interface ProbeFacts {
  ranAt: string;
  appName: string;
  appCreated: boolean;
  createBody?: Record<string, unknown>;
  createAttempts: { body: Record<string, unknown>; status: number | null; message?: string }[];
  meTopKeys: string[];
  planFieldNames: string[];
  plans: Plan[];
  bundlePlansSample?: unknown;
  balance: { source: string; value: number | null };
  projectDetailKeys: string[];
  projectHourlyPrice?: number;
  projectPlanID?: string;
  logs: Record<string, ArrSummary>;
  logLineSample?: unknown;
  events: Record<string, { status: number | null; rows: number | null }>;
  eventSample?: { metaData?: unknown; firstRow?: unknown };
  metrics: Record<string, MetricSummary>;
  release: {
    releaseID?: string;
    states: string[];
    finalState?: string;
    durationSec?: number;
    releaseKeys?: string[];
    deployBodyAccepted?: Record<string, unknown>;
  };
  buildLogs: Record<string, ArrSummary>;
  buildLogSample?: unknown;
  health: { url: string; status: number | null; latencyMs: number | null; attempts: number; bodySnippet?: string };
  envs: {
    semantics: 'merge' | 'replace' | 'unknown';
    keysBefore: string[];
    keysAfterA: string[];
    keysAfterB: string[];
    restoreStatus?: number | null;
    keysAfterRestore?: string[];
    note?: string;
  };
  restart: { status: number | null; appletStates: string[] };
  rollback: {
    sourceReuseStatus: number | null;
    sourceReuseFinalState?: string;
    candidates: { call: string; status: number | null; message?: string }[];
    decision: string;
  };
  domain: {
    name?: string;
    createStatus: number | null;
    createMessage?: string;
    listStatus: number | null;
    checkStatus: number | null;
    deleteStatus: number | null;
    cname?: string;
  };
  errors: string[];
}

export function newFacts(appName: string): ProbeFacts {
  return {
    ranAt: new Date().toISOString(),
    appName,
    appCreated: false,
    createAttempts: [],
    meTopKeys: [],
    planFieldNames: [],
    plans: [],
    balance: { source: 'none', value: null },
    projectDetailKeys: [],
    logs: {},
    events: {},
    metrics: {},
    release: { states: [] },
    buildLogs: {},
    health: { url: '', status: null, latencyMs: null, attempts: 0 },
    envs: { semantics: 'unknown', keysBefore: [], keysAfterA: [], keysAfterB: [] },
    restart: { status: null, appletStates: [] },
    rollback: { sourceReuseStatus: null, candidates: [], decision: '' },
    domain: { createStatus: null, listStatus: null, checkStatus: null, deleteStatus: null },
    errors: [],
  };
}

export function arrSummary(res: RawResponse | null, timeKey = 'datetime'): ArrSummary {
  if (!res) return { status: null, count: null };
  const b = res.body as AnyJson;
  if (Array.isArray(b?.data) && b.data.some((d: AnyJson) => Array.isArray(d?.values))) {
    const ts: string[] = b.data.flatMap((d: AnyJson) => (d.values ?? []).map((v: AnyJson[]) => String(v[0])));
    ts.sort((x, y) => (x.length - y.length) || x.localeCompare(y));
    return { status: res.status, count: ts.length, first: ts[0], last: ts[ts.length - 1] };
  }
  const arr: AnyJson[] | null = Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : null;
  if (!arr) return { status: res.status, count: null };
  const first = arr[0]?.[timeKey] ?? arr[0]?.createdAt;
  const last = arr[arr.length - 1]?.[timeKey] ?? arr[arr.length - 1]?.createdAt;
  return { status: res.status, count: arr.length, first: first ? String(first) : undefined, last: last ? String(last) : undefined };
}

export function metricSummary(res: RawResponse | null): MetricSummary {
  if (!res) return { status: null, series: null, points: null };
  const result = (res.body as AnyJson)?.result;
  if (!Array.isArray(result)) return { status: res.status, series: null, points: null };
  const all: number[] = [];
  for (const s of result) for (const v of s?.values ?? []) if (Array.isArray(v)) all.push(Number(v[0]));
  all.sort((a, b) => a - b);
  return { status: res.status, series: result.length, points: all.length, firstTs: all[0], lastTs: all[all.length - 1] };
}

export function eventRows(res: RawResponse | null): number | null {
  const data = (res?.body as AnyJson)?.data;
  if (!Array.isArray(data)) return null;
  return data.reduce((n: number, d: AnyJson) => n + (Array.isArray(d?.values) ? d.values.length : 0), 0);
}

export function envKeys(res: RawResponse | null): string[] {
  const envs = (res?.body as AnyJson)?.project?.envs;
  return Array.isArray(envs) ? envs.map((e: AnyJson) => String(e.key)).sort() : [];
}
