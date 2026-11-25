// QR matrix -> styled vector geometry, rendered either as an SVG string or onto a canvas.
import QRCode from 'qrcode';

export type ECL = 'L' | 'M' | 'Q' | 'H';
export type ModuleShape = 'square' | 'rounded' | 'dots';
export type EyeShape = 'square' | 'rounded' | 'circle' | 'leaf';
export type GradType = 'diagonal' | 'horizontal' | 'vertical' | 'radial';

export interface Logo {
  src: string; // data URL
  img: HTMLImageElement;
  w: number;
  h: number;
}

export interface Style {
  module: ModuleShape;
  eye: EyeShape;
  fg: string;
  bg: string;
  transparent: boolean;
  gradient: boolean;
  fg2: string;
  gradType: GradType;
  eyeColor: string | null;
  margin: number;
  ecl: ECL;
  logo: Logo | null;
  /** Fraction of the symbol area cleared for the logo (0.04 – 0.2). */
  logoArea: number;
  logoPlate: boolean;
}

/** Data codewords per version (index 0 = v1) for each error-correction level. */
const DATA_CODEWORDS: Record<ECL, number[]> = {
  L: [19, 34, 55, 80, 108, 136, 156, 194, 232, 274, 324, 370, 428, 461, 523, 589, 647, 721, 795, 861, 932, 1006, 1094, 1174, 1276, 1370, 1468, 1531, 1631, 1735, 1843, 1955, 2071, 2191, 2306, 2434, 2566, 2702, 2812, 2956],
  M: [16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334, 365, 415, 453, 507, 563, 627, 669, 714, 782, 860, 914, 1000, 1062, 1128, 1193, 1267, 1373, 1455, 1541, 1631, 1725, 1812, 1914, 1992, 2102, 2216, 2334],
  Q: [13, 22, 34, 48, 62, 76, 88, 110, 132, 154, 180, 206, 244, 261, 295, 325, 367, 397, 445, 485, 512, 568, 614, 664, 718, 754, 808, 871, 911, 985, 1033, 1115, 1171, 1231, 1286, 1354, 1426, 1502, 1582, 1666],
  H: [9, 16, 26, 36, 46, 60, 66, 86, 100, 122, 140, 158, 180, 197, 223, 253, 283, 313, 341, 385, 406, 442, 464, 514, 538, 596, 628, 661, 701, 745, 793, 845, 901, 961, 986, 1054, 1096, 1142, 1222, 1276],
};

/** Max bytes that fit in byte mode for a version/level. */
export function byteCapacity(version: number, ecl: ECL) {
  const bits = DATA_CODEWORDS[ecl][version - 1] * 8 - 4 - (version < 10 ? 8 : 16);
  return Math.floor(bits / 8);
}

export interface Symbol {
  size: number;
  /** Function-pattern / format-info modules that carry no data. */
  reserved: (r: number, c: number) => boolean;
  version: number;
  ecl: ECL;
  mask: number;
  dark: (r: number, c: number) => boolean;
  usedBits: number;
  capacityBits: number;
  modes: string[];
}

export function createSymbol(text: string, ecl: ECL, version?: number): Symbol {
  const qr = QRCode.create(text, version ? { errorCorrectionLevel: ecl, version } : { errorCorrectionLevel: ecl });
  const { size, data, reservedBit } = qr.modules;
  const v = qr.version;
  const idx = v < 10 ? 0 : v < 27 ? 1 : 2;
  let usedBits = 0;
  const modes = new Set<string>();
  for (const seg of qr.segments) {
    usedBits += 4 + seg.mode.ccBits[idx] + seg.getBitsLength();
    modes.add(seg.mode.id);
  }
  return {
    size,
    version: v,
    ecl,
    mask: qr.maskPattern,
    reserved: (r, c) => !!reservedBit[r * size + c],
    dark: (r, c) => r >= 0 && c >= 0 && r < size && c < size && !!data[r * size + c],
    usedBits,
    capacityBits: DATA_CODEWORDS[ecl][v - 1] * 8,
    modes: [...modes],
  };
}

// ---------------------------------------------------------------------------
// Logo safety: how much of the error-correction budget the covered modules use up
// ---------------------------------------------------------------------------

