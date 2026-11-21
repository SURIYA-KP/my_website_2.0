// Column type inference and conversion. Used by the parse worker and, for SQL
// results, on the main thread. Pure functions, no DOM.
import { BOOL_NULL, type Column, type ColType } from './types';

export type Cell = string | number | boolean | null | undefined;

const NA = new Set(['', 'na', 'n/a', 'null', 'none', 'nan', '#n/a', 'nil', '-', '—']);

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const COMMA_FLOAT_RE = /^[+-]?\d+(?:,\d+)?$/;
const BOOL_TRUE = new Set(['true', 'yes']);
const BOOL_FALSE = new Set(['false', 'no']);
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;
const YMD_SLASH_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const XY_SLASH_RE = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export function isMissingToken(s: string) {
  return NA.has(s.trim().toLowerCase());
}

function hasLeadingZero(s: string) {
  return /^[+-]?0\d/.test(s);
}

function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return NaN;
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const dt = new Date(t);
  if (dt.getUTCDate() !== d || dt.getUTCMonth() !== mo - 1) return NaN; // e.g. Feb 30
  return t;
}

/** Parse an ISO or slash-separated date. order: 'mdy' | 'dmy' for a/b/yyyy forms. */
export function parseDate(s: string, order: 'mdy' | 'dmy' = 'mdy'): { t: number; time: boolean } | null {
  let m = ISO_RE.exec(s);
  if (m) {
    const ms = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0;
    let t = utc(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0, ms);
    if (Number.isNaN(t)) return null;
    if (m[8] && m[8] !== 'Z') {
      const sign = m[8][0] === '-' ? -1 : 1;
      const digits = m[8].slice(1).replace(':', '');
      t -= sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60000;
    }
    return { t, time: !!m[4] };
  }
  m = YMD_SLASH_RE.exec(s);
  if (m) {
    const t = utc(+m[1], +m[2], +m[3]);
    return Number.isNaN(t) ? null : { t, time: false };
  }
  m = XY_SLASH_RE.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const [mo, d] = order === 'mdy' ? [a, b] : [b, a];
    const t = utc(+m[3], mo, d, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
    return Number.isNaN(t) ? null : { t, time: !!m[4] };
  }
  return null;
}

interface Guess {
  type: ColType;
  decimalComma: boolean;
  dateOrder: 'mdy' | 'dmy';
}

/** Decide the type of one column by scanning every value. */
export function guessType(rowCount: number, get: (r: number) => Cell, allowDecimalComma: boolean): Guess {
  let canInt = true;
  let canFloat = true;
  let canComma = allowDecimalComma;
  let sawComma = false;
  let canBool = true;
  let canDate = true;
  let sawFirstGt12 = false;
  let sawSecondGt12 = false;
  let nonNull = 0;
  for (let r = 0; r < rowCount; r++) {
    const v = get(r);
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      nonNull++;
      canBool = canDate = canComma = false;
      if (!Number.isInteger(v)) canInt = false;
      continue;
    }
    if (typeof v === 'boolean') {
      nonNull++;
      canInt = canFloat = canDate = canComma = false;
      continue;
    }
    const s = v.trim();
    if (NA.has(s.toLowerCase())) continue;
    nonNull++;
    if (canInt && !(INT_RE.test(s) && !hasLeadingZero(s) && s.replace(/^[+-]/, '').length <= 15)) canInt = false;
    if (canFloat && !(FLOAT_RE.test(s) && !(hasLeadingZero(s) && !s.includes('.')) && s.length <= 24)) canFloat = false;
    if (canComma) {
      if (!COMMA_FLOAT_RE.test(s) || hasLeadingZero(s.split(',')[0])) canComma = false;
      else if (s.includes(',')) sawComma = true;
    }
    if (canBool) {
      const l = s.toLowerCase();
      if (!BOOL_TRUE.has(l) && !BOOL_FALSE.has(l)) canBool = false;
    }
    if (canDate) {
      const m = XY_SLASH_RE.exec(s);
      if (m) {
        const a = +m[1];
        const b = +m[2];
        if (a > 12) sawFirstGt12 = true;
        if (b > 12) sawSecondGt12 = true;
        if ((sawFirstGt12 && sawSecondGt12) || a > 31 || b > 31) canDate = false;
      } else if (!parseDate(s)) canDate = false;
    }
    if (!canInt && !canFloat && !canComma && !canBool && !canDate) break;
  }
  const dateOrder = sawFirstGt12 ? 'dmy' : 'mdy';
  let type: ColType = 'string';
  let decimalComma = false;
  if (nonNull === 0) type = 'string';
  else if (canBool) type = 'boolean';
  else if (canInt) type = 'integer';
  else if (canFloat) type = 'float';
  else if (canComma && sawComma) {
    type = 'float';
    decimalComma = true;
  } else if (canDate) type = 'date';
  return { type, decimalComma, dateOrder };
}

