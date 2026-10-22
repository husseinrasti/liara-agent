import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { create } from 'tar';

/** Minimal Node app used by the probe (and as the first "healthy" release of the demo app). */
export function probeSourceFiles(appName: string, port = 3000): Record<string, string> {
  return {
    'package.json': JSON.stringify(
      { name: 'liara-agent-probe', version: '1.0.0', private: true, scripts: { start: 'node index.js' } },
      null,
      2,
    ),
    'index.js': [
      "const http = require('http');",
      `const port = Number(process.env.PORT) || ${port};`,
      'http',
      '  .createServer((req, res) => {',
      '    const started = Date.now();',
      "    res.writeHead(200, { 'content-type': 'text/plain' });",
      "    res.end('ok');",
      '    console.log(`${req.method} ${req.url} 200 ${Date.now() - started}ms`);',
      '  })',
      "  .listen(port, () => console.log('probe app listening on port ' + port));",
      '',
    ].join('\n'),
    'liara.json': JSON.stringify({ app: appName, port, platform: 'node' }, null, 2),
  };
}

/** Writes the files into `dir` and packs them as a gzipped tarball at `outFile`. */
export async function buildTarGz(dir: string, files: Record<string, string>, outFile: string): Promise<Buffer> {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  mkdirSync(path.dirname(outFile), { recursive: true });
  await create({ gzip: true, cwd: dir, file: outFile, portable: true }, Object.keys(files));
  return readFileSync(outFile);
}
