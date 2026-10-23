/**
 * MCP smoke test over stdio, the way Claude Desktop / Cursor talk to the server.
 *
 *   npm run mcp:smoke -- --sim     against the LIARA_FAKE simulator (offline)
 *   npm run mcp:smoke              against the real Liara account (needs DEMO_APP_NAME)
 *
 * Checks: tool list and annotations, a read tool, risk-1 refusal without
 * `confirm`, a confirmed + verified restart, risk-2 refusal without the typed
 * app name, the access-log limitation, and diagnose_app.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getConfig, ROOT_DIR } from '../src/config';
import { SIM_DEMO_APP } from '../src/sim/deps';
import { Acceptance, assert } from './acceptance/harness';

const sim = process.argv.includes('--sim');

type ToolText = { isError?: boolean; content: { type: string; text?: string }[] };
const textOf = (r: unknown) => ((r as ToolText).content ?? []).map((c) => c.text ?? '').join('\n');

async function main() {
  if (sim) process.env.LIARA_API_TOKEN ||= 'simulated';
  const app = sim ? SIM_DEMO_APP : getConfig().liara.demoAppName;
  if (!app) {
    console.error('DEMO_APP_NAME is not set (or pass --sim).');
    process.exit(2);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/mcp/server.ts'], cwd: ROOT_DIR, env: { ...env, LIARA_FAKE: sim ? '1' : '0' }, stderr: 'ignore' });
  const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });
  const t = new Acceptance(`MCP smoke — ${sim ? 'SIMULATOR (LIARA_FAKE=1)' : 'live Liara'}, app "${app}"`);
  await client.connect(transport);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  try {
    await t.check('tools/list: 36 tools, risk annotations', async () => {
      const { tools } = await client.listTools();
      assert(tools.length === 36, `${tools.length} tools`);
      assert(tools.find((x) => x.name === 'delete_app')?.annotations?.destructiveHint === true, 'delete_app is not destructive');
      assert(tools.find((x) => x.name === 'list_apps')?.annotations?.readOnlyHint === true, 'list_apps is not read-only');
      return `${tools.length} tools`;
    });

    await t.check('read tool: list_apps', async () => {
      const r = await call('list_apps', {});
      assert(!(r as ToolText).isError && textOf(r).includes(app), textOf(r).slice(0, 120));
      return textOf(r).split('\n')[0]!;
    });

    await t.check('risk 1 without confirm is refused with consequences', async () => {
      const r = await call('restart_app', { appName: app });
      assert((r as ToolText).isError === true && textOf(r).includes('نیاز به تأیید'), textOf(r).slice(0, 120));
      return textOf(r).split('\n')[0]!;
    });

    await t.check('risk 1 with confirm runs and is verified', async () => {
      const r = await call('restart_app', { appName: app, confirm: true });
      assert(!(r as ToolText).isError && textOf(r).includes('بررسی بعد از اقدام'), textOf(r).slice(0, 160));
      return textOf(r).split('\n').slice(0, 2).join(' — ').slice(0, 110);
    });

    await t.check('risk 2 without the typed app name is refused', async () => {
      const r = await call('delete_app', { appName: app, confirm: true });
      assert((r as ToolText).isError === true && textOf(r).includes('confirmAppName'), textOf(r).slice(0, 120));
      return 'refused';
    });

    await t.check('access logs → explicit limitation', async () => {
      const r = await call('report_limitation', { topic: 'access_logs' });
      assert(textOf(r).includes('محدودیت'), textOf(r).slice(0, 120));
      return textOf(r).split('\n')[0]!.slice(0, 100);
    });

    await t.check('diagnose_app returns a diagnosis', async () => {
      const r = await call('diagnose_app', { appName: app });
      assert(!(r as ToolText).isError && /summaryFa|severity/.test(textOf(r)), textOf(r).slice(0, 160));
      return textOf(r).split('\n')[0]!.slice(0, 100);
    });
  } finally {
    await client.close();
  }
  process.exit(t.print() ? 0 : 1);
}

main().catch((err) => {
  console.error('mcp smoke crashed:', (err as Error).message);
  process.exit(1);
});