/** Convert one column's raw cells into typed storage. */
export function buildColumn(name: string, rowCount: number, get: (r: number) => Cell, allowDecimalComma = false): Column & { decimalComma: boolean } {
  const g = guessType(rowCount, get, allowDecimalComma);
  if (g.type === 'integer' || g.type === 'float') {
    const data = new Float64Array(rowCount);
    for (let r = 0; r < rowCount; r++) {
      const v = get(r);
      if (typeof v === 'number') data[r] = Number.isFinite(v) ? v : NaN;
      else if (typeof v === 'string') {
        const s = v.trim();
        data[r] = NA.has(s.toLowerCase()) ? NaN : Number(g.decimalComma ? s.replace(',', '.') : s);
      } else data[r] = NaN;
    }
    return { name, type: g.type, data, decimalComma: g.decimalComma };
  }
  if (g.type === 'boolean') {
    const data = new Uint8Array(rowCount);
    for (let r = 0; r < rowCount; r++) {
      const v = get(r);
      if (typeof v === 'boolean') data[r] = v ? 1 : 0;
      else if (typeof v === 'string') {
        const l = v.trim().toLowerCase();
        data[r] = BOOL_TRUE.has(l) ? 1 : BOOL_FALSE.has(l) ? 0 : BOOL_NULL;
      } else data[r] = BOOL_NULL;
    }
    return { name, type: 'boolean', data, decimalComma: false };
  }
  if (g.type === 'date') {
    const data = new Float64Array(rowCount);
    let hasTime = false;
    for (let r = 0; r < rowCount; r++) {
      const v = get(r);
      const s = typeof v === 'string' ? v.trim() : '';
      const p = s && !NA.has(s.toLowerCase()) ? parseDate(s, g.dateOrder) : null;
      if (p) {
        data[r] = p.t;
        if (p.time && p.t % 86400000 !== 0) hasTime = true;
      } else data[r] = NaN;
    }
    return { name, type: 'date', data, hasTime, decimalComma: false };
  }
  const data: (string | null)[] = new Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    const v = get(r);
    if (v === null || v === undefined || v === '') data[r] = null;
    else data[r] = typeof v === 'string' ? v : String(v);
  }
  return { name, type: 'string', data, decimalComma: false };
}

/** Make header names unique and non-empty. */
export function uniqueNames(raw: string[]): string[] {
  const used = new Set<string>();
  return raw.map((n, i) => {
    const base = String(n ?? '').replace(/^﻿/, '').trim() || `column_${i + 1}`;
    let name = base;
    let k = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${k++}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Build a dataset's columns from row objects (JSON, SQL results). */
export function columnsFromObjects(rows: Record<string, unknown>[], onProgress?: (r: number) => void): Column[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const names = uniqueNames(keys);
  const cell = (v: unknown): Cell => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (typeof v === 'bigint') return Number(v);
    return JSON.stringify(v);
  };
  return keys.map((k, i) => {
    const col = buildColumn(names[i], rows.length, (r) => cell(rows[r]?.[k]));
    onProgress?.((i + 1) / keys.length);
    return { name: col.name, type: col.type, data: col.data, hasTime: col.hasTime };
  });
}

/** Flatten nested plain objects into dotted keys; arrays stay as values. */
export function flatten(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out[prefix || 'value'] = obj;
    return out;
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  if (!entries.length && prefix) out[prefix] = null;
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
