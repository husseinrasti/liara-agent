import { describe, expect, it } from 'vitest';
import { clusterLogs, extractStackTraces, isErrorLine, normalizeSignature } from '../logs';

const at = (i: number) => `2026-10-22T10:${String(i).padStart(2, '0')}:00.000Z`;

describe('normalizeSignature', () => {
  it('collapses volatile parts', () => {
    const a = normalizeSignature('2026-10-22T10:00:01Z GET /api/products/123 500 45ms req=9f8e7d6c5b4a3210');
    const b = normalizeSignature('2026-10-22T10:05:09Z GET /api/products/987 500 12ms req=0123456789abcdef');
    expect(a).toBe(b);
  });
});

describe('clusterLogs', () => {
  it('groups repeated lines, puts errors first', () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => ({ t: at(i), msg: `GET / 200 ${i}ms` })),
      ...Array.from({ length: 5 }, (_, i) => ({ t: at(30 + i), msg: `Error: connect ECONNREFUSED 127.0.0.1:${5432 + i}` })),
      { t: at(50), msg: 'memory usage: 480 MB' },
    ];
    const clusters = clusterLogs(lines);
    expect(clusters[0]).toMatchObject({ count: 5, isError: true, firstTs: at(30), lastTs: at(34) });
    expect(clusters[1]).toMatchObject({ count: 20, isError: false });
    expect(clusters).toHaveLength(3);
  });

  it('respects the limit', () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({ t: at(i), msg: `unique message ${'x'.repeat(i)}` }));
    expect(clusterLogs(lines, 12)).toHaveLength(12);
  });
});

describe('extractStackTraces', () => {
  it('extracts a Node.js crash trace', () => {
    const lines = [
      'server started on 3000',
      "TypeError: Cannot read properties of undefined (reading 'id')",
      '    at handler (/app/index.js:12:20)',
      '    at Server.<anonymous> (/app/index.js:30:5)',
      '    at Server.emit (node:events:519:28)',
      'next line after crash',
    ];
    const traces = extractStackTraces(lines);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.split('\n')).toHaveLength(4);
    expect(traces[0]).toContain("reading 'id'");
  });

  it('extracts a Python traceback including the exception line', () => {
    const lines = [
      'Traceback (most recent call last):',
      '  File "/app/main.py", line 3, in <module>',
      '    import flask_sqlalchemy',
      "ModuleNotFoundError: No module named 'flask_sqlalchemy'",
    ];
    const [trace] = extractStackTraces(lines);
    expect(trace).toContain('ModuleNotFoundError');
    expect(trace!.split('\n')).toHaveLength(4);
  });

  it('dedupes identical traces and caps the count', () => {
    const crash = ['Error: boom', '    at a (/app/x.js:1:1)'];
    expect(extractStackTraces([...crash, ...crash, ...crash])).toHaveLength(1);
  });
});

describe('isErrorLine', () => {
  it('matches common error words', () => {
    for (const l of ['FATAL ERROR: Reached heap limit', 'UnhandledPromiseRejection', 'Killed', 'ECONNRESET']) expect(isErrorLine(l)).toBe(true);
    expect(isErrorLine('GET / 200 3ms')).toBe(false);
  });
});
