import type { LiaraClient } from '../client';
import { AnyBodySchema, NetworksSchema } from '../types';

/** Private networks. Apps on g2 (new infrastructure) plans must be created inside one, or Liara answers `g2_plan_unavailable` [probe]. */
export async function listNetworks(c: LiaraClient): Promise<{ _id: string; name: string }[]> {
  return (await c.request(NetworksSchema, { path: '/v1/networks' })).networks ?? [];
}

export async function createNetwork(c: LiaraClient, name: string): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: '/v1/networks', body: { networkName: name } });
}

export const DEFAULT_NETWORK_NAME = 'liara-agent';

/** The network for a new app, like liara-cli `app:create`: the first existing one, else a new "liara-agent" network. */
export async function resolveNetwork(c: LiaraClient): Promise<{ _id: string; name: string; created: boolean }> {
  const existing = await listNetworks(c);
  if (existing[0]) return { ...existing[0], created: false };
  await createNetwork(c, DEFAULT_NETWORK_NAME);
  const created = (await listNetworks(c)).find((n) => n.name === DEFAULT_NETWORK_NAME);
  if (!created) throw new Error('network was created but is not listed');
  return { ...created, created: true };
}
