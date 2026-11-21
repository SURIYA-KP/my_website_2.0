// Virtualized table: only the rows in view are in the DOM, so 200k+ rows scroll
// smoothly. Sticky header with sort indicators, filter buttons and resizable columns.
import { escapeHtml } from '../../lib/ui';
import { displayText, isNull } from './format';
import { TYPE_ICON, TYPE_LABEL, isNumericType } from './types';
import type { DataView } from './view';

export interface GridOptions {
  filters?: boolean;
  onSortChange?: () => void;
  onFilterClick?: (col: number, anchor: HTMLElement) => void;
  onSelect?: (row: number, col: number) => void;
  emptyHtml?: () => string;
}

const ROW_H = 30;
const NUM_W = 64;
const MAX_PX = 8_000_000; // keep below browser element-height limits; scale beyond
const OVERSCAN = 6;

const FILTER_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/></svg>';

export class Grid {
  root: HTMLElement;
  private scroller: HTMLDivElement;
  private head: HTMLDivElement;
  private body: HTMLDivElement;
  private empty: HTMLDivElement;
  private view: DataView | null = null;
  private opts: GridOptions;
  private cols: number[] = [];
  private pool: HTMLDivElement[] = [];
  private raf = 0;
  private totalW = 0;
  selected: { row: number; col: number } | null = null;

