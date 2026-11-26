// The race canvas: cached landscape background + per-frame trails, heads, markers and hover.
import { fitView, isFinished, OPTIMIZER_BY_ID, type Landscape, type OptimizerDef, type OptimizerId, type Race, type Vec2, type View } from './engine';
import { renderBackground, makeLut, LIGHT_STOPS, DARK_STOPS } from './render';
import { cssVar } from '../../lib/ui';

export interface Palette {
  dark: boolean;
  elev: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  halo: string;
  colors: Record<OptimizerId, string>;
  lut: Uint8ClampedArray;
  contour: string;
  contourMajor: string;
  axisBg: string;
}

let probe: CanvasRenderingContext2D | null = null;
function rgb(color: string): [number, number, number] {
  probe ??= document.createElement('canvas').getContext('2d');
  if (!probe) return [128, 128, 128];
  probe.fillStyle = '#808080';
  probe.fillStyle = color;
  const s = String(probe.fillStyle);
  if (s.startsWith('#')) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
  const m = s.match(/[\d.]+/g);
  return m ? [+m[0], +m[1], +m[2]] : [128, 128, 128];
}

let lutLight: Uint8ClampedArray | null = null;
let lutDark: Uint8ClampedArray | null = null;

export function readPalette(): Palette {
  const v = (n: string, fb: string) => cssVar(n) || fb;
  const elev = v('--bg-elev', '#fff');
  const [r, g, b] = rgb(elev);
  const dark = r + g + b < 300;
  const colors = {} as Record<OptimizerId, string>;
  for (const id of Object.keys(OPTIMIZER_BY_ID) as OptimizerId[]) colors[id] = v(OPTIMIZER_BY_ID[id].colorVar, '#888');
  if (dark) lutDark ??= makeLut(DARK_STOPS);
  else lutLight ??= makeLut(LIGHT_STOPS);
  return {
    dark,
    elev,
    text: v('--text', '#111'),
    muted: v('--text-muted', '#555'),
    faint: v('--text-faint', '#888'),
    border: v('--border', '#ddd'),
    accent: v('--accent', '#4f46e5'),
    success: v('--success', '#15803d'),
    warning: v('--warning', '#b45309'),
    danger: v('--danger', '#c4314b'),
    halo: `rgba(${r},${g},${b},${dark ? 0.7 : 0.8})`,
    colors,
    lut: dark ? lutDark! : lutLight!,
    contour: dark ? 'rgba(255,255,255,0.075)' : 'rgba(25,25,60,0.11)',
    contourMajor: dark ? 'rgba(255,255,255,0.17)' : 'rgba(25,25,60,0.22)',
    axisBg: `rgba(${r},${g},${b},${dark ? 0.72 : 0.78})`,
  };
}

/* ---------- shapes (canvas + SVG share one geometry) ---------- */

type Shape = OptimizerDef['shape'];

function polygon(n: number, r: number, rot: number, inner = 0): Vec2[] {
  const pts: Vec2[] = [];
  const k = inner ? n * 2 : n;
  for (let i = 0; i < k; i++) {
    const a = rot + (i * Math.PI * 2) / k;
    const rr = inner && i % 2 ? inner : r;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return pts;
}

/** Outline of a marker shape around (0, 0) with "radius" r. */
export function shapePoints(shape: Shape, r: number): Vec2[] | null {
  switch (shape) {
    case 'circle': return null;
    case 'square': return polygon(4, r * 1.2, Math.PI / 4);
    case 'triangle': return polygon(3, r * 1.3, -Math.PI / 2).map(([x, y]) => [x, y + r * 0.2]);
    case 'triangle-down': return polygon(3, r * 1.3, Math.PI / 2).map(([x, y]) => [x, y - r * 0.2]);
    case 'diamond': return polygon(4, r * 1.3, 0);
    case 'hexagon': return polygon(6, r * 1.1, 0);
    case 'star': return polygon(5, r * 1.45, -Math.PI / 2, r * 0.62);
    case 'cross': {
      const a = r * 0.42, b = r * 1.15;
      return [[-a, -b], [a, -b], [a, -a], [b, -a], [b, a], [a, a], [a, b], [-a, b], [-a, a], [-b, a], [-b, -a], [-a, -a]];
    }
  }
}

export function pathShape(ctx: CanvasRenderingContext2D, shape: Shape, x: number, y: number, r: number) {
  const pts = shapePoints(shape, r);
  ctx.beginPath();
  if (!pts) ctx.arc(x, y, r, 0, Math.PI * 2);
  else {
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(x + px, y + py) : ctx.moveTo(x + px, y + py)));
    ctx.closePath();
  }
}

