import { createTwoFilesPatch } from 'diff';
import { copyText, debounce, downloadText, escapeHtml, setupDropzone, toast } from '../../lib/ui';
import type { DiffOptions, DiffResult, Row, Seg, WsMode, InlineMode } from './engine';
import { EXAMPLES } from './examples';

type Side = 'a' | 'b';
type Eol = 'lf' | 'crlf' | 'mixed';
type View = 'split' | 'unified';

const LARGE_CHARS = 400_000; // combined size above which live update pauses
const LARGE_LINES = 10_000;
const SYNC_PATCH_CHARS = 300_000; // bigger patches are built in the worker
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const CHUNK_ROWS = 400;
const FIRST_PAINT_ROWS = 1200;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// Worker client (cancellable; falls back to the main thread if workers fail)
// ---------------------------------------------------------------------------
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (p: string, d: number, t: number) => void };

class WorkerClient {
  private worker: Worker | null = null;
  private failed = false;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private ensure(): Worker | null {
    if (this.worker || this.failed) return this.worker;
    try {
      this.worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const msg = e.data;
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === 'progress') return p.onProgress?.(msg.phase, msg.done, msg.total);
        this.pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.result);
        else p.reject(new Error(msg.message));
      };
      this.worker.onerror = (e) => {
        e.preventDefault();
        this.failed = true;
        const waiting = [...this.pending.values()];
        this.reset();
        waiting.forEach((p) => p.reject(new Error('worker-failed')));
      };
    } catch {
      this.failed = true;
      this.worker = null;
    }
    return this.worker;
  }

  async request<T>(msg: Record<string, unknown>, onProgress?: Pending['onProgress']): Promise<T> {
    const w = this.ensure();
    if (!w) return runOnMainThread(msg) as Promise<T>;
    const id = ++this.seq;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress });
        w.postMessage({ ...msg, id });
      });
    } catch (e) {
      if ((e as Error).message === 'worker-failed') return runOnMainThread(msg) as Promise<T>;
      throw e;
    }
  }

  get busy() {
    return this.pending.size > 0;
  }

  private reset() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  /** Stop whatever is running (terminates the worker). */
  cancel() {
    const waiting = [...this.pending.values()];
    this.reset();
    waiting.forEach((p) => p.reject(new Error('cancelled')));
  }
}

async function runOnMainThread(msg: Record<string, any>) {
  await new Promise((r) => setTimeout(r, 0));
  if (msg.type === 'patch') return createTwoFilesPatch(msg.nameA, msg.nameB, msg.a, msg.b, undefined, undefined, { context: msg.context });
  const { computeDiff } = await import('./engine');
  return computeDiff(msg.a, msg.b, msg.options);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
interface SideState {
  raw: string | null; // exact text as loaded (keeps CRLF / mixed endings) until edited
  eol: Eol;
}

interface Snapshot {
  a: string;
  b: string;
  linesA: string[];
  linesB: string[];
  options: DiffOptions;
  nameA: string;
  nameB: string;
}

const state = {
  sides: { a: { raw: null, eol: 'lf' }, b: { raw: null, eol: 'lf' } } as Record<Side, SideState>,
  view: 'split' as View,
  context: 3,
  options: { ws: 'none', ignoreCase: false, ignoreBlank: false, ignoreEol: true, inline: 'word' } as DiffOptions,
  result: null as DiffResult | null,
  snap: null as Snapshot | null,
  cur: -1,
  reverted: new Set<number>(),
  stale: false,
  jobId: 0,
};

const diffClient = new WorkerClient();
const patchClient = new WorkerClient();

// Elements
const els = {
  text: { a: $<HTMLTextAreaElement>('td-text-a'), b: $<HTMLTextAreaElement>('td-text-b') },
  name: { a: $<HTMLInputElement>('td-name-a'), b: $<HTMLInputElement>('td-name-b') },
  eol: { a: $<HTMLSelectElement>('td-eol-a'), b: $<HTMLSelectElement>('td-eol-b') },
  meta: { a: $('td-meta-a'), b: $('td-meta-b') },
  out: $('td-out'),
  rows: $('td-rows'),
  colhead: $('td-colhead'),
  notices: $('td-notices'),
  progress: $('td-progress'),
  progressBar: $('td-progress-bar'),
  progressText: $('td-progress-text'),
  pos: $('td-pos'),
  status: $('td-status'),
  compare: $<HTMLButtonElement>('td-compare'),
  live: $<HTMLInputElement>('td-live'),
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
function getText(side: Side): string {
  const s = state.sides[side];
  if (s.raw !== null) return s.raw;
  const v = els.text[side].value;
  return s.eol === 'crlf' ? v.replace(/\r?\n/g, '\r\n') : v.replace(/\r\n/g, '\n');
}

function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf && lf ? 'mixed' : crlf ? 'crlf' : 'lf';
}

function syncEolSelect(side: Side) {
  const sel = els.eol[side];
  const mixedOpt = sel.querySelector<HTMLOptionElement>('option[value="mixed"]')!;
  mixedOpt.hidden = state.sides[side].eol !== 'mixed';
  sel.value = state.sides[side].eol;
}

function setText(side: Side, text: string, name?: string) {
  state.sides[side] = { raw: text, eol: detectEol(text) };
  els.text[side].value = text;
  if (name !== undefined) els.name[side].value = name;
  syncEolSelect(side);
  updateMeta(side);
}

function updateMeta(side: Side) {
  const t = getText(side);
  let lines = 0;
  if (t) {
    for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) lines++;
    if (!t.endsWith('\n')) lines++;
  }
  els.meta[side].textContent = `${lines.toLocaleString()} line${lines === 1 ? '' : 's'} · ${t.length.toLocaleString()} chars`;
}