/** Level H: error-correction blocks and total EC codewords per version (ISO 18004 table 9). */
const H_BLOCKS = [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81];
const H_EC = [17, 28, 44, 64, 88, 112, 130, 156, 192, 224, 264, 308, 352, 384, 432, 480, 532, 588, 650, 700, 750, 816, 900, 960, 1050, 1110, 1200, 1260, 1350, 1440, 1530, 1620, 1710, 1800, 1890, 1980, 2100, 2220, 2310, 2430];

/**
 * Covering modules with a logo destroys every codeword that has a bit underneath it. This maps
 * the covered modules to codewords (zig-zag placement, then block de-interleaving) and returns the
 * worst block's damage as a share of what level H can repair (1 = at the limit).
 */
export function logoLoad(sym: Symbol, area: number): number {
  if (sym.ecl !== 'H') return Infinity;
  const N = sym.size, v = sym.version;
  const n = logoModules(N, area);
  const lo = (N - n) / 2, hi = lo + n;
  const blocks = H_BLOCKS[v - 1], ecTotal = H_EC[v - 1];
  const total = DATA_CODEWORDS.H[v - 1] + ecTotal;
  const ecPer = ecTotal / blocks;
  const g2 = total % blocks, g1 = blocks - g2;
  const data1 = Math.floor(total / blocks) - ecPer;
  const dataLen = (b: number) => (b < g1 ? data1 : data1 + 1);
  // Interleaved codeword order -> block index
  const owner: number[] = [];
  for (let i = 0; i < data1 + 1; i++) for (let b = 0; b < blocks; b++) if (i < dataLen(b)) owner.push(b);
  for (let i = 0; i < ecPer; i++) for (let b = 0; b < blocks; b++) owner.push(b);
  const hit = new Set<number>();
  let bit = 0, up = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < N; i++) {
      const r = up ? N - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (sym.reserved(r, c)) continue;
        const cw = bit++ >> 3;
        if (cw < total && r >= lo && r < hi && c >= lo && c < hi) hit.add(cw);
      }
    }
    up = !up;
  }
  const perBlock = new Array(blocks).fill(0);
  hit.forEach((cw) => perBlock[owner[cw]]++);
  const fixable = Math.floor((ecPer - (v === 1 ? 1 : 0)) / 2);
  return Math.max(...perBlock) / fixable;
}

/** Share of the repair budget a logo may use: leaves room for smudges, glare and print defects. */
export const LOGO_LOAD_LIMIT = 0.75;

/**
 * Level-H symbol for a code with a logo. Starts at the smallest version and steps up (at most 8
 * versions) until the covered area stays within LOGO_LOAD_LIMIT of what error correction can
 * repair; if none does, the version with the least damage wins.
 */
export function createLogoSymbol(text: string, area: number): { sym: Symbol; natural: number; load: number } {
  const first = createSymbol(text, 'H');
  const natural = first.version;
  let best = { sym: first, load: logoLoad(first, area) };
  for (let v = natural + 1; best.load > LOGO_LOAD_LIMIT && v <= Math.min(40, natural + 8); v++) {
    const sym = createSymbol(text, 'H', v);
    const load = logoLoad(sym, area);
    if (load < best.load - 1e-9) best = { sym, load };
  }
  return { ...best, natural };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const f = (n: number) => +n.toFixed(3);

/** Rounded rectangle path with per-corner radii [tl, tr, br, bl]. */
function rrect(x: number, y: number, w: number, h: number, [tl, tr, br, bl]: number[]) {
  return (
    `M${f(x + tl)} ${f(y)}H${f(x + w - tr)}` +
    (tr ? `A${tr} ${tr} 0 0 1 ${f(x + w)} ${f(y + tr)}` : '') +
    `V${f(y + h - br)}` +
    (br ? `A${br} ${br} 0 0 1 ${f(x + w - br)} ${f(y + h)}` : '') +
    `H${f(x + bl)}` +
    (bl ? `A${bl} ${bl} 0 0 1 ${f(x)} ${f(y + h - bl)}` : '') +
    `V${f(y + tl)}` +
    (tl ? `A${tl} ${tl} 0 0 1 ${f(x + tl)} ${f(y)}` : '') +
    'Z'
  );
}

function circle(cx: number, cy: number, r: number) {
  return `M${f(cx - r)} ${f(cy)}a${r} ${r} 0 1 0 ${f(2 * r)} 0a${r} ${r} 0 1 0 ${f(-2 * r)} 0Z`;
}

export interface Geometry {
  total: number; // viewBox size in modules (incl. margin)
  modules: string;
  align: string; // solid alignment patterns (even-odd), empty for square modules
  eyeOuter: string; // even-odd ring
  eyeInner: string;
  logoBox: { x: number; y: number; size: number } | null;
}

/** Centres of the alignment patterns for a QR version (ISO 18004 Annex E), excluding those under the finders. */
export function alignmentCentres(version: number): [number, number][] {
  if (version < 2) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const pos = [size - 7];
  for (let i = 1; i < count - 1; i++) pos.push(pos[i - 1] - step);
  pos.push(6);
  pos.reverse();
  const out: [number, number][] = [];
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      out.push([pos[i], pos[j]]);
    }
  }
  return out;
}

