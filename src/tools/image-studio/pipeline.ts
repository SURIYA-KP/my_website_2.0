// Canvas pipeline shared by the Web Worker (OffscreenCanvas) and the main-thread fallback
// (HTMLCanvasElement). Input is an already-oriented ImageBitmap; output is a re-encoded Blob,
// which by construction contains no EXIF/XMP/ICC metadata.
import {
  type Edit, type OutFormat, type Settings, MIME,
  computeResize, isIdentityEdit, resolveFormat,
} from './types';

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface CanvasEnv {
  create(w: number, h: number): AnyCanvas;
  encode(c: AnyCanvas, mime: string, quality?: number): Promise<Blob>;
}

export const offscreenEnv: CanvasEnv = {
  create: (w, h) => new OffscreenCanvas(w, h),
  encode: (c, type, quality) => (c as OffscreenCanvas).convertToBlob({ type, quality }),
};

export const domEnv: CanvasEnv = {
  create: (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  },
  encode: (c, type, quality) =>
    new Promise((res, rej) =>
      (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('The browser could not encode this image (too large?)'))), type, quality),
    ),
};

const ctx2d = (c: AnyCanvas) => {
  const ctx = c.getContext('2d') as Ctx | null;
  if (!ctx) throw new Error('Canvas 2D is unavailable (the image may be too large for this browser).');
  return ctx;
};

/** Detect which formats canvas can actually encode (falls back to PNG when unsupported). */
export async function detectFormats(env: CanvasEnv): Promise<OutFormat[]> {
  const out: OutFormat[] = ['jpeg', 'png'];
  const c = env.create(4, 4);
  ctx2d(c).fillRect(0, 0, 2, 2);
  for (const f of ['webp', 'avif'] as OutFormat[]) {
    try {
      const b = await env.encode(c, MIME[f], 0.8);
      if (b.type === MIME[f]) out.push(f);
    } catch { /* unsupported */ }
  }
  return out;
}

export interface Region { src: CanvasImageSource; sx: number; sy: number; sw: number; sh: number }

/** Apply flip + rotation, then compute the crop region. */
export function applyEdit(env: CanvasEnv, bmp: ImageBitmap, edit: Edit | null | undefined): Region {
  const w = bmp.width, h = bmp.height;
  if (isIdentityEdit(edit)) return { src: bmp, sx: 0, sy: 0, sw: w, sh: h };
  const e = edit!;
  let src: CanvasImageSource = bmp;
  let W = w, H = h;
  if (e.rotate || e.flipH || e.flipV) {
    const swap = e.rotate === 90 || e.rotate === 270;
    W = swap ? h : w;
    H = swap ? w : h;
    const c = env.create(W, H);
    const ctx = ctx2d(c);
    ctx.translate(W / 2, H / 2);
    ctx.rotate((e.rotate * Math.PI) / 180);
    ctx.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1);
    ctx.drawImage(bmp, -w / 2, -h / 2);
    src = c;
  }
  if (!e.crop) return { src, sx: 0, sy: 0, sw: W, sh: H };
  const sx = Math.max(0, Math.min(W - 1, Math.round(e.crop.x * W)));
  const sy = Math.max(0, Math.min(H - 1, Math.round(e.crop.y * H)));
  const sw = Math.max(1, Math.min(W - sx, Math.round(e.crop.w * W)));
  const sh = Math.max(1, Math.min(H - sy, Math.round(e.crop.h * H)));
  return { src, sx, sy, sw, sh };
}

/** Draw a region at a target size, halving step by step for big downscales (sharper, less aliasing). */
export function renderRegion(env: CanvasEnv, r: Region, tw: number, th: number, background: string | null): AnyCanvas {
  let { src, sx, sy, sw, sh } = r;
  while (sw / 2 >= tw && sh / 2 >= th && sw > 2 && sh > 2) {
    const nw = Math.max(tw, Math.round(sw / 2));
    const nh = Math.max(th, Math.round(sh / 2));
    const step = env.create(nw, nh);
    const sctx = ctx2d(step);
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, sx, sy, sw, sh, 0, 0, nw, nh);
    src = step; sx = 0; sy = 0; sw = nw; sh = nh;
  }
  const out = env.create(tw, th);
  const ctx = ctx2d(out);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, tw, th);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, tw, th);
  return out;
}

