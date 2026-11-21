// Canvas: zoom/pan, hit testing, hover outline, selection overlay with resize/rotate handles,
// and pointer/touch gestures. The overlay lives in screen space, outside the document.
import { Editor, M } from './editor';

const SVG_NS = 'http://www.w3.org/2000/svg';
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot';
const HANDLES: [HandleId, number, number][] = [
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5],
];

type Gesture =
  | { type: 'move'; x0: number; y0: number; items: ReturnType<Editor['gestureItems']>; moved: boolean; pointerId: number }
  | { type: 'resize1'; handle: HandleId; el: Element; t0: DOMMatrix; ctm0: DOMMatrix; bb: DOMRect; gx: number; gy: number; moved: boolean; pointerId: number }
  | { type: 'resizeN'; handle: HandleId; box: { x: number; y: number; w: number; h: number }; gx: number; gy: number; items: ReturnType<Editor['gestureItems']>; moved: boolean; pointerId: number }
  | { type: 'rotate'; cx: number; cy: number; a0: number; items: ReturnType<Editor['gestureItems']>; moved: boolean; pointerId: number }
  | { type: 'pan'; x0: number; y0: number; px: number; py: number; moved: boolean; pointerId: number; tapClears: boolean }
  | { type: 'marquee'; x0: number; y0: number; x1: number; y1: number; additive: boolean; moved: boolean; pointerId: number }
  | { type: 'pinch'; d0: number; z0: number; mx0: number; my0: number; px: number; py: number; moved: boolean; pointerId: number };

export type Background = 'checker' | 'white' | 'dark';

export class Canvas {
  zoom = 1;
  panX = 0;
  panY = 0;
  paused = false;
  /** True while the view is "fit to screen" (refit when the viewport size changes). */
  fitted = true;
  onEditText: (el: Element) => void = () => {};
  private gesture: Gesture | null = null;
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private hover: Element | null = null;
  private spaceDown = false;
  private raf = 0;
  private overlay: SVGSVGElement;
  private paper: HTMLElement;
  private grid: HTMLElement;
  private gridOn = false;

  constructor(
    readonly viewport: HTMLElement,
    readonly editor: Editor,
  ) {
    this.overlay = viewport.querySelector('.svgs-overlay') as SVGSVGElement;
    this.paper = viewport.querySelector('.svgs-paper') as HTMLElement;
    this.grid = viewport.querySelector('.svgs-grid') as HTMLElement;
    this.bind();
    let prev = { w: viewport.clientWidth, h: viewport.clientHeight };
    new ResizeObserver(() => {
      const w = viewport.clientWidth;
      const h = viewport.clientHeight;
      if (this.fitted) this.fit();
      else {
        // Keep the drawing centred where it was when panels open/close.
        this.panX += (w - prev.w) / 2;
        this.panY += (h - prev.h) / 2;
        this.updateView();
      }
      prev = { w, h };
    }).observe(viewport);
    editor.on((kind) => {
      if (kind === 'replace') {
        this.hover = null;
        this.applyPaused();
        this.updateView();
      } else if (kind === 'doc') this.updateView();
      else if (kind === 'selection') {
        this.drawOverlay();
        this.tick();
      } else if (kind === 'live') this.drawOverlay();
    });
  }

  // ---------------------------------------------------------------- view
  private docRect() {
    const s = this.editor.docSize();
    return { x: this.panX, y: this.panY, w: s.w * this.zoom, h: s.h * this.zoom };
  }

