// Pure diff engine shared by the worker and the main-thread fallback.
// No DOM access here.
import { diffArrays } from 'diff';

export type WsMode = 'none' | 'leading' | 'trailing' | 'both' | 'all';
export type InlineMode = 'word' | 'char';

export interface DiffOptions {
  ws: WsMode;
  ignoreCase: boolean;
  ignoreBlank: boolean;
  ignoreEol: boolean;
  inline: InlineMode;
}

/** [0 = unchanged, 1 = changed, text] */
export type Seg = [0 | 1, string];

/**
 * One aligned side-by-side row.
 * k: 0 = equal, 1 = part of a change block, 2 = ignored change (blank lines only, with "ignore blank lines")
 * a / b: 0-based line index in Original / Changed, or -1 for a filler cell.
 */
export interface Row {
  k: 0 | 1 | 2;
  a: number;
  b: number;
  blk: number;
  sa?: Seg[];
  sb?: Seg[];
}

export interface Block {
  start: number; // first row index
  end: number; // exclusive
  dels: number;
  adds: number;
}

export interface Stats {
  added: number;
  removed: number;
  changed: number;
  similarity: number; // 0..100
  linesA: number;
  linesB: number;
}

export interface LineInfo {
  eol: 'LF' | 'CRLF' | 'Mixed' | 'None';
  finalNewline: boolean;
  lines: number;
}

export interface DiffResult {
  rows: Row[];
  blocks: Block[];
  stats: Stats;
  infoA: LineInfo;
  infoB: LineInfo;
  identical: boolean; // byte-for-byte identical
  onlyEol: boolean; // identical except for line endings
  onlyFinalNewline: boolean; // identical except for the newline at EOF
  aborted: boolean; // line diff timed out and a coarse result is shown
  ms: number;
}

export type Progress = (phase: string, done: number, total: number) => void;

/** Split into lines. Each line keeps a trailing \r (CRLF files); the \n separators are dropped. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

export function lineInfo(text: string): LineInfo {
  let lf = 0;
  let crlf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  const eol = lf && crlf ? 'Mixed' : crlf ? 'CRLF' : lf ? 'LF' : 'None';
  return { eol, finalNewline: text.endsWith('\n'), lines: splitLines(text).length };
}

const stripCr = (s: string) => (s.charCodeAt(s.length - 1) === 13 ? s.slice(0, -1) : s);

export function normalizeLine(line: string, o: DiffOptions): string {
  let s = o.ignoreEol ? stripCr(line) : line;
  switch (o.ws) {
    case 'leading':
      s = s.replace(/^\s+/, '');
      break;
    case 'trailing':
      s = s.replace(/\s+$/, '');
      break;
    case 'both':
      s = s.trim();
      break;
    case 'all':
      s = s.replace(/\s+/g, '');
      break;
  }
  if (o.ignoreCase) s = s.toLowerCase();
  return s;
}

const isBlank = (s: string) => /^\s*$/.test(s);

// ---------------------------------------------------------------------------
// Line-level diff
// ---------------------------------------------------------------------------

/** Returns matched line pairs [aIndex, bIndex] in increasing order. */
function matchLines(keysA: string[], keysB: string[], aborted: { v: boolean }): Array<[number, number]> {
  // Map each distinct normalized line to an integer so the LCS compares numbers.
  const ids = new Map<string, number>();
  const idOf = (k: string) => {
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    return id;
  };
  const idsA = keysA.map(idOf);
  const idsB = keysB.map(idOf);
  const inA = new Uint8Array(ids.size);
  const inB = new Uint8Array(ids.size);
  for (const id of idsA) inA[id] = 1;
  for (const id of idsB) inB[id] = 1;

  const matches: Array<[number, number]> = [];
  // Common prefix / suffix.
  let pre = 0;
  while (pre < idsA.length && pre < idsB.length && idsA[pre] === idsB[pre]) matches.push([pre, pre]), pre++;
  let suf = 0;
  while (suf < idsA.length - pre && suf < idsB.length - pre && idsA[idsA.length - 1 - suf] === idsB[idsB.length - 1 - suf]) suf++;

  // Lines that do not occur on the other side can never match: drop them from the
  // LCS input. This keeps very different files fast (like GNU diff's "discard").
  const mapA: number[] = [];
  const fa: number[] = [];
  for (let i = pre; i < idsA.length - suf; i++) if (inB[idsA[i]]) mapA.push(i), fa.push(idsA[i]);
  const mapB: number[] = [];
  const fb: number[] = [];
  for (let i = pre; i < idsB.length - suf; i++) if (inA[idsB[i]]) mapB.push(i), fb.push(idsB[i]);

  if (fa.length && fb.length) {
    const changes = diffArrays(fa, fb, { timeout: 15000 });
    if (changes) {
      let pa = 0;
      let pb = 0;
      for (const c of changes) {
        if (c.added) pb += c.count;
        else if (c.removed) pa += c.count;
        else {
          for (let j = 0; j < c.count; j++) matches.push([mapA[pa + j], mapB[pb + j]]);
          pa += c.count;
          pb += c.count;
        }
      }
    } else {
      aborted.v = true;
    }
  }
  for (let j = suf; j > 0; j--) matches.push([idsA.length - j, idsB.length - j]);
  return matches;
}

