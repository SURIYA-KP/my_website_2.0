// Background rendering: log-scaled loss heatmap + marching-squares contours, cached offscreen.
import type { Landscape, View } from './engine';

export type { View };

/** Colours the cached background needs (the rest of the canvas palette lives in the UI). */
export interface BgTheme {
  lut: Uint8ClampedArray;
  contour: string;
  contourMajor: string;
}

/* ---------- Perceptual colormap (OKLCH stops interpolated in OKLab) ---------- */

type Stop = [t: number, L: number, C: number, h: number];

function oklchToLab([, L, C, h]: Stop): [number, number, number] {
  const r = (h * Math.PI) / 180;
  return [L, C * Math.cos(r), C * Math.sin(r)];
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  }) as [number, number, number];
}

export function makeLut(stops: Stop[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const labs = stops.map(oklchToLab);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const t0 = stops[k][0];
    const t1 = stops[k + 1][0];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    const a = labs[k];
    const b = labs[k + 1];
    const [r, g, bl] = labToRgb(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = bl;
  }
  return lut;
}

// Lightness rises monotonically from valleys to peaks in both themes (perceptually ordered),
// with a gentle hue sweep and low chroma so the coloured optimizer paths stay the most salient thing.
export const LIGHT_STOPS: Stop[] = [
  [0, 0.56, 0.1, 266],
  [0.3, 0.7, 0.085, 232],
  [0.62, 0.85, 0.065, 180],
  [0.85, 0.935, 0.05, 112],
  [1, 0.985, 0.025, 85],
];
export const DARK_STOPS: Stop[] = [
  [0, 0.16, 0.035, 285],
  [0.35, 0.26, 0.06, 268],
  [0.65, 0.37, 0.07, 236],
  [0.88, 0.48, 0.065, 200],
  [1, 0.56, 0.05, 170],
];

/* ---------- Field ---------- */

export interface Field {
  /** Transformed (log-scaled) values on a gw × gh grid of CSS pixels. */
  u: Float32Array;
  gw: number;
  gh: number;
  lo: number;
  hi: number;
  transform: (f: number) => number;
}

function quantile(sorted: Float64Array, q: number) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}

export function computeField(l: Landscape, v: View, gw: number, gh: number): Field {
  const raw = new Float64Array(gw * gh);
  const dx = (v.xmax - v.xmin) / gw;
  const dy = (v.ymax - v.ymin) / gh;
  for (let j = 0; j < gh; j++) {
    const y = v.ymax - (j + 0.5) * dy;
    for (let i = 0; i < gw; i++) raw[j * gw + i] = l.f(v.xmin + (i + 0.5) * dx, y);
  }
  // Pick the transform from a sample of the values.
  const step = Math.max(1, Math.floor(raw.length / 4000));
  const sample: number[] = [];
  for (let k = 0; k < raw.length; k += step) if (Number.isFinite(raw[k])) sample.push(raw[k]);
  // log10(f − f* + δ): δ (a tiny fraction of the median height) keeps the minimum finite.
  const fmin = l.fmin;
  const g = Float64Array.from(sample.map((f) => Math.max(0, f - fmin))).sort();
  const delta = Math.max(1e-12, quantile(g, 0.5) * 1e-5);
  const transform = (f: number) => Math.log10(Math.max(0, f - fmin) + delta);
  const u = new Float32Array(raw.length);
  for (let k = 0; k < raw.length; k++) u[k] = transform(raw[k]);
  const us = Float64Array.from(sample.map(transform)).sort();
  const lo = quantile(us, 0.005);
  let hi = quantile(us, 0.995);
  if (hi - lo < 1e-9) hi = lo + 1;
  return { u, gw, gh, lo, hi, transform };
}

/* ---------- Marching squares ---------- */

