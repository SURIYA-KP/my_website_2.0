// A view over a dataset: column order/visibility, filters, global search and
// multi-column sort, producing the list of row indices to show.
import { rawText } from './format';
import { BOOL_NULL, type Column, type Dataset } from './types';

export type Filter =
  | { kind: 'text'; q: string }
  | { kind: 'range'; min: number | null; max: number | null }
  | { kind: 'set'; values: Set<string> };

export interface SortSpec {
  col: number;
  desc: boolean;
}

/** Category key used by "set" filters, charts and top-value profiles. */
export function keyOf(col: Column, r: number): string {
  if (col.type === 'string') return (col.data as (string | null)[])[r] ?? '';
  if (col.type === 'boolean') {
    const v = (col.data as Uint8Array)[r];
    return v === BOOL_NULL ? '' : v ? 'true' : 'false';
  }
  return rawText(col, r);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class DataView {
  ds: Dataset;
  order: number[];
  hidden = new Set<number>();
  widths: number[] = [];
  sort: SortSpec[] = [];
  filters = new Map<number, Filter>();
  search = '';
  indices: Uint32Array;
  private sortKeys = new Map<number, Float64Array>();
  private lowerCache = new Map<number, string[]>();

  constructor(ds: Dataset) {
    this.ds = ds;
    this.order = ds.columns.map((_, i) => i);
    this.indices = new Uint32Array(ds.rowCount);
    for (let i = 0; i < ds.rowCount; i++) this.indices[i] = i;
  }

  get visibleColumns(): number[] {
    return this.order.filter((c) => !this.hidden.has(c));
  }

  get isFiltered() {
    return this.filters.size > 0 || this.search.trim() !== '';
  }

  /** Re-run filters, search and sort. */
  recompute() {
    const n = this.ds.rowCount;
    const cols = this.ds.columns;
    const tests: ((r: number) => boolean)[] = [];
    for (const [c, f] of this.filters) tests.push(this.makeTest(cols[c], c, f));
    const q = this.search.trim().toLowerCase();
    if (q) {
      const vis = this.visibleColumns.map((c) => this.lower(c));
      tests.push((r) => {
        for (let k = 0; k < vis.length; k++) if (vis[k][r].includes(q)) return true;
        return false;
      });
    }
    let out: Uint32Array;
    if (!tests.length) {
      out = new Uint32Array(n);
      for (let i = 0; i < n; i++) out[i] = i;
    } else {
      const tmp = new Uint32Array(n);
      let m = 0;
      outer: for (let r = 0; r < n; r++) {
        for (let k = 0; k < tests.length; k++) if (!tests[k](r)) continue outer;
        tmp[m++] = r;
      }
      out = tmp.slice(0, m);
    }
    if (this.sort.length) {
      const keys = this.sort.map((s) => this.sortKey(s.col));
      const dirs = this.sort.map((s) => (s.desc ? -1 : 1));
      out.sort((a, b) => {
        for (let k = 0; k < keys.length; k++) {
          const x = keys[k][a];
          const y = keys[k][b];
          if (x !== y) {
            const xn = x !== x;
            const yn = y !== y;
            if (xn) return yn ? 0 : 1; // missing values always last
            if (yn) return -1;
            return (x < y ? -1 : 1) * dirs[k];
          }
        }
        return a - b;
      });
    }
    this.indices = out;
  }

  private makeTest(col: Column, c: number, f: Filter): (r: number) => boolean {
    if (f.kind === 'text') {
      const q = f.q.toLowerCase();
      const lower = this.lower(c);
      return (r) => lower[r].includes(q);
    }
    if (f.kind === 'range') {
      const d = col.data as Float64Array;
      const lo = f.min ?? -Infinity;
      const hi = f.max ?? Infinity;
      return (r) => d[r] >= lo && d[r] <= hi;
    }
    const set = f.values;
    return (r) => set.has(keyOf(col, r));
  }

  private lower(c: number): string[] {
    let l = this.lowerCache.get(c);
    if (!l) {
      const col = this.ds.columns[c];
      l = new Array(this.ds.rowCount);
      for (let r = 0; r < this.ds.rowCount; r++) l[r] = rawText(col, r).toLowerCase();
      this.lowerCache.set(c, l);
    }
    return l;
  }

  /** Numeric sort key per row (NaN = missing). Strings are ranked once with a collator. */
  private sortKey(c: number): Float64Array {
    let k = this.sortKeys.get(c);
    if (k) return k;
    const col = this.ds.columns[c];
    const n = this.ds.rowCount;
    if (col.type === 'integer' || col.type === 'float' || col.type === 'date') k = col.data as Float64Array;
    else if (col.type === 'boolean') {
      k = new Float64Array(n);
      const d = col.data as Uint8Array;
      for (let r = 0; r < n; r++) k[r] = d[r] === BOOL_NULL ? NaN : d[r];
    } else {
      const d = col.data as (string | null)[];
      const uniq = Array.from(new Set(d.filter((v): v is string => v != null)));
      uniq.sort(collator.compare);
      const rank = new Map<string, number>();
      uniq.forEach((v, i) => rank.set(v, i));
      k = new Float64Array(n);
      for (let r = 0; r < n; r++) k[r] = d[r] == null ? NaN : rank.get(d[r] as string)!;
    }
    this.sortKeys.set(c, k);
    return k;
  }

  /** Click on a header: plain click sorts by that column alone, shift adds/toggles it. */
  toggleSort(col: number, additive: boolean) {
    const i = this.sort.findIndex((s) => s.col === col);
    if (!additive) {
      if (i >= 0 && this.sort.length === 1) {
        if (!this.sort[0].desc) this.sort[0].desc = true;
        else this.sort = [];
      } else this.sort = [{ col, desc: false }];
      return;
    }
    if (i < 0) this.sort.push({ col, desc: false });
    else if (!this.sort[i].desc) this.sort[i].desc = true;
    else this.sort.splice(i, 1);
  }
}
