// Shared types and pure helpers for Image Studio (used by the page and the worker).

export type OutFormat = 'jpeg' | 'png' | 'webp' | 'avif';
export type FormatChoice = 'keep' | OutFormat;
export type ResizeMode = 'none' | 'fit' | 'percent' | 'exact';

export interface ResizeSettings {
  mode: ResizeMode;
  /** fit: max width / height (0 = unconstrained). exact: width / height (0 = derive when locked). */
  width: number;
  height: number;
  percent: number;
  /** exact mode: keep the aspect ratio (derive the missing side) instead of stretching. */
  lock: boolean;
}

export interface Settings {
  format: FormatChoice;
  /** 1..100. In target-size mode this is the maximum quality tried. */
  quality: number;
  resize: ResizeSettings;
  target: { enabled: boolean; kb: number };
  /** Background used when flattening transparency (JPEG has no alpha). */
  background: string;
  /** Rasterization scale for SVG input. */
  svgScale: number;
}

/** Crop / rotate / flip. Flips are applied to the source first, then the rotation, then the crop
 *  (crop is normalized 0..1 in the rotated image's coordinates). */
export interface Edit {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  crop: { x: number; y: number; w: number; h: number } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  format: 'webp',
  quality: 80,
  resize: { mode: 'none', width: 1920, height: 1920, percent: 50, lock: true },
  target: { enabled: false, kb: 200 },
  background: '#ffffff',
  svgScale: 2,
};

export function cloneSettings(s: Settings): Settings {
  return { ...s, resize: { ...s.resize }, target: { ...s.target } };
}

export function isIdentityEdit(e: Edit | null | undefined): boolean {
  return !e || (e.rotate === 0 && !e.flipH && !e.flipV && !e.crop);
}

export const MIME: Record<OutFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};
export const EXT: Record<OutFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };
export const LABEL: Record<OutFormat, string> = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', avif: 'AVIF' };

/** Short label for a source MIME type / file. */
export function sourceLabel(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'JPEG';
  if (m.includes('png')) return 'PNG';
  if (m.includes('webp')) return 'WebP';
  if (m.includes('gif')) return 'GIF';
  if (m.includes('bmp')) return 'BMP';
  if (m.includes('avif')) return 'AVIF';
  if (m.includes('svg')) return 'SVG';
  if (m.includes('ico')) return 'ICO';
  return m.replace('image/', '').toUpperCase() || '?';
}

/** Which encoder to use for "Keep" and when a choice isn't supported. */
export function resolveFormat(choice: FormatChoice, srcMime: string, supported: OutFormat[]): OutFormat {
  const has = (f: OutFormat) => supported.includes(f);
  if (choice !== 'keep') {
    if (has(choice)) return choice;
    // The UI hides unsupported encoders; this is only a safety net.
    return choice === 'avif' && has('webp') ? 'webp' : 'jpeg';
  }
  const m = srcMime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpeg';
  if (m.includes('webp')) return has('webp') ? 'webp' : 'png';
  if (m.includes('avif')) return has('avif') ? 'avif' : has('webp') ? 'webp' : 'png';
  // PNG, GIF, BMP, SVG, ICO and anything else: lossless PNG keeps transparency.
  return 'png';
}

/** Compute output dimensions. Never returns less than 1px. */
export function computeResize(w: number, h: number, r: ResizeSettings): { width: number; height: number } {
  const clamp = (n: number) => Math.max(1, Math.round(n));
  switch (r.mode) {
    case 'fit': {
      const mw = r.width > 0 ? r.width : Infinity;
      const mh = r.height > 0 ? r.height : Infinity;
      const s = Math.min(1, mw / w, mh / h);
      return { width: clamp(w * s), height: clamp(h * s) };
    }
    case 'percent': {
      const p = Math.max(1, Math.min(1000, r.percent || 100)) / 100;
      return { width: clamp(w * p), height: clamp(h * p) };
    }
    case 'exact': {
      const ew = r.width > 0 ? r.width : 0;
      const eh = r.height > 0 ? r.height : 0;
      if (!ew && !eh) return { width: w, height: h };
      if (r.lock || !ew || !eh) {
        // Aspect locked: width wins when given, otherwise derive from height.
        if (ew) return { width: clamp(ew), height: clamp((ew * h) / w) };
        return { width: clamp((eh * w) / h), height: clamp(eh) };
      }
      return { width: clamp(ew), height: clamp(eh) };
    }
    default:
      return { width: w, height: h };
  }
}

/** Dimensions after rotate + crop (before resizing). */
export function editedSize(w: number, h: number, e: Edit | null | undefined): { width: number; height: number } {
  if (!e) return { width: w, height: h };
  let W = w, H = h;
  if (e.rotate === 90 || e.rotate === 270) [W, H] = [h, w];
  if (e.crop) return { width: Math.max(1, Math.round(e.crop.w * W)), height: Math.max(1, Math.round(e.crop.h * H)) };
  return { width: W, height: H };
}

/** Build download filenames: base name + suffix + new extension, de-duplicated (case-insensitive). */
export function buildFilenames(entries: { name: string; ext: string }[], suffix = ''): string[] {
  const used = new Set<string>();
  const safeSuffix = suffix.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return entries.map(({ name, ext }) => {
    let base = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'image';
    base += safeSuffix;
    let candidate = `${base}.${ext}`;
    let n = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${base}-${n++}.${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
