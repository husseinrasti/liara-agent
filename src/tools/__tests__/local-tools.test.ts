import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { list } from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../../config';
import { analyzeDir } from '../local/analyze-project';
import { buildArchive } from '../local/build-source-archive';
import { httpProbe, validatePublicUrl } from '../local/http-probe';
import { loadSections, searchSections, tokenize } from '../local/search-docs';
import { cleanShellOutput, validateShellCommand } from '../../liara/endpoints/shell';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'liara-agent-proj-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe('analyze_project', () => {
  it('detects the placeholder demo-app as node on port 3000', () => {
    const a = analyzeDir(path.join(ROOT_DIR, 'demo-app'));
    expect(a.platform).toBe('node');
    expect(a.port).toBe(3000);
    expect(a.startCommand).toBe('node index.js');
  });

  it('detects Next.js, env keys, database and secrets', () => {
    const dir = project({
      'package.json': JSON.stringify({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15', react: '19', pg: '8' }, engines: { node: '22.x' } }),
      '.env.example': 'DATABASE_URL=postgres://user:pass@host/db\nNEXT_PUBLIC_SITE_NAME=shop\nNODE_ENV=development\n',
      '.env': 'DATABASE_URL=real-secret\n',
      'app/page.tsx': 'export default function P(){ return process.env.NEXT_PUBLIC_SITE_NAME ?? "x" }',
      'lib/pay.ts': 'const key = process.env.PAYMENT_API_KEY; const opt = process.env.FEATURE_FLAG || "off";',
    });
    const a = analyzeDir(dir);
    expect(a.platform).toBe('next');
    expect(a.port).toBe(3000);
    expect(a.nodeVersion).toBe('22.x');
    expect(a.needsDatabase).toBe('postgres');
    const keys = Object.fromEntries(a.envKeys.map((k) => [k.key, k]));
    expect(keys.DATABASE_URL).toMatchObject({ required: true, isSecret: false });
    expect(keys.PAYMENT_API_KEY).toMatchObject({ required: true, isSecret: true, example: undefined });
    expect(keys.FEATURE_FLAG!.required).toBe(false);
    expect(keys.NODE_ENV!.required).toBe(false);
    expect(a.warnings.join(' ')).toMatch(/\.env will NOT be uploaded/);
  });

  it.each([
    [{ 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }), artisan: '' }, 'laravel', 80],
    [{ 'manage.py': '', 'requirements.txt': 'Django==5\n' }, 'django', 80],
    [{ 'requirements.txt': 'flask\ngunicorn\n', 'app.py': 'import os\nos.environ["SECRET_KEY"]' }, 'flask', 80],
    [{ 'index.html': '<h1>hi</h1>' }, 'static', 80],
    [{ 'go.mod': 'module x' }, 'go', 8080],
    [{ 'api.csproj': '<Project/>' }, 'dotnet', 80],
    [{ Dockerfile: 'FROM node:22\nEXPOSE 8000\n', 'package.json': '{}' }, 'docker', 8000],
    [{ 'liara.json': JSON.stringify({ platform: 'vue', port: 80 }), 'package.json': '{}' }, 'vue', 80],
  ])('detects %#', (files, platform, port) => {
    const a = analyzeDir(project(files as Record<string, string>));
    expect(a.platform).toBe(platform);
    expect(a.port).toBe(port);
  });

  it('reads the listening port from a node entry file', () => {
    const a = analyzeDir(project({ 'package.json': JSON.stringify({ main: 'server.js', scripts: { start: 'node server.js' } }), 'server.js': 'app.listen(process.env.PORT || 8081)' }));
    expect(a.port).toBe(8081);
  });
});

