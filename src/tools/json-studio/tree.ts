// Virtualized JSON tree. Expansion state is a WeakSet of container objects, rows are rebuilt
// iteratively and only the rows in view are rendered, so multi-megabyte documents stay fluid.
import { escapeHtml } from '../../lib/ui';
import { isContainer, typeOf, type Seg } from './util';

const ROW_H = 26;
const OVERSCAN = 12;

interface Row {
  key: Seg | null;
  value: unknown;
  depth: number;
  parent: Row | null;
}

type MatchKey = object | typeof ROOT;
const ROOT = Symbol('root');

export class TreeView {
  private data: unknown = undefined;
  private expanded = new WeakSet<object>();
  private rows: Row[] = [];
  private inner: HTMLElement;
  private raf = 0;
  private active = -1;
  private query = '';
  private matches: { parent: MatchKey; key: Seg | null }[] = [];
  private matchSet = new Map<MatchKey, Set<Seg | null>>();
  private current = -1;
  onSelect?: (segs: Seg[], value: unknown, viaKeyboard: boolean) => void;
  onActivate?: (segs: Seg[]) => void;

  constructor(private host: HTMLElement) {
    host.setAttribute('role', 'tree');
    host.tabIndex = 0;
    this.inner = document.createElement('div');
    this.inner.className = 'jss-tree-inner';
    host.appendChild(this.inner);
    host.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(host);
    host.addEventListener('click', (e) => this.onClick(e));
    host.addEventListener('dblclick', (e) => {
      const i = this.rowIndex(e);
      if (i >= 0 && !(e.target as HTMLElement).closest('[data-toggle]')) this.toggle(i);
    });
    host.addEventListener('keydown', (e) => this.onKey(e));
  }

  get rowCount() {
    return this.rows.length;
  }

  setData(value: unknown, nodeCount: number) {
    this.data = value;
    this.expanded = new WeakSet();
    this.active = -1;
    this.matches = [];
    this.matchSet = new Map();
    this.current = -1;
    // Small documents open two levels deep; big ones only show the first level.
    const limit = nodeCount < 2000 ? 3 : 1;
    const stack: [unknown, number][] = [[value, 0]];
    while (stack.length) {
      const [v, d] = stack.pop()!;
      if (!isContainer(v) || d >= limit) continue;
      const n = Array.isArray(v) ? v.length : Object.keys(v).length;
      if (d > 0 && n > 200) continue;
      this.expanded.add(v);
      for (const c of Object.values(v)) if (isContainer(c)) stack.push([c, d + 1]);
    }
    this.rebuild();
    this.host.scrollTop = 0;
    if (this.query) this.search(this.query);
  }

  private rebuild() {
    const rows: Row[] = [];
    if (this.data === undefined) {
      this.rows = rows;
      this.render(true);
      return;
    }
    const stack: Row[] = [{ key: null, value: this.data, depth: 0, parent: null }];
    while (stack.length) {
      const r = stack.pop()!;
      rows.push(r);
      const v = r.value;
      if (isContainer(v) && this.expanded.has(v)) {
        if (Array.isArray(v)) {
          for (let k = v.length - 1; k >= 0; k--) stack.push({ key: k, value: v[k], depth: r.depth + 1, parent: r });
        } else {
          const keys = Object.keys(v);
          for (let k = keys.length - 1; k >= 0; k--)
            stack.push({ key: keys[k], value: (v as Record<string, unknown>)[keys[k]], depth: r.depth + 1, parent: r });
        }
      }
    }
    this.rows = rows;
    this.inner.style.height = `${rows.length * ROW_H + 8}px`;
    this.render(true);
  }

  expandAll() {
    const stack: unknown[] = [this.data];
    while (stack.length) {
      const v = stack.pop();
      if (!isContainer(v)) continue;
      this.expanded.add(v);
      if (Array.isArray(v)) for (let k = 0; k < v.length; k++) stack.push(v[k]);
      else for (const k in v) stack.push((v as Record<string, unknown>)[k]);
    }
    this.rebuild();
  }

  collapseAll() {
    this.expanded = new WeakSet();
    if (isContainer(this.data)) this.expanded.add(this.data);
    this.active = Math.min(this.active, 0);
    this.rebuild();
    this.host.scrollTop = 0;
  }

  toggle(i: number) {
    const r = this.rows[i];
    if (!r || !isContainer(r.value)) return;
    if (this.expanded.has(r.value)) this.expanded.delete(r.value);
    else this.expanded.add(r.value);
    this.rebuild();
  }

