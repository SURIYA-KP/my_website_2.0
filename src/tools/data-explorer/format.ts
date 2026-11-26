// Value formatting shared by the table, profile, charts and exports.
import { BOOL_NULL, type Column } from './types';

export type NumFmt = 'auto' | 'fixed2' | 'raw';
let numFmt: NumFmt = 'auto';
const fmtAuto = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const fmtFixed = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtStat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

export function setNumFmt(f: NumFmt) {
  numFmt = f;
}
export function getNumFmt() {
  return numFmt;
}

export function formatNumber(v: number, integer = false): string {
  if (Number.isNaN(v)) return '';
  if (numFmt === 'raw') return String(v);
  if (Math.abs(v) >= 1e15 || (v !== 0 && Math.abs(v) < 1e-4)) return v.toExponential(3);
  if (integer) return fmtInt.format(v);
  return numFmt === 'fixed2' ? fmtFixed.format(v) : fmtAuto.format(v);
}

/** Formatting for statistics (always readable, independent of the table setting). */
export function formatStat(v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 1e15 || (v !== 0 && Math.abs(v) < 1e-4)) return v.toExponential(3);
  return fmtStat.format(v);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatDate(t: number, withTime = false): string {
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (!withTime) return date;
  const s = d.getUTCSeconds();
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${s || d.getUTCMilliseconds() ? ':' + pad(s) : ''}`;
}

/** ISO-ish raw text for a value (used by exports, search and SQL). */
export function rawText(col: Column, r: number): string {
  switch (col.type) {
    case 'integer':
    case 'float': {
      const v = (col.data as Float64Array)[r];
      return Number.isNaN(v) ? '' : String(v);
    }
    case 'date':
      return formatDate((col.data as Float64Array)[r], col.hasTime);
    case 'boolean': {
      const v = (col.data as Uint8Array)[r];
      return v === BOOL_NULL ? '' : v ? 'true' : 'false';
    }
    default:
      return (col.data as (string | null)[])[r] ?? '';
  }
}

/** Typed value for JSON export / SQL rows. */
export function rawValue(col: Column, r: number): string | number | boolean | null {
  switch (col.type) {
    case 'integer':
    case 'float': {
      const v = (col.data as Float64Array)[r];
      return Number.isNaN(v) ? null : v;
    }
    case 'date': {
      const v = (col.data as Float64Array)[r];
      return Number.isNaN(v) ? null : formatDate(v, col.hasTime);
    }
    case 'boolean': {
      const v = (col.data as Uint8Array)[r];
      return v === BOOL_NULL ? null : v === 1;
    }
    default:
      return (col.data as (string | null)[])[r] ?? null;
  }
}

export function isNull(col: Column, r: number): boolean {
  switch (col.type) {
    case 'boolean':
      return (col.data as Uint8Array)[r] === BOOL_NULL;
    case 'string':
      return (col.data as (string | null)[])[r] == null;
    default:
      return Number.isNaN((col.data as Float64Array)[r]);
  }
}

const PLAIN_INT = /(^|[\s_.-])(id|code|zip|year|postcode|number|no)$|^(id|year|zip)$/i;
const plainCache = new WeakMap<Column, boolean>();
/** Identifier-like integer columns (IDs, years, ZIP codes) are shown without digit grouping. */
export function isPlainInt(col: Column) {
  let p = plainCache.get(col);
  if (p === undefined) {
    p = col.type === 'integer' && PLAIN_INT.test(col.name.trim());
    plainCache.set(col, p);
  }
  return p;
}

/** Display text for a table cell. */
export function displayText(col: Column, r: number): string {
  switch (col.type) {
    case 'integer':
      if (isPlainInt(col)) return rawText(col, r);
      return formatNumber((col.data as Float64Array)[r], true);
    case 'float':
      return formatNumber((col.data as Float64Array)[r]);
    default:
      return rawText(col, r);
  }
}