/** Small inline SVG of an optimizer's marker, filled with its CSS colour variable. */
export function shapeSvg(id: OptimizerId, size = 14) {
  const def = OPTIMIZER_BY_ID[id];
  const r = 4.6;
  const pts = shapePoints(def.shape, r);
  const fill = `var(${def.colorVar})`;
  const body = pts
    ? `<polygon points="${pts.map(([x, y]) => `${(x + 8).toFixed(2)},${(y + 8).toFixed(2)}`).join(' ')}" fill="${fill}"/>`
    : `<circle cx="8" cy="8" r="${r + 0.4}" fill="${fill}"/>`;
  return `<svg class="opt-shape" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
}

/* ---------- axis ticks ---------- */

function niceStep(span: number, target: number) {
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
const fmtTick = (v: number) => (Math.abs(v) < 1e-9 ? '0' : String(+v.toFixed(6)).replace('-', '−'));

/* ---------- stage ---------- */

export interface DrawOptions {
  race: Race;
  start: Vec2;
  selected: OptimizerId;
  hover: Vec2 | null;
  pal: Palette;
}

const TRAIL = 90;

export class Stage {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bg = document.createElement('canvas');
  w = 0;
  h = 0;
  dpr = 1;
  view: View = { xmin: -1, xmax: 1, ymin: -1, ymax: 1 };
  private bgKey = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  /** Match the backing store to the CSS box. Returns true when the size changed. */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(1, Math.round(this.canvas.clientWidth));
    const h = Math.max(1, Math.round(this.canvas.clientHeight));
    if (w === this.w && h === this.h && dpr === this.dpr) return false;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    return true;
  }

  /** Re-render the cached heatmap + contours + axes, only if landscape, size or theme changed. */
  prepare(l: Landscape, pal: Palette, key: string) {
    const k = `${key}|${this.w}x${this.h}@${this.dpr}|${pal.dark}`;
    if (k === this.bgKey) return;
    this.bgKey = k;
    const base = fitView(l.view, this.w / this.h);
    const mx = (base.xmax - base.xmin) * 0.03;
    const my = (base.ymax - base.ymin) * 0.03;
    this.view = { xmin: base.xmin - mx, xmax: base.xmax + mx, ymin: base.ymin - my, ymax: base.ymax + my };
    renderBackground(this.bg, l, this.view, this.w, this.h, this.dpr, pal);
    this.drawAxes(pal);
  }

  invalidate() {
    this.bgKey = '';
  }

  private drawAxes(pal: Palette) {
    const ctx = this.bg.getContext('2d')!;
    const { w, h, view: v } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `500 10px ${getComputedStyle(this.canvas).getPropertyValue('--font-mono') || 'monospace'}`;
    ctx.textBaseline = 'middle';
    const sx = niceStep(v.xmax - v.xmin, Math.max(3, Math.round(w / 90)));
    const sy = niceStep(v.ymax - v.ymin, Math.max(3, Math.round(h / 80)));
    const label = (text: string, x: number, y: number, align: CanvasTextAlign) => {
      const tw = ctx.measureText(text).width;
      const bx = align === 'center' ? x - tw / 2 - 3 : align === 'left' ? x - 3 : x - tw - 3;
      ctx.fillStyle = pal.axisBg;
      ctx.beginPath();
      ctx.roundRect(bx, y - 7, tw + 6, 14, 3);
      ctx.fill();
      ctx.fillStyle = pal.muted;
      ctx.textAlign = align;
      ctx.fillText(text, x, y + 0.5);
    };
    ctx.strokeStyle = pal.muted;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    for (let x = Math.ceil(v.xmin / sx) * sx; x <= v.xmax; x += sx) {
      const px = Math.round(((x - v.xmin) / (v.xmax - v.xmin)) * w) + 0.5;
      if (px < 24 || px > w - 12) continue;
      ctx.beginPath();
      ctx.moveTo(px, h);
      ctx.lineTo(px, h - 4);
      ctx.stroke();
    }
    for (let y = Math.ceil(v.ymin / sy) * sy; y <= v.ymax; y += sy) {
      const py = Math.round(((v.ymax - y) / (v.ymax - v.ymin)) * h) + 0.5;
      if (py < 12 || py > h - 20) continue;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(4, py);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (let x = Math.ceil(v.xmin / sx) * sx; x <= v.xmax; x += sx) {
      const px = ((x - v.xmin) / (v.xmax - v.xmin)) * w;
      if (px < 24 || px > w - 12) continue;
      label(fmtTick(x), px, h - 13, 'center');
    }
    for (let y = Math.ceil(v.ymin / sy) * sy; y <= v.ymax; y += sy) {
      const py = ((v.ymax - y) / (v.ymax - v.ymin)) * h;
      if (py < 12 || py > h - 20) continue;
      label(fmtTick(y), 8, py, 'left');
    }
    ctx.restore();
  }

  px(x: number) {
    return ((x - this.view.xmin) / (this.view.xmax - this.view.xmin)) * this.w;
  }
  py(y: number) {
    return ((this.view.ymax - y) / (this.view.ymax - this.view.ymin)) * this.h;
  }
  /** CSS-pixel offset inside the canvas -> landscape coordinates. */
  toWorld(ox: number, oy: number): Vec2 {
    const v = this.view;
    return [v.xmin + (ox / this.w) * (v.xmax - v.xmin), v.ymax - (oy / this.h) * (v.ymax - v.ymin)];
  }

  draw({ race, start, selected, hover, pal }: DrawOptions) {
    const { ctx, w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.bg, 0, 0, w, h);
    const l = race.cfg.landscape;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Known stationary points.
    for (const m of l.markers) this.marker(m.kind, this.px(m.x), this.py(m.y), pal);

    // Hover crosshair.
    if (hover) {
      const hx = this.px(hover[0]), hy = this.py(hover[1]);
      ctx.save();
      ctx.strokeStyle = pal.text;
      ctx.globalAlpha = 0.22;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(hy) + 0.5);
      ctx.lineTo(w, Math.round(hy) + 0.5);
      ctx.moveTo(Math.round(hx) + 0.5, 0);
      ctx.lineTo(Math.round(hx) + 0.5, h);
      ctx.stroke();
      ctx.restore();
    }

    // Start pin.
    const sx = this.px(start[0]), sy = this.py(start[1]);
    ctx.beginPath();
    ctx.arc(sx, sy, 8, 0, Math.PI * 2);
    ctx.fillStyle = pal.halo;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = pal.text;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - 4, sy);
    ctx.lineTo(sx + 4, sy);
    ctx.moveTo(sx, sy - 4);
    ctx.lineTo(sx, sy + 4);
    ctx.stroke();

    // Trails: unselected first, the selected optimizer on top.
    const runners = [...race.runners].sort((a, b) => Number(a.id === selected) - Number(b.id === selected));
    for (const r of runners) this.trail(r.xs, r.ys, pal.colors[r.id], pal);
    for (const r of runners) this.head(r, r.id === selected, pal);
  }

  private trail(xs: number[], ys: number[], color: string, pal: Palette) {
    const { ctx } = this;
    const n = xs.length;
    if (n < 2) return;
    const lim = 4 * Math.max(this.w, this.h);
    const P = (i: number): Vec2 => [
      Math.max(-lim, Math.min(lim, this.px(xs[i]))),
      Math.max(-lim, Math.min(lim, this.py(ys[i]))),
    ];
    const cut = Math.max(0, n - TRAIL);
    // Older part: faint, decimated to ≥ 1.5 px between vertices.
    if (cut > 0) {
      ctx.beginPath();
      let [lx, ly] = P(0);
      ctx.moveTo(lx, ly);
      for (let i = 1; i <= cut; i++) {
        const [x, y] = P(i);
        if (i === cut || Math.abs(x - lx) + Math.abs(y - ly) >= 1.5) {
          ctx.lineTo(x, y);
          lx = x;
          ly = y;
        }
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Recent part: halo, then segments whose opacity ramps up toward the head.
    ctx.beginPath();
    for (let i = cut; i < n; i++) {
      const [x, y] = P(i);
      if (i === cut) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = pal.halo;
    ctx.lineWidth = 4.5;
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    const chunks = 9;
    const per = Math.max(1, Math.ceil((n - cut) / chunks));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    for (let c = cut; c < n - 1; c += per) {
      const end = Math.min(n - 1, c + per);
      ctx.globalAlpha = 0.4 + 0.6 * ((end - cut) / Math.max(1, n - 1 - cut));
      ctx.beginPath();
      const [x0, y0] = P(c);
      ctx.moveTo(x0, y0);
      for (let i = c + 1; i <= end; i++) {
        const [x, y] = P(i);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private head(r: Race['runners'][number], selected: boolean, pal: Palette) {
    const { ctx, w, h } = this;
    const def = OPTIMIZER_BY_ID[r.id];
    const color = pal.colors[r.id];
    let x = this.px(r.state.x);
    let y = this.py(r.state.y);
    const inset = 9;
    const outside = !(x >= 0 && x <= w && y >= 0 && y <= h);
    if (outside) {
      // Clamp to the edge and point an arrow toward where it went.
      const cx = w / 2, cy = h / 2;
      const dx = x - cx, dy = y - cy;
      const s = Math.min((w / 2 - inset) / Math.abs(dx || 1e-9), (h / 2 - inset) / Math.abs(dy || 1e-9));
      x = cx + dx * s;
      y = cy + dy * s;
      const a = Math.atan2(dy, dx);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(7, 0);
      ctx.lineTo(-5, -6);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.strokeStyle = pal.halo;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }
    if (r.status === 'diverged') {
      ctx.save();
      ctx.lineWidth = 5;
      ctx.strokeStyle = pal.halo;
      const d = 6;
      const cross = () => {
        ctx.beginPath();
        ctx.moveTo(x - d, y - d);
        ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d);
        ctx.lineTo(x - d, y + d);
        ctx.stroke();
      };
      cross();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = color;
      cross();
      ctx.restore();
      return;
    }
    if (outside) return;
    const rad = selected ? 6.5 : 5.2;
    if (selected) {
      ctx.beginPath();
      ctx.arc(x, y, rad + 6, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (isFinished(r.status) && r.status !== 'max-steps') {
      ctx.beginPath();
      ctx.arc(x, y, rad + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = r.status === 'converged' ? pal.success : pal.warning;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    pathShape(ctx, def.shape, x, y, rad);
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = pal.halo;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
  }

  private marker(kind: string, x: number, y: number, pal: Palette) {
    const { ctx } = this;
    ctx.save();
    if (kind === 'global') {
      pathShape(ctx, 'star', x, y, 5.2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = pal.halo;
      ctx.stroke();
      ctx.fillStyle = pal.text;
      ctx.fill();
    } else if (kind === 'local') {
      ctx.beginPath();
      ctx.arc(x, y, 4.2, 0, Math.PI * 2);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = pal.halo;
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = pal.text;
      ctx.stroke();
    } else if (kind === 'saddle') {
      pathShape(ctx, 'diamond', x, y, 3.8);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = pal.halo;
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = pal.text;
      ctx.stroke();
    } else {
      pathShape(ctx, 'triangle', x, y, 4);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = pal.halo;
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = pal.text;
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Small landscape thumbnail for the picker. */
export function renderThumb(canvas: HTMLCanvasElement, l: Landscape, pal: Palette) {
  const w = canvas.clientWidth || 80;
  const h = canvas.clientHeight || 50;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const view = fitView(l.view, w / h);
  renderBackground(canvas, l, view, w, h, dpr, { ...pal, contour: pal.contour, contourMajor: pal.contourMajor });
}
