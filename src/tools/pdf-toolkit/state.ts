// Pure page-arrangement model: page items, operations, undo/redo and range parsing.
// No DOM here so the logic stays easy to reason about.

export interface Item {
  uid: string;
  /** Source id, or null for an inserted blank page. */
  src: string | null;
  /** 0-based page index inside the source PDF (0 for images and blanks). */
  page: number;
  /** Extra rotation chosen by the user: 0, 90, 180 or 270. */
  rot: number;
  /** Displayed width/height before user rotation (points for PDFs, pixels for images). */
  w: number;
  h: number;
}

let uidCounter = 0;
export const newUid = () => `p${(++uidCounter).toString(36)}`;

export const normRot = (deg: number) => (((Math.round(deg / 90) * 90) % 360) + 360) % 360;

/** Move the given items so they sit (in their current relative order) before `insertBefore` (index in the full list). */
export function moveTo(items: Item[], uids: Set<string>, insertBefore: number): Item[] {
  const moving = items.filter((it) => uids.has(it.uid));
  if (!moving.length) return items;
  let target = 0;
  for (let i = 0; i < Math.min(insertBefore, items.length); i++) if (!uids.has(items[i].uid)) target++;
  const rest = items.filter((it) => !uids.has(it.uid));
  return [...rest.slice(0, target), ...moving, ...rest.slice(target)];
}

/** Move each selected item one step earlier (delta -1) or later (+1), keeping blocks together. */
export function moveBy(items: Item[], uids: Set<string>, delta: -1 | 1): Item[] {
  const out = items.slice();
  if (delta < 0) {
    for (let i = 1; i < out.length; i++) {
      if (uids.has(out[i].uid) && !uids.has(out[i - 1].uid)) [out[i - 1], out[i]] = [out[i], out[i - 1]];
    }
  } else {
    for (let i = out.length - 2; i >= 0; i--) {
      if (uids.has(out[i].uid) && !uids.has(out[i + 1].uid)) [out[i + 1], out[i]] = [out[i], out[i + 1]];
    }
  }
  return out;
}

export function rotate(items: Item[], uids: Set<string>, delta: number): Item[] {
  return items.map((it) => (uids.has(it.uid) ? { ...it, rot: normRot(it.rot + delta) } : it));
}

export function remove(items: Item[], uids: Set<string>): Item[] {
  return items.filter((it) => !uids.has(it.uid));
}

/** Insert a copy right after each selected item. Returns the new list and the uids of the copies. */
export function duplicate(items: Item[], uids: Set<string>): { items: Item[]; copies: string[] } {
  const out: Item[] = [];
  const copies: string[] = [];
  for (const it of items) {
    out.push(it);
    if (uids.has(it.uid)) {
      const c = { ...it, uid: newUid() };
      copies.push(c.uid);
      out.push(c);
    }
  }
  return { items: out, copies };
}

export function insertAt(items: Item[], index: number, add: Item[]): Item[] {
  const i = Math.max(0, Math.min(index, items.length));
  return [...items.slice(0, i), ...add, ...items.slice(i)];
}

/** Reverse the selected items among their own positions (2+ selected), otherwise the whole list. */
export function reverse(items: Item[], uids: Set<string>): Item[] {
  const chosen = items.filter((it) => uids.has(it.uid));
  if (chosen.length < 2) return items.slice().reverse();
  const rev = chosen.reverse();
  let k = 0;
  return items.map((it) => (uids.has(it.uid) ? rev[k++] : it));
}

/** Undo/redo stack of immutable item arrays. */
export class History {
  private past: Item[][] = [];
  private future: Item[][] = [];
  constructor(private limit = 200) {}
  push(prev: Item[]) {
    this.past.push(prev);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: Item[]): Item[] | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    return prev;
  }
  redo(current: Item[]): Item[] | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  clear() { this.past = []; this.future = []; }
}

export interface RangeResult {
  groups: number[][]; // 1-based page positions per output file
  labels: string[];
  error?: string;
}

/**
 * Parse "1-3, 5, 8-10" into groups of 1-based positions. Each comma (or semicolon) separated
 * part becomes one output file. "8-" means 8 to the end, "-3" means 1 to 3, "5-3" counts down.
 */
export function parseRanges(input: string, max: number): RangeResult {
  const parts = input.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const groups: number[][] = [];
  const labels: string[] = [];
  if (!parts.length) return { groups, labels, error: 'Enter page ranges, for example 1-3, 5, 8-10.' };
  for (const raw of parts) {
    const part = raw.replace(/\s+/g, '').replace(/[–—]/g, '-').toLowerCase().replace(/end|last/g, String(max));
    const m = part.match(/^(\d*)(?:(-)(\d*))?$/);
    if (!m || (!m[1] && !m[3])) return { groups, labels, error: `“${raw}” is not a page or range.` };
    const a = m[1] ? parseInt(m[1], 10) : 1;
    const b = m[2] ? (m[3] ? parseInt(m[3], 10) : max) : a;
    for (const n of [a, b]) {
      if (n < 1 || n > max) return { groups, labels, error: `Page ${n} is out of range (1–${max}).` };
    }
    const g: number[] = [];
    const step = a <= b ? 1 : -1;
    for (let n = a; step > 0 ? n <= b : n >= b; n += step) g.push(n);
    groups.push(g);
    labels.push(a === b ? String(a) : `${a}-${b}`);
  }
  return { groups, labels };
}

/** Split 1..max into chunks of n pages. */
export function chunk(n: number, max: number): RangeResult {
  const groups: number[][] = [];
  const labels: string[] = [];
  if (!Number.isFinite(n) || n < 1) return { groups, labels, error: 'Enter a number of pages of 1 or more.' };
  for (let s = 1; s <= max; s += n) {
    const e = Math.min(max, s + n - 1);
    const g: number[] = [];
    for (let k = s; k <= e; k++) g.push(k);
    groups.push(g);
    labels.push(s === e ? String(s) : `${s}-${e}`);
  }
  return { groups, labels };
}