  updateView() {
    if (!this.editor.root) return;
    const r = this.docRect();
    const pos = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;`;
    this.editor.setView(`:host{position:absolute;inset:0;overflow:hidden;contain:strict}:host>svg:not([aria-hidden]){position:absolute;display:block;max-width:none;${pos}}`);
    this.paper.style.cssText = pos;
    this.grid.style.cssText = pos;
    if (this.gridOn) {
      const vb = this.editor.viewBox();
      const unit = (r.w / vb.w) || 1;
      let step = 10;
      while (step * unit < 8) step *= 5;
      const px = step * unit;
      const ox = ((-vb.x % step) * unit + px) % px;
      const oy = ((-vb.y % step) * unit + px) % px;
      this.grid.style.backgroundSize = `${px}px ${px}px, ${px}px ${px}px, ${px * 5}px ${px * 5}px, ${px * 5}px ${px * 5}px`;
      this.grid.style.backgroundPosition = `${ox}px ${oy}px`;
    }
    this.grid.hidden = !this.gridOn;
    this.drawOverlay();
    this.editor.emit('view');
  }

  fit() {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const s = this.editor.docSize();
    const pad = vw < 500 ? 16 : 40;
    const z = Math.min((vw - pad * 2) / s.w, (vh - pad * 2) / s.h);
    this.zoom = clampZoom(Number.isFinite(z) && z > 0 ? z : 1);
    this.panX = (vw - s.w * this.zoom) / 2;
    this.panY = (vh - s.h * this.zoom) / 2;
    this.fitted = true;
    this.updateView();
  }

  setZoom(z: number, cx = this.viewport.clientWidth / 2, cy = this.viewport.clientHeight / 2) {
    const nz = clampZoom(z);
    this.panX = cx - ((cx - this.panX) * nz) / this.zoom;
    this.panY = cy - ((cy - this.panY) * nz) / this.zoom;
    this.zoom = nz;
    this.fitted = false;
    this.updateView();
  }

  zoomBy(f: number, cx?: number, cy?: number) {
    this.setZoom(this.zoom * f, cx, cy);
  }

  setGrid(on: boolean) {
    this.gridOn = on;
    this.updateView();
  }

  setBackground(bg: Background) {
    this.paper.dataset.bg = bg;
  }

  // ---------------------------------------------------------------- animation
  setPaused(p: boolean) {
    this.paused = p;
    this.applyPaused();
  }

  private applyPaused() {
    const root = this.editor.root;
    if (!root) return;
    if (this.paused) root.pauseAnimations();
    else root.unpauseAnimations();
    for (const a of this.editor.shadow.getAnimations()) {
      if (this.paused) a.pause();
      else a.play();
    }
    this.tick();
  }

  restart() {
    this.editor.root.setCurrentTime(0);
    for (const a of this.editor.shadow.getAnimations()) a.currentTime = 0;
    this.drawOverlay();
  }

  /** Keep the overlay glued to animated elements while playing. */
  private tick() {
    cancelAnimationFrame(this.raf);
    if (this.paused || !this.editor.selection.length || !this.editor.hasAnimation()) return;
    const loop = () => {
      this.drawOverlay();
      if (!this.paused && this.editor.selection.length) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- hit testing
  /** Top-most selectable, unlocked document element under a client point. */
  hitLeaf(x: number, y: number): Element | null {
    const root = this.editor.root;
    for (const el of this.editor.shadow.elementsFromPoint(x, y)) {
      if (el === root || !root.contains(el)) continue;
      let leaf: Element | null = el;
      while (leaf && leaf !== root && !this.editor.isSelectable(leaf)) leaf = leaf.parentElement;
      if (!leaf || leaf === root) continue;
      if (this.editor.isLocked(leaf)) continue;
      return leaf;
    }
    return null;
  }

  // ---------------------------------------------------------------- overlay
  private vpOrigin() {
    const r = this.viewport.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  drawOverlay() {
    const o = this.vpOrigin();
    const ov = this.overlay;
    const parts: string[] = [];
    const poly = (pts: DOMPoint[], cls: string) =>
      `<polygon class="${cls}" points="${pts.map((p) => `${(p.x - o.x).toFixed(1)},${(p.y - o.y).toFixed(1)}`).join(' ')}"/>`;
    const sel = this.editor.selection.filter((el) => el.isConnected);
    if (this.hover && this.hover.isConnected && !sel.includes(this.hover)) {
      const q = this.editor.screenQuad(this.hover);
      if (q) parts.push(poly(q, 'svgs-ov-hover'));
    }
    const g = this.gesture;
    const busy = g && g.moved && g.type !== 'marquee' && g.type !== 'pan' && g.type !== 'pinch';
    const quads = sel.map((el) => this.editor.screenQuad(el)).filter((q): q is DOMPoint[] => !!q);
    quads.forEach((q) => parts.push(poly(q, 'svgs-ov-sel')));
    let frame: DOMPoint[] | null = null;
    const single = sel.length === 1 && quads.length === 1;
    if (single) frame = quads[0];
    else if (quads.length > 1) {
      const xs = quads.flat().map((p) => p.x);
      const ys = quads.flat().map((p) => p.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      frame = [new DOMPoint(x0, y0), new DOMPoint(x1, y0), new DOMPoint(x1, y1), new DOMPoint(x0, y1)];
      parts.push(poly(frame, 'svgs-ov-frame'));
    }
    const canTransform = sel.length > 0 && sel.every((el) => this.editor.canTransform(el));
    if (frame && canTransform && !busy) {
      const lerp = (u: number, v: number) => {
        const top = { x: frame![0].x + (frame![1].x - frame![0].x) * u, y: frame![0].y + (frame![1].y - frame![0].y) * u };
        const bot = { x: frame![3].x + (frame![2].x - frame![3].x) * u, y: frame![3].y + (frame![2].y - frame![3].y) * u };
        return { x: top.x + (bot.x - top.x) * v - o.x, y: top.y + (bot.y - top.y) * v - o.y };
      };
      const tiny = Math.hypot(frame[1].x - frame[0].x, frame[1].y - frame[0].y) < 24 || Math.hypot(frame[3].x - frame[0].x, frame[3].y - frame[0].y) < 24;
      // Rotate handle: beyond the top edge, along the box's own "up".
      const tm = lerp(0.5, 0);
      const bm = lerp(0.5, 1);
      const len = Math.hypot(tm.x - bm.x, tm.y - bm.y) || 1;
      const ux = (tm.x - bm.x) / len;
      const uy = (tm.y - bm.y) / len;
      const rx = tm.x + ux * 26;
      const ry = tm.y + uy * 26;
      parts.push(`<line class="svgs-ov-stem" x1="${tm.x.toFixed(1)}" y1="${tm.y.toFixed(1)}" x2="${rx.toFixed(1)}" y2="${ry.toFixed(1)}"/>`);
      parts.push(`<circle class="svgs-handle svgs-handle-rot" data-handle="rot" cx="${rx.toFixed(1)}" cy="${ry.toFixed(1)}" r="6"><title>Rotate (Shift: 15° steps)</title></circle>`);
      for (const [id, u, v] of HANDLES) {
        if (tiny && id.length === 1) continue;
        const p = lerp(u, v);
        parts.push(`<rect class="svgs-handle" data-handle="${id}" x="${(p.x - 5).toFixed(1)}" y="${(p.y - 5).toFixed(1)}" width="10" height="10" rx="2" style="cursor:${cursorFor(id, frame)}"/>`);
      }
    }
    if (g?.type === 'marquee' && g.moved) {
      const x = Math.min(g.x0, g.x1) - o.x;
      const y = Math.min(g.y0, g.y1) - o.y;
      parts.push(`<rect class="svgs-ov-marquee" x="${x}" y="${y}" width="${Math.abs(g.x1 - g.x0)}" height="${Math.abs(g.y1 - g.y0)}"/>`);
    }
    ov.innerHTML = parts.join('');
  }

  // ---------------------------------------------------------------- input
  private bind() {
    const vp = this.viewport;
    vp.addEventListener('pointerdown', (e) => this.down(e));
    vp.addEventListener('pointermove', (e) => this.move(e));
    vp.addEventListener('pointerup', (e) => this.up(e));
    vp.addEventListener('pointercancel', (e) => this.up(e, true));
    vp.addEventListener('pointerleave', () => {
      if (!this.gesture && this.hover) {
        this.hover = null;
        this.drawOverlay();
      }
    });
    vp.addEventListener('click', (e) => e.preventDefault());
    vp.addEventListener('dblclick', (e) => {
      const leaf = this.hitLeaf(e.clientX, e.clientY);
      if (!leaf) return;
      const before = this.editor.selection[0];
      const target = this.editor.drillTarget(leaf);
      if (target && target === before && /^(text|tspan)$/.test(target.localName)) this.onEditText(target);
      else if (target) this.editor.select([target]);
    });
    vp.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const o = this.vpOrigin();
        if (e.ctrlKey || e.metaKey) {
          const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
          this.zoomBy(Math.min(4, Math.max(0.25, f)), e.clientX - o.x, e.clientY - o.y);
        } else {
          const k = e.deltaMode === 1 ? 16 : 1;
          this.panX -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
          this.panY -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
          this.fitted = false;
          this.updateView();
        }
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      const t = e.target as Node;
      if (e.code === 'Space' && !this.spaceDown && (t === document.body || this.viewport.contains(t)) && !document.querySelector('dialog[open]')) {
        this.spaceDown = true;
        vp.classList.add('is-space');
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        vp.classList.remove('is-space');
      }
    });
  }

  private down(e: PointerEvent) {
    const o = this.vpOrigin();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (this.pointers.size === 2) {
      // Second finger: switch to pinch-zoom / two-finger pan, abandoning a move.
      this.cancelGesture();
      const [a, b] = Array.from(this.pointers.values());
      this.gesture = {
        type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.zoom,
        mx0: (a.x + b.x) / 2 - o.x, my0: (a.y + b.y) / 2 - o.y, px: this.panX, py: this.panY, moved: true, pointerId: e.pointerId,
      };
      return;
    }
    if (this.pointers.size > 2) return;
    const target = e.target as Element;
    const handle = (target.closest?.('[data-handle]') as Element | null)?.getAttribute('data-handle') as HandleId | null;
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      e.preventDefault();
      this.startPan(e, false);
      return;
    }
    if (e.button !== 0) return;
    if (handle) {
      this.startHandle(e, handle);
      return;
    }
    const leaf = this.hitLeaf(e.clientX, e.clientY);
    const deep = e.altKey || e.metaKey;
    const hit = leaf ? this.editor.resolveTarget(leaf, deep) : null;
    if (!hit) {
      if (e.pointerType === 'mouse') {
        if (!e.shiftKey && this.editor.selection.length) this.editor.select([]);
        this.gesture = { type: 'marquee', x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, additive: e.shiftKey, moved: false, pointerId: e.pointerId };
        this.viewport.setPointerCapture(e.pointerId);
      } else this.startPan(e, true);
      return;
    }
    if (e.shiftKey) {
      this.editor.toggleSelect(hit);
      if (!this.editor.selection.includes(hit)) return;
    } else if (!this.editor.selection.includes(hit)) this.editor.select([hit]);
    this.gesture = { type: 'move', x0: e.clientX, y0: e.clientY, items: this.editor.gestureItems(), moved: false, pointerId: e.pointerId };
    this.viewport.setPointerCapture(e.pointerId);
  }

  private startPan(e: PointerEvent, tapClears: boolean) {
    this.gesture = { type: 'pan', x0: e.clientX, y0: e.clientY, px: this.panX, py: this.panY, moved: false, pointerId: e.pointerId, tapClears };
    this.viewport.classList.add('is-panning');
    this.viewport.setPointerCapture(e.pointerId);
  }

  private startHandle(e: PointerEvent, handle: HandleId) {
    e.preventDefault();
    const sel = this.editor.selection;
    const items = this.editor.gestureItems();
    if (!items.length) return;
    this.viewport.setPointerCapture(e.pointerId);
    const quads = sel.map((el) => this.editor.screenQuad(el)).filter((q): q is DOMPoint[] => !!q);
    const pts = quads.flat();
    if (handle === 'rot') {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      this.gesture = { type: 'rotate', cx, cy, a0: Math.atan2(e.clientY - cy, e.clientX - cx), items, moved: false, pointerId: e.pointerId };
      return;
    }
    if (sel.length === 1) {
      const el = sel[0] as SVGGraphicsElement;
      const ctm0 = M(el.getScreenCTM());
      const bb = el.getBBox();
      // Grab offset: where on the handle the pointer went down (so the edge does not jump).
      const [, u, v] = HANDLES.find((h) => h[0] === handle)!;
      const p0 = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm0.inverse());
      const gx = p0.x - (bb.x + bb.width * u);
      const gy = p0.y - (bb.y + bb.height * v);
      this.gesture = { type: 'resize1', handle, el, t0: items[0].t0, ctm0, bb, gx, gy, moved: false, pointerId: e.pointerId };
    } else {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const [, u, v] = HANDLES.find((h) => h[0] === handle)!;
      const gx = e.clientX - (box.x + box.w * u);
      const gy = e.clientY - (box.y + box.h * v);
      this.gesture = { type: 'resizeN', handle, box, gx, gy, items, moved: false, pointerId: e.pointerId };
    }
  }

  private move(e: PointerEvent) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const g = this.gesture;
    if (!g) {
      if (e.pointerType === 'mouse' && !this.spaceDown) {
        const leaf = this.hitLeaf(e.clientX, e.clientY);
        const h = leaf ? this.editor.resolveTarget(leaf, e.altKey || e.metaKey) : null;
        if (h !== this.hover) {
          this.hover = h;
          this.drawOverlay();
        }
      }
      return;
    }
    if (g.type === 'pinch') {
      const pts = Array.from(this.pointers.values());
      if (pts.length < 2) return;
      const [a, b] = pts;
      const o = this.vpOrigin();
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2 - o.x;
      const my = (a.y + b.y) / 2 - o.y;
      const z = clampZoom((g.z0 * d) / g.d0);
      // Keep the document point under the initial midpoint under the current midpoint.
      this.panX = mx - ((g.mx0 - g.px) * z) / g.z0;
      this.panY = my - ((g.my0 - g.py) * z) / g.z0;
      this.zoom = z;
      this.fitted = false;
      this.updateView();
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    const dx0 = e.clientX - ('x0' in g ? g.x0 : e.clientX);
    const dy0 = e.clientY - ('y0' in g ? g.y0 : e.clientY);
    if (!g.moved) {
      if ((g.type === 'move' || g.type === 'pan' || g.type === 'marquee') && Math.hypot(dx0, dy0) < 3) return;
      g.moved = true;
      this.hover = null;
    }
    switch (g.type) {
      case 'pan':
        this.fitted = false;
        this.panX = g.px + dx0;
        this.panY = g.py + dy0;
        this.updateView();
        return;
      case 'marquee':
        g.x1 = e.clientX;
        g.y1 = e.clientY;
        this.drawOverlay();
        return;
      case 'move': {
        let dx = dx0;
        let dy = dy0;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        this.editor.applyScreen(g.items, new DOMMatrix().translate(dx, dy));
        break;
      }
      case 'rotate': {
        let a = Math.atan2(e.clientY - g.cy, e.clientX - g.cx) - g.a0;
        let deg = (a * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        a = deg;
        const S = new DOMMatrix().translate(g.cx, g.cy).rotate(a).translate(-g.cx, -g.cy);
        this.editor.applyScreen(g.items, S);
        break;
      }
      case 'resize1': {
        const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(g.ctm0.inverse());
        const p = { x: q.x - g.gx, y: q.y - g.gy };
        const { bb } = g;
        const [, u, v] = HANDLES.find((h) => h[0] === g.handle)!;
        const hx = bb.x + bb.width * u;
        const hy = bb.y + bb.height * v;
        let ax = bb.x + bb.width * (1 - u);
        let ay = bb.y + bb.height * (1 - v);
        if (e.altKey) {
          ax = bb.x + bb.width / 2;
          ay = bb.y + bb.height / 2;
        }
        const useX = u !== 0.5 && Math.abs(hx - ax) > 1e-9;
        const useY = v !== 0.5 && Math.abs(hy - ay) > 1e-9;
        let sx = useX ? (p.x - ax) / (hx - ax) : 1;
        let sy = useY ? (p.y - ay) / (hy - ay) : 1;
        if (e.shiftKey) {
          const s = useX && useY ? (Math.abs(sx) > Math.abs(sy) ? sx : sy) : useX ? sx : sy;
          sx = Math.sign(sx || 1) * Math.abs(s);
          sy = Math.sign(sy || 1) * Math.abs(s);
          if (!useX) {
            sx = Math.abs(s);
            ax = bb.x + bb.width / 2;
          }
          if (!useY) {
            sy = Math.abs(s);
            ay = bb.y + bb.height / 2;
          }
        }
        sx = clampScale(sx);
        sy = clampScale(sy);
        const L = new DOMMatrix().translate(ax, ay).scale(sx, sy).translate(-ax, -ay);
        this.editor.setMatrix(g.el, g.t0.multiply(L));
        break;
      }
      case 'resizeN': {
        const [, u, v] = HANDLES.find((h) => h[0] === g.handle)!;
        const { box } = g;
        const hx = box.x + box.w * u;
        const hy = box.y + box.h * v;
        let ax = box.x + box.w * (1 - u);
        let ay = box.y + box.h * (1 - v);
        if (e.altKey) {
          ax = box.x + box.w / 2;
          ay = box.y + box.h / 2;
        }
        const px = e.clientX - g.gx;
        const py = e.clientY - g.gy;
        let sx = u !== 0.5 && hx !== ax ? (px - ax) / (hx - ax) : 1;
        let sy = v !== 0.5 && hy !== ay ? (py - ay) / (hy - ay) : 1;
        if (e.shiftKey) {
          const s = u === 0.5 ? sy : v === 0.5 ? sx : Math.abs(sx) > Math.abs(sy) ? sx : sy;
          sx = sy = s;
        }
        const S = new DOMMatrix().translate(ax, ay).scale(clampScale(sx), clampScale(sy)).translate(-ax, -ay);
        this.editor.applyScreen(g.items, S);
        break;
      }
    }
    this.editor.emit('live');
  }

  private up(e: PointerEvent, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pinch') {
      if (this.pointers.size < 2) this.gesture = null;
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    this.gesture = null;
    this.viewport.classList.remove('is-panning');
    if (this.viewport.hasPointerCapture(e.pointerId)) this.viewport.releasePointerCapture(e.pointerId);
    if (g.type === 'pan') {
      if (!g.moved && g.tapClears && !cancelled) this.editor.select([]);
      return;
    }
    if (g.type === 'marquee') {
      if (g.moved) this.finishMarquee(g);
      this.drawOverlay();
      return;
    }
    if (g.moved) {
      if (cancelled) this.editor.undoLive();
      else this.editor.commit();
    } else this.drawOverlay();
  }

  private cancelGesture() {
    const g = this.gesture;
    if (g && g.moved && (g.type === 'move' || g.type === 'rotate' || g.type === 'resize1' || g.type === 'resizeN')) this.editor.commit();
    this.gesture = null;
  }

  private finishMarquee(g: Extract<Gesture, { type: 'marquee' }>) {
    const x0 = Math.min(g.x0, g.x1);
    const x1 = Math.max(g.x0, g.x1);
    const y0 = Math.min(g.y0, g.y1);
    const y1 = Math.max(g.y0, g.y1);
    const hits = this.editor
      .layerChildren(this.editor.root)
      .filter((el) => !this.editor.isLocked(el) && !this.editor.isHidden(el))
      .filter((el) => {
        const q = this.editor.screenQuad(el);
        if (!q) return false;
        const xs = q.map((p) => p.x);
        const ys = q.map((p) => p.y);
        // Inside the box completely (so big backgrounds are not picked up by accident).
        return Math.min(...xs) >= x0 && Math.max(...xs) <= x1 && Math.min(...ys) >= y0 && Math.max(...ys) <= y1;
      });
    this.editor.select(g.additive ? [...this.editor.selection, ...hits] : hits);
  }
}

function clampZoom(z: number) {
  return Math.min(64, Math.max(0.05, z));
}
function clampScale(s: number) {
  if (!Number.isFinite(s)) return 1;
  return Math.abs(s) < 0.01 ? (s < 0 ? -0.01 : 0.01) : s;
}

function cursorFor(id: HandleId, frame: DOMPoint[]) {
  const ang = (Math.atan2(frame[1].y - frame[0].y, frame[1].x - frame[0].x) * 180) / Math.PI;
  const base: Record<string, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const a = (((base[id] + ang) % 180) + 180) % 180;
  return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
}

export function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export { SVG_NS };
