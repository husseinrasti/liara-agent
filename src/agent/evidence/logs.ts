/** Pure log analysis helpers (no LLM). Used by get_app_logs and collect_evidence. */

export const ERROR_LINE_RE = /error|exception|fatal|unhandled|traceback|ENOENT|ECONN|OOM|killed|panic|refused|denied|timed? ?out/i;

export function isErrorLine(msg: string): boolean {
  return ERROR_LINE_RE.test(msg);
}

export interface LogEntry {
  t: string;
  msg: string;
  type?: string;
}

/** Normalizes volatile parts (times, ids, numbers, paths, urls) so similar lines share a signature. */
export function normalizeSignature(line: string): string {
  return line
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/https?:\/\/[^\s"')]+/g, '<url>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/(?:\/[\w.-]+){2,}(?::\d+(?::\d+)?)?/g, '<path>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export interface LogCluster {
  signature: string;
  count: number;
  firstTs: string;
  lastTs: string;
  sample: string;
  isError: boolean;
}

/** Groups lines by signature; errors first, then by frequency. */
export function clusterLogs(lines: LogEntry[], limit = 12): LogCluster[] {
  const map = new Map<string, LogCluster>();
  for (const l of lines) {
    const msg = l.msg.trim();
    if (!msg) continue;
    const signature = normalizeSignature(msg);
    const c = map.get(signature);
    if (c) {
      c.count++;
      if (l.t < c.firstTs) c.firstTs = l.t;
      if (l.t > c.lastTs) c.lastTs = l.t;
    } else {
      map.set(signature, { signature, count: 1, firstTs: l.t, lastTs: l.t, sample: msg.slice(0, 300), isError: isErrorLine(msg) });
    }
  }
  return [...map.values()]
    .sort((a, b) => Number(b.isError) - Number(a.isError) || b.count - a.count || b.lastTs.localeCompare(a.lastTs))
    .slice(0, limit);
}

const TRACE_START = /(^|\s)(?:(?:\w*Error|\w*Exception|Unhandled|FATAL)\b|Traceback \(most recent call last\)|panic:|Fatal error)/;
const TRACE_FRAME = /^\s+at\s|^\s+File "|^\s{2,}\S|^\s*\^+\s*$|^Caused by|^\s*\.\.\.\s*\d* more|^\w*(Error|Exception)(:|$)|^node:internal|^\s*\{$|^\s*\}$|^\s+\w+: /;

/** Extracts up to `max` distinct stack traces (each ≤ `maxLines` lines). */
export function extractStackTraces(lines: LogEntry[] | string[], max = 3, maxLines = 25): string[] {
  const msgs = lines.map((l) => (typeof l === 'string' ? l : l.msg));
  const traces: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < msgs.length && traces.length < max; i++) {
    const line = msgs[i]!;
    if (!TRACE_START.test(line)) continue;
    const block = [line];
    let j = i + 1;
    while (j < msgs.length && block.length < maxLines && (TRACE_FRAME.test(msgs[j]!) || /^\s+\S/.test(msgs[j]!))) {
      block.push(msgs[j]!);
      j++;
    }
    // Python tracebacks end with the exception line after the frames.
    if (/Traceback/.test(line) && j < msgs.length && /(Error|Exception)/.test(msgs[j]!) && block.length < maxLines) {
      block.push(msgs[j]!);
      j++;
    }
    const isTrace = block.length > 1 || /Error|Exception|panic/.test(line);
    const key = normalizeSignature(block.slice(0, 2).join('\n'));
    if (isTrace && !seen.has(key)) {
      seen.add(key);
      traces.push(block.join('\n'));
    }
    i = j - 1;
  }
  return traces;
}
