// Popovers for the table: per-column filters (contains / range / date range /
// pick values) and the column show/hide menu. Also describes active filters as chips.
import { escapeHtml } from '../../lib/ui';
import { formatDate, formatStat } from './format';
import { TYPE_LABEL, isNumericType, type Column } from './types';
import { keyOf, type DataView, type Filter } from './view';

/** A single floating panel anchored to a button. */
export class Popover {
  el: HTMLElement;
  private anchor: HTMLElement | null = null;
  /** Finds the anchor again after the table header re-renders. */
  private reanchor: (() => HTMLElement | null) | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    document.addEventListener('pointerdown', (e) => {
      if (this.el.hidden) return;
      const t = e.target as Node;
      if (this.el.contains(t) || this.liveAnchor()?.contains(t)) return;
      this.close(false);
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
      }
    });
    window.addEventListener('resize', () => this.place());
    document.addEventListener('scroll', (e) => {
      if (!this.el.hidden && this.anchor && !this.el.contains(e.target as Node)) this.place();
    }, true);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  isFor(anchor: HTMLElement) {
    return this.isOpen && this.liveAnchor() === anchor;
  }

  private liveAnchor() {
    if (this.anchor && !this.anchor.isConnected) {
      const a = this.reanchor?.() ?? null;
      if (a) a.setAttribute('aria-expanded', 'true');
      this.anchor = a;
    }
    return this.anchor;
  }

  /** Show fresh content (a new element each time, so old listeners go away with it). */
  open(anchor: HTMLElement, label: string, html: string, reanchor?: () => HTMLElement | null): HTMLElement {
    this.close(false);
    this.anchor = anchor;
    this.reanchor = reanchor ?? null;
    this.el.setAttribute('aria-label', label);
    const content = document.createElement('div');
    content.className = 'dx-pop-content';
    content.innerHTML = html;
    this.el.replaceChildren(content);
    this.el.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    this.place();
    const first = this.el.querySelector<HTMLElement>('[data-autofocus]') ?? this.el.querySelector<HTMLElement>('input, select, button');
    first?.focus({ preventScroll: true });
    return content;
  }

  close(returnFocus: boolean) {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.el.innerHTML = '';
    const a = this.liveAnchor();
    this.anchor = null;
    this.reanchor = null;
    a?.setAttribute('aria-expanded', 'false');
    if (returnFocus && a?.isConnected) a.focus({ preventScroll: true });
  }

  /** Position below the anchor, kept inside the viewport. */
  place() {
    if (this.el.hidden) return;
    const anchor = this.liveAnchor();
    if (!anchor) return this.close(false);
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    let left = Math.min(r.right - w, vw - w - 8);
    if (left < 8) left = Math.max(8, Math.min(r.left, vw - w - 8));
    let top = r.bottom + 6;
    if (top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(Math.max(8, top))}px`;
  }
}

const isoDay = (t: number | null) => (t == null || !Number.isFinite(t) ? '' : formatDate(t));

function columnRange(col: Column) {
  const d = col.data as Float64Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

function valueCounts(col: Column, n: number) {
  const counts = new Map<string, number>();
  for (let r = 0; r < n; r++) {
    const k = keyOf(col, r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

const MAX_PICK = 1000;

/** Short human description of an active filter, for chips. */
export function describeFilter(col: Column, f: Filter): string {
  if (f.kind === 'text') return `contains “${f.q}”`;
  if (f.kind === 'set') {
    const vals = Array.from(f.values).map((v) => (v === '' ? '(empty)' : v));
    if (!vals.length) return 'no values';
    return vals.length <= 2 ? `is ${vals.join(' or ')}` : `${vals.length} values`;
  }
  const fmt = (v: number) => (col.type === 'date' ? formatDate(v, col.hasTime) : formatStat(v));
  if (f.min != null && f.max != null) return `${fmt(f.min)} – ${fmt(f.max)}`;
  if (f.min != null) return `≥ ${fmt(f.min)}`;
  return `≤ ${fmt(f.max!)}`;
}

/** Build and open the filter editor for column c. `onChange` fires (debounced) on every edit. */
export function openFilter(pop: Popover, view: DataView, c: number, anchor: HTMLElement, onChange: () => void) {
  const col = view.ds.columns[c];
  const cur = view.filters.get(c);
  const name = escapeHtml(col.name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const apply = (f: Filter | null) => {
    clearTimeout(timer);
    if (f) view.filters.set(c, f);
    else view.filters.delete(c);
    onChange();
  };
  /** Typing applies after a short pause; any immediate apply (or closing) cancels it. */
  const later = (f: Filter | null) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (el.isConnected) apply(f);
    }, 180);
  };
  let body = '';
  let mode: 'text' | 'set' | 'range' = 'text';
  let counts: { value: string; count: number }[] = [];

  if (isNumericType(col.type) || col.type === 'date') {
    mode = 'range';
    const { lo, hi } = columnRange(col);
    const isDate = col.type === 'date';
    const rf = cur?.kind === 'range' ? cur : null;
    const val = (v: number | null | undefined) => (v == null ? '' : isDate ? isoDay(v) : String(v));
    const ph = (v: number) => (Number.isFinite(v) ? (isDate ? isoDay(v) : formatStat(v)) : '');
    const type = isDate ? 'date' : 'number';
    body = `<p class="dx-pop-hint small faint">${isDate ? 'Dates' : 'Values'} from ${ph(lo) || '–'} to ${ph(hi) || '–'}</p>
      <div class="dx-pop-range">
        <label class="field"><span class="label">${isDate ? 'From' : 'Min'}</span><input class="input" type="${type}" step="any" data-k="min" value="${escapeHtml(val(rf?.min))}" placeholder="${escapeHtml(ph(lo))}" data-autofocus /></label>
        <label class="field"><span class="label">${isDate ? 'To' : 'Max'}</span><input class="input" type="${type}" step="any" data-k="max" value="${escapeHtml(val(rf?.max != null && isDate ? rf.max - 86399999 : rf?.max))}" placeholder="${escapeHtml(ph(hi))}" /></label>
      </div>`;
  } else {
    counts = valueCounts(col, view.ds.rowCount);
    const pickable = counts.length <= MAX_PICK;
    mode = col.type === 'boolean' || (cur?.kind === 'set' && pickable) || (!cur && pickable && counts.length <= 30) ? 'set' : 'text';
    const sel = cur?.kind === 'set' ? cur.values : null;
    const list = pickable
      ? counts
          .map(
            (v, i) =>
              `<label class="dx-pick" data-v="${escapeHtml(v.value.toLowerCase())}"><input type="checkbox" data-i="${i}"${!sel || sel.has(v.value) ? ' checked' : ''} /><span class="dx-pick-v">${v.value === '' ? '<em class="faint">(empty)</em>' : escapeHtml(v.value.length > 80 ? v.value.slice(0, 80) + '…' : v.value)}</span><span class="dx-pick-n faint">${v.count.toLocaleString()}</span></label>`,
          )
          .join('')
      : '';
    const seg =
      pickable && col.type !== 'boolean'
        ? `<div class="btn-group dx-pop-modes" role="group" aria-label="Filter mode"><button type="button" class="btn btn-sm" data-mode="text" aria-pressed="${mode === 'text'}">Contains</button><button type="button" class="btn btn-sm" data-mode="set" aria-pressed="${mode === 'set'}">Pick values</button></div>`
        : '';
    body = `${seg}
      <div class="dx-pop-text" ${mode === 'text' ? '' : 'hidden'}>
        <label class="field"><span class="label">Text contains</span><input class="input" type="search" data-k="q" value="${escapeHtml(cur?.kind === 'text' ? cur.q : '')}" placeholder="Type to filter…" autocomplete="off" spellcheck="false" ${mode === 'text' ? 'data-autofocus' : ''} /></label>
        ${pickable ? '' : `<p class="small faint dx-pop-hint">${counts.length.toLocaleString()} distinct values: too many to list, so this column filters by text.</p>`}
      </div>
      <div class="dx-pop-set" ${mode === 'set' ? '' : 'hidden'}>
        ${counts.length > 8 ? `<input class="input dx-pick-search" type="search" placeholder="Search ${counts.length.toLocaleString()} values…" aria-label="Search values" autocomplete="off" ${mode === 'set' ? 'data-autofocus' : ''} />` : ''}
        <div class="dx-pick-actions small"><button type="button" class="btn btn-sm btn-ghost" data-all="1">Select all</button><button type="button" class="btn btn-sm btn-ghost" data-all="0">Select none</button></div>
        <div class="dx-pick-list" role="group" aria-label="Values">${list}</div>
      </div>`;
  }

  const html = `<div class="dx-pop-head"><strong>Filter <span class="dx-pop-col">${name}</span></strong><span class="badge">${TYPE_LABEL[col.type]}</span></div>
    <div class="dx-pop-body">${body}</div>
    <div class="dx-pop-foot"><button type="button" class="btn btn-sm btn-ghost" data-act="clear">Clear filter</button><button type="button" class="btn btn-sm btn-primary" data-act="done">Done</button></div>`;
  const fromChip = anchor.matches('[data-edit]');
  const el = pop.open(anchor, `Filter ${col.name}`, html, () =>
    (fromChip && document.querySelector<HTMLElement>(`#dx-chips [data-edit="${c}"]`)) ||
    document.querySelector<HTMLElement>(`#dx-grid .dx-fbtn[data-c="${c}"]`),
  );

  const readRange = (): Filter | null => {
    const get = (k: string) => el.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!.value.trim();
    const conv = (s: string, end: boolean) => {
      if (!s) return null;
      if (col.type === 'date') {
        const t = Date.parse(`${s}T00:00:00Z`);
        return Number.isNaN(t) ? null : end ? t + 86399999 : t;
      }
      const v = Number(s);
      return Number.isFinite(v) ? v : null;
    };
    const min = conv(get('min'), false);
    const max = conv(get('max'), true);
    return min == null && max == null ? null : { kind: 'range', min, max };
  };
  const readText = (): Filter | null => {
    const q = el.querySelector<HTMLInputElement>('[data-k="q"]')!.value;
    return q.trim() ? { kind: 'text', q: q.trim() } : null;
  };
  const readSet = (): Filter | null => {
    const boxes = Array.from(el.querySelectorAll<HTMLInputElement>('.dx-pick input'));
    if (boxes.every((b) => b.checked)) return null;
    return { kind: 'set', values: new Set(boxes.filter((b) => b.checked).map((b) => counts[Number(b.dataset.i)].value)) };
  };
  const read = () => (mode === 'range' ? readRange() : mode === 'set' ? readSet() : readText());

  el.addEventListener('input', (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('dx-pick-search')) {
      const q = (t as HTMLInputElement).value.trim().toLowerCase();
      el.querySelectorAll<HTMLElement>('.dx-pick').forEach((p) => (p.hidden = !!q && !p.dataset.v!.includes(q)));
      return;
    }
    if (t.matches('input[type="checkbox"]')) return; // handled by "change"
    later(read());
  });
  el.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).closest('.dx-pick')) apply(read());
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).matches('input.input')) {
      e.preventDefault();
      apply(read());
      pop.close(true);
    }
  });
  el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.mode) {
      mode = t.dataset.mode as 'text' | 'set';
      el.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
      el.querySelector<HTMLElement>('.dx-pop-text')!.hidden = mode !== 'text';
      el.querySelector<HTMLElement>('.dx-pop-set')!.hidden = mode !== 'set';
      apply(read());
      pop.place();
    } else if (t.dataset.all) {
      const on = t.dataset.all === '1';
      el.querySelectorAll<HTMLElement>('.dx-pick').forEach((p) => {
        if (!p.hidden) p.querySelector<HTMLInputElement>('input')!.checked = on;
      });
      apply(read());
    } else if (t.dataset.act === 'clear') {
      apply(null);
      pop.close(true);
    } else if (t.dataset.act === 'done') {
      apply(read());
      pop.close(true);
    }
  });
}

