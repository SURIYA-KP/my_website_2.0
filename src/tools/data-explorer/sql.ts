// SQL tab: runs read-only queries against the dataset (table `data`) with alasql.
// alasql is loaded lazily the first time the tab opens. It compiles queries with
// `new Function`, which is why this page passes allowEval to ToolLayout.
import { escapeHtml } from '../../lib/ui';
import { rawValue } from './format';
import { columnsFromObjects } from './infer';
import { isNumericType, type Dataset } from './types';
import { keyOf } from './view';
import { pickMeasure } from './chart-ui';

type Alasql = typeof import('alasql').default;
let alasqlMod: Promise<Alasql> | null = null;
export const loadAlasql = () => (alasqlMod ??= import('alasql').then((m) => (m.default ?? m) as Alasql));

const RESERVED = new Set(
  ('add all alter and any as asc between by case cast column columns count create cross date day delete desc distinct drop else end exists false first for from full group having hour if in index inner insert into is join key last left like limit match max min minute month not null of offset on or order outer over pivot right row rows second select set sum avg table then time timestamp to top true union unique update user using value values view when where with year').split(' '),
);

/** How to write a column name in a query: plain when safe, otherwise [in brackets]. */
export function quoteIdent(name: string) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase())) return name;
  return name.includes(']') ? `\`${name.replace(/`/g, '``')}\`` : `[${name}]`;
}

/** Rows as plain objects for alasql (dates as ISO text, booleans as true/false). */
export function rowsForSql(ds: Dataset, indices?: Uint32Array): Record<string, unknown>[] {
  const cols = ds.columns;
  const n = indices ? indices.length : ds.rowCount;
  const out: Record<string, unknown>[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = indices ? indices[i] : i;
    const o: Record<string, unknown> = {};
    for (let c = 0; c < cols.length; c++) o[cols[c].name] = rawValue(cols[c], r);
    out[i] = o;
  }
  return out;
}

export interface Example {
  label: string;
  sql: string;
}

