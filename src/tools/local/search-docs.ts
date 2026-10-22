import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ROOT_DIR } from '../../config';
import { ok } from '../helpers';
import { defineTool } from '../registry';

export interface DocSection {
  path: string;
  heading: string;
  body: string;
}

export const KNOWLEDGE_DIR = path.join(ROOT_DIR, 'src/knowledge');

/** Splits markdown files into `##` sections. */
export function loadSections(dir = KNOWLEDGE_DIR): DocSection[] {
  if (!existsSync(dir)) return [];
  const out: DocSection[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? file;
    const parts = text.split(/^##\s+/m);
    const intro = parts.shift()?.replace(/^#\s+.+$/m, '').trim();
    if (intro) out.push({ path: `src/knowledge/${file}`, heading: title, body: intro });
    for (const part of parts) {
      const [heading, ...rest] = part.split('\n');
      out.push({ path: `src/knowledge/${file}`, heading: `${title} › ${heading!.trim()}`, body: rest.join('\n').trim() });
    }
  }
  return out;
}

/** Lowercased Latin/Persian word tokens (≥ 2 chars); Arabic-script variants of ی/ک are unified. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 2);
}

export function searchSections(sections: DocSection[], query: string, limit = 5) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  return sections
    .map((s) => {
      const head = tokenize(s.heading);
      const body = tokenize(s.body);
      let score = 0;
      for (const t of terms) {
        score += head.filter((w) => w.includes(t)).length * 3;
        score += body.filter((w) => w === t).length + body.filter((w) => w !== t && w.includes(t)).length * 0.5;
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ s, score }) => ({ heading: s.heading, path: s.path, score: Math.round(score * 10) / 10, snippet: snippetAround(s.body, terms) }));
}

function snippetAround(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  const idx = Math.max(0, Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), body.length));
  const start = Math.max(0, idx - 120);
  return `${start > 0 ? '…' : ''}${body.slice(start, start + 600).trim()}${start + 600 < body.length ? '…' : ''}`;
}

let cache: DocSection[] | null = null;

export const searchDocsTool = defineTool({
  name: 'search_docs',
  title: 'Search Liara knowledge',
  description:
    'Keyword search over curated Liara notes (platforms & ports, liara.json, plans, env vars, domains, IRNIC/DNS steps, common errors, API limits). Returns heading, snippet and file. Use for how-to and requirement questions.',
  input: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(10).default(5) }),
  risk: 0,
  category: 'local',
  describeFa: ({ query }) => `جست‌وجو در راهنمای لیارا: «${query}»`,
  run: async ({ query, limit }) => {
    cache ??= loadSections();
    const hits = searchSections(cache, query, limit);
    return ok(hits, hits.length ? `${hits.length} بخش مرتبط در راهنما پیدا شد.` : 'در راهنمای داخلی مطلبی درباره‌ی این موضوع پیدا نشد.');
  },
});
