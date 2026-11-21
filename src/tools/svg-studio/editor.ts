// Editor core: the live SVG document (rendered in a shadow root), selection, history and
// every editing operation. No toolbar/panel UI here; listeners re-render on change.
import { parseSvg, SVG_NS } from './sanitize';
import { serialize, num, LOCK_ATTR } from './xml';

export type ChangeKind = 'doc' | 'selection' | 'live' | 'replace' | 'view';

/** Elements that draw something (or group things that do) and can be selected. */
export const GRAPHIC = new Set([
  'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'textPath', 'image', 'use',
  'g', 'a', 'switch', 'svg', 'foreignObject',
]);
export const CONTAINERS = new Set(['g', 'a', 'switch', 'svg']);
/** Subtrees that are never rendered directly. */
const NON_RENDERED = new Set(['defs', 'clipPath', 'mask', 'pattern', 'marker', 'symbol', 'linearGradient', 'radialGradient', 'filter', 'style', 'script', 'title', 'desc', 'metadata']);
export const TRANSFORMABLE_EXCLUDE = new Set(['tspan', 'textPath']);
/** Inheritable presentation attributes copied from a group to its children when ungrouping. */
const INHERITED = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-miterlimit', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing', 'color', 'visibility'];
const GROUP_EFFECTS = ['opacity', 'filter', 'clip-path', 'mask'];

export const M = (m?: { a: number; b: number; c: number; d: number; e: number; f: number } | null) =>
  m ? new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]) : new DOMMatrix();

/** Clean transform attribute text for a matrix: translate/rotate/scale when it decomposes, matrix() otherwise. */
export function matrixToTransform(m: DOMMatrix): string {
  const eps = 1e-6;
  const { a, b, c, d, e, f } = m;
  const t = Math.abs(e) > eps || Math.abs(f) > eps ? `translate(${num(e)} ${num(f)})` : '';
  if (Math.abs(b) < eps && Math.abs(c) < eps) {
    if (Math.abs(a - 1) < eps && Math.abs(d - 1) < eps) return t;
    const s = Math.abs(a - d) < eps ? `scale(${num(a, 4)})` : `scale(${num(a, 4)} ${num(d, 4)})`;
    return [t, s].filter(Boolean).join(' ');
  }
  // Rotation + scale without skew: columns orthogonal.
  if (Math.abs(a * c + b * d) < 1e-6 * Math.max(1, a * a + b * b)) {
    const sx = Math.hypot(a, b);
    const det = a * d - b * c;
    const sy = Math.sign(det) * Math.hypot(c, d);
    const ang = (Math.atan2(b, a) * 180) / Math.PI;
    const parts = [t, `rotate(${num(ang, 2)})`];
    if (Math.abs(sx - 1) > eps || Math.abs(sy - 1) > eps) parts.push(Math.abs(sx - sy) < eps ? `scale(${num(sx, 4)})` : `scale(${num(sx, 4)} ${num(sy, 4)})`);
    return parts.filter(Boolean).join(' ');
  }
  return `matrix(${[a, b, c, d].map((v) => num(v, 5)).join(' ')} ${num(e)} ${num(f)})`;
}

export interface ElementInfo {
  el: Element;
  depth: number;
}

