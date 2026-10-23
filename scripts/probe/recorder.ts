import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LiaraClient, RawResponse, RequestInit } from '../../src/liara/client';
import { sanitize } from '../lib/sanitize';

export interface StepRow {
  id: string;
  title: string;
  call: string;
  status: number | 'ERR' | '-';
  ms: number | null;
  note: string;
}

/** Records every probe call as `<id>.raw.json` (gitignored) and a sanitized `<id>.json`. */
export class Recorder {
  readonly rows: StepRow[] = [];

  constructor(
    private readonly client: LiaraClient,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async call(id: string, title: string, init: RequestInit): Promise<RawResponse | null> {
    const method = init.method ?? 'GET';
    process.stderr.write(`… ${id} ${method} ${init.path}\n`);
    const request = { method, path: init.path, query: init.query, body: init.multipart ? '<multipart>' : init.body };
    try {
      const res = await this.client.requestRaw({ ...init, retries: init.retries ?? 0 });
      this.save(id, { request, status: res.status, durationMs: res.durationMs, body: res.body });
      this.rows.push({ id, title, call: `${method} ${init.path}`, status: res.status, ms: res.durationMs, note: brief(res) });
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.save(id, { request, error: message });
      this.rows.push({ id, title, call: `${method} ${init.path}`, status: 'ERR', ms: null, note: message.slice(0, 60) });
      return null;
    }
  }

  /** Saves a non-HTTP observation (poll sequences, health checks, derived facts). */
  record(id: string, title: string, data: unknown, note = '', status: StepRow['status'] = '-'): void {
    this.save(id, data);
    this.rows.push({ id, title, call: '(derived)', status, ms: null, note });
  }

  private save(id: string, data: unknown): void {
    writeFileSync(path.join(this.dir, `${id}.raw.json`), JSON.stringify(data, null, 2));
    writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(sanitize(data), null, 2));
  }

  printTable(): void {
    const header = ['step', 'call', 'status', 'ms', 'note'];
    const lines = this.rows.map((r) => [r.id, r.call.slice(0, 58), String(r.status), r.ms === null ? '' : String(r.ms), r.note]);
    const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
    const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join('  ');
    console.log(fmt(header));
    console.log(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const l of lines) console.log(fmt(l));
  }
}

function brief(res: RawResponse): string {
  const b = res.body;
  if (Array.isArray(b)) return `array(${b.length})`;
  if (b && typeof b === 'object') {
    const o = b as Record<string, unknown>;
    if (!res.ok && typeof o.message === 'string') return `msg: ${o.message.slice(0, 60)}`;
    return `keys: ${Object.keys(o).slice(0, 6).join(',')}`;
  }
  if (typeof b === 'string') return `text: ${b.slice(0, 50).replace(/\s+/g, ' ')}`;
  return b === undefined ? 'empty' : typeof b;
}
