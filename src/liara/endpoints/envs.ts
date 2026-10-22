import type { LiaraClient } from '../client';
import { AnyBodySchema, type EnvVar } from '../types';
import { getApp } from './apps';

/**
 * `POST /v1/projects/update-envs` REPLACES the whole variable set (see API-NOTES),
 * and triggers a restart. These helpers implement merge/delete semantics on top.
 */
export const UPDATE_ENVS_REPLACES_ALL = true;

export async function getEnvs(c: LiaraClient, name: string): Promise<EnvVar[]> {
  return (await getApp(c, name)).envs ?? [];
}

/** Sends the complete variable set (low level). */
export async function setAllEnvs(c: LiaraClient, name: string, variables: { key: string; value: string }[]): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: '/v1/projects/update-envs', body: { project: name, variables } });
}

export class EncryptedEnvError extends Error {
  override name = 'EncryptedEnvError';
}

/** Pure merge used by updateEnvs/deleteEnvs (exported for tests). */
export function mergeEnvs(
  current: EnvVar[],
  set: Record<string, string> = {},
  unset: string[] = [],
): { key: string; value: string }[] {
  const removed = new Set(unset);
  const out = new Map<string, string>();
  for (const e of current) {
    if (removed.has(e.key) || e.key in set) continue;
    if (e.encrypted && (e.value === undefined || e.value === null)) {
      throw new EncryptedEnvError(`env ${e.key} is encrypted and its value is not readable; cannot re-send the full set`);
    }
    out.set(e.key, e.value ?? '');
  }
  for (const [k, v] of Object.entries(set)) if (!removed.has(k)) out.set(k, v);
  return [...out.entries()].map(([key, value]) => ({ key, value }));
}

/** Adds/overwrites `set` and removes `unset`, keeping every other variable. Returns the resulting keys. */
export async function updateEnvs(
  c: LiaraClient,
  name: string,
  set: Record<string, string> = {},
  unset: string[] = [],
): Promise<string[]> {
  const current = await getEnvs(c, name);
  const next = UPDATE_ENVS_REPLACES_ALL ? mergeEnvs(current, set, unset) : Object.entries(set).map(([key, value]) => ({ key, value }));
  await setAllEnvs(c, name, next);
  return next.map((v) => v.key);
}

export async function deleteEnvs(c: LiaraClient, name: string, keys: string[]): Promise<string[]> {
  return updateEnvs(c, name, {}, keys);
}
