import type { LiaraClient } from '../client';
import {
  AnyBodySchema,
  AppletsResponseSchema,
  ProjectDetailsResponseSchema,
  ProjectsResponseSchema,
  ReleasesPageSchema,
  type Applet,
  type Project,
  type ProjectDetails,
  type ReleasesPage,
} from '../types';

export const appPath = (name: string) => `/v1/projects/${encodeURIComponent(name)}`;

export async function listApps(c: LiaraClient): Promise<Project[]> {
  const res = await c.request(ProjectsResponseSchema, { path: '/v1/projects' });
  return res.projects ?? [];
}

export async function getApp(c: LiaraClient, name: string): Promise<ProjectDetails> {
  const res = await c.request(ProjectDetailsResponseSchema, { path: appPath(name) });
  return res.project;
}

export interface CreateAppInput {
  name: string;
  planID: string;
  platform: string;
  bundlePlanID?: string;
  network?: string;
  readOnlyRootFilesystem?: boolean;
}

export async function createApp(c: LiaraClient, input: CreateAppInput): Promise<unknown> {
  const body: Record<string, unknown> = { name: input.name, planID: input.planID, platform: input.platform };
  if (input.bundlePlanID) body.bundlePlanID = input.bundlePlanID;
  if (input.network) body.network = input.network;
  if (input.readOnlyRootFilesystem !== undefined) body.readOnlyRootFilesystem = input.readOnlyRootFilesystem;
  return c.request(AnyBodySchema, { method: 'POST', path: '/v1/projects', body });
}

export async function deleteApp(c: LiaraClient, name: string): Promise<void> {
  await c.request(AnyBodySchema, { method: 'DELETE', path: appPath(name) });
}

export async function scaleApp(c: LiaraClient, name: string, scale: 0 | 1): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: `${appPath(name)}/actions/scale`, body: { scale } });
}

export async function restartApp(c: LiaraClient, name: string): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: `${appPath(name)}/actions/restart` });
}

export async function resizeApp(c: LiaraClient, name: string, planID: string): Promise<void> {
  await c.request(AnyBodySchema, { method: 'POST', path: `${appPath(name)}/resize`, body: { planID } });
}

export async function getApplets(c: LiaraClient, name: string): Promise<Applet[]> {
  const res = await c.request(AppletsResponseSchema, { path: `${appPath(name)}/applets` });
  return res.applets ?? [];
}

export async function getReleases(c: LiaraClient, name: string, page = 1, count = 10): Promise<ReleasesPage> {
  return c.request(ReleasesPageSchema, { path: `${appPath(name)}/releases`, query: { page, count } });
}
