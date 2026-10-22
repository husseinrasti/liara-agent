import type { LiaraClient } from '../client';
import { AnyBodySchema } from '../types';

type Toggle = 'enable' | 'disable';
const toggle = (on: boolean): Toggle => (on ? 'enable' : 'disable');
const byId = (projectId: string) => `/v1/projects/${encodeURIComponent(projectId)}`;

/** These settings endpoints take the app `_id`, not its name. */
export async function setZeroDowntime(c: LiaraClient, projectId: string, on: boolean): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: `${byId(projectId)}/zero-downtime/${toggle(on)}` });
}

export async function setDefaultSubdomain(c: LiaraClient, projectId: string, on: boolean): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: `${byId(projectId)}/default-subdomain/${toggle(on)}` });
}

export async function setFixedIp(c: LiaraClient, projectId: string, on: boolean): Promise<unknown> {
  return c.request(AnyBodySchema, { method: 'POST', path: `${byId(projectId)}/fixed-ip/${toggle(on)}` });
}

export async function setReadOnly(c: LiaraClient, projectId: string, on: boolean): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: `${byId(projectId)}/read-only/${toggle(on)}` });
}
