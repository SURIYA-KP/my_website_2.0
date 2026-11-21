// Crop / rotate / flip editor. Works on a downscaled preview; the final edit is applied to the
// full-resolution image by the pipeline.
import { cssVar } from '../../lib/ui';
import { applyEdit, domEnv } from './pipeline';
import { type Edit, editedSize, isIdentityEdit } from './types';

type Crop = NonNullable<Edit['crop']>;
const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };
const MIN = 0.02;

export class CropEditor {
  private dlg: HTMLDialogElement;
  private cv: HTMLCanvasElement;
  private info: HTMLElement;
  private aspectSel: HTMLSelectElement;
  private preview: ImageBitmap | null = null;
  private fullW = 1;
  private fullH = 1;
  private edit: Edit = { rotate: 0, flipH: false, flipV: false, crop: null };
  private rotated: HTMLCanvasElement | OffscreenCanvas | ImageBitmap | null = null;
  private box = { x: 0, y: 0, w: 1, h: 1 }; // image rect inside canvas (CSS px)
  private resolve: ((e: Edit | null | undefined) => void) | null = null;
  private ro: ResizeObserver;

  constructor(dlg: HTMLDialogElement) {
    this.dlg = dlg;
    this.cv = dlg.querySelector('canvas')!;
    this.info = dlg.querySelector('[data-crop="info"]')!;
    this.aspectSel = dlg.querySelector('[data-crop="aspect"]')!;
    const on = (k: string, fn: () => void) => dlg.querySelector(`[data-crop="${k}"]`)!.addEventListener('click', fn);
    on('rotl', () => this.rotate(-90));
    on('rotr', () => this.rotate(90));
    on('fliph', () => this.flip(true));
    on('flipv', () => this.flip(false));
    on('reset', () => { this.edit = { rotate: 0, flipH: false, flipV: false, crop: null }; this.aspectSel.value = 'free'; this.rebuild(); });
    on('cancel', () => this.finish(undefined));
    on('apply', () => this.finish(isIdentityEdit(this.edit) ? null : this.clean(this.edit)));
    this.aspectSel.addEventListener('change', () => this.applyAspect());
    dlg.addEventListener('close', () => this.finish(undefined));
    this.ro = new ResizeObserver(() => { if (dlg.open) this.draw(); });
    this.ro.observe(this.cv.parentElement!);
    this.bindPointer();
    this.cv.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Resolves with the new edit, null for "no edit", or undefined when cancelled. */
  async open(bitmap: ImageBitmap, initial: Edit | null, title: string): Promise<Edit | null | undefined> {
    this.fullW = bitmap.width;
    this.fullH = bitmap.height;
    const s = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    this.preview?.close();
    this.preview = await createImageBitmap(bitmap, {
      resizeWidth: Math.max(1, Math.round(bitmap.width * s)),
      resizeHeight: Math.max(1, Math.round(bitmap.height * s)),
      resizeQuality: 'high',
    });
    this.edit = initial ? { ...initial, crop: initial.crop ? { ...initial.crop } : null } : { rotate: 0, flipH: false, flipV: false, crop: null };
    this.aspectSel.value = 'free';
    this.dlg.querySelector('[data-crop="title"]')!.textContent = title;
    this.dlg.showModal();
    this.rebuild();
    this.cv.focus();
    return new Promise((res) => { this.resolve = res; });
  }

  private finish(v: Edit | null | undefined) {
    const r = this.resolve;
    this.resolve = null;
    if (this.dlg.open) this.dlg.close();
    this.preview?.close();
    this.preview = null;
    this.rotated = null;
    r?.(v);
  }

  private clean(e: Edit): Edit {
    const c = e.crop;
    const full = !c || (c.x < 0.001 && c.y < 0.001 && c.w > 0.999 && c.h > 0.999);
    return { ...e, crop: full ? null : { ...c! } };
  }

  /** Pixel size of the rotated (uncropped) full-resolution image. */
  private rotSize() {
    const swap = this.edit.rotate % 180 !== 0;
    return { W: swap ? this.fullH : this.fullW, H: swap ? this.fullW : this.fullH };
  }

  private rotate(deg: 90 | -90) {
    const c = this.edit.crop;
    if (c) this.edit.crop = deg === 90 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
    this.edit.rotate = (((this.edit.rotate + deg) % 360) + 360) % 360 as Edit['rotate'];
    this.aspectSel.value = 'free';
    this.rebuild();
  }

  /** Flip as seen on screen (after rotation). */
  private flip(horizontal: boolean) {
    const sideways = this.edit.rotate % 180 !== 0;
    if (horizontal !== sideways) this.edit.flipH = !this.edit.flipH;
    else this.edit.flipV = !this.edit.flipV;
    const c = this.edit.crop;
    if (c) this.edit.crop = horizontal ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h };
    this.rebuild();
  }

  private ratio(): number | null {
    const v = this.aspectSel.value;
    if (v === 'free') return null;
    const [a, b] = v.split(':').map(Number);
    return a / b;
  }