async function loadFile(side: Side, file: File) {
  if (file.size > MAX_FILE_BYTES) {
    toast(`“${file.name}” is too large (max 50 MB).`, 'error', 3500);
    return;
  }
  try {
    const text = await file.text();
    if (text.includes('\u0000')) {
      toast(`“${file.name}” looks like a binary file. Text Diff compares text only.`, 'error', 4000);
      return;
    }
    setText(side, text, file.name);
    toast(`Loaded ${file.name}`);
    scheduleRun(true);
  } catch (e) {
    toast(`Could not read “${file.name}”: ${(e as Error).message}`, 'error', 4000);
  }
}

function totalSize() {
  const a = els.text.a.value;
  const b = els.text.b.value;
  return { chars: a.length + b.length, lines: countNl(a) + countNl(b) };
}
function countNl(s: string) {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}
const isLarge = () => {
  const t = totalSize();
  return t.chars > LARGE_CHARS || t.lines > LARGE_LINES;
};

// ---------------------------------------------------------------------------
// Running the diff
// ---------------------------------------------------------------------------
let progressTimer: ReturnType<typeof setTimeout> | undefined;
let jobStarted = 0;

function showProgress(text: string, frac: number | null) {
  els.progress.hidden = false;
  els.progressText.textContent = text;
  els.progressBar.classList.toggle('td-indeterminate', frac === null);
  els.progressBar.style.width = frac === null ? '' : `${Math.round(frac * 100)}%`;
}
function hideProgress() {
  clearTimeout(progressTimer);
  els.progress.hidden = true;
}

function markStale(on: boolean) {
  state.stale = on;
  els.out.classList.toggle('td-stale', on && !!state.result);
  els.compare.classList.toggle('td-attn', on);
  updateStatus();
}

function updateStatus(extra?: string) {
  const parts: string[] = [];
  if (extra) parts.push(extra);
  else if (state.stale && isLarge()) parts.push('Large input: live update is paused. Press Compare (Ctrl+Enter).');
  else if (state.stale && !els.live.checked) parts.push('Inputs changed. Press Compare (Ctrl+Enter).');
  els.status.textContent = parts.join(' ');
  els.status.hidden = !parts.length;
}

const debouncedRun = debounce(() => run(), 250);

/** Called whenever inputs/options change. */
function scheduleRun(immediate = false) {
  markStale(true);
  if (!els.live.checked || isLarge()) {
    if (immediate && !isLarge()) run();
    return;
  }
  if (immediate) run();
  else debouncedRun();
}

async function run() {
  const a = getText('a');
  const b = getText('b');
  const options = { ...state.options };
  const id = ++state.jobId;
  if (diffClient.busy) diffClient.cancel();
  markStale(false);
  updateStatus();
  if (!a && !b) {
    state.result = null;
    state.snap = null;
    hideProgress();
    renderAll();
    return;
  }
  jobStarted = performance.now();
  els.out.setAttribute('aria-busy', 'true');
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => showProgress('Comparing…', null), 150);
  try {
    const result = await diffClient.request<DiffResult>({ type: 'diff', a, b, options }, (phase, done, total) => {
      if (id !== state.jobId) return;
      if (performance.now() - jobStarted < 150) return;
      clearTimeout(progressTimer);
      showProgress(`${phase}… ${total > 1 ? Math.round((100 * done) / total) + '%' : ''}`, total > 1 ? done / total : null);
    });
    if (id !== state.jobId) return;
    const { splitLines } = await import('./engine');
    state.result = result;
    state.snap = { a, b, linesA: splitLines(a), linesB: splitLines(b), options, nameA: fileName('a'), nameB: fileName('b') };
    state.cur = -1;
    state.reverted.clear();
    renderAll();
  } catch (e) {
    if (id !== state.jobId) return;
    const msg = (e as Error).message;
    hideProgress();
    els.out.removeAttribute('aria-busy');
    if (msg === 'cancelled') {
      markStale(true);
      updateStatus('Comparison cancelled.');
    } else {
      toast(`Comparison failed: ${msg}`, 'error', 4000);
    }
  }
}