export function logoModules(size: number, area: number) {
  let n = Math.round(Math.sqrt(Math.min(0.2, Math.max(0.02, area))) * size);
  if ((size - n) % 2) n -= 1; // keep it centred on module boundaries
  return Math.max(3, n);
}

export function buildGeometry(sym: Symbol, style: Style): Geometry {
  const N = sym.size;
  const m = Math.max(0, Math.round(style.margin));
  const total = N + 2 * m;
  const inFinder = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= N - 7) || (r >= N - 7 && c < 7);

  let logoBox: Geometry['logoBox'] = null;
  let lo = -1, hi = -1;
  if (style.logo) {
    const n = logoModules(N, style.logoArea);
    lo = (N - n) / 2;
    hi = lo + n;
    logoBox = { x: lo + m, y: lo + m, size: n };
  }
  const inLogo = (r: number, c: number) => r >= lo && r < hi && c >= lo && c < hi;
  // Decorative module shapes leave gaps that make the small alignment patterns hard to find, so
  // those are drawn as solid shapes (like the finder eyes) whenever modules are not plain squares.
  const solidAlign = style.module !== 'square';
  const aligns = solidAlign
    ? alignmentCentres(sym.version).filter(([ar, ac]) => !(ar + 2 >= lo && ar - 2 < hi && ac + 2 >= lo && ac - 2 < hi))
    : [];
  const inAlign = (r: number, c: number) => aligns.some(([ar, ac]) => Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2);
  const on = (r: number, c: number) => sym.dark(r, c) && !inFinder(r, c) && !inLogo(r, c) && !inAlign(r, c);

  const parts: string[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!on(r, c)) continue;
      const x = c + m, y = r + m;
      if (style.module === 'square') {
        let run = 1;
        while (c + run < N && on(r, c + run)) run++;
        parts.push(`M${x} ${y}h${run}v1h-${run}z`);
        c += run - 1;
      } else if (style.module === 'dots') {
        parts.push(circle(x + 0.5, y + 0.5, 0.46));
      } else {
        const up = on(r - 1, c), dn = on(r + 1, c), lf = on(r, c - 1), rt = on(r, c + 1);
        const R = 0.5;
        parts.push(rrect(x, y, 1, 1, [!up && !lf ? R : 0, !up && !rt ? R : 0, !dn && !rt ? R : 0, !dn && !lf ? R : 0]));
      }
    }
  }

  const outer: string[] = [], inner: string[] = [];
  for (const [er, ec] of [[0, 0], [0, N - 7], [N - 7, 0]]) {
    const x = ec + m, y = er + m;
    switch (style.eye) {
      case 'square':
        outer.push(rrect(x, y, 7, 7, [0, 0, 0, 0]) + rrect(x + 1, y + 1, 5, 5, [0, 0, 0, 0]));
        inner.push(rrect(x + 2, y + 2, 3, 3, [0, 0, 0, 0]));
        break;
      case 'rounded':
        outer.push(rrect(x, y, 7, 7, [2, 2, 2, 2]) + rrect(x + 1, y + 1, 5, 5, [1.2, 1.2, 1.2, 1.2]));
        inner.push(rrect(x + 2, y + 2, 3, 3, [0.9, 0.9, 0.9, 0.9]));
        break;
      case 'circle':
        outer.push(circle(x + 3.5, y + 3.5, 3.5) + circle(x + 3.5, y + 3.5, 2.5));
        inner.push(circle(x + 3.5, y + 3.5, 1.5));
        break;
      case 'leaf': {
        // Drop shape: the corner facing the centre of the code stays sharp.
        const sharp = er === 0 ? (ec === 0 ? 2 : 3) : 1;
        const pick = (r: number) => [r, r, r, r].map((v, i) => (i === sharp ? 0 : v));
        const big = 3, mid = 2, small = 1.4;
        outer.push(rrect(x, y, 7, 7, pick(big)) + rrect(x + 1, y + 1, 5, 5, pick(mid)));
        inner.push(rrect(x + 2, y + 2, 3, 3, pick(small)));
        break;
      }
    }
  }

  const roundAlign = style.eye !== 'square';
  const align: string[] = [];
  for (const [ar, ac] of aligns) {
    const x = ac - 2 + m, y = ar - 2 + m;
    const R = roundAlign ? 1.4 : 0, r = roundAlign ? 0.7 : 0, k = roundAlign ? 0.5 : 0;
    align.push(rrect(x, y, 5, 5, [R, R, R, R]) + rrect(x + 1, y + 1, 3, 3, [r, r, r, r]) + rrect(x + 2, y + 2, 1, 1, [k, k, k, k]));
  }

  return { total, modules: parts.join(''), align: align.join(''), eyeOuter: outer.join(''), eyeInner: inner.join(''), logoBox };
}