function detectAlpha(env: CanvasEnv, r: Region): boolean {
  const s = 64;
  const c = env.create(s, s);
  const ctx = ctx2d(c) as CanvasRenderingContext2D;
  ctx.drawImage(r.src, r.sx, r.sy, r.sw, r.sh, 0, 0, s, s);
  const d = ctx.getImageData(0, 0, s, s).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

export interface JobOptions {
  settings: Settings;
  edit: Edit | null;
  srcType: string;
  srcBytes: number;
  supported: OutFormat[];
}

export interface JobResult {
  blob: Blob;
  width: number;
  height: number;
  srcW: number;
  srcH: number;
  format: OutFormat;
  quality: number | null;
  scale: number;
  hasAlpha: boolean;
  flattened: boolean;
  passes: number;
  /** null when target mode is off */
  targetMet: boolean | null;
}

const MIN_Q = 0.35;

export async function processBitmap(
  env: CanvasEnv,
  bmp: ImageBitmap,
  o: JobOptions,
  onProgress: (text: string) => void = () => {},
): Promise<JobResult> {
  const s = o.settings;
  const format = resolveFormat(s.format, o.srcType, o.supported);
  const mime = MIME[format];
  const lossy = format !== 'png';
  const region = applyEdit(env, bmp, o.edit);
  const base = computeResize(region.sw, region.sh, s.resize);
  const hasAlpha = detectAlpha(env, region);
  const flatten = format === 'jpeg';
  const bg = flatten ? s.background || '#ffffff' : null;
  const qMax = Math.max(0.01, Math.min(1, s.quality / 100));
  let passes = 0;
  const sized = (scale: number) => ({
    w: Math.max(1, Math.round(base.width * scale)),
    h: Math.max(1, Math.round(base.height * scale)),
  });
  const done = (blob: Blob, scale: number, q: number | null, met: boolean | null): JobResult => {
    const { w, h } = sized(scale);
    return {
      blob, width: w, height: h, srcW: bmp.width, srcH: bmp.height, format,
      quality: lossy ? q : null, scale, hasAlpha, flattened: flatten && hasAlpha, passes, targetMet: met,
    };
  };

  if (!s.target.enabled) {
    onProgress('Encoding');
    const { w, h } = sized(1);
    const c = renderRegion(env, region, w, h, bg);
    passes = 1;
    return done(await env.encode(c, mime, lossy ? qMax : undefined), 1, qMax, null);
  }

  // Target size: binary search on quality (lossy), then shrink the dimensions if needed.
  const target = Math.max(1, s.target.kb) * 1024;
  let scale = 1;
  let smallest: { blob: Blob; scale: number; q: number } | null = null;
  const encode = async (c: AnyCanvas, q: number) => {
    passes++;
    onProgress(`Pass ${passes}${scale < 1 ? ` · ${Math.round(scale * 100)}% size` : ''}`);
    const b = await env.encode(c, mime, lossy ? q : undefined);
    if (!smallest || b.size < smallest.blob.size) smallest = { blob: b, scale, q };
    return b;
  };
  for (let round = 0; round < 10; round++) {
    const { w, h } = sized(scale);
    const c = renderRegion(env, region, w, h, bg);
    if (!lossy) {
      const b = await encode(c, 1);
      if (b.size <= target) return done(b, scale, null, true);
      if (w <= 8 || h <= 8) break;
      scale *= Math.min(0.92, Math.max(0.3, Math.sqrt(target / b.size) * 0.95));
      continue;
    }
    const top = await encode(c, qMax);
    if (top.size <= target) return done(top, scale, qMax, true);
    const lo0 = Math.min(MIN_Q, qMax);
    const low = await encode(c, lo0);
    if (low.size > target) {
      if (w <= 8 || h <= 8) break;
      scale *= Math.min(0.92, Math.max(0.3, Math.sqrt(target / low.size) * 0.97));
      continue;
    }
    let best = low, bestQ = lo0, lo = lo0, hi = qMax;
    for (let i = 0; i < 6 && hi - lo > 0.015; i++) {
      const mid = (lo + hi) / 2;
      const b = await encode(c, mid);
      if (b.size <= target) { best = b; bestQ = mid; lo = mid; } else hi = mid;
    }
    return done(best, scale, bestQ, true);
  }
  const sm = smallest as { blob: Blob; scale: number; q: number } | null;
  if (!sm) throw new Error('Encoding failed');
  return done(sm.blob, sm.scale, sm.q, sm.blob.size <= target);
}
