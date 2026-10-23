/** Pure scans for env vars, database and disk needs over a ProjectSnapshot. */
import { isSecretKey } from '../../helpers';
import { allDeps, readJson, type PackageJson, type ProjectSnapshot } from './detect';

export interface EnvKey {
  key: string;
  required: boolean;
  example?: string;
  isSecret: boolean;
}

const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
const IGNORED_KEYS = /^(PORT|HOME|PATH|PWD|HOSTNAME|CI|TZ|LANG|npm_.*|VERCEL.*|NEXT_RUNTIME|NODE_OPTIONS)$/;
const OPTIONAL_KEYS = /^(NODE_ENV|DEBUG|LOG_LEVEL|HOST|APP_ENV|APP_DEBUG)$/;
const CODE_EXT = /\.(c|m)?(js|ts)x?$|\.py$|\.php$|\.go$|\.cs$|\.rb$/;

/** [regex, group index of the "has default" marker or 0] per language */
const PATTERNS: [RegExp, number][] = [
  [/process\.env\.([A-Z_][A-Z0-9_]*)(\s*(?:\|\||\?\?))?/g, 2],
  [/process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\](\s*(?:\|\||\?\?))?/g, 2],
  [/import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g, 0],
  [/os\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g, 0],
  [/os\.(?:environ\.get|getenv)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*(,)?/g, 2],
  [/\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*(,)?/g, 2],
  [/os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g, 0],
  [/GetEnvironmentVariable\(\s*"([A-Z_][A-Z0-9_]*)"/g, 0],
];

function parseEnvExample(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2]!.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim();
    out.push({ key: m[1]!, value });
  }
  return out;
}

export function scanEnvKeys(snap: ProjectSnapshot, opts: { maxFiles?: number; maxKeys?: number } = {}): EnvKey[] {
  const keys = new Map<string, EnvKey>();
  const add = (key: string, required: boolean, example?: string) => {
    if (IGNORED_KEYS.test(key)) return;
    const req = required && !OPTIONAL_KEYS.test(key);
    const cur = keys.get(key);
    const isSecret = isSecretKey(key);
    const shownExample = example && !isSecret ? example.slice(0, 60) : undefined;
    if (cur) {
      cur.required ||= req;
      cur.example ??= shownExample;
    } else {
      keys.set(key, { key, required: req, example: shownExample, isSecret });
    }
  };
  for (const f of EXAMPLE_FILES) {
    const text = snap.read(f);
    if (text) for (const { key, value } of parseEnvExample(text)) add(key, true, value || undefined);
  }
  const codeFiles = snap.files.filter((f) => CODE_EXT.test(f) && !/(^|\/)(test|tests|__tests__|spec)\//.test(f)).slice(0, opts.maxFiles ?? 800);
  for (const f of codeFiles) {
    const code = snap.read(f);
    if (!code) continue;
    for (const [re, defaultGroup] of PATTERNS) {
      for (const m of code.matchAll(re)) add(m[1]!, !(defaultGroup && m[defaultGroup]));
    }
  }
  return [...keys.values()].sort((a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key)).slice(0, opts.maxKeys ?? 40);
}

export type DatabaseKind = 'postgres' | 'mysql' | 'mongo' | 'redis';

export function detectDatabase(snap: ProjectSnapshot): { kind: DatabaseKind | null; evidence?: string } {
  const deps = allDeps(readJson<PackageJson>(snap, 'package.json'));
  const text = [snap.read('requirements.txt'), snap.read('pyproject.toml'), snap.read('go.mod'), snap.read('composer.json')].join('\n').toLowerCase();
  const prisma = snap.read('prisma/schema.prisma');
  const prismaProvider = prisma ? /provider\s*=\s*"(postgresql|mysql|mongodb|sqlite|sqlserver)"/.exec(prisma)?.[1] : undefined;
  const envExample = (snap.read('.env.example') ?? '').toLowerCase();
  const checks: [DatabaseKind, boolean, string][] = [
    ['postgres', Boolean(deps.pg || deps.postgres || deps['pg-promise'] || prismaProvider === 'postgresql' || /psycopg|asyncpg|lib\/pq|jackc\/pgx/.test(text) || /db_connection=pgsql/.test(envExample)), 'PostgreSQL client in dependencies'],
    ['mysql', Boolean(deps.mysql || deps.mysql2 || prismaProvider === 'mysql' || /mysqlclient|pymysql|mysql-connector|go-sql-driver\/mysql/.test(text) || /db_connection=mysql/.test(envExample)), 'MySQL client in dependencies'],
    ['mongo', Boolean(deps.mongoose || deps.mongodb || prismaProvider === 'mongodb' || /pymongo|motor|mongoengine|mongo-driver/.test(text)), 'MongoDB client in dependencies'],
    ['redis', Boolean(deps.redis || deps.ioredis || deps.bullmq || deps.bull || /\bredis\b|celery/.test(text)), 'Redis client in dependencies'],
  ];
  const hit = checks.find(([, yes]) => yes);
  return hit ? { kind: hit[0], evidence: hit[2] } : { kind: null };
}

const HEAVY_DEPS = ['puppeteer', 'playwright', 'sharp', 'canvas', '@tensorflow/tfjs-node', 'tensorflow', 'torch', 'onnxruntime-node', 'opencv-python', 'fluent-ffmpeg'];

/** Memory/CPU-hungry dependencies that justify a bigger plan. */
export function detectNotableDeps(snap: ProjectSnapshot): string[] {
  const deps = allDeps(readJson<PackageJson>(snap, 'package.json'));
  const py = `${snap.read('requirements.txt') ?? ''}\n${snap.read('pyproject.toml') ?? ''}`.toLowerCase();
  return HEAVY_DEPS.filter((d) => deps[d] || new RegExp(`(^|[\\s"'])${d.replace(/[/.]/g, '\\$&')}([\\s=<>~"']|$)`, 'm').test(py));
}

export function detectDiskNeed(snap: ProjectSnapshot): { needsDisk: boolean; evidence?: string } {
  const deps = allDeps(readJson<PackageJson>(snap, 'package.json'));
  if (deps['better-sqlite3'] || deps.sqlite3 || deps.sqlite) return { needsDisk: true, evidence: 'uses an SQLite file database' };
  if (deps.multer || deps.formidable || deps.busboy || deps['express-fileupload']) return { needsDisk: true, evidence: 'accepts file uploads' };
  if (snap.files.some((f) => /^(uploads?|media)\//.test(f))) return { needsDisk: true, evidence: 'has an uploads/media folder' };
  const settings = snap.files.find((f) => f.endsWith('settings.py'));
  if (settings && /MEDIA_ROOT/.test(snap.read(settings) ?? '')) return { needsDisk: true, evidence: 'Django MEDIA_ROOT configured' };
  if (snap.files.some((f) => f.endsWith('.sqlite3') || f.endsWith('.db'))) return { needsDisk: true, evidence: 'contains a local database file' };
  return { needsDisk: false };
}