export class Editor {
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  root!: SVGSVGElement;
  selection: Element[] = [];
  warnings: string[] = [];
  /** Name for downloads. */
  fileName = 'drawing';
  private history: string[] = [];
  private hIndex = -1;
  private listeners: ((kind: ChangeKind) => void)[] = [];
  private probe: SVGRectElement;
  private viewStyle: HTMLStyleElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.shadow = host.attachShadow({ mode: 'open' });
    this.viewStyle = document.createElement('style');
    this.shadow.appendChild(this.viewStyle);
    const probeSvg = document.createElementNS(SVG_NS, 'svg');
    probeSvg.setAttribute('aria-hidden', 'true');
    probeSvg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden';
    this.probe = document.createElementNS(SVG_NS, 'rect');
    probeSvg.appendChild(this.probe);
    this.shadow.appendChild(probeSvg);
  }

  on(fn: (kind: ChangeKind) => void) {
    this.listeners.push(fn);
  }
  emit(kind: ChangeKind) {
    for (const fn of this.listeners) fn(kind);
  }

  /** Size and position of the rendered document in the viewport (set by the canvas). */
  setView(css: string) {
    this.viewStyle.textContent = css;
  }

  // ---------------------------------------------------------------- loading
  /** Load SVG text as a new document. Throws SvgParseError on invalid input. */
  load(text: string, { lenient = true, name }: { lenient?: boolean; name?: string } = {}) {
    const { root, warnings } = parseSvg(text, { lenient });
    this.mount(root);
    this.normalize();
    this.warnings = warnings;
    this.selection = [];
    this.history = [];
    this.hIndex = -1;
    if (name) this.fileName = name.replace(/\.svg$/i, '') || 'drawing';
    this.commit();
    this.emit('replace');
    return warnings;
  }

  private mount(parsed: SVGSVGElement) {
    const live = document.importNode(parsed, true) as unknown as SVGSVGElement;
    if (this.root) this.root.replaceWith(live);
    else this.shadow.insertBefore(live, this.shadow.firstChild!.nextSibling);
    this.root = live;
  }

  /** Make sure the document has a viewBox and a usable size so zoom/export work. */
  private normalize() {
    const r = this.root;
    const size = this.docSize();
    if (!r.getAttribute('viewBox')) {
      let w = size.w;
      let h = size.h;
      if (!size.explicit) {
        // No size at all: fit to content.
        try {
          const bb = r.getBBox();
          if (bb.width > 0 && bb.height > 0) {
            w = Math.ceil(bb.x + bb.width);
            h = Math.ceil(bb.y + bb.height);
          }
        } catch {
          /* not rendered */
        }
      }
      r.setAttribute('viewBox', `0 0 ${num(w)} ${num(h)}`);
    }
    const vb = this.viewBox();
    const w = r.getAttribute('width');
    const h = r.getAttribute('height');
    if (!w || /%$/.test(w.trim()) || !h || /%$/.test(h.trim())) {
      if (!w || /%$/.test(w)) r.setAttribute('width', num(h && !/%$/.test(h) ? (parseFloat(h) * vb.w) / vb.h : vb.w));
      if (!h || /%$/.test(h)) r.setAttribute('height', num((parseFloat(r.getAttribute('width')!) * vb.h) / vb.w));
    }
  }

  viewBox() {
    const p = (this.root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0) return { x: p[0], y: p[1], w: p[2], h: p[3] };
    const s = this.docSize();
    return { x: 0, y: 0, w: s.w, h: s.h };
  }

  /** Intrinsic size in CSS px (from width/height, falling back to the viewBox). */
  docSize() {
    const r = this.root;
    const unit: Record<string, number> = { px: 1, '': 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, rem: 16 };
    const len = (v: string | null) => {
      const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(v || '');
      if (!m || !(m[2].toLowerCase() in unit)) return NaN;
      return parseFloat(m[1]) * unit[m[2].toLowerCase()];
    };
    let w = len(r.getAttribute('width'));
    let h = len(r.getAttribute('height'));
    const p = (r.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const vb = p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0 ? p : null;
    const explicit = Number.isFinite(w) || Number.isFinite(h);
    if (!Number.isFinite(w) && !Number.isFinite(h)) {
      w = vb ? vb[2] : 300;
      h = vb ? vb[3] : 150;
    } else if (!Number.isFinite(w)) w = vb ? (h * vb[2]) / vb[3] : 300;
    else if (!Number.isFinite(h)) h = vb ? (w * vb[3]) / vb[2] : 150;
    return { w: Math.max(1, w), h: Math.max(1, h), explicit };
  }

  // ---------------------------------------------------------------- history
  snapshot() {
    return new XMLSerializer().serializeToString(this.root);
  }

  /** Record the current document as an undo step (no-op if nothing changed). */
  commit(kind: ChangeKind | null = 'doc') {
    const snap = this.snapshot();
    if (this.history[this.hIndex] !== snap) {
      this.history.splice(this.hIndex + 1);
      this.history.push(snap);
      if (this.history.length > 200) this.history.shift();
      this.hIndex = this.history.length - 1;
    }
    if (kind) this.emit(kind);
  }

  canUndo() {
    return this.hIndex > 0;
  }
  canRedo() {
    return this.hIndex < this.history.length - 1;
  }
  undo() {
    if (this.canUndo()) this.restore(this.history[--this.hIndex]);
  }
  redo() {
    if (this.canRedo()) this.restore(this.history[++this.hIndex]);
  }

  /** Throw away uncommitted live changes (a cancelled drag). */
  undoLive() {
    this.restore(this.history[this.hIndex]);
  }

  private restore(snap: string) {
    const paths = this.selection.map((el) => this.pathOf(el));
    const { root } = parseSvg(snap, { lenient: true });
    this.mount(root);
    this.selection = paths.map((p) => this.elAt(p)).filter((e): e is Element => !!e && this.isSelectable(e));
    this.emit('replace');
  }

  /** Replace the document with edited code (from the code panel). Throws SvgParseError. */
  applyCode(text: string) {
    const paths = this.selection.map((el) => this.pathOf(el));
    const { root, warnings } = parseSvg(text, { lenient: false });
    this.mount(root);
    this.normalize();
    this.warnings = warnings;
    this.selection = paths.map((p) => this.elAt(p)).filter((e): e is Element => !!e && this.isSelectable(e));
    this.commit(null);
    this.emit('replace');
    return warnings;
  }

  code(opts: { clean?: boolean; minify?: boolean } = {}) {
    return serialize(this.root, opts);
  }

  // ---------------------------------------------------------------- structure
  pathOf(el: Element): number[] {
    const path: number[] = [];
    let cur: Element | null = el;
    while (cur && cur !== this.root) {
      const parent: Element | null = cur.parentElement;
      if (!parent) return [];
      path.unshift(Array.prototype.indexOf.call(parent.children, cur));
      cur = parent;
    }
    return path;
  }

  elAt(path: number[]): Element | null {
    let cur: Element | null = this.root;
    for (const i of path) {
      cur = cur?.children[i] ?? null;
      if (!cur) return null;
    }
    return cur === this.root ? null : cur;
  }

  isSelectable(el: Element) {
    if (!GRAPHIC.has(el.localName) || el === this.root || !this.root.contains(el)) return false;
    for (let p = el.parentElement; p && p !== (this.root as Element); p = p.parentElement) if (NON_RENDERED.has(p.localName)) return false;
    return true;
  }

  isLocked(el: Element) {
    for (let p: Element | null = el; p && p !== this.root; p = p.parentElement) if (p.hasAttribute(LOCK_ATTR)) return true;
    return false;
  }

  isHidden(el: Element) {
    return (el as SVGElement).style?.display === 'none' || el.getAttribute('display') === 'none';
  }

  /** Selectable children (layers tree). */
  layerChildren(el: Element): Element[] {
    return Array.from(el.children).filter((c) => this.isSelectable(c) || (c.localName === 'tspan' && el.localName === 'text'));
  }

  canTransform(el: Element) {
    return !TRANSFORMABLE_EXCLUDE.has(el.localName) && el.parentElement?.localName !== 'text';
  }

  // ---------------------------------------------------------------- selection
  select(els: Element[], emit = true) {
    const uniq = Array.from(new Set(els.filter((e) => this.isSelectable(e))));
    // Drop elements whose ancestor is also selected.
    this.selection = uniq.filter((e) => !uniq.some((o) => o !== e && o.contains(e)));
    if (emit) this.emit('selection');
  }

  toggleSelect(el: Element) {
    if (this.selection.includes(el)) this.select(this.selection.filter((e) => e !== el));
    else this.select([...this.selection, el]);
  }

  /**
   * What a click on `leaf` selects: the child of the current scope (the group the selection
   * lives in) that contains the leaf, or a top-level item when clicking outside that scope.
   */
  resolveTarget(leaf: Element, deep = false): Element | null {
    let el: Element | null = leaf;
    while (el && el !== this.root && !this.isSelectable(el)) el = el.parentElement;
    if (!el || el === this.root) return null;
    if (deep) {
      // Deep clicks on words select the whole <text>, not the tspan (drill in with double-click).
      if (el.localName === 'tspan' || el.localName === 'textPath') {
        let t: Element | null = el;
        while (t && t.localName !== 'text') t = t.parentElement;
        if (t && this.isSelectable(t) && !this.selection.some((s) => s !== t && t!.contains(s))) return t;
      }
      return el;
    }
    let scope: Element | null = this.selection[0]?.parentElement ?? this.root;
    while (scope && scope !== this.root && !scope.contains(el)) scope = scope.parentElement;
    if (!scope) scope = this.root;
    return this.skipWrappers(this.childOfContaining(scope, el), el);
  }

  /**
   * Organisational groups (no id, no transform/style, e.g. Mermaid's g.root / g.nodes, or a
   * lone wrapper <g>) are clicked through so a click lands on the meaningful part.
   */
  private skipWrappers(target: Element, leaf: Element) {
    let t = target;
    while (t !== leaf && t.localName === 'g' && t.contains(leaf) && this.isWrapper(t)) t = this.childOfContaining(t, leaf);
    return t;
  }

  isWrapper(g: Element) {
    if (g.hasAttribute('id') || g.hasAttribute(LOCK_ATTR)) return false;
    if (Array.from(g.attributes).some((a) => a.name !== 'class')) return false;
    const cls = g.getAttribute('class') || '';
    if (/^(root|nodes|edgePaths|edgeLabels|clusters|edges|labels|nodeLabels)$/.test(cls.trim())) return true;
    const parent = g.parentElement;
    return !!parent && this.layerChildren(parent).length === 1;
  }

  /** The direct child of `ancestor` on the way to `el` (or `el` itself). */
  childOfContaining(ancestor: Element, el: Element): Element {
    let cur = el;
    while (cur.parentElement && cur.parentElement !== ancestor && cur.parentElement !== (this.root as Element)) cur = cur.parentElement;
    return cur;
  }

  /** Double-click: go one level deeper into the selected group under the pointer. */
  drillTarget(leaf: Element): Element | null {
    const sel = this.selection.length === 1 ? this.selection[0] : null;
    if (sel && sel !== leaf && sel.contains(leaf)) {
      let el: Element | null = leaf;
      while (el && !this.isSelectable(el)) el = el.parentElement;
      // Double-clicking a label inside the selected group goes straight to its <text>.
      let text: Element | null = el;
      while (text && text !== sel && text.localName !== 'text') text = text.parentElement;
      if (text && text !== sel && text.localName === 'text' && this.isSelectable(text)) return text;
      if (el && el !== sel) return this.skipWrappers(this.childOfContaining(sel, el), el);
    }
    return this.resolveTarget(leaf);
  }

  selectParent() {
    const p = this.selection[0]?.parentElement;
    this.select(p && p !== (this.root as Element) && this.isSelectable(p) ? [p] : []);
  }

  // ---------------------------------------------------------------- transforms
  localMatrix(el: Element) {
    const g = el as SVGGraphicsElement;
    return M(g.transform?.baseVal?.consolidate()?.matrix);
  }

  setMatrix(el: Element, m: DOMMatrix) {
    const t = matrixToTransform(m);
    if (t) el.setAttribute('transform', t);
    else el.removeAttribute('transform');
  }

  /** Matrix from the coordinate system an element's transform lives in (its parent's) to the screen. */
  parentScreenCTM(el: Element) {
    const p = el.parentElement as unknown as SVGGraphicsElement | null;
    return M(p?.getScreenCTM?.() ?? null);
  }

  /** Screen CTM of the root user space (document units). */
  rootScreenCTM() {
    return M(this.root.getScreenCTM());
  }

  /** Apply a screen-space transform S to each element, given its matrices at the start of the gesture. */
  applyScreen(items: { el: Element; t0: DOMMatrix; mp: DOMMatrix }[], S: DOMMatrix) {
    for (const { el, t0, mp } of items) {
      if (!this.canTransform(el)) continue;
      this.setMatrix(el, mp.inverse().multiply(S).multiply(mp).multiply(t0));
    }
  }

  gestureItems(els = this.selection) {
    return els.filter((el) => this.canTransform(el)).map((el) => ({ el, t0: this.localMatrix(el), mp: this.parentScreenCTM(el) }));
  }

  /** Move the selection by (dx, dy) document units. */
  nudge(dx: number, dy: number) {
    if (!this.selection.length) return;
    const r = this.rootScreenCTM();
    const S = r.multiply(new DOMMatrix().translate(dx, dy)).multiply(r.inverse());
    this.applyScreen(this.gestureItems(), S);
    this.commit();
  }

  /** Screen-space corner points of an element's bounding box (follows rotation). */
  screenQuad(el: Element): DOMPoint[] | null {
    const g = el as SVGGraphicsElement;
    if (!g.getBBox || !g.getScreenCTM) return null;
    let bb: DOMRect;
    try {
      bb = g.getBBox();
    } catch {
      return null;
    }
    const m = g.getScreenCTM();
    if (!m) return null;
    const mm = M(m);
    return [
      [bb.x, bb.y],
      [bb.x + bb.width, bb.y],
      [bb.x + bb.width, bb.y + bb.height],
      [bb.x, bb.y + bb.height],
    ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(mm));
  }

  // ---------------------------------------------------------------- operations
  uniqueId(base: string) {
    const clean = base.replace(/[^\w-]/g, '-').replace(/^(\d)/, 'id-$1') || 'item';
    const stem = clean.replace(/-(copy|\d+)(-\d+)?$/, '');
    let candidate = `${stem}-copy`;
    let n = 2;
    while (this.root.querySelector(`[id="${CSS.escape(candidate)}"]`)) candidate = `${stem}-copy-${n++}`;
    return candidate;
  }

  deleteSelection() {
    if (!this.selection.length) return;
    const next = this.selection[0].parentElement;
    for (const el of this.selection) el.remove();
    this.selection = next && next !== (this.root as Element) && this.isSelectable(next) ? [next] : [];
    this.commit();
  }

  duplicateSelection() {
    if (!this.selection.length) return;
    const clones: Element[] = [];
    const r = this.rootScreenCTM();
    for (const el of this.selection) {
      const clone = el.cloneNode(true) as Element;
      // New unique ids, and rewrite references inside the clone to its own copies.
      const map = new Map<string, string>();
      for (const n of [clone, ...Array.from(clone.querySelectorAll('[id]'))]) {
        const id = n.getAttribute('id');
        if (!id) continue;
        const nid = this.uniqueId(id);
        map.set(id, nid);
        n.setAttribute('id', nid);
        // Reserve the id while generating the others.
        this.root.appendChild(document.createElementNS(SVG_NS, 'desc')).setAttribute('id', nid);
      }
      this.root.querySelectorAll(':scope > desc[id]:empty').forEach((d) => d.remove());
      if (map.size) {
        for (const n of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
          for (const a of Array.from(n.attributes)) {
            const v = a.value.replace(/url\(\s*#([^)\s]+)\s*\)/g, (m, id) => (map.has(id) ? `url(#${map.get(id)})` : m));
            const v2 = /href$/.test(a.name) && v.startsWith('#') && map.has(v.slice(1)) ? `#${map.get(v.slice(1))}` : v;
            if (v2 !== a.value) n.setAttribute(a.name, v2);
          }
        }
      }
      el.after(clone);
      clones.push(clone);
    }
    // Offset copies by 10 document units so they are visible.
    const S = r.multiply(new DOMMatrix().translate(10, 10)).multiply(r.inverse());
    this.applyScreen(this.gestureItems(clones), S);
    this.selection = clones;
    this.commit();
  }

  groupSelection() {
    const sel = this.selection.filter((el) => this.canTransform(el));
    if (!sel.length) return;
    const ordered = this.documentOrder(sel);
    const last = ordered[ordered.length - 1];
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('id', this.freshId('group'));
    const items = this.gestureItems(ordered);
    last.after(g);
    const mg = M((g as SVGGElement).getScreenCTM());
    for (const { el, t0, mp } of items) {
      g.appendChild(el);
      this.setMatrix(el, mg.inverse().multiply(mp).multiply(t0));
    }
    this.selection = [g];
    this.commit();
  }

  ungroupSelection() {
    const groups = this.selection.filter((el) => el.localName === 'g' || el.localName === 'a');
    if (!groups.length) return;
    const released: Element[] = [];
    for (const g of groups) {
      const gm = this.localMatrix(g);
      const inherited = INHERITED.filter((a) => g.hasAttribute(a)).map((a) => [a, g.getAttribute(a)!] as const);
      const effects = GROUP_EFFECTS.filter((a) => g.hasAttribute(a)).map((a) => [a, g.getAttribute(a)!] as const);
      const cls = g.getAttribute('class');
      const style = g.getAttribute('style');
      for (const child of Array.from(g.childNodes)) {
        g.before(child);
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const el = child as Element;
        if (/^(animate|set|animateTransform|animateMotion|title|desc)$/.test(el.localName)) continue;
        if (this.canTransform(el) && GRAPHIC.has(el.localName)) this.setMatrix(el, gm.multiply(this.localMatrix(el)));
        for (const [a, v] of [...inherited, ...effects]) if (!el.hasAttribute(a)) el.setAttribute(a, v);
        if (cls) el.setAttribute('class', `${cls} ${el.getAttribute('class') || ''}`.trim());
        if (style) el.setAttribute('style', `${style};${el.getAttribute('style') || ''}`.replace(/;;+/g, ';').replace(/;$/, ''));
        if (this.isSelectable(el)) released.push(el);
      }
      g.remove();
    }
    this.selection = released;
    this.commit();
  }

  freshId(base: string) {
    let n = 1;
    while (this.root.querySelector(`[id="${base}-${n}"]`)) n++;
    return `${base}-${n}`;
  }

  documentOrder(els: Element[]) {
    return [...els].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  /** Reorder within the parent: 'forward' | 'backward' | 'front' | 'back'. */
  reorder(dir: 'forward' | 'backward' | 'front' | 'back') {
    const sel = this.documentOrder(this.selection);
    if (!sel.length) return;
    const siblings = (el: Element) => Array.from(el.parentElement!.children).filter((c) => this.isSelectable(c) || c.localName === 'tspan');
    const list = dir === 'forward' || dir === 'front' ? [...sel].reverse() : sel;
    for (const el of list) {
      const sib = siblings(el);
      const i = sib.indexOf(el);
      if (dir === 'forward' && i < sib.length - 1 && !sel.includes(sib[i + 1])) sib[i + 1].after(el);
      else if (dir === 'backward' && i > 0 && !sel.includes(sib[i - 1])) sib[i - 1].before(el);
      else if (dir === 'front' && i < sib.length - 1) sib[sib.length - 1].after(el);
      else if (dir === 'back' && i > 0) sib[0].before(el);
    }
    this.commit();
  }

  /** Move an element to a new parent/position (layers drag and drop), keeping it visually in place. */
  moveTo(el: Element, ref: Element, where: 'before' | 'after' | 'inside') {
    if (el === ref || el.contains(ref)) return;
    const [item] = this.gestureItems([el]);
    if (where === 'inside') ref.appendChild(el);
    else if (where === 'before') ref.before(el);
    else ref.after(el);
    if (item) {
      const mp = this.parentScreenCTM(el);
      this.setMatrix(el, mp.inverse().multiply(item.mp).multiply(item.t0));
    }
    this.commit();
  }

  toggleHidden(el: Element) {
    const s = (el as SVGElement).style;
    if (s.display === 'none') s.removeProperty('display');
    else if (el.getAttribute('display') === 'none') el.removeAttribute('display');
    else el.setAttribute('display', 'none');
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
    this.commit();
  }

  toggleLock(el: Element) {
    if (el.hasAttribute(LOCK_ATTR)) el.removeAttribute(LOCK_ATTR);
    else {
      el.setAttribute(LOCK_ATTR, 'true');
      this.selection = this.selection.filter((s) => !el.contains(s));
    }
    this.commit();
  }

  rename(el: Element, id: string) {
    const v = id.trim().replace(/\s+/g, '-');
    const old = el.getAttribute('id');
    if (v === (old ?? '')) return true;
    if (v && this.root.querySelector(`[id="${CSS.escape(v)}"]`)) return false;
    if (v) el.setAttribute('id', v);
    else el.removeAttribute('id');
    // Keep references (url(#old), href="#old") working.
    if (old && v) {
      for (const n of Array.from(this.root.querySelectorAll('*'))) {
        for (const a of Array.from(n.attributes)) {
          let val = a.value.replace(new RegExp(`url\\(\\s*#${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)`, 'g'), `url(#${v})`);
          if (/href$/.test(a.name) && val === `#${old}`) val = `#${v}`;
          if (val !== a.value) n.setAttribute(a.name, val);
        }
      }
    }
    this.commit();
    return true;
  }

  setAttr(el: Element, name: string, value: string | null, commit = true) {
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
    if (commit) this.commit();
  }

  // ---------------------------------------------------------------- styles
  /** Where a presentation property is set on the element itself. */
  getProp(el: Element, prop: string): { value: string; source: 'style' | 'attr' | 'computed' } {
    const sv = (el as SVGElement).style?.getPropertyValue(prop);
    if (sv) return { value: sv.trim(), source: 'style' };
    const av = el.getAttribute(prop);
    if (av !== null) return { value: av, source: 'attr' };
    return { value: getComputedStyle(el).getPropertyValue(prop).trim(), source: 'computed' };
  }

  /** Normalized computed value for comparing (via a hidden probe element). */
  private normalized(prop: string, value: string) {
    this.probe.removeAttribute('style');
    this.probe.style.setProperty(prop, /^-?[\d.]+$/.test(value) && /size|width|spacing/.test(prop) ? `${value}px` : value);
    return getComputedStyle(this.probe).getPropertyValue(prop).trim();
  }

  /**
   * Set a presentation property where it lives: in style="" if it is already there,
   * otherwise as an attribute, moving to style="" when a CSS rule would override the attribute.
   */
  setProp(el: Element, prop: string, value: string) {
    const svgEl = el as SVGElement;
    const v = value.trim();
    if (!v) {
      svgEl.style.removeProperty(prop);
      el.removeAttribute(prop);
    } else if (svgEl.style.getPropertyValue(prop)) {
      svgEl.style.setProperty(prop, /^-?[\d.]+$/.test(v) && /size|width|spacing/.test(prop) ? `${v}px` : v);
    } else {
      el.setAttribute(prop, v);
      const want = this.normalized(prop, v);
      if (want && getComputedStyle(el).getPropertyValue(prop).trim() !== want) {
        el.removeAttribute(prop);
        svgEl.style.setProperty(prop, /^-?[\d.]+$/.test(v) && /size|width|spacing/.test(prop) ? `${v}px` : v);
      }
    }
    if (el.getAttribute('style') !== null && !el.getAttribute('style')!.trim()) el.removeAttribute('style');
  }

  /** The gradient element a fill/stroke url(#id) points at, if any. */
  gradientFor(el: Element, prop: 'fill' | 'stroke'): { grad: Element; stops: Element[] } | null {
    const v = this.getProp(el, prop).value;
    const m = /url\(\s*["']?#([^"')\s]+)["']?\s*\)/.exec(v);
    if (!m) return null;
    let grad = this.root.querySelector(`[id="${CSS.escape(m[1])}"]`);
    if (!grad || !/Gradient$/.test(grad.localName)) return null;
    const own = grad;
    // Stops may be inherited through href.
    for (let i = 0; i < 5 && grad && !grad.querySelector('stop'); i++) {
      const href: string | null = grad.getAttribute('href') || grad.getAttribute('xlink:href');
      grad = href ? this.root.querySelector(`[id="${CSS.escape(href.slice(1))}"]`) : null;
    }
    return { grad: own, stops: grad ? Array.from(grad.querySelectorAll('stop')) : [] };
  }

  // ---------------------------------------------------------------- text
  /** Lines of a <text>: one per top-level <tspan> line (or the whole text). */
  textLines(el: Element): { lines: string[]; holders: Element[] } {
    const tspans = Array.from(el.children).filter((c) => c.localName === 'tspan');
    const hasOwnText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.nodeValue!.trim());
    const path = Array.from(el.children).find((c) => c.localName === 'textPath');
    if (path && !tspans.length && !hasOwnText) return { lines: [path.textContent || ''], holders: [path] };
    if (!tspans.length || hasOwnText) return { lines: [ownText(el)], holders: [el] };
    return { lines: tspans.map((t) => t.textContent || ''), holders: tspans };
  }

  setTextLines(el: Element, lines: string[]) {
    const { holders } = this.textLines(el);
    if (holders.length === 1 && holders[0] === el) {
      setOwnText(el, lines.join(' '));
    } else {
      holders.forEach((h, i) => {
        if (i < lines.length) setOwnText(h, i === holders.length - 1 ? lines.slice(i).join(' ') : lines[i]);
        else h.remove();
      });
    }
    this.commit();
  }

  fitViewBox() {
    let bb: DOMRect;
    try {
      bb = this.root.getBBox();
    } catch {
      return false;
    }
    if (!(bb.width > 0 && bb.height > 0)) return false;
    const vb = this.viewBox();
    const size = this.docSize();
    const scale = size.w / vb.w;
    const x = Math.floor(bb.x);
    const y = Math.floor(bb.y);
    const w = Math.ceil(bb.x + bb.width) - x;
    const h = Math.ceil(bb.y + bb.height) - y;
    this.root.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.root.setAttribute('width', num(w * scale));
    this.root.setAttribute('height', num(h * scale));
    this.commit();
    return true;
  }

  // ---------------------------------------------------------------- animation
  hasAnimation() {
    if (this.root.querySelector('animate, animateTransform, animateMotion, set')) return true;
    return this.shadow.getAnimations().length > 0;
  }
}

/** Text content that belongs to the element (ignores <animate>/<title> children). */
function ownText(el: Element) {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && /^(tspan|textPath|a)$/.test((n as Element).localName)))
    .map((n) => n.textContent)
    .join('');
}

function setOwnText(el: Element, text: string) {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && /^(tspan|textPath|a)$/.test((n as Element).localName))) n.remove();
  }
  el.insertBefore(document.createTextNode(text), el.firstChild);
}
