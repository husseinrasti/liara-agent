/** Loads and validates playbooks from YAML (cached). */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { ROOT_DIR } from '../../config';
import { PlaybookSchema, type Playbook } from './schema';

export const PLAYBOOKS_DIR = path.join(ROOT_DIR, 'src/agent/playbooks');

let cache: Playbook[] | null = null;

export function loadPlaybooks(dir = PLAYBOOKS_DIR): Playbook[] {
  if (cache && dir === PLAYBOOKS_DIR) return cache;
  if (!existsSync(dir)) return [];
  const list = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => {
      const parsed = PlaybookSchema.safeParse(parse(readFileSync(path.join(dir, f), 'utf8')));
      if (!parsed.success) throw new Error(`invalid playbook ${f}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return parsed.data;
    });
  if (dir === PLAYBOOKS_DIR) cache = list;
  return list;
}

export function getPlaybook(id: string | undefined): Playbook | undefined {
  return id ? loadPlaybooks().find((p) => p.id === id) : undefined;
}