/** Column show/hide menu. */
export function openColumns(pop: Popover, view: DataView, anchor: HTMLElement, onChange: () => void) {
  const items = view.order
    .map((c) => {
      const col = view.ds.columns[c];
      return `<label class="dx-pick"><input type="checkbox" data-c="${c}"${view.hidden.has(c) ? '' : ' checked'} /><span class="dx-pick-v">${escapeHtml(col.name)}</span><span class="dx-pick-n faint">${TYPE_LABEL[col.type]}</span></label>`;
    })
    .join('');
  const html = `<div class="dx-pop-head"><strong>Columns</strong><span class="small faint" data-count></span></div>
    <div class="dx-pop-body">
      ${view.order.length > 8 ? '<input class="input dx-pick-search" type="search" placeholder="Find a column…" aria-label="Find a column" autocomplete="off" data-autofocus />' : ''}
      <div class="dx-pick-actions small"><button type="button" class="btn btn-sm btn-ghost" data-all="1">Show all</button><button type="button" class="btn btn-sm btn-ghost" data-all="0">Hide all</button></div>
      <div class="dx-pick-list" role="group" aria-label="Visible columns">${items}</div>
    </div>`;
  const el = pop.open(anchor, 'Show or hide columns', html);
  const count = () => {
    el.querySelector('[data-count]')!.textContent = `${view.visibleColumns.length} of ${view.order.length} shown`;
  };
  count();
  const sync = () => {
    view.hidden.clear();
    el.querySelectorAll<HTMLInputElement>('input[data-c]').forEach((b) => {
      if (!b.checked) view.hidden.add(Number(b.dataset.c));
    });
    count();
    onChange();
  };
  el.addEventListener('change', sync);
  el.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains('dx-pick-search')) return;
    const q = t.value.trim().toLowerCase();
    el.querySelectorAll<HTMLElement>('.dx-pick').forEach((p) => (p.hidden = !!q && !p.textContent!.toLowerCase().includes(q)));
  });
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-all]');
    if (!b) return;
    const on = b.dataset.all === '1';
    el.querySelectorAll<HTMLInputElement>('input[data-c]').forEach((x) => (x.checked = on));
    sync();
  });
}