function gradCoords(type: GradType, m: number, N: number) {
  const a = m, b = m + N;
  if (type === 'horizontal') return { x1: a, y1: 0, x2: b, y2: 0 };
  if (type === 'vertical') return { x1: 0, y1: a, x2: 0, y2: b };
  return { x1: a, y1: a, x2: b, y2: b };
}

function logoRect(g: Geometry, logo: Logo) {
  const box = g.logoBox!;
  const pad = Math.max(0.5, box.size * 0.08);
  const inner = box.size - pad * 2;
  const ratio = logo.w / logo.h || 1;
  const w = ratio >= 1 ? inner : inner * ratio;
  const h = ratio >= 1 ? inner / ratio : inner;
  return { x: box.x + (box.size - w) / 2, y: box.y + (box.size - h) / 2, w, h };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function toSvg(sym: Symbol, style: Style, px = 512, title = 'QR code'): string {
  const g = buildGeometry(sym, style);
  const T = g.total, m = Math.max(0, Math.round(style.margin)), N = sym.size;
  const defs: string[] = [];
  let fill = esc(style.fg);
  if (style.gradient) {
    if (style.gradType === 'radial') {
      defs.push(`<radialGradient id="qrg" gradientUnits="userSpaceOnUse" cx="${T / 2}" cy="${T / 2}" r="${f(N * 0.72)}"><stop offset="0" stop-color="${esc(style.fg)}"/><stop offset="1" stop-color="${esc(style.fg2)}"/></radialGradient>`);
    } else {
      const c = gradCoords(style.gradType, m, N);
      defs.push(`<linearGradient id="qrg" gradientUnits="userSpaceOnUse" x1="${c.x1}" y1="${c.y1}" x2="${c.x2}" y2="${c.y2}"><stop offset="0" stop-color="${esc(style.fg)}"/><stop offset="1" stop-color="${esc(style.fg2)}"/></linearGradient>`);
    }
    fill = 'url(#qrg)';
  }
  const eyeFill = style.eyeColor ? esc(style.eyeColor) : fill;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${T} ${T}" width="${px}" height="${px}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
  ];
  if (defs.length) out.push(`<defs>${defs.join('')}</defs>`);
  if (!style.transparent) out.push(`<rect width="${T}" height="${T}" fill="${esc(style.bg)}"/>`);
  out.push(`<path d="${g.modules}" fill="${fill}"/>`);
  if (g.align) out.push(`<path d="${g.align}" fill="${fill}" fill-rule="evenodd"/>`);
  out.push(`<path d="${g.eyeOuter}" fill="${eyeFill}" fill-rule="evenodd"/>`);
  out.push(`<path d="${g.eyeInner}" fill="${eyeFill}"/>`);
  if (style.logo && g.logoBox) {
    const b = g.logoBox;
    if (style.logoPlate) {
      const plate = style.transparent ? '#ffffff' : esc(style.bg);
      out.push(`<rect x="${f(b.x + 0.25)}" y="${f(b.y + 0.25)}" width="${f(b.size - 0.5)}" height="${f(b.size - 0.5)}" rx="${f(b.size * 0.18)}" fill="${plate}"/>`);
    }
    const r = logoRect(g, style.logo);
    out.push(`<image x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" preserveAspectRatio="xMidYMid meet" xlink:href="${esc(style.logo.src)}"/>`);
  }
  out.push('</svg>');
  return out.join('');
}