  static segs(r: Row): Seg[] {
    const segs: Seg[] = [];
    for (let c: Row | null = r; c && c.key !== null; c = c.parent) segs.push(c.key);
    return segs.reverse();
  }

  // ---------- search ----------
  search(q: string): number {
    this.query = q;
    this.matches = [];
    this.matchSet = new Map();
    this.current = -1;
    if (!q || this.data === undefined) {
      this.render(true);
      return 0;
    }
    const needle = q.toLowerCase();
    const hit = (s: string) => s.toLowerCase().includes(needle);
    const EXPAND_CAP = 2000;
    // Iterative DFS in document order, carrying the ancestor chain for expansion.
    const stack: { v: unknown; parent: MatchKey; key: Seg | null; anc: object[] }[] = [{ v: this.data, parent: ROOT, key: null, anc: [] }];
    while (stack.length) {
      const { v, parent, key, anc } = stack.pop()!;
      const keyHit = key !== null && typeof key === 'string' && hit(key);
      const valHit = !isContainer(v) && hit(v === null ? 'null' : String(v));
      if (keyHit || valHit) {
        this.matches.push({ parent, key });
        let set = this.matchSet.get(parent);
        if (!set) this.matchSet.set(parent, (set = new Set()));
        set.add(key);
        if (this.matches.length <= EXPAND_CAP) for (const a of anc) this.expanded.add(a);
      }
      if (isContainer(v)) {
        const chain = [...anc, v as object];
        if (Array.isArray(v)) for (let k = v.length - 1; k >= 0; k--) stack.push({ v: v[k], parent: v, key: k, anc: chain });
        else {
          const keys = Object.keys(v);
          for (let k = keys.length - 1; k >= 0; k--) stack.push({ v: (v as Record<string, unknown>)[keys[k]], parent: v, key: keys[k], anc: chain });
        }
      }
    }
    this.rebuild();
    if (this.matches.length) this.gotoMatch(0);
    return this.matches.length;
  }

  get queryText() {
    return this.query;
  }
  get matchCount() {
    return this.matches.length;
  }
  get currentMatch() {
    return this.current;
  }

  gotoMatch(n: number) {
    if (!this.matches.length) return;
    this.current = (n + this.matches.length) % this.matches.length;
    const m = this.matches[this.current];
    const pk = (r: Row): MatchKey => (r.parent ? (r.parent.value as object) : ROOT);
    let idx = this.rows.findIndex((r) => r.key === m.key && pk(r) === m.parent);
    if (idx < 0) {
      // Not visible (beyond the expansion cap): expand its ancestors now.
      this.expandPathTo(m.parent);
      idx = this.rows.findIndex((r) => r.key === m.key && pk(r) === m.parent);
    }
    if (idx >= 0) this.setActive(idx, false);
    this.render(true);
  }

  private expandPathTo(target: MatchKey) {
    if (target === ROOT) return;
    const stack: { v: unknown; anc: object[] }[] = [{ v: this.data, anc: [] }];
    while (stack.length) {
      const { v, anc } = stack.pop()!;
      if (!isContainer(v)) continue;
      if (v === target) {
        for (const a of anc) this.expanded.add(a);
        this.expanded.add(v);
        this.rebuild();
        return;
      }
      for (const c of Object.values(v)) if (isContainer(c)) stack.push({ v: c, anc: [...anc, v] });
    }
  }

  // ---------- selection / keyboard ----------
  private setActive(i: number, scroll = true) {
    this.active = Math.max(0, Math.min(this.rows.length - 1, i));
    const top = this.active * ROW_H;
    const h = this.host.clientHeight;
    if (!scroll || top < this.host.scrollTop || top + ROW_H > this.host.scrollTop + h) {
      if (top < this.host.scrollTop || top + ROW_H > this.host.scrollTop + h) this.host.scrollTop = Math.max(0, top - h / 3);
    }
    this.host.setAttribute('aria-activedescendant', `jss-row-${this.active}`);
    this.render(true);
  }

  private rowIndex(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.jss-row');
    return el ? Number(el.dataset.i) : -1;
  }