function fileName(side: Side) {
  return els.name[side].value.trim() || (side === 'a' ? 'original.txt' : 'changed.txt');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
interface Piece {
  html: () => string;
  firstRow: number;
  lastRow: number; // inclusive
  rows: number;
}
let pieces: Piece[] = [];
let renderedPieces = 0;
let renderToken = 0;

const disp = (line: string) => (state.snap!.options.ignoreEol && line.endsWith('\r') ? line.slice(0, -1) : line);

function esc(text: string) {
  let h = escapeHtml(text);
  if (h.includes('\r')) h = h.replace(/\r/g, '<span class="td-cr" title="Carriage return (CR)">␍</span>');
  return h;
}

function segHtml(segs: Seg[] | undefined, fallback: string, cls: string) {
  if (!segs) return esc(fallback);
  let h = '';
  for (const [ch, text] of segs) h += ch ? `<mark class="${cls}">${esc(text)}</mark>` : esc(text);
  return h;
}

const ICON_REVERT =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const ICON_RESTORE =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>';

function actHtml(r: Row, idx: number) {
  const res = state.result!;
  if (r.k !== 1 || res.blocks[r.blk].start !== idx) return '<span class="td-act"></span>';
  const rev = state.reverted.has(r.blk);
  const n = r.blk + 1;
  return `<span class="td-act"><button type="button" class="td-revert" data-blk="${r.blk}" aria-pressed="${rev}" title="${rev ? `Restore change ${n}` : `Revert change ${n} (keep the Original lines in the merged result)`}" aria-label="${rev ? 'Restore' : 'Revert'} change ${n}">${rev ? ICON_RESTORE : ICON_REVERT}</button></span>`;
}

function splitRowHtml(i: number): string {
  const r = state.result!.rows[i];
  const { linesA, linesB } = state.snap!;
  const blkAttr = r.k === 1 ? ` data-blk="${r.blk}"` : '';
  const rev = r.k === 1 && state.reverted.has(r.blk) ? ' td-reverted' : '';
  const cls = r.k === 0 ? 'td-r' : r.k === 1 ? `td-r td-chg${rev}` : 'td-r td-ign';
  const left =
    r.a < 0
      ? '<span class="td-ln td-fill"></span><span class="td-c td-fill"></span>'
      : `<span class="td-ln">${r.a + 1}</span><span class="td-c${r.k === 0 ? '' : r.k === 1 ? ' td-del' : ' td-igc'}">${r.k === 1 ? segHtml(r.sa, disp(linesA[r.a]), 'td-x-del') : esc(disp(linesA[r.a]))}</span>`;
  const right =
    r.b < 0
      ? '<span class="td-ln td-fill"></span><span class="td-c td-fill"></span>'
      : `<span class="td-ln">${r.b + 1}</span><span class="td-c${r.k === 0 ? '' : r.k === 1 ? ' td-add' : ' td-igc'}">${r.k === 1 ? segHtml(r.sb, disp(linesB[r.b]), 'td-x-add') : esc(disp(linesB[r.b]))}</span>`;
  return `<div class="${cls}" data-r="${i}"${blkAttr}>${left}${actHtml(r, i)}${right}</div>`;
}

function unifiedLine(i: number, side: 'eq' | 'del' | 'add', first: boolean): string {
  const r = state.result!.rows[i];
  const { linesA, linesB } = state.snap!;
  const blkAttr = r.k === 1 ? ` data-blk="${r.blk}"` : '';
  const rev = r.k === 1 && state.reverted.has(r.blk) ? ' td-reverted' : '';
  const ign = r.k === 2 ? ' td-ign' : '';
  const act = first ? actHtml(r, i) : '<span class="td-act"></span>';
  if (side === 'eq')
    return `<div class="td-u" data-r="${i}"><span class="td-act"></span><span class="td-ln">${r.a + 1}</span><span class="td-ln">${r.b + 1}</span><span class="td-sign"> </span><span class="td-c">${esc(disp(linesB[r.b]))}</span></div>`;
  if (side === 'del')
    return `<div class="td-u td-chg${rev}${ign}" data-r="${i}"${blkAttr}>${act}<span class="td-ln">${r.a + 1}</span><span class="td-ln"></span><span class="td-sign">−</span><span class="td-c ${r.k === 1 ? 'td-del' : 'td-igc'}">${r.k === 1 ? segHtml(r.sa, disp(linesA[r.a]), 'td-x-del') : esc(disp(linesA[r.a]))}</span></div>`;
  return `<div class="td-u td-chg${rev}${ign}" data-r="${i}"${blkAttr}>${act}<span class="td-ln"></span><span class="td-ln">${r.b + 1}</span><span class="td-sign">+</span><span class="td-c ${r.k === 1 ? 'td-add' : 'td-igc'}">${r.k === 1 ? segHtml(r.sb, disp(linesB[r.b]), 'td-x-add') : esc(disp(linesB[r.b]))}</span></div>`;
}

/** HTML for rows [from, to). Change groups are never split by callers. */
function rowsHtml(from: number, to: number): string {
  const rows = state.result!.rows;
  let h = '';
  if (state.view === 'split') {
    for (let i = from; i < to; i++) h += splitRowHtml(i);
    return h;
  }
  let i = from;
  while (i < to) {
    const r = rows[i];
    if (r.k === 0) {
      h += unifiedLine(i, 'eq', false);
      i++;
      continue;
    }
    let j = i;
    while (j < to && rows[j].k === r.k && rows[j].blk === r.blk) j++;
    let first = true;
    for (let x = i; x < j; x++) if (rows[x].a >= 0) (h += unifiedLine(x, 'del', first)), (first = false);
    for (let x = i; x < j; x++) if (rows[x].b >= 0) (h += unifiedLine(x, 'add', first)), (first = false);
    i = j;
  }
  return h;
}

function gapHtml(from: number, to: number) {
  const n = to - from;
  const more = n > 40;
  return `<div class="td-gap" data-from="${from}" data-to="${to}">
    ${more ? `<button type="button" class="td-gap-btn" data-dir="up" title="Show 20 more lines above">↑ 20</button>` : ''}
    <button type="button" class="td-gap-btn td-gap-all" data-dir="all">Show ${n.toLocaleString()} hidden line${n === 1 ? '' : 's'}</button>
    ${more ? `<button type="button" class="td-gap-btn" data-dir="down" title="Show 20 more lines below">↓ 20</button>` : ''}
  </div>`;
}

function buildPieces(): Piece[] {
  const res = state.result!;
  const rows = res.rows;
  const n = rows.length;
  const ctx = state.context;
  const show = new Uint8Array(n);
  for (const b of res.blocks) {
    const s = Math.max(0, b.start - ctx);
    const e = Math.min(n, b.end + ctx);
    show.fill(1, s, e);
  }
  if (!Number.isFinite(ctx)) show.fill(1);
  const out: Piece[] = [];
  let i = 0;
  while (i < n) {
    if (!show[i]) {
      let j = i;
      while (j < n && !show[j]) j++;
      if (j - i >= 3) {
        const from = i;
        const to = j;
        out.push({ html: () => gapHtml(from, to), firstRow: from, lastRow: to - 1, rows: 1 });
        i = j;
        continue;
      }
      show.fill(1, i, j);
    }
    // a run of visible rows: split into chunks at equal rows
    let j = i;
    while (j < n && show[j]) j++;
    let s = i;
    while (s < j) {
      let e = Math.min(j, s + CHUNK_ROWS);
      while (e < j && rows[e].k !== 0 && rows[e - 1].k !== 0) e++; // never split a change group
      const from = s;
      const to = e;
      out.push({ html: () => rowsHtml(from, to), firstRow: from, lastRow: to - 1, rows: to - from });
      s = e;
    }
    i = j;
  }
  return out;
}

function renderPiece(p: Piece) {
  const wrap = document.createElement('div');
  wrap.className = 'td-chunk';
  if (p.rows > 60) wrap.style.containIntrinsicSize = `auto ${p.rows * 20}px`;
  wrap.innerHTML = p.html();
  els.rows.appendChild(wrap);
}

/** Synchronously render everything up to (and including) the piece containing `row`. */
function ensureRendered(row: number) {
  while (renderedPieces < pieces.length && pieces[renderedPieces].firstRow <= row) renderPiece(pieces[renderedPieces++]);
}

function renderRows() {
  const token = ++renderToken;
  els.rows.textContent = '';
  els.rows.classList.toggle('td-split', state.view === 'split');
  els.rows.classList.toggle('td-unified', state.view === 'unified');
  pieces = buildPieces();
  renderedPieces = 0;
  let budget = FIRST_PAINT_ROWS;
  while (renderedPieces < pieces.length && budget > 0) {
    budget -= pieces[renderedPieces].rows;
    renderPiece(pieces[renderedPieces++]);
  }
  const total = pieces.length;
  const finish = () => {
    hideProgress();
    els.out.removeAttribute('aria-busy');
    if (state.cur >= 0) highlightCurrent(false);
  };
  if (renderedPieces >= total) return finish();
  const step = () => {
    if (token !== renderToken) return;
    const t0 = performance.now();
    while (renderedPieces < total && performance.now() - t0 < 12) renderPiece(pieces[renderedPieces++]);
    if (renderedPieces < total) {
      showProgress(`Rendering… ${Math.round((100 * renderedPieces) / total)}%`, renderedPieces / total);
      requestAnimationFrame(step);
    } else finish();
  };
  requestAnimationFrame(step);
}

function lnWidth() {
  const s = state.snap;
  const max = s ? Math.max(s.linesA.length, s.linesB.length, 9) : 9;
  return `${String(max).length + 1.5}ch`;
}

function renderAll() {
  const res = state.result;
  const snap = state.snap;
  els.out.classList.remove('td-stale');
  renderStats();
  renderNotices();
  if (!res || !snap) {
    pieces = [];
    renderToken++;
    els.rows.textContent = '';
    els.colhead.innerHTML = '';
    els.rows.innerHTML =
      '<div class="td-empty"><strong>Nothing to compare yet.</strong><span class="muted">Paste text into both panes, open or drop files, or load an example.</span></div>';
    els.out.removeAttribute('aria-busy');
    hideProgress();
    updateNav();
    return;
  }
  els.out.style.setProperty('--td-lnw', lnWidth());
  els.colhead.className = `td-colhead ${state.view === 'split' ? 'td-split' : 'td-unified'}`;
  els.colhead.innerHTML =
    state.view === 'split'
      ? `<span class="td-colname" title="${escapeHtml(snap.nameA)}"><span class="td-dot td-dot-a"></span>${escapeHtml(snap.nameA)}</span><span class="td-colname" title="${escapeHtml(snap.nameB)}"><span class="td-dot td-dot-b"></span>${escapeHtml(snap.nameB)}</span>`
      : `<span class="td-colname"><span class="td-dot td-dot-a"></span>${escapeHtml(snap.nameA)} <span class="faint">→</span> <span class="td-dot td-dot-b"></span>${escapeHtml(snap.nameB)}</span>`;
  renderRows();
  updateNav();
}

function renderStats() {
  const res = state.result;
  const set = (id: string, v: string) => ($(id).textContent = v);
  $('td-stats').hidden = !res;
  if (!res) return;
  const s = res.stats;
  set('td-stat-added', s.added.toLocaleString());
  set('td-stat-removed', s.removed.toLocaleString());
  set('td-stat-changed', s.changed.toLocaleString());
  const sim = s.similarity;
  set('td-stat-sim', `${sim >= 99.95 || sim === 0 ? sim.toFixed(0) : sim.toFixed(1)}%`);
  set('td-stat-blocks', `${res.blocks.length.toLocaleString()} change${res.blocks.length === 1 ? '' : 's'}`);
  $('td-stat-time').textContent = `${res.ms < 1 ? '<1' : Math.round(res.ms)} ms`;
}

function eolName(e: string) {
  return e === 'None' ? 'no line breaks' : e;
}

function renderNotices() {
  const res = state.result;
  const snap = state.snap;
  const n: string[] = [];
  if (res && snap) {
    const o = snap.options;
    const { infoA, infoB } = res;
    const eolDiffers = infoA.eol !== infoB.eol && infoA.eol !== 'None' && infoB.eol !== 'None';
    if (res.identical) n.push(`<div class="alert alert-success" data-notice="identical">The two texts are identical.</div>`);
    else if (res.onlyEol)
      n.push(
        `<div class="alert alert-warning" data-notice="only-eol"><strong>Only line endings differ:</strong> Original uses ${eolName(infoA.eol)}, Changed uses ${eolName(infoB.eol)}. ${
          o.ignoreEol ? 'They are ignored now; turn off “Ignore line endings” to see each affected line.' : 'Affected lines are marked with ␍.'
        }</div>`,
      );
    else if (res.onlyFinalNewline)
      n.push(
        `<div class="alert alert-warning" data-notice="only-final-newline"><strong>Only the newline at the end of the file differs:</strong> ${
          infoA.finalNewline ? 'Changed' : 'Original'
        } has no final newline.</div>`,
      );
    else if (!res.blocks.length) n.push(`<div class="alert alert-info" data-notice="no-diff-ignored">No differences after applying the ignore options.</div>`);
    if (!res.onlyEol && (eolDiffers || infoA.eol === 'Mixed' || infoB.eol === 'Mixed'))
      n.push(
        `<div class="alert alert-info" data-notice="eol-differs">Line endings: Original ${eolName(infoA.eol)}, Changed ${eolName(infoB.eol)}${
          o.ignoreEol ? ' (ignored).' : '. Lines differing only by a carriage return are marked ␍.'
        }</div>`,
      );
    if (res.aborted)
      n.push(`<div class="alert alert-warning" data-notice="aborted">These texts are very different, so the diff gave up looking for the minimal set of changes and shows a coarser result.</div>`);
  }
  els.notices.innerHTML = n.join('');
  els.notices.hidden = !n.length;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function updateNav() {
  const total = state.result?.blocks.length ?? 0;
  els.pos.textContent = total ? (state.cur >= 0 ? `${state.cur + 1} of ${total}` : `${total} change${total === 1 ? '' : 's'}`) : 'No changes';
  ($('td-prev') as HTMLButtonElement).disabled = !total;
  ($('td-next') as HTMLButtonElement).disabled = !total;
}

function highlightCurrent(scroll = true) {
  els.rows.querySelectorAll('.td-cur').forEach((el) => el.classList.remove('td-cur', 'td-cur-first', 'td-cur-last'));
  const res = state.result;
  if (!res || state.cur < 0) return;
  const b = res.blocks[state.cur];
  ensureRendered(b.end - 1);
  const els2 = els.rows.querySelectorAll<HTMLElement>(`[data-blk="${state.cur}"]`);
  els2.forEach((el) => el.classList.add('td-cur'));
  if (els2.length) {
    els2[0].classList.add('td-cur-first');
    els2[els2.length - 1].classList.add('td-cur-last');
    if (scroll) scrollToEl(els2[0]);
  }
}

function scrollToEl(el: HTMLElement) {
  const out = els.out;
  const head = els.colhead.offsetHeight;
  const top = el.getBoundingClientRect().top - out.getBoundingClientRect().top + out.scrollTop - head - out.clientHeight / 3;
  out.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  // Make sure the output box itself is on screen.
  const r = out.getBoundingClientRect();
  if (r.top < 60 || r.top > window.innerHeight - 120) out.scrollIntoView({ block: 'nearest' });
}

function go(delta: number) {
  const total = state.result?.blocks.length ?? 0;
  if (!total) {
    toast('No changes to navigate');
    return;
  }
  state.cur = state.cur < 0 ? (delta > 0 ? 0 : total - 1) : (state.cur + delta + total) % total;
  highlightCurrent(true);
  updateNav();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function patchContext() {
  return Number.isFinite(state.context) ? state.context : 1_000_000;
}

async function buildPatch(): Promise<string> {
  const a = getText('a');
  const b = getText('b');
  const msg = { type: 'patch', a, b, nameA: fileName('a'), nameB: fileName('b'), context: patchContext() };
  if (a.length + b.length <= SYNC_PATCH_CHARS) return createTwoFilesPatch(msg.nameA, msg.nameB, a, b, undefined, undefined, { context: msg.context });
  toast('Building patch…');
  return patchClient.request<string>(msg);
}

function mergedText(): string {
  const res = state.result!;
  const { linesA, linesB, b } = state.snap!;
  const out: string[] = [];
  for (const r of res.rows) {
    if (r.k === 1 && state.reverted.has(r.blk)) {
      if (r.a >= 0) out.push(linesA[r.a]);
    } else if (r.b >= 0) out.push(linesB[r.b]);
  }
  if (!out.length) return '';
  const finalNl = b === '' ? state.snap!.a.endsWith('\n') : b.endsWith('\n');
  const eol = detectEol(b) === 'crlf' ? '\r\n' : '\n';
  // Lines keep their own CR, so joining with \n preserves CRLF files exactly.
  let text = out.join('\n');
  if (finalNl) text += eol === '\r\n' && !out[out.length - 1].endsWith('\r') ? '\r\n' : '\n';
  return text;
}

function baseName(name: string) {
  return name.replace(/\.[^./\\]+$/, '') || 'changes';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function setPressed(groupId: string, value: string) {
  $(groupId)
    .querySelectorAll<HTMLButtonElement>('[data-value]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
}

function loadExample(id: string) {
  const ex = EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
  setText('a', ex.a, ex.nameA);
  setText('b', ex.b, ex.nameB);
  run();
}

export function init() {
  (['a', 'b'] as Side[]).forEach((side) => {
    const ta = els.text[side];
    ta.addEventListener('input', () => {
      const s = state.sides[side];
      if (s.raw !== null) {
        if (s.eol === 'mixed') s.eol = detectEol(s.raw) === 'mixed' ? ((s.raw.match(/\r\n/g) || []).length * 2 > countNl(s.raw) ? 'crlf' : 'lf') : s.eol;
        s.raw = null;
        syncEolSelect(side);
      }
      updateMeta(side);
      scheduleRun();
    });
    els.eol[side].addEventListener('change', () => {
      state.sides[side] = { raw: null, eol: els.eol[side].value as Eol };
      syncEolSelect(side);
      updateMeta(side);
      scheduleRun(true);
    });
    els.name[side].addEventListener('change', () => {
      if (state.snap) {
        state.snap.nameA = fileName('a');
        state.snap.nameB = fileName('b');
        renderAll();
      }
    });
    $(`td-clear-${side}`).addEventListener('click', () => {
      setText(side, '');
      ta.focus();
      scheduleRun(true);
    });
    setupDropzone($(`td-drop-${side}`), (files) => loadFile(side, files[0]), { accept: '.txt,.md,.json,.js,.ts,.css,.html,.xml,.yaml,.yml,.csv,.log,.ini,.conf,.cfg,.toml,.diff,.patch,.py,.java,.c,.h,.cpp,.go,.rs,.rb,.php,.sql,.sh,text/*' });
    // Dropping a file anywhere on the pane (including the textarea) loads it.
    const pane = $(`td-pane-${side}`);
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    pane.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      pane.classList.add('td-dragover');
    });
    pane.addEventListener('dragleave', (e) => {
      if (!pane.contains(e.relatedTarget as Node)) pane.classList.remove('td-dragover');
    });
    pane.addEventListener('drop', (e) => {
      pane.classList.remove('td-dragover');
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      const f = e.dataTransfer!.files[0];
      if (f) loadFile(side, f);
    });
  });

  $('td-swap').addEventListener('click', () => {
    const [ta, tb] = [els.text.a.value, els.text.b.value];
    const [na, nb] = [els.name.a.value, els.name.b.value];
    const [sa, sb] = [state.sides.a, state.sides.b];
    els.text.a.value = tb;
    els.text.b.value = ta;
    els.name.a.value = nb;
    els.name.b.value = na;
    state.sides = { a: sb, b: sa };
    syncEolSelect('a');
    syncEolSelect('b');
    updateMeta('a');
    updateMeta('b');
    toast('Swapped Original and Changed');
    scheduleRun(true);
  });

  $('td-load-example').addEventListener('click', () => {
    loadExample(($('td-example') as HTMLSelectElement).value);
    toast('Example loaded');
  });

  els.compare.addEventListener('click', () => run());
  $('td-cancel').addEventListener('click', () => {
    state.jobId++;
    diffClient.cancel();
    renderToken++;
    hideProgress();
    els.out.removeAttribute('aria-busy');
    markStale(true);
    updateStatus('Comparison cancelled.');
  });
  els.live.addEventListener('change', () => {
    if (els.live.checked && state.stale) scheduleRun(true);
    updateStatus();
  });

  // View / highlight toggles
  $('td-view').addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-value]')?.dataset.value as View | undefined;
    if (!v || v === state.view) return;
    state.view = v;
    setPressed('td-view', v);
    if (state.result) renderAll();
  });
  $('td-inline').addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-value]')?.dataset.value as InlineMode | undefined;
    if (!v || v === state.options.inline) return;
    state.options.inline = v;
    setPressed('td-inline', v);
    scheduleRun(true);
  });
  const ctxSel = $<HTMLSelectElement>('td-context');
  ctxSel.addEventListener('change', () => {
    state.context = ctxSel.value === 'all' ? Infinity : Number(ctxSel.value);
    if (state.result) renderAll();
  });
  const wsSel = $<HTMLSelectElement>('td-ws');
  wsSel.addEventListener('change', () => {
    state.options.ws = wsSel.value as WsMode;
    scheduleRun(true);
  });
  const bindCheck = (id: string, key: 'ignoreCase' | 'ignoreBlank' | 'ignoreEol') => {
    const el = $<HTMLInputElement>(id);
    el.checked = state.options[key];
    el.addEventListener('change', () => {
      state.options[key] = el.checked;
      scheduleRun(true);
    });
  };
  bindCheck('td-ignore-case', 'ignoreCase');
  bindCheck('td-ignore-blank', 'ignoreBlank');
  bindCheck('td-ignore-eol', 'ignoreEol');

  // Output interactions (gap expanders, revert buttons)
  els.rows.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const gapBtn = t.closest<HTMLButtonElement>('.td-gap-btn');
    if (gapBtn) return expandGap(gapBtn.closest<HTMLElement>('.td-gap')!, gapBtn.dataset.dir as 'up' | 'down' | 'all');
    const rev = t.closest<HTMLButtonElement>('.td-revert');
    if (rev) {
      const blk = Number(rev.dataset.blk);
      if (state.reverted.has(blk)) state.reverted.delete(blk);
      else state.reverted.add(blk);
      rerenderBlock(blk);
      toast(state.reverted.has(blk) ? `Change ${blk + 1} reverted in the merged result` : `Change ${blk + 1} restored`);
      updateRevertedCount();
    }
  });

  $('td-prev').addEventListener('click', () => go(-1));
  $('td-next').addEventListener('click', () => go(1));

  $('td-copy-patch').addEventListener('click', async () => {
    try {
      const p = await buildPatch();
      await copyText(p, hasHunks(p) ? 'Patch copied' : 'No differences: copied an empty patch');
    } catch (e) {
      toast(`Could not build the patch: ${(e as Error).message}`, 'error');
    }
  });
  const download = async (ext: string) => {
    try {
      const p = await buildPatch();
      downloadText(p, `${baseName(fileName('b'))}.${ext}`, 'text/x-diff;charset=utf-8');
      toast(hasHunks(p) ? `Downloaded ${baseName(fileName('b'))}.${ext}` : 'No differences: the patch is empty');
    } catch (e) {
      toast(`Could not build the patch: ${(e as Error).message}`, 'error');
    }
  };
  $('td-dl-diff').addEventListener('click', () => download('diff'));
  $('td-dl-patch').addEventListener('click', () => download('patch'));
  $('td-copy-merged').addEventListener('click', () => {
    if (!state.result) return toast('Nothing to copy yet', 'error');
    const n = state.reverted.size;
    copyText(mergedText(), n ? `Merged text copied (${n} change${n === 1 ? '' : 's'} reverted)` : 'Changed text copied');
  });
  $('td-dl-merged').addEventListener('click', () => {
    if (!state.result) return toast('Nothing to download yet', 'error');
    downloadText(mergedText(), `${baseName(fileName('b'))}.merged${(fileName('b').match(/\.[^./\\]+$/) || ['.txt'])[0]}`);
    toast('Merged text downloaded');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const typing = t.matches('input, textarea, select, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
      return;
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      go(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'j' || e.key === 'F7') {
      if (e.key === 'F7' && e.shiftKey) go(-1);
      else go(1);
      e.preventDefault();
    } else if (e.key === 'p' || e.key === 'k') {
      go(-1);
      e.preventDefault();
    }
  });

  // Initial state
  if (window.innerWidth < 760) {
    state.view = 'unified';
    setPressed('td-view', 'unified');
  }
  loadExample('code');
}

