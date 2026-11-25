// JSON ↔ YAML (js-yaml) and JSON ↔ CSV (papaparse). Imported lazily by main.ts.
import { dump, loadAll } from 'js-yaml';
import Papa from 'papaparse';
import { setProp } from './repair';

// ---------- YAML ----------
export function jsonToYaml(data: unknown): string {
  if (data === undefined) return '';
  return dump(data, { noRefs: true, lineWidth: -1 });
}

export function yamlToJson(text: string): unknown {
  const docs = loadAll(text).filter((d) => d !== undefined);
  if (!docs.length) throw new Error('The YAML document is empty');
  return docs.length === 1 ? docs[0] : docs;
}

// ---------- CSV ----------
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function flatten(v: unknown, prefix: string, out: Record<string, unknown>) {
  if (Array.isArray(v)) {
    if (!v.length) out[prefix] = '[]';
    else v.forEach((e, i) => flatten(e, prefix ? `${prefix}.${i}` : String(i), out));
  } else if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (!keys.length) out[prefix] = '{}';
    else for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = v;
  }
}

/** Flatten rows: an array of objects becomes one row per object, nested keys use dots. */
export function flattenRows(data: unknown): { fields: string[]; rows: Record<string, unknown>[] } {
  const items = Array.isArray(data) ? data : [data];
  const rows = items.map((item) => {
    const out: Record<string, unknown> = {};
    if (isPlainObject(item) || Array.isArray(item)) flatten(item, '', out);
    else out.value = item;
    if ('' in out) {
      out.value = out[''];
      delete out[''];
    }
    return out;
  });
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) seen.add(k), fields.push(k);
  return { fields, rows };
}

const cell = (v: unknown) => (v === null ? 'null' : v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function jsonToCsv(data: unknown, delimiter = ','): string {
  const { fields, rows } = flattenRows(data);
  return Papa.unparse(
    { fields, data: rows.map((r) => fields.map((f) => (f in r ? cell(r[f]) : ''))) },
    { delimiter, newline: '\n' },
  );
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
function typed(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (NUMBER.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && (Number.isSafeInteger(n) || !/^-?\d+$/.test(s))) return n;
  }
  return s;
}

/** Turn objects whose keys are exactly 0..n-1 back into arrays. */
function arrayify(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(arrayify);
  if (!isPlainObject(v)) return v;
  const keys = Object.keys(v);
  for (const k of keys) v[k] = arrayify(v[k]);
  if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => v[k]);
  return v;
}

export interface CsvParseOptions {
  delimiter?: string; // '' = auto-detect
  inferTypes?: boolean;
}

export function csvToJson(text: string, opts: CsvParseOptions = {}): unknown[] {
  const res = Papa.parse(text.replace(/^\ufeff/, ''), { delimiter: opts.delimiter ?? '', skipEmptyLines: 'greedy' });
  const fatal = res.errors.find((e: { type: string }) => e.type === 'Quotes');
  if (fatal) throw new Error(`CSV error on row ${fatal.row + 1}: ${fatal.message}`);
  const [header, ...rows] = res.data as string[][];
  if (!header || !header.length) throw new Error('The CSV has no header row');
  const conv = opts.inferTypes === false ? (s: string) => s : typed;
  if (header.length === 1 && header[0] === 'value') return rows.map((r) => conv(r[0] ?? ''));
  return rows.map((r) => {
    const obj: Record<string, unknown> = {};
    header.forEach((h, c) => {
      const raw = r[c];
      if (raw === undefined || raw === '') return;
      const v = conv(raw);
      const path = h.split('.');
      let cur: Record<string, unknown> = obj;
      for (let p = 0; p < path.length - 1; p++) {
        const next = cur[path[p]];
        if (next === undefined) {
          const created: Record<string, unknown> = {};
          setProp(cur, path[p], created);
          cur = created;
        } else if (isPlainObject(next)) cur = next;
        else {
          setProp(obj, h, v); // conflicting columns (e.g. "a" and "a.b"): keep the literal key
          return;
        }
      }
      setProp(cur, path[path.length - 1], v);
    });
    return arrayify(obj) as Record<string, unknown>;
  });
}

// ---------- detection ----------
export type InputFormat = 'json' | 'yaml' | 'csv' | 'jsonl';

/** JSON Lines: two or more lines, each one a JSON value. */
export function jsonLinesToArray(text: string): unknown[] | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  try {
    return lines.map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

/**
 * Guess what non-JSON text is. Anything starting like JSON stays JSON (so "Fix it" can repair it);
 * YAML needs `key:` / `- ` structure that parses to an object or array; CSV needs a header and
 * rows with a consistent number of delimited fields.
 */
export function sniffFormat(text: string): InputFormat {
  const t = text.replace(/^\ufeff/, '').trimStart();
  if (!t || t[0] === '"') return 'json';
  if (t[0] === '{' || t[0] === '[') return jsonLinesToArray(t) ? 'jsonl' : 'json';
  const lines = t.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l)).slice(0, 30);
  const yamlish = lines.filter((l) => /^\s*(?:-\s|-$|---|[^\s,:][^,:]*:(?:\s|$)|"[^"]+":\s|'[^']+':\s)/.test(l)).length;
  if (lines.length && yamlish / lines.length >= 0.8) {
    try {
      const v = yamlToJson(t);
      if (v && typeof v === 'object') return 'yaml';
    } catch {
      /* not YAML */
    }
  }
  if (lines.length >= 2) {
    const res = Papa.parse(lines.slice(0, 20).join('\n'), { delimiter: '' });
    const rows = res.data as string[][];
    const w = rows[0]?.length ?? 0;
    if (w >= 2 && rows.filter((r) => r.length === w).length >= Math.max(2, rows.length * 0.8)) return 'csv';
  }
  return 'json';
}
