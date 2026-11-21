// Before/after viewer: a draggable divider over two aligned layers, with zoom and pan.

export interface CompareInput {
  title: string;
  before: HTMLCanvasElement;
  afterUrl: string;
  width: number;
  height: number;
  beforeLabel: string;
  afterLabel: string;
}

export class CompareViewer {
  private dlg: HTMLDialogElement;
  private stage: HTMLElement;
  private content: HTMLElement;
  private beforeHost: HTMLElement;
  private afterWrap: HTMLElement;
  private afterImg: HTMLImageElement;
  private divider: HTMLElement;
  private zoomLabel: HTMLElement;
  private W = 1;
  private H = 1;
  private zoom = 1;
  private fitZoom = 1;
  private px = 0;
  private py = 0;
  private split = 0.5;
  private ro: ResizeObserver;

  constructor(dlg: HTMLDialogElement) {
    this.dlg = dlg;
    const q = <T extends HTMLElement>(s: string) => dlg.querySelector<T>(s)!;
    this.stage = q('.is-cmp-stage');
    this.content = q('.is-cmp-content');
    this.beforeHost = q('.is-cmp-before');
    this.afterWrap = q('.is-cmp-after');
    this.afterImg = q('.is-cmp-after img');
    this.divider = q('.is-cmp-divider');
    this.zoomLabel = q('[data-cmp="zoom"]');
    q('[data-cmp="in"]').addEventListener('click', () => this.zoomBy(1.25));
    q('[data-cmp="out"]').addEventListener('click', () => this.zoomBy(0.8));
    q('[data-cmp="fit"]').addEventListener('click', () => this.fit());
    q('[data-cmp="actual"]').addEventListener('click', () => this.setZoom(1));
    q('[data-cmp="close"]').addEventListener('click', () => this.close());
    dlg.addEventListener('close', () => this.cleanup());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) this.close(); });
    dlg.addEventListener('keydown', (e) => this.onKey(e));
    this.ro = new ResizeObserver(() => { if (dlg.open) { const wasFit = Math.abs(this.zoom - this.fitZoom) < 1e-6; this.computeFit(); if (wasFit) this.fit(); else this.layout(); } });
    this.ro.observe(this.stage);
    this.bindPointer();
  }

  open(inp: CompareInput) {
    this.W = inp.width;
    this.H = inp.height;
    this.split = 0.5;
    this.dlg.querySelector('[data-cmp="title"]')!.textContent = inp.title;
    this.dlg.querySelector('[data-cmp="before-label"]')!.textContent = inp.beforeLabel;
    this.dlg.querySelector('[data-cmp="after-label"]')!.textContent = inp.afterLabel;
    this.beforeHost.replaceChildren(inp.before);
    this.afterImg.src = inp.afterUrl;
    this.afterImg.alt = `Output: ${inp.title}`;
    inp.before.setAttribute('role', 'img');
    inp.before.setAttribute('aria-label', `Original: ${inp.title}`);
    if (!this.dlg.open) this.dlg.showModal();
    requestAnimationFrame(() => { this.computeFit(); this.fit(); this.divider.focus(); });
  }

  close() { if (this.dlg.open) this.dlg.close(); }

  private cleanup() {
    this.beforeHost.replaceChildren();
    this.afterImg.removeAttribute('src');
  }

  private computeFit() {
    const r = this.stage.getBoundingClientRect();
    this.fitZoom = Math.min((r.width - 16) / this.W, (r.height - 16) / this.H);
    if (!(this.fitZoom > 0)) this.fitZoom = 1;
  }

  fit() {
    this.zoom = this.fitZoom;
    const r = this.stage.getBoundingClientRect();
    this.px = (r.width - this.W * this.zoom) / 2;
    this.py = (r.height - this.H * this.zoom) / 2;
    this.layout();
  }

  private setZoom(z: number, cx?: number, cy?: number) {
    const r = this.stage.getBoundingClientRect();
    const ox = cx ?? r.width / 2;
    const oy = cy ?? r.height / 2;
    const nz = Math.max(Math.min(this.fitZoom, 0.05), Math.min(32, z));
    // Keep the point under the cursor fixed.
    this.px = ox - ((ox - this.px) * nz) / this.zoom;
    this.py = oy - ((oy - this.py) * nz) / this.zoom;
    this.zoom = nz;
    this.layout();
  }

  private zoomBy(f: number, cx?: number, cy?: number) { this.setZoom(this.zoom * f, cx, cy); }

  private clampPan() {
    const r = this.stage.getBoundingClientRect();
    const cw = this.W * this.zoom, ch = this.H * this.zoom;
    this.px = cw <= r.width ? (r.width - cw) / 2 : Math.min(0, Math.max(r.width - cw, this.px));
    this.py = ch <= r.height ? (r.height - ch) / 2 : Math.min(0, Math.max(r.height - ch, this.py));
  }

  private layout() {
    this.clampPan();
    const r = this.stage.getBoundingClientRect();
    const cw = this.W * this.zoom, ch = this.H * this.zoom;
    Object.assign(this.content.style, { width: `${cw}px`, height: `${ch}px`, transform: `translate(${this.px}px, ${this.py}px)` });
    this.content.classList.toggle('is-pixelated', this.zoom >= 2);
    const x = this.split * r.width;
    this.divider.style.left = `${x}px`;
    const inset = Math.max(0, Math.min(100, ((x - this.px) / cw) * 100));
    this.afterWrap.style.clipPath = `inset(0 0 0 ${inset}%)`;
    const pct = Math.round(this.split * 100);
    this.divider.setAttribute('aria-valuenow', String(pct));
    this.divider.setAttribute('aria-valuetext', `${pct}% original, ${100 - pct}% output`);
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  setSplit(f: number) {
    this.split = Math.max(0, Math.min(1, f));
    this.layout();
  }

  private bindPointer() {
    let mode: 'divider' | 'pan' | null = null;
    let sx = 0, sy = 0, spx = 0, spy = 0;
    const local = (e: PointerEvent) => {
      const r = this.stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
    };
    this.stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = local(e);
      const dx = Math.abs(p.x - this.split * p.w);
      const pannable = this.W * this.zoom > this.stage.clientWidth + 1 || this.H * this.zoom > this.stage.clientHeight + 1;
      if (dx < 18 || !pannable || (e.target as HTMLElement).closest('.is-cmp-divider')) {
        mode = 'divider';
        this.setSplit(p.x / p.w);
      } else {
        mode = 'pan';
        this.stage.classList.add('is-panning');
      }
      sx = e.clientX; sy = e.clientY; spx = this.px; spy = this.py;
      this.stage.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.stage.addEventListener('pointermove', (e) => {
      if (!mode) return;
      if (mode === 'divider') { const p = local(e); this.setSplit(p.x / p.w); }
      else { this.px = spx + e.clientX - sx; this.py = spy + e.clientY - sy; this.layout(); }
    });
    const end = () => { mode = null; this.stage.classList.remove('is-panning'); };
    this.stage.addEventListener('pointerup', end);
    this.stage.addEventListener('pointercancel', end);
    this.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e as unknown as PointerEvent);
      this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    }, { passive: false });
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t === this.divider && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'Home') this.setSplit(0);
      else if (e.key === 'End') this.setSplit(1);
      else this.setSplit(this.split + (e.key === 'ArrowLeft' ? -step : step));
      return;
    }
    if (t.tagName === 'INPUT') return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomBy(0.8); }
    else if (e.key === '0') { e.preventDefault(); this.fit(); }
    else if (e.key === '1') { e.preventDefault(); this.setZoom(1); }
  }
}