describe('build_source_archive', () => {
  it('excludes node_modules, .git, .env and gitignored files but keeps dist', async () => {
    const dir = project({
      'package.json': '{"scripts":{"start":"node index.js"}}',
      'index.js': 'console.log(1)',
      'dist/bundle.js': '1',
      'node_modules/x/index.js': '1',
      '.git/HEAD': 'ref: refs/heads/main',
      '.env': 'SECRET=1',
      '.env.example': 'SECRET=',
      '.gitignore': 'logs/\n*.tmp\n',
      'logs/a.log': '1',
      'notes.tmp': '1',
      'src/.gitignore': 'generated.js\n',
      'src/generated.js': '1',
      'src/keep.js': '1',
    });
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'liara-agent-arch-')), 'src.tar.gz');
    const res = await buildArchive(dir, out);
    const entries: string[] = [];
    await list({ file: out, onReadEntry: (e) => void entries.push(e.path) });
    expect(entries.sort()).toEqual(['.env.example', '.gitignore', 'dist/bundle.js', 'index.js', 'package.json', 'src/.gitignore', 'src/keep.js'].sort());
    expect(res.excludedSecrets).toEqual(['.env']);
    expect(res.fileCount).toBe(7);
  });
});

describe('search_docs', () => {
  const sections = loadSections();
  it('loads knowledge sections', () => {
    expect(sections.length).toBeGreaterThan(5);
  });
  it('finds port and IRNIC guidance (Latin and Persian queries)', () => {
    expect(searchSections(sections, 'default port node')[0]!.heading).toMatch(/پورت|port/i);
    expect(searchSections(sections, 'ایرنیک NS')[0]!.path).toBe('src/knowledge/irnic.md');
    expect(searchSections(sections, 'zzzz-not-there')).toEqual([]);
  });
  it('tokenizes Persian: unifies Arabic letter variants and splits on ZWNJ (stem match)', () => {
    expect(tokenize('دامنه‌ي كاربر')).toEqual(['دامنه', 'کاربر']);
  });
});

describe('exec_shell guard', () => {
  it('allows read-only commands only', () => {
    expect(validateShellCommand('df -h').ok).toBe(true);
    expect(validateShellCommand('npm ls --depth=0').ok).toBe(true);
    for (const bad of ['rm -rf /', 'ls; rm x', 'cat $HOME/x', 'cat .env', 'curl http://x', 'node app.js', 'echo `id`']) {
      expect(validateShellCommand(bad).ok, bad).toBe(false);
    }
  });
  it('redacts env values and strips terminal noise', () => {
    expect(cleanShellOutput('env', '\u001b[32mNODE_ENV=production\u001b[0m\r\nDB_PASSWORD=x\n')).toBe('NODE_ENV=••••\nDB_PASSWORD=••••');
    expect(cleanShellOutput('cat config', 'API_TOKEN=abc\nname=shop')).toBe('API_TOKEN=••••\nname=shop');
  });
});

describe('http probe', () => {
  let server: ReturnType<typeof createServer>;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/fail') {
        res.writeHead(500);
        res.end('Internal Server Error');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<h1>ok</h1>');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it('measures status and latency', async () => {
    const ok = await httpProbe(`${base}/`, { samples: 2 });
    expect(ok).toMatchObject({ status: 200, ok: true, bodySnippet: 'ok', samples: 2 });
    const bad = await httpProbe(`${base}/fail`, { samples: 1 });
    expect(bad).toMatchObject({ status: 500, ok: false });
  });

  it('reports no-response as status 0', async () => {
    const res = await httpProbe('http://127.0.0.1:9/', { samples: 1, timeoutMs: 1000 });
    expect(res.status).toBe(0);
    expect(res.error).toBeTruthy();
  });

  it('only allows public http(s) URLs in the tool', () => {
    expect(validatePublicUrl('https://shop.liara.run/').ok).toBe(true);
    for (const u of ['http://localhost:3000', 'http://127.0.0.1', 'http://10.0.0.5', 'file:///etc/passwd', 'not a url']) expect(validatePublicUrl(u).ok, u).toBe(false);
  });
});