/** Example queries that use this dataset's own columns. */
export function examplesFor(ds: Dataset): Example[] {
  const cols = ds.columns;
  const n = Math.min(ds.rowCount, 2000);
  const distinct = (c: number) => {
    const s = new Set<string>();
    for (let r = 0; r < n && s.size < 60; r++) s.add(keyOf(cols[c], r));
    return s.size;
  };
  const cat = cols.findIndex((c, i) => (c.type === 'string' || c.type === 'boolean') && distinct(i) >= 2 && distinct(i) <= 40);
  const nums = cols.map((c, i) => ({ c, i })).filter(({ c, i }) => isNumericType(c.type) && !(c.type === 'integer' && /(^|[\s_])id$|^id$/i.test(c.name)) && distinct(i) > 1);
  const num = pickMeasure(cols.map((c) => c.name), nums.map(({ i }) => i));
  const date = cols.findIndex((c) => c.type === 'date');
  const q = (i: number) => quoteIdent(cols[i].name);
  const slug = (i: number) => cols[i].name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'value';
  const ex: Example[] = [{ label: 'First 100 rows', sql: 'SELECT *\nFROM data\nLIMIT 100' }];
  if (cat >= 0 && num >= 0) {
    ex.push({
      label: `Totals by ${cols[cat].name}`,
      sql: `SELECT ${q(cat)},\n  COUNT(*) AS n,\n  ROUND(SUM(${q(num)}), 2) AS sum_${slug(num)},\n  ROUND(AVG(${q(num)}), 2) AS avg_${slug(num)}\nFROM data\nGROUP BY ${q(cat)}\nORDER BY sum_${slug(num)} DESC`,
    });
  } else if (cat >= 0) {
    ex.push({ label: `Count by ${cols[cat].name}`, sql: `SELECT ${q(cat)}, COUNT(*) AS n\nFROM data\nGROUP BY ${q(cat)}\nORDER BY n DESC` });
  }
  if (num >= 0) ex.push({ label: `Top 10 by ${cols[num].name}`, sql: `SELECT *\nFROM data\nORDER BY ${q(num)} DESC\nLIMIT 10` });
  if (date >= 0) {
    const m = `SUBSTRING(${q(date)}, 1, 7)`;
    ex.push({
      label: 'Per month',
      sql: `SELECT ${m} AS [month],\n  COUNT(*) AS n${num >= 0 ? `,\n  ROUND(SUM(${q(num)}), 2) AS sum_${slug(num)}` : ''}\nFROM data\nGROUP BY ${m}\nORDER BY [month]`,
    });
  }
  if (cat >= 0) {
    const first = keyOf(cols[cat], 0).replace(/'/g, "''");
    ex.push({ label: 'Filter rows', sql: `SELECT *\nFROM data\nWHERE ${q(cat)} = '${first}'${num >= 0 ? `\n  AND ${q(num)} > 0` : ''}` });
  }
  return ex;
}

export interface SqlResult {
  dataset: Dataset;
  ms: number;
  warning?: string;
}

export class SqlError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

let dbSeq = 0;

/** Run a query. `rows` is the table content (rebuilt by the caller when the dataset changes). */
export async function runSql(sql: string, rows: Record<string, unknown>[]): Promise<SqlResult> {
  const alasql = await loadAlasql();
  const text = sql.trim();
  if (!text) throw new SqlError('Write a query first, for example: SELECT * FROM data LIMIT 10');
  let ast: { statements: unknown[] };
  try {
    ast = alasql.parse(text) as { statements: unknown[] };
  } catch (e) {
    throw new SqlError(cleanMessage(e), 'Column names with spaces or symbols need brackets, e.g. [Order Date]. Text values use single quotes.');
  }
  const yy = (alasql as unknown as { yy: Record<string, new () => unknown> }).yy;
  const stmts = ast.statements.filter(Boolean);
  if (!stmts.length) throw new SqlError('The query is empty.');
  if (!stmts.every((s) => s instanceof yy.Select || s instanceof yy.WithSelect)) {
    throw new SqlError('Only SELECT queries are supported here.', 'The data is read-only: use SELECT … FROM data, then "Use as dataset" to keep the result.');
  }
  const db = new alasql.Database(`dx_${++dbSeq}`);
  db.exec('CREATE TABLE data');
  (db as unknown as { tables: Record<string, { data: unknown[] }> }).tables.data.data = rows;
  const t0 = performance.now();
  let res: unknown;
  try {
    res = db.exec(text);
  } catch (e) {
    const msg = cleanMessage(e);
    const hint = /does not exist/i.test(msg)
      ? 'The table is called data, e.g. SELECT * FROM data.'
      : /parse error/i.test(msg)
        ? 'Column names with spaces or symbols need brackets, e.g. [Order Date].'
        : undefined;
    throw new SqlError(msg, hint);
  } finally {
    delete (alasql as unknown as { databases: Record<string, unknown> }).databases[`dx_${dbSeq}`];
  }
  const ms = performance.now() - t0;
  if (stmts.length > 1 && Array.isArray(res)) res = res[res.length - 1];
  let out: Record<string, unknown>[];
  if (Array.isArray(res)) out = res.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r }));
  else out = [{ value: res }];
  // alasql silently yields `undefined` for unknown column names; the table itself only holds null for missing values.
  if (out.length) {
    const keys = Object.keys(out[0]);
    const unknown = keys.filter((k) => out.every((r) => r[k] === undefined));
    if (unknown.length) {
      const names = Object.keys(rows[0] ?? {});
      const tips = unknown
        .map((u) => {
          const near = closest(u, names);
          return near ? `did you mean ${quoteIdent(near)}?` : '';
        })
        .filter(Boolean);
      throw new SqlError(
        `Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}${tips.length ? ` (${tips.join(' ')})` : ''}`,
        'Column names are case-sensitive, and names with spaces need brackets, e.g. [Order Date].',
      );
    }
  }
  const columns = columnsFromObjects(out);
  let warning: string | undefined;
  if (out.length && !columns.length) {
    throw new SqlError(
      `The query returned ${out.length.toLocaleString()} rows but no columns.`,
      'A column name is probably misspelled: names are case-sensitive, and names with spaces need brackets, e.g. [Order Date].',
    );
  }
  if (!out.length) warning = 'The query ran fine but returned no rows.';
  return { dataset: { name: 'Query result', columns, rowCount: out.length, meta: { format: 'sql', warnings: [] } }, ms, warning };
}

/** Closest column name (case-insensitive, small edit distance). */
function closest(word: string, names: string[]): string | null {
  const w = word.toLowerCase().replace(/^\[|\]$/g, '');
  let best: string | null = null;
  let bestD = Math.max(2, Math.floor(w.length / 3)) + 1;
  for (const n of names) {
    const d = lev(w, n.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

function lev(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function cleanMessage(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+$/g, '');
}

export function errorHtml(e: unknown) {
  const err = e instanceof SqlError ? e : new SqlError(e instanceof Error ? e.message : String(e));
  return `<strong>Query failed</strong><pre class="dx-sql-errmsg">${escapeHtml(err.message)}</pre>${err.hint ? `<p class="dx-sql-hint">${escapeHtml(err.hint)}</p>` : ''}`;
}
