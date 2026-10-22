import type { LiaraClient } from '../client';
import { AnyBodySchema, DisksResponseSchema } from '../types';

/** Disks of an app. Note: this endpoint takes the app `_id`. */
export async function getDisks(c: LiaraClient, projectId: string) {
  const res = await c.request(DisksResponseSchema, { path: `/v1/projects/${encodeURIComponent(projectId)}/disks` });
  return { disks: res.disks ?? [], mounts: res.mounts ?? [] };
}

export async function createDisk(c: LiaraClient, appName: string, disk: { name: string; sizeGB: number }): Promise<void> {
  await c.request(AnyBodySchema, {
    method: 'POST',
    path: `/v1/projects/${encodeURIComponent(appName)}/disks`,
    body: { name: disk.name, size: String(disk.sizeGB) },
  });
}

export async function resizeDisk(c: LiaraClient, appName: string, diskName: string, sizeGB: number): Promise<void> {
  await c.request(AnyBodySchema, {
    method: 'POST',
    path: `/v1/projects/${encodeURIComponent(appName)}/disks/${encodeURIComponent(diskName)}/resize`,
    body: { size: String(sizeGB) },
  });
}