  private applyAspect() {
    const r = this.ratio();
    if (!r) return;
    const { W, H } = this.rotSize();
    // Largest centered rect with ratio r.
    let w = 1, h = (W / r) / H;
    if (h > 1) { h = 1; w = (H * r) / W; }
    this.edit.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
    this.draw();
  }

  private rebuild() {
    if (!this.preview) return;
    const reg = applyEdit(domEnv, this.preview, { ...this.edit, crop: null });
    this.rotated = reg.src as HTMLCanvasElement;
    this.draw();
  }

  private draw() {
    if (!this.rotated || !this.dlg.open) return;
    const host = this.cv.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const rw = (this.rotated as HTMLCanvasElement).width, rh = (this.rotated as HTMLCanvasElement).height;
    const maxW = host.clientWidth, maxH = Math.max(200, host.clientHeight);
    const s = Math.min(maxW / rw, maxH / rh);
    const cw = Math.max(1, Math.floor(rw * s)), ch = Math.max(1, Math.floor(rh * s));
    this.cv.style.width = `${cw}px`;
    this.cv.style.height = `${ch}px`;
    this.cv.width = Math.round(cw * dpr);
    this.cv.height = Math.round(ch * dpr);
    this.box = { x: 0, y: 0, w: cw, h: ch };
    const ctx = this.cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.rotated as CanvasImageSource, 0, 0, cw, ch);
    const c = this.edit.crop ?? FULL;
    const x = c.x * cw, y = c.y * ch, w = c.w * cw, h = c.h * ch;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.rect(x, y, w, h);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(x + (w * i) / 3, y); ctx.lineTo(x + (w * i) / 3, y + h);
      ctx.moveTo(x, y + (h * i) / 3); ctx.lineTo(x + w, y + (h * i) / 3);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
    ctx.fillStyle = cssVar('--accent') || '#4f46e5';
    for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    const out = editedSize(this.fullW, this.fullH, this.clean(this.edit));
    const parts = [`${out.width} × ${out.height} px`];
    if (this.edit.rotate) parts.push(`rotated ${this.edit.rotate}°`);
    if (this.edit.flipH || this.edit.flipV) parts.push('flipped');
    this.info.textContent = parts.join(' · ');
  }

  private bindPointer() {
    let mode: 'move' | 'resize' | null = null;
    let ax = 0, ay = 0, start: Crop = FULL, sx = 0, sy = 0;
    const norm = (e: PointerEvent) => {
      const r = this.cv.getBoundingClientRect();
      return { u: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), v: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)), r };
    };
    this.cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.rotated) return;
      const { u, v, r } = norm(e);
      const c = this.edit.crop ?? FULL;
      const corners = [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]];
      const hit = corners.findIndex(([cx, cy]) => Math.hypot((cx - u) * r.width, (cy - v) * r.height) < 16);
      if (hit >= 0) {
        mode = 'resize';
        const opp = corners[3 - hit];
        ax = opp[0]; ay = opp[1];
      } else if (u > c.x && u < c.x + c.w && v > c.y && v < c.y + c.h && this.edit.crop) {
        mode = 'move';
        start = { ...c }; sx = u; sy = v;
      } else {
        mode = 'resize';
        ax = u; ay = v;
      }
      this.cv.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.cv.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const { u, v } = norm(e);
      if (mode === 'move') {
        this.edit.crop = {
          ...start,
          x: Math.max(0, Math.min(1 - start.w, start.x + u - sx)),
          y: Math.max(0, Math.min(1 - start.h, start.y + v - sy)),
        };
      } else this.edit.crop = this.fromAnchor(ax, ay, u, v);
      this.draw();
    });
    const end = () => {
      if (mode && this.edit.crop && (this.edit.crop.w < MIN || this.edit.crop.h < MIN)) this.edit.crop = null;
      mode = null;
      this.draw();
    };
    this.cv.addEventListener('pointerup', end);
    this.cv.addEventListener('pointercancel', end);
  }

  private fromAnchor(ax: number, ay: number, u: number, v: number): Crop {
    const dx = u >= ax ? 1 : -1, dy = v >= ay ? 1 : -1;
    const maxW = dx > 0 ? 1 - ax : ax, maxH = dy > 0 ? 1 - ay : ay;
    let w = Math.min(Math.abs(u - ax), maxW), h = Math.min(Math.abs(v - ay), maxH);
    const r = this.ratio();
    if (r) {
      const { W, H } = this.rotSize();
      const k = W / (H * r); // normalized height per normalized width
      h = w * k;
      if (h > maxH) { h = maxH; w = h / k; }
    }
    return { x: dx > 0 ? ax : ax - w, y: dy > 0 ? ay : ay - h, w, h };
  }

  private onKey(e: KeyboardEvent) {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d || !this.edit.crop) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.05 : 0.01;
    const c = this.edit.crop;
    this.edit.crop = { ...c, x: Math.max(0, Math.min(1 - c.w, c.x + d[0] * step)), y: Math.max(0, Math.min(1 - c.h, c.y + d[1] * step)) };
    this.draw();
  }
}