export function toCanvas(sym: Symbol, style: Style, px: number): HTMLCanvasElement {
  const g = buildGeometry(sym, style);
  const T = g.total, m = Math.max(0, Math.round(style.margin)), N = sym.size;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(px / T, px / T);
  if (!style.transparent) {
    ctx.fillStyle = style.bg;
    ctx.fillRect(0, 0, T, T);
  }
  let paint: string | CanvasGradient = style.fg;
  if (style.gradient) {
    let gr: CanvasGradient;
    if (style.gradType === 'radial') gr = ctx.createRadialGradient(T / 2, T / 2, 0, T / 2, T / 2, N * 0.72);
    else {
      const c = gradCoords(style.gradType, m, N);
      gr = ctx.createLinearGradient(c.x1, c.y1, c.x2, c.y2);
    }
    gr.addColorStop(0, style.fg);
    gr.addColorStop(1, style.fg2);
    paint = gr;
  }
  ctx.fillStyle = paint;
  ctx.fill(new Path2D(g.modules));
  if (g.align) ctx.fill(new Path2D(g.align), 'evenodd');
  ctx.fillStyle = style.eyeColor ?? paint;
  ctx.fill(new Path2D(g.eyeOuter), 'evenodd');
  ctx.fill(new Path2D(g.eyeInner));
  if (style.logo && g.logoBox) {
    const b = g.logoBox;
    if (style.logoPlate) {
      ctx.fillStyle = style.transparent ? '#ffffff' : style.bg;
      const r = b.size * 0.18;
      ctx.fill(new Path2D(rrect(b.x + 0.25, b.y + 0.25, b.size - 0.5, b.size - 0.5, [r, r, r, r])));
    }
    const r = logoRect(g, style.logo);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(style.logo.img, r.x, r.y, r.w, r.h);
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Colour checks
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function luminance(hex: string) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Warning {
  level: 'info' | 'warning' | 'error';
  text: string;
}

export function styleWarnings(style: Style): Warning[] {
  const w: Warning[] = [];
  const bg = style.transparent ? '#ffffff' : style.bg;
  const fgs = [style.fg, ...(style.gradient ? [style.fg2] : []), ...(style.eyeColor ? [style.eyeColor] : [])];
  const worst = Math.min(...fgs.map((c) => contrast(c, bg)));
  const ratio = worst.toFixed(1);
  if (worst < 2.5) w.push({ level: 'error', text: `Very low contrast (${ratio}:1). Most scanners will not read this; aim for 4.5:1 or more.` });
  else if (worst < 4.5) w.push({ level: 'warning', text: `Low contrast (${ratio}:1). Some phones may struggle, especially in dim light.` });
  if (!style.transparent && fgs.some((c) => luminance(c) > luminance(style.bg) + 0.02)) {
    w.push({ level: 'warning', text: 'Inverted colours (light code on a dark background). Many scanners only read dark-on-light codes.' });
  }
  if (style.transparent) w.push({ level: 'warning', text: 'Transparent background: make sure it is placed on a light, plain surface.' });
  if (style.margin < 2) w.push({ level: 'warning', text: `Quiet zone of ${style.margin} module${style.margin === 1 ? '' : 's'}. Leave at least 2 (4 is the standard) so scanners can find the code.` });
  return w;
}