function hasHunks(p: string) {
  return /^@@ /m.test(p);
}

function updateRevertedCount() {
  const n = state.reverted.size;
  const el = $('td-reverted-count');
  el.textContent = n ? `${n} reverted` : '';
  el.hidden = !n;
}

function rerenderBlock(blk: number) {
  const b = state.result!.blocks[blk];
  const nodes = els.rows.querySelectorAll<HTMLElement>(`[data-blk="${blk}"]`);
  if (!nodes.length) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = rowsHtml(b.start, b.end);
  nodes[0].before(...Array.from(tmp.children));
  nodes.forEach((n) => n.remove());
  if (state.cur === blk) highlightCurrent(false);
  els.rows.querySelector<HTMLButtonElement>(`.td-revert[data-blk="${blk}"]`)?.focus();
}

function expandGap(gap: HTMLElement, dir: 'up' | 'down' | 'all') {
  let from = Number(gap.dataset.from);
  let to = Number(gap.dataset.to);
  const STEP = 20;
  if (dir === 'all' || to - from <= STEP + 2) {
    gap.insertAdjacentHTML('beforebegin', rowsHtml(from, to));
    gap.remove();
    return;
  }
  if (dir === 'up') {
    gap.insertAdjacentHTML('beforebegin', rowsHtml(from, from + STEP));
    from += STEP;
  } else {
    gap.insertAdjacentHTML('afterend', rowsHtml(to - STEP, to));
    to -= STEP;
  }
  const replacement = document.createElement('div');
  replacement.innerHTML = gapHtml(from, to);
  const fresh = replacement.firstElementChild as HTMLElement;
  gap.replaceWith(fresh);
  fresh.querySelector<HTMLButtonElement>(`.td-gap-btn[data-dir="${dir}"]`)?.focus();
}
