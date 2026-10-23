/**
 * Tiny, safe expression evaluator for playbook `when` conditions and a `{{path}}`
 * template renderer. Supports: numbers, 'strings', true/false/null, dotted paths
 * (with .length), ! && || == != < <= > >= and parentheses. No eval, no calls.
 */

type Token = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

const OPS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '!', '(', ')'];

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new Error(`unterminated string in: ${src}`);
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (!m) throw new Error(`unexpected "${ch}" in: ${src}`);
    out.push({ t: 'id', v: m[0] });
    i += m[0].length;
  }
  return out;
}

export function resolvePath(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (key === 'length' && (Array.isArray(cur) || typeof cur === 'string')) cur = cur.length;
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

/** Evaluates `src` against `ctx`. Comparisons with null/undefined operands are false (except ==/!= null). */
export function evaluateExpr(src: string, ctx: unknown): boolean {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  const primary = (): unknown => {
    const tok = take();
    if (!tok) throw new Error(`unexpected end of: ${src}`);
    if (tok.t === 'num' || tok.t === 'str') return tok.v;
    if (tok.t === 'id') {
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      if (tok.v === 'null') return null;
      return resolvePath(ctx, tok.v);
    }
    if (tok.v === '(') {
      const v = or();
      if (take()?.v !== ')') throw new Error(`missing ) in: ${src}`);
      return v;
    }
    if (tok.v === '!') return !truthy(primary());
    throw new Error(`unexpected "${tok.v}" in: ${src}`);
  };

  const comparison = (): unknown => {
    const left = primary();
    const op = peek();
    if (op?.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(op.v)) {
      take();
      const right = primary();
      return compare(op.v, left, right);
    }
    return left;
  };

  const and = (): unknown => {
    let v = comparison();
    while (peek()?.v === '&&') {
      take();
      const r = comparison();
      v = truthy(v) && truthy(r);
    }
    return v;
  };

  const or = (): unknown => {
    let v = and();
    while (peek()?.v === '||') {
      take();
      const r = and();
      v = truthy(v) || truthy(r);
    }
    return v;
  };

  const result = or();
  if (pos !== tokens.length) throw new Error(`unexpected trailing tokens in: ${src}`);
  return truthy(result);
}

function truthy(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

function compare(op: string, a: unknown, b: unknown): boolean {
  if (op === '==') return a === b || (a == null && b == null);
  if (op === '!=') return !(a === b || (a == null && b == null));
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
}

export const UNRESOLVED = Symbol('unresolved');

/**
 * Renders `{{path}}` placeholders. A string that is exactly one placeholder takes
 * the raw value (numbers stay numbers). Missing values yield UNRESOLVED anywhere
 * in the structure so callers can drop the fix.
 */
export function renderTemplate(value: unknown, ctx: unknown): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(value);
    if (whole) {
      const v = resolvePath(ctx, whole[1]!);
      return v === undefined || v === null || v === '' ? UNRESOLVED : v;
    }
    let missing = false;
    const out = value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p: string) => {
      const v = resolvePath(ctx, p);
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) missing = true;
      return Array.isArray(v) ? v.join('، ') : String(v ?? '');
    });
    return missing ? UNRESOLVED : out;
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = renderTemplate(k, ctx);
      out[key === UNRESOLVED ? '__unresolved__' : String(key)] = renderTemplate(v, ctx);
      if (key === UNRESOLVED) out.__unresolved__ = UNRESOLVED;
    }
    return out;
  }
  return value;
}

export function hasUnresolved(value: unknown): boolean {
  if (value === UNRESOLVED) return true;
  if (Array.isArray(value)) return value.some(hasUnresolved);
  if (value && typeof value === 'object') return Object.values(value).some(hasUnresolved);
  return false;
}
