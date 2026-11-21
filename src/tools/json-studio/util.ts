import { setProp } from './repair';
import { escapeHtml } from '../../lib/ui';

export type Seg = string | number;

export interface Stats {
  keys: number;
  nodes: number;
  maxDepth: number;
  rootType: string;
}

export const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
export const isContainer = (v: unknown): v is object => v !== null && typeof v === 'object';

/** Count keys/nodes and measure depth iteratively (safe for deep or huge documents). */
export function computeStats(value: unknown): Stats {
  let keys = 0;
  let nodes = 0;
  let maxDepth = 0;
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    nodes++;
    if (v !== null && typeof v === 'object') {
      const depth = d + 1;
      if (depth > maxDepth) maxDepth = depth;
      if (Array.isArray(v)) {
        for (let k = 0; k < v.length; k++) stack.push([v[k], depth]);
      } else {
        for (const k in v) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
          keys++;
          stack.push([(v as Record<string, unknown>)[k], depth]);
        }
      }
    }
  }
  return { keys, nodes, maxDepth, rootType: typeOf(value) };
}

/** Recursively sort object keys (arrays keep their order). */
export function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) setProp(out, k, sortKeysDeep((v as Record<string, unknown>)[k]));
    return out;
  }
  return v;
}

export const indentValue = (s: string) => (s === 'tab' ? '\t' : Number(s) || 2);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function toJsonPath(segs: Seg[]) {
  let p = '$';
  for (const s of segs) {
    if (typeof s === 'number') p += `[${s}]`;
    else if (IDENT.test(s)) p += `.${s}`;
    else p += `['${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
  }
  return p;
}

export function toJsPath(segs: Seg[], root = 'data') {
  let p = root;
  for (const s of segs) {
    if (typeof s === 'number') p += `[${s}]`;
    else if (IDENT.test(s)) p += `.${s}`;
    else p += `[${JSON.stringify(s)}]`;
  }
  return p;
}

/** One-line JSON syntax highlighter (works on any JSON text line, incl. pretty-printed). */
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g;
export function highlightJsonLine(line: string) {
  if (line.length > 4000) return escapeHtml(line);
  let out = '';
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = TOKEN.exec(line)); ) {
    out += escapeHtml(line.slice(last, m.index));
    if (m[1] !== undefined) {
      out += m[2] !== undefined
        ? `<span class="jss-hk">${escapeHtml(m[1])}</span>${m[2]}`
        : `<span class="jss-hs">${escapeHtml(m[1])}</span>`;
    } else if (m[3] !== undefined) out += `<span class="jss-hn">${m[3]}</span>`;
    else if (m[4] !== undefined) out += `<span class="jss-hb">${m[4]}</span>`;
    else out += `<span class="jss-hl">${m[5]}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

const TS_TOKEN = /\b(export|interface|type|readonly)\b|\b(string|number|boolean|null|unknown|Record)\b|("(?:[^"\\]|\\.)*")/g;
export function highlightTsLine(line: string) {
  if (line.length > 4000) return escapeHtml(line);
  let out = '';
  let last = 0;
  TS_TOKEN.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = TS_TOKEN.exec(line)); ) {
    out += escapeHtml(line.slice(last, m.index));
    const cls = m[1] ? 'jss-hkw' : m[2] ? 'jss-hb' : 'jss-hs';
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

export function countLines(text: string) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}
