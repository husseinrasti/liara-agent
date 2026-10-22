import type { LiaraClient } from '../client';
import { AnyBodySchema, DomainCheckSchema, DomainsResponseSchema, type Domain, type DomainCheck } from '../types';

export async function listDomains(c: LiaraClient, appName: string): Promise<Domain[]> {
  const res = await c.request(DomainsResponseSchema, { path: '/v1/domains', query: { project: appName } });
  return res.domains ?? [];
}

/** Attaches a custom domain to an app. Returns the created domain (re-read from the list). */
export async function addDomain(c: LiaraClient, appName: string, domain: string): Promise<Domain | null> {
  await c.request(AnyBodySchema, { method: 'POST', path: '/v1/domains', body: { name: domain, project: appName, type: 'PROJECT' } });
  const all = await listDomains(c, appName);
  return all.find((d) => d.name === domain) ?? null;
}

export async function setDomainProject(c: LiaraClient, domainID: string, projectID: string): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: '/v1/domains/set-project', body: { domainID, projectID } });
}

export async function checkDomain(c: LiaraClient, domainId: string): Promise<DomainCheck['domain']> {
  const res = await c.request(DomainCheckSchema, { path: `/v1/domains/${encodeURIComponent(domainId)}/check` });
  return res.domain;
}

export async function enableSsl(c: LiaraClient, domain: string): Promise<unknown> {
  return c.request(AnyBodySchema, { method: 'POST', path: '/v1/domains/provision-ssl-certs', body: { domain } });
}

export async function disableSsl(c: LiaraClient, domainId: string): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: `/v1/domains/${encodeURIComponent(domainId)}/ssl/disable` });
}

export async function deleteDomain(c: LiaraClient, domainId: string): Promise<void> {
  await c.request(AnyBodySchema, { method: 'DELETE', path: `/v1/domains/${encodeURIComponent(domainId)}` });
}

/** True when Liara reports the domain as verified/connected. */
export function isDomainVerified(d: Pick<Domain, 'status'>): boolean {
  return /^(ACTIVE|VERIFIED|OK|CONNECTED)$/i.test(d.status ?? '');
}

/** True when the SSL certificate is issued and active. */
export function isSslActive(d: Pick<Domain, 'certificatesStatus'>): boolean {
  return /^(ACTIVE|ISSUED|VALID|OK)$/i.test(d.certificatesStatus ?? '');
}