/** Append contour segments for `level` to `path`. Grid coordinates are scaled by (sx, sy). */
export function marchingSquares(field: Field, level: number, stride: number, sx: number, sy: number, path: Path2D) {
  const { u, gw, gh } = field;
  const cols = Math.floor((gw - 1) / stride);
  const rows = Math.floor((gh - 1) / stride);
  // Grid point (i, j) -> sample index; sample centres sit at (i*stride + 0.5) CSS px.
  const val = (i: number, j: number) => u[j * stride * gw + i * stride];
  const px = (i: number) => (i * stride + 0.5) * sx;
  const py = (j: number) => (j * stride + 0.5) * sy;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = val(i, j); // top-left
      const b = val(i + 1, j); // top-right
      const c = val(i + 1, j + 1); // bottom-right
      const d = val(i, j + 1); // bottom-left
      let idx = 0;
      if (a > level) idx |= 8;
      if (b > level) idx |= 4;
      if (c > level) idx |= 2;
      if (d > level) idx |= 1;
      if (idx === 0 || idx === 15) continue;
      const x0 = px(i);
      const x1 = px(i + 1);
      const y0 = py(j);
      const y1 = py(j + 1);
      const lerp = (p: number, q: number) => (level - p) / (q - p);
      const top = (): [number, number] => [x0 + (x1 - x0) * lerp(a, b), y0];
      const right = (): [number, number] => [x1, y0 + (y1 - y0) * lerp(b, c)];
      const bottom = (): [number, number] => [x0 + (x1 - x0) * lerp(d, c), y1];
      const left = (): [number, number] => [x0, y0 + (y1 - y0) * lerp(a, d)];
      const seg = (p: [number, number], q: [number, number]) => {
        path.moveTo(p[0], p[1]);
        path.lineTo(q[0], q[1]);
      };
      switch (idx) {
        case 1: case 14: seg(left(), bottom()); break;
        case 2: case 13: seg(bottom(), right()); break;
        case 3: case 12: seg(left(), right()); break;
        case 4: case 11: seg(top(), right()); break;
        case 6: case 9: seg(top(), bottom()); break;
        case 7: case 8: seg(left(), top()); break;
        case 5: case 10: {
          // Saddle cell: disambiguate with the centre value.
          const centre = (a + b + c + d) / 4 > level;
          if ((idx === 5) === centre) {
            seg(left(), top());
            seg(bottom(), right());
          } else {
            seg(left(), bottom());
            seg(top(), right());
          }
          break;
        }
      }
    }
  }
}

/* ---------- Background ---------- */

export const CONTOUR_LEVELS = 18;

export function renderBackground(
  out: HTMLCanvasElement | OffscreenCanvas,
  l: Landscape,
  v: View,
  cssW: number,
  cssH: number,
  dpr: number,
  theme: BgTheme,
  contours = true,
): Field {
  const gw = Math.max(2, Math.round(cssW));
  const gh = Math.max(2, Math.round(cssH));
  const field = computeField(l, v, gw, gh);
  const img = new ImageData(gw, gh);
  const { u, lo, hi } = field;
  const span = hi - lo;
  const lut = theme.lut;
  for (let k = 0; k < u.length; k++) {
    let t = (u[k] - lo) / span;
    if (!(t >= 0)) t = 0;
    else if (t > 1) t = 1;
    const ci = Math.round(t * 255) * 3;
    const p = k * 4;
    img.data[p] = lut[ci];
    img.data[p + 1] = lut[ci + 1];
    img.data[p + 2] = lut[ci + 2];
    img.data[p + 3] = 255;
  }
  out.width = Math.round(cssW * dpr);
  out.height = Math.round(cssH * dpr);
  const ctx = out.getContext('2d') as CanvasRenderingContext2D;
  const tmp = new OffscreenCanvas(gw, gh);
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, 0, 0, out.width, out.height);

  if (!contours) return field;
  // Contours: evenly spaced in log-loss, every 3rd one emphasised.
  const sx = out.width / gw;
  const sy = out.height / gh;
  const minor = new Path2D();
  const major = new Path2D();
  for (let k = 1; k < CONTOUR_LEVELS; k++) {
    const level = lo + (span * k) / CONTOUR_LEVELS;
    marchingSquares(field, level, 2, sx, sy, k % 3 === 0 ? major : minor);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = theme.contour;
  ctx.lineWidth = 0.8 * dpr;
  ctx.stroke(minor);
  ctx.strokeStyle = theme.contourMajor;
  ctx.lineWidth = 1.1 * dpr;
  ctx.stroke(major);
  return field;
}