  private onClick(e: MouseEvent) {
    const i = this.rowIndex(e);
    if (i < 0) return;
    if ((e.target as HTMLElement).closest('[data-toggle]')) {
      this.active = i;
      this.toggle(i);
      return;
    }
    this.setActive(i);
    const r = this.rows[i];
    this.onSelect?.(TreeView.segs(r), r.value, false);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.rows.length) return;
    const r = this.rows[this.active];
    const page = Math.max(1, Math.floor(this.host.clientHeight / ROW_H) - 1);
    const go = (i: number) => {
      e.preventDefault();
      this.setActive(i);
      const row = this.rows[this.active];
      this.onSelect?.(TreeView.segs(row), row.value, true);
    };
    switch (e.key) {
      case 'ArrowDown': return go(this.active < 0 ? 0 : this.active + 1);
      case 'ArrowUp': return go(this.active - 1);
      case 'PageDown': return go(this.active + page);
      case 'PageUp': return go(this.active - page);
      case 'Home': return go(0);
      case 'End': return go(this.rows.length - 1);
      case 'ArrowRight':
        e.preventDefault();
        if (r && isContainer(r.value) && !this.expanded.has(r.value)) this.toggle(this.active);
        else if (r && isContainer(r.value)) go(this.active + 1);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (r && isContainer(r.value) && this.expanded.has(r.value)) this.toggle(this.active);
        else if (r?.parent) go(this.rows.indexOf(r.parent));
        return;
      case ' ':
        e.preventDefault();
        this.toggle(this.active);
        return;
      case 'Enter':
        e.preventDefault();
        if (r) this.onActivate?.(TreeView.segs(r));
        return;
    }
  }

  // ---------- rendering ----------
  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => ((this.raf = 0), this.render()));
  }

  private lastKey = '';
  refresh() {
    this.render(true);
  }

  private mark(text: string) {
    if (!this.query) return escapeHtml(text);
    const lower = text.toLowerCase();
    const q = this.query.toLowerCase();
    let out = '';
    let last = 0;
    for (let k = lower.indexOf(q); k !== -1; k = lower.indexOf(q, k + q.length)) {
      out += escapeHtml(text.slice(last, k)) + `<mark>${escapeHtml(text.slice(k, k + q.length))}</mark>`;
      last = k + q.length;
    }
    return out + escapeHtml(text.slice(last));
  }

  private render(force = false) {
    const h = this.host.clientHeight || 500;
    const first = Math.max(0, Math.floor(this.host.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(this.rows.length, Math.ceil((this.host.scrollTop + h) / ROW_H) + OVERSCAN);
    const key = `${first}:${last}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const cur = this.current >= 0 ? this.matches[this.current] : null;
    let html = '';
    for (let i = first; i < last; i++) {
      const r = this.rows[i];
      const v = r.value;
      const t = typeOf(v);
      const container = isContainer(v);
      const open = container && this.expanded.has(v as object);
      const pk: MatchKey = r.parent ? (r.parent.value as object) : ROOT;
      const isMatch = this.matchSet.get(pk)?.has(r.key) ?? false;
      const isCur = !!cur && cur.parent === pk && cur.key === r.key;
      const cls = `jss-row${i === this.active ? ' is-active' : ''}${isMatch ? ' is-match' : ''}${isCur ? ' is-current' : ''}`;
      let keyHtml: string;
      if (r.key === null) keyHtml = '<span class="jss-k jss-k-root">$</span>';
      else if (typeof r.key === 'number') keyHtml = `<span class="jss-k jss-k-idx">${r.key}</span>`;
      else keyHtml = `<span class="jss-k">${this.mark(r.key)}</span>`;
      let valHtml: string;
      if (container) {
        const n = Array.isArray(v) ? v.length : Object.keys(v as object).length;
        const label = Array.isArray(v) ? `${n} ${n === 1 ? 'item' : 'items'}` : `${n} ${n === 1 ? 'key' : 'keys'}`;
        valHtml = `<span class="jss-badge jss-b-${t}">${t === 'array' ? '[ ]' : '{ }'} ${t}</span><span class="jss-count">${label}</span>`;
      } else {
        let s = t === 'string' ? JSON.stringify(v) : String(v);
        if (s.length > 300) s = s.slice(0, 300) + '…';
        valHtml = `<span class="jss-v jss-v-${t}">${this.mark(s)}</span><span class="jss-badge jss-b-${t}">${t}</span>`;
      }
      const caret = container ? `<span class="jss-caret" data-toggle aria-hidden="true">${open ? '▾' : '▸'}</span>` : '<span class="jss-caret"></span>';
      html += `<div class="${cls}" id="jss-row-${i}" data-i="${i}" role="treeitem" aria-level="${r.depth + 1}"${container ? ` aria-expanded="${open}"` : ''} aria-selected="${i === this.active}" style="top:${i * ROW_H + 4}px;padding-left:${r.depth * 18 + 6}px">${caret}${keyHtml}<span class="jss-colon">:</span>${valHtml}</div>`;
    }
    this.inner.innerHTML = html;
  }
}