export function computeDiff(textA: string, textB: string, o: DiffOptions, progress?: Progress): DiffResult {
  const t0 = Date.now();
  const linesA = splitLines(textA);
  const linesB = splitLines(textB);
  progress?.('Comparing lines', 0, 1);
  const keysA = linesA.map((l) => normalizeLine(l, o));
  const keysB = linesB.map((l) => normalizeLine(l, o));
  const aborted = { v: false };
  const matches = matchLines(keysA, keysB, aborted);

  const rows: Row[] = [];
  const blocks: Block[] = [];
  const stats: Stats = { added: 0, removed: 0, changed: 0, similarity: 100, linesA: linesA.length, linesB: linesB.length };

  let ia = 0;
  let ib = 0;
  const gap = (ea: number, eb: number) => {
    const dels = ea - ia;
    const adds = eb - ib;
    if (!dels && !adds) return;
    let ignored = false;
    if (o.ignoreBlank) {
      ignored = true;
      for (let i = ia; i < ea && ignored; i++) if (!isBlank(linesA[i])) ignored = false;
      for (let i = ib; i < eb && ignored; i++) if (!isBlank(linesB[i])) ignored = false;
    }
    const n = Math.max(dels, adds);
    const blk = ignored ? -1 : blocks.length;
    const start = rows.length;
    for (let k = 0; k < n; k++) rows.push({ k: ignored ? 2 : 1, a: k < dels ? ia + k : -1, b: k < adds ? ib + k : -1, blk });
    if (!ignored) {
      blocks.push({ start, end: rows.length, dels, adds });
      const paired = Math.min(dels, adds);
      stats.changed += paired;
      stats.added += adds - paired;
      stats.removed += dels - paired;
    }
  };
  for (const [ma, mb] of matches) {
    gap(ma, mb);
    rows.push({ k: 0, a: ma, b: mb, blk: -1 });
    ia = ma + 1;
    ib = mb + 1;
  }
  gap(linesA.length, linesB.length);

  // Inline (word / character) highlights for paired changed lines + similarity.
  const disp = (l: string) => (o.ignoreEol ? stripCr(l) : l);
  let totalA = 0;
  let totalB = 0;
  let common = 0;
  const pairs: Row[] = [];
  for (const r of rows) {
    if (r.k === 2) continue;
    const la = r.a >= 0 ? disp(linesA[r.a]).length : 0;
    const lb = r.b >= 0 ? disp(linesB[r.b]).length : 0;
    totalA += la + (r.a >= 0 ? 1 : 0); // +1 counts the line break
    totalB += lb + (r.b >= 0 ? 1 : 0);
    if (r.k === 0) common += Math.min(la, lb) + 1;
    else if (r.a >= 0 && r.b >= 0) pairs.push(r);
  }
  const step = Math.max(200, Math.ceil(pairs.length / 50));
  for (let i = 0; i < pairs.length; i++) {
    const r = pairs[i];
    const res = inlineDiff(disp(linesA[r.a]), disp(linesB[r.b]), o);
    r.sa = res.sa;
    r.sb = res.sb;
    common += res.common;
    if (progress && i % step === 0) progress('Highlighting changes', i, pairs.length);
  }
  stats.similarity = totalA + totalB === 0 ? 100 : (200 * common) / (totalA + totalB);
  if (blocks.length && stats.similarity > 99.9) stats.similarity = 99.9;

  const identical = textA === textB;
  const lfA = textA.replace(/\r\n/g, '\n');
  const lfB = textB.replace(/\r\n/g, '\n');
  const onlyEol = !identical && lfA === lfB;
  const onlyFinalNewline = !identical && !onlyEol && lfA.replace(/\n$/, '') === lfB.replace(/\n$/, '');
  return {
    rows,
    blocks,
    stats,
    infoA: lineInfo(textA),
    infoB: lineInfo(textB),
    identical,
    onlyEol,
    onlyFinalNewline,
    aborted: aborted.v,
    ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Inline diff for one pair of lines
// ---------------------------------------------------------------------------

const WORD_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const isWs = (s: string) => /^\s+$/.test(s);
const nonWsLen = (s: string) => s.replace(/\s+/g, '').length;

export function tokenize(s: string, mode: InlineMode): string[] {
  return mode === 'char' ? Array.from(s) : s.match(WORD_RE) ?? [];
}

interface Op {
  t: 0 | 1 | 2; // 0 equal, 1 removed, 2 added
  a: string;
  b: string;
}

export function inlineDiff(a: string, b: string, o: Pick<DiffOptions, 'inline' | 'ignoreCase' | 'ws'>): { sa: Seg[]; sb: Seg[]; common: number } {
  // A trailing CR (when line endings are not ignored) is shown as its own marker.
  const crA = a.endsWith('\r');
  const crB = b.endsWith('\r');
  if (crA) a = a.slice(0, -1);
  if (crB) b = b.slice(0, -1);
  const whole = () => ({ sa: a ? ([[1, a]] as Seg[]) : [], sb: b ? ([[1, b]] as Seg[]) : [], common: 0 });

  let res: { sa: Seg[]; sb: Seg[]; common: number };
  if (!a || !b || a.length + b.length > 20000) {
    res = whole();
  } else {
    const ta = tokenize(a, o.inline);
    const tb = tokenize(b, o.inline);
    const cmp = o.ignoreCase
      ? (x: string, y: string) => x === y || x.toLowerCase() === y.toLowerCase() || (o.ws === 'all' && isWs(x) && isWs(y))
      : (x: string, y: string) => x === y || (o.ws === 'all' && isWs(x) && isWs(y));
    const changes = diffArrays(ta, tb, { comparator: cmp, timeout: 150 });
    if (!changes) {
      res = whole();
    } else {
      let ops: Op[] = [];
      let pa = 0;
      let pb = 0;
      for (const c of changes) {
        if (c.added) ops.push({ t: 2, a: '', b: tb.slice(pb, (pb += c.count)).join('') });
        else if (c.removed) ops.push({ t: 1, a: ta.slice(pa, (pa += c.count)).join(''), b: '' });
        else ops.push({ t: 0, a: ta.slice(pa, (pa += c.count)).join(''), b: tb.slice(pb, (pb += c.count)).join('') });
      }
      // Readability cleanup: tiny equal islands (whitespace, or a single char in
      // char mode) sandwiched between changes are folded into the change.
      ops = ops.flatMap((op, i) => {
        if (op.t !== 0 || i === 0 || i === ops.length - 1) return [op];
        if (ops[i - 1].t === 0 || ops[i + 1].t === 0) return [op];
        const tiny = isWs(op.a) || (o.inline === 'char' && op.a.length <= 2 && nonWsLen(op.a) <= 1);
        return tiny ? [{ t: 1, a: op.a, b: '' } as Op, { t: 2, a: '', b: op.b } as Op] : [op];
      });
      const sa: Seg[] = [];
      const sb: Seg[] = [];
      const push = (arr: Seg[], ch: 0 | 1, text: string) => {
        if (!text) return;
        const last = arr[arr.length - 1];
        if (last && last[0] === ch) last[1] += text;
        else arr.push([ch, text]);
      };
      let common = 0;
      ops.forEach((op, i) => {
        if (op.t === 0) {
          push(sa, 0, op.a);
          push(sb, 0, op.b);
          common += Math.min(op.a.length, op.b.length);
          return;
        }
        const text = op.t === 1 ? op.a : op.b;
        // Whitespace-only edits that the whitespace option ignores are not highlighted.
        const atStart = i === 0;
        const atEnd = i === ops.length - 1 || (i === ops.length - 2 && ops[i + 1].t !== 0);
        const ignorable =
          isWs(text) &&
          (o.ws === 'all' || ((o.ws === 'leading' || o.ws === 'both') && atStart) || ((o.ws === 'trailing' || o.ws === 'both') && atEnd));
        push(op.t === 1 ? sa : sb, ignorable ? 0 : 1, text);
      });
      // Lines with little in common read better as a whole-line replacement.
      let commonNonWs = 0;
      for (const op of ops) if (op.t === 0) commonNonWs += nonWsLen(op.a);
      const maxNonWs = Math.max(nonWsLen(a), nonWsLen(b));
      res = maxNonWs > 0 && commonNonWs < 0.25 * maxNonWs ? whole() : { sa, sb, common };
    }
  }
  if (crA) res.sa.push([crB ? 0 : 1, '\r']);
  if (crB) res.sb.push([crA ? 0 : 1, '\r']);
  if (crA && crB) res.common += 1;
  return res;
}
