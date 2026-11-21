// Theme-aware colours for canvas drawing. Everything is read from CSS variables.
import { cssVar } from '../../lib/ui';

export type RGB = [number, number, number];

let probe: CanvasRenderingContext2D | null = null;
/** Parse any CSS colour into [r, g, b] by letting the canvas normalise it. */
export function toRgb(color: string): RGB {
  if (!probe) probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [128, 128, 128];
  probe.fillStyle = '#808080';
  probe.fillStyle = color || '#808080';
  const s = String(probe.fillStyle);
  if (s.startsWith('#')) {
    const h = s.slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const m = s.match(/[\d.]+/g);
  return m ? [+m[0], +m[1], +m[2]] : [128, 128, 128];
}

export const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export interface Theme {
  bg: string; elev: string; sunken: string; border: string; borderStrong: string;
  text: string; muted: string; faint: string; accent: string; danger: string;
  cluster: string[]; classes: string[]; pos: string; neg: string;
  rgb: { bg: RGB; elev: RGB; text: RGB; cluster: RGB[]; classes: RGB[]; pos: RGB; neg: RGB };
  dark: boolean;
}

export function readTheme(): Theme {
  const v = (n: string, fb: string) => cssVar(n) || fb;
  const cluster = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8', '--ml-lab-k9', '--ml-lab-k10'].map((n) => v(n, '#888'));
  const classes = ['--ml-lab-class-a', '--ml-lab-class-b', '--ml-lab-class-c'].map((n) => v(n, '#888'));
  const t = {
    bg: v('--bg', '#fff'), elev: v('--bg-elev', '#fff'), sunken: v('--bg-sunken', '#eee'),
    border: v('--border', '#ddd'), borderStrong: v('--border-strong', '#ccc'),
    text: v('--text', '#111'), muted: v('--text-muted', '#555'), faint: v('--text-faint', '#888'),
    accent: v('--accent', '#4f46e5'), danger: v('--danger', '#c00'),
    cluster, classes, pos: v('--ml-lab-pos', '#4f46e5'), neg: v('--ml-lab-neg', '#dc2626'),
  };
  const elev = toRgb(t.elev);
  return {
    ...t,
    rgb: {
      bg: toRgb(t.bg), elev, text: toRgb(t.text), cluster: cluster.map(toRgb), classes: classes.map(toRgb),
      pos: toRgb(t.pos), neg: toRgb(t.neg),
    },
    dark: elev[0] + elev[1] + elev[2] < 300,
  };
}

/** Size a canvas's backing store to its CSS box at device pixel ratio; returns a ctx in CSS px. */
export function fitCanvas(canvas: HTMLCanvasElement, cssW?: number, cssH?: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(cssW ?? canvas.clientWidth));
  const h = Math.max(1, Math.round(cssH ?? canvas.clientHeight));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

/** Faint graph-paper grid used as the backdrop of both stages. */
export function drawGraphPaper(ctx: CanvasRenderingContext2D, size: number, th: Theme) {
  ctx.fillStyle = th.elev;
  ctx.fillRect(0, 0, size, size);
  ctx.lineWidth = 1;
  for (let i = 1; i < 20; i++) {
    const p = Math.round((i / 20) * size) + 0.5;
    ctx.strokeStyle = i % 5 === 0 ? th.borderStrong : th.border;
    ctx.globalAlpha = i === 10 ? 0.9 : i % 5 === 0 ? 0.55 : 0.45;
    ctx.beginPath();
    ctx.moveTo(p, 0); ctx.lineTo(p, size);
    ctx.moveTo(0, p); ctx.lineTo(size, p);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