  constructor(root: HTMLElement, opts: GridOptions = {}) {
    this.root = root;
    this.opts = opts;
    root.classList.add('dx-grid-wrap');
    root.innerHTML = '';
    this.scroller = document.createElement('div');
    this.scroller.className = 'dx-grid';
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'table');
    this.head = document.createElement('div');
    this.head.className = 'dx-head';
    this.head.setAttribute('role', 'rowgroup');
    this.body = document.createElement('div');
    this.body.className = 'dx-body';
    this.body.setAttribute('role', 'rowgroup');
    this.empty = document.createElement('div');
    this.empty.className = 'dx-empty';
    this.empty.hidden = true;
    this.scroller.append(this.head, this.body);
    root.append(this.scroller, this.empty);
    this.scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.body.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.dx-cell[data-c]');
      if (!cell) return;
      const rowEl = cell.parentElement as HTMLElement;
      const row = Number(rowEl.dataset.r);
      const col = Number(cell.dataset.c);
      this.selected = { row, col };
      this.paint();
      this.opts.onSelect?.(row, col);
    });
    this.head.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const fbtn = t.closest<HTMLElement>('.dx-fbtn');
      if (fbtn) {
        this.opts.onFilterClick?.(Number(fbtn.dataset.c), fbtn);
        return;
      }
      const hbtn = t.closest<HTMLElement>('.dx-hbtn');
      if (hbtn && this.view) {
        this.view.toggleSort(Number(hbtn.dataset.c), (e as MouseEvent).shiftKey);
        this.opts.onSortChange?.();
      }
    });
    this.head.addEventListener('pointerdown', (e) => this.startResize(e));
  }

  setView(view: DataView) {
    this.view = view;
    this.selected = null;
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    if (!view.widths.length) view.widths = this.autoWidths(view);
    this.refresh();
  }

  get scrollElement() {
    return this.scroller;
  }

  /** Rebuild header and rows after any change to the view. */
  refresh() {
    const v = this.view;
    if (!v) return;
    this.cols = v.visibleColumns;
    this.totalW = NUM_W + this.cols.reduce((s, c) => s + v.widths[c], 0);
    this.scroller.setAttribute('aria-rowcount', String(v.indices.length + 1));
    this.scroller.setAttribute('aria-colcount', String(this.cols.length + 1));
    this.renderHead();
    for (const r of this.pool) r.remove();
    this.pool = [];
    const n = v.indices.length;
    this.body.style.height = `${Math.min(n * ROW_H, MAX_PX)}px`;
    this.body.style.width = `${this.totalW}px`;
    if (this.scroller.scrollTop > n * ROW_H) this.scroller.scrollTop = 0;
    this.empty.hidden = n > 0;
    if (!n) this.empty.innerHTML = this.opts.emptyHtml?.() ?? '<p>No rows.</p>';
    this.paint();
  }

  private renderHead() {
    const v = this.view!;
    const ds = v.ds;
    const sortPos = new Map(v.sort.map((s, i) => [s.col, { i, desc: s.desc }]));
    let html = `<div class="dx-row dx-hrow" role="row" style="width:${this.totalW}px"><div class="dx-cell dx-num dx-hnum" role="columnheader" style="width:${NUM_W}px"><span class="sr-only">Row number</span>#</div>`;
    for (const c of this.cols) {
      const col = ds.columns[c];
      const s = sortPos.get(c);
      const filtered = v.filters.has(c);
      const aria = s ? (s.desc ? 'descending' : 'ascending') : 'none';
      const ind = s ? `<span class="dx-sort" aria-hidden="true">${s.desc ? '▼' : '▲'}${v.sort.length > 1 ? `<sub>${s.i + 1}</sub>` : ''}</span>` : '';
      const name = escapeHtml(col.name);
      html += `<div class="dx-cell dx-hcell${isNumericType(col.type) ? ' dx-right' : ''}${s ? ' is-sorted' : ''}" role="columnheader" aria-sort="${aria}" data-c="${c}" data-type="${col.type}" style="width:${v.widths[c]}px">`;
      html += `<button type="button" class="dx-hbtn" data-c="${c}" title="${name} · ${TYPE_LABEL[col.type]}. Click to sort, Shift+click to add to the sort."><span class="dx-tico dx-t-${col.type}" aria-label="${TYPE_LABEL[col.type]}">${TYPE_ICON[col.type]}</span><span class="dx-hname">${name}</span>${ind}</button>`;
      if (this.opts.filters) html += `<button type="button" class="dx-fbtn${filtered ? ' is-active' : ''}" data-c="${c}" aria-label="Filter ${name}${filtered ? ' (active)' : ''}" title="Filter">${FILTER_ICON}</button>`;
      html += `<span class="dx-resize" data-c="${c}" aria-hidden="true"></span></div>`;
    }
    html += '</div>';
    this.head.innerHTML = html;
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  /** Render the rows currently in the viewport. */
  paint() {
    const v = this.view;
    if (!v) return;
    const n = v.indices.length;
    const st = this.scroller.scrollTop;
    const headH = this.head.offsetHeight;
    const vh = Math.max(ROW_H, this.scroller.clientHeight - headH);
    const full = n * ROW_H;
    const virt = Math.min(full, MAX_PX);
    const ratio = virt > vh && full > virt ? (full - vh) / (virt - vh) : 1;
    const logical = st * ratio;
    const first = Math.max(0, Math.floor(logical / ROW_H) - OVERSCAN);
    const last = Math.min(n, Math.ceil((logical + vh) / ROW_H) + OVERSCAN);
    const count = Math.max(0, last - first);
    while (this.pool.length < count) {
      const row = document.createElement('div');
      row.className = 'dx-row';
      row.setAttribute('role', 'row');
      row.style.width = `${this.totalW}px`;
      let html = `<div class="dx-cell dx-num" role="cell" style="width:${NUM_W}px"></div>`;
      for (const c of this.cols) {
        const t = v.ds.columns[c].type;
        html += `<div class="dx-cell${isNumericType(t) ? ' dx-right' : ''}" role="cell" data-c="${c}" style="width:${v.widths[c]}px"></div>`;
      }
      row.innerHTML = html;
      this.body.appendChild(row);
      this.pool.push(row);
    }
    for (let k = 0; k < this.pool.length; k++) {
      const el = this.pool[k];
      if (k >= count) {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      const i = first + k;
      const r = v.indices[i];
      el.style.transform = `translateY(${st + (i * ROW_H - logical)}px)`;
      el.setAttribute('aria-rowindex', String(i + 2));
      el.classList.toggle('is-odd', i % 2 === 1);
      if (el.dataset.r === String(r) && el.dataset.i === String(i)) {
        this.markSelection(el, r);
        continue;
      }
      el.dataset.r = String(r);
      el.dataset.i = String(i);
      const cells = el.children;
      (cells[0] as HTMLElement).textContent = String(r + 1);
      for (let j = 0; j < this.cols.length; j++) {
        const col = v.ds.columns[this.cols[j]];
        const cell = cells[j + 1] as HTMLElement;
        if (isNull(col, r)) {
          cell.textContent = '—';
          cell.classList.add('dx-null');
          cell.removeAttribute('title');
        } else {
          const txt = displayText(col, r);
          cell.classList.remove('dx-null');
          if (col.type === 'string' && (txt.length > 40 || txt.includes('\n'))) {
            cell.textContent = txt.replace(/\r?\n/g, ' ↵ ');
            cell.title = txt.length > 2000 ? txt.slice(0, 2000) + '…' : txt;
          } else {
            cell.textContent = txt;
            cell.removeAttribute('title');
          }
        }
      }
      this.markSelection(el, r);
    }
  }

  private markSelection(el: HTMLElement, r: number) {
    const sel = this.selected;
    const cells = el.children;
    for (let j = 0; j < this.cols.length; j++) {
      (cells[j + 1] as HTMLElement).classList.toggle('is-selected', !!sel && sel.row === r && sel.col === this.cols[j]);
    }
  }

  /** Scroll so that view position i is visible (used by tests and keyboard). */
  scrollToIndex(i: number) {
    const v = this.view;
    if (!v) return;
    const full = v.indices.length * ROW_H;
    const virt = Math.min(full, MAX_PX);
    const vh = this.scroller.clientHeight - this.head.offsetHeight;
    const ratio = virt > vh && full > virt ? (full - vh) / (virt - vh) : 1;
    this.scroller.scrollTop = (i * ROW_H) / ratio;
  }

  private autoWidths(v: DataView): number[] {
    const sample = Math.min(v.ds.rowCount, 300);
    return v.ds.columns.map((col) => {
      let max = col.name.length + 4;
      for (let r = 0; r < sample; r++) {
        const len = displayText(col, r).length;
        if (len > max) max = len;
      }
      return Math.round(Math.min(320, Math.max(84, max * 7.6 + 34)));
    });
  }

  private applyWidths() {
    const v = this.view!;
    this.totalW = NUM_W + this.cols.reduce((s, c) => s + v.widths[c], 0);
    const w = `${this.totalW}px`;
    this.body.style.width = w;
    for (const row of [this.head.firstElementChild as HTMLElement, ...this.pool]) {
      if (!row) continue;
      row.style.width = w;
      row.querySelectorAll<HTMLElement>('[data-c].dx-cell').forEach((el) => (el.style.width = `${v.widths[Number(el.dataset.c)]}px`));
    }
  }

  private startResize(e: PointerEvent) {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.dx-resize');
    if (!handle || !this.view) return;
    e.preventDefault();
    const c = Number(handle.dataset.c);
    const v = this.view;
    const startX = e.clientX;
    const startW = v.widths[c];
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      v.widths[c] = Math.max(56, Math.min(800, startW + ev.clientX - startX));
      this.applyWidths();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
}
