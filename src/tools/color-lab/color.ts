// Pure color math for Color Lab. No DOM access here, so it is easy to reason about and test.
import {
  parse,
  converter,
  formatHex,
  formatHex8,
  inGamut,
  toGamut,
  clampChroma,
  wcagContrast,
  nearest,
  differenceCiede2000,
  colorsNamed,
  interpolate,
} from 'culori';

export type Color = { mode: string; alpha?: number; [k: string]: any };
export type Rgb = { mode: 'rgb'; r: number; g: number; b: number; alpha?: number };
export type Oklch = { mode: 'oklch'; l: number; c: number; h?: number; alpha?: number };

export const toRgb = converter('rgb') as (c: any) => Rgb;
export const toOklch = converter('oklch') as (c: any) => Oklch;
export const toOklab = converter('oklab') as (c: any) => any;
export const toHsl = converter('hsl') as (c: any) => any;
export const toHwb = converter('hwb') as (c: any) => any;
export const toLab = converter('lab') as (c: any) => any;
export const toLch = converter('lch') as (c: any) => any;
const isInRgb = inGamut('rgb');
const isInP3 = inGamut('p3');
const mapToRgb = toGamut('rgb', 'oklch');

/** Parse any CSS color string. Returns undefined on failure. */
export function parseColor(input: string): Color | undefined {
  const s = (input ?? '').trim();
  if (!s) return undefined;
  let c = parse(s) as Color | undefined;
  // Be forgiving: allow hex without the leading '#'.
  if (!c && /^[0-9a-f]{3,8}$/i.test(s) && [3, 4, 6, 8].includes(s.length)) c = parse('#' + s) as Color | undefined;
  return c ?? undefined;
}

export function inSrgb(c: Color) {
  return isInRgb(c);
}
export function inP3(c: Color) {
  return isInP3(c);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, d = 0) => {
  const f = 10 ** d;
  const v = Math.round(x * f) / f;
  return Object.is(v, -0) ? 0 : v;
};
const num = (x: number | undefined, d: number) => String(round(x ?? 0, d));
const hue = (h: number | undefined, d = 2) => num(Number.isFinite(h as number) ? ((h as number) % 360 + 360) % 360 : 0, d);
const alphaPart = (a: number | undefined) => (a === undefined || a >= 1 ? '' : ` / ${round(a * 100, 1)}%`);

/** sRGB color with channels clamped into [0,1], gamut-mapped in OKLCH first when needed. */
export function srgb(c: Color): Rgb {
  const mapped = isInRgb(c) ? toRgb(c) : (mapToRgb(c) as Rgb);
  const out: Rgb = { mode: 'rgb', r: clamp01(mapped.r ?? 0), g: clamp01(mapped.g ?? 0), b: clamp01(mapped.b ?? 0) };
  if (c.alpha !== undefined && c.alpha < 1) out.alpha = clamp01(c.alpha);
  return out;
}

export function hex(c: Color): string {
  return formatHex(srgb(c))!;
}
export function hex8(c: Color): string {
  const r = srgb(c);
  return formatHex8({ ...r, alpha: r.alpha ?? 1 })!;
}
/** '#rrggbb' or '#rrggbbaa' when translucent. */
export function hexAuto(c: Color): string {
  return c.alpha !== undefined && c.alpha < 1 ? hex8(c) : hex(c);
}

export function formatRgbCss(c: Color) {
  const r = srgb(c);
  return `rgb(${round(r.r * 255)} ${round(r.g * 255)} ${round(r.b * 255)}${alphaPart(r.alpha)})`;
}
export function formatHslCss(c: Color) {
  const h = toHsl(srgb(c));
  return `hsl(${hue(h.h, 1)} ${num((h.s ?? 0) * 100, 1)}% ${num((h.l ?? 0) * 100, 1)}%${alphaPart(c.alpha)})`;
}
export function formatHwbCss(c: Color) {
  const h = toHwb(srgb(c));
  return `hwb(${hue(h.h, 1)} ${num((h.w ?? 0) * 100, 1)}% ${num((h.b ?? 0) * 100, 1)}%${alphaPart(c.alpha)})`;
}
export function formatLabCss(c: Color) {
  const l = toLab(c);
  return `lab(${num(l.l, 2)}% ${num(l.a, 2)} ${num(l.b, 2)}${alphaPart(c.alpha)})`;
}
export function formatLchCss(c: Color) {
  const l = toLch(c);
  return `lch(${num(l.l, 2)}% ${num(l.c, 2)} ${hue(l.h)}${alphaPart(c.alpha)})`;
}
export function formatOklabCss(c: Color) {
  const l = toOklab(c);
  return `oklab(${num(l.l * 100, 2)}% ${num(l.a, 4)} ${num(l.b, 4)}${alphaPart(c.alpha)})`;
}
export function formatOklchCss(c: Color) {
  const l = toOklch(c);
  return `oklch(${num(l.l * 100, 2)}% ${num(l.c, 4)} ${hue(l.h)}${alphaPart(c.alpha)})`;
}
export function cmyk(c: Color) {
  const { r, g, b } = srgb(c);
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: round(((1 - r - k) / (1 - k)) * 100),
    m: round(((1 - g - k) / (1 - k)) * 100),
    y: round(((1 - b - k) / (1 - k)) * 100),
    k: round(k * 100),
  };
}
export function formatCmyk(c: Color) {
  const v = cmyk(c);
  return `cmyk(${v.c}% ${v.m}% ${v.y}% ${v.k}%)`;
}

export interface FormatRow {
  id: string;
  label: string;
  value: string;
  /** True when the value had to be gamut-mapped into sRGB. */
  mapped: boolean;
}

export function allFormats(c: Color): FormatRow[] {
  const out = !isInRgb(c);
  return [
    { id: 'hex', label: 'HEX', value: hex(c), mapped: out },
    { id: 'hex8', label: 'HEX8', value: hex8(c), mapped: out },
    { id: 'rgb', label: 'RGB', value: formatRgbCss(c), mapped: out },
    { id: 'hsl', label: 'HSL', value: formatHslCss(c), mapped: out },
    { id: 'hwb', label: 'HWB', value: formatHwbCss(c), mapped: out },
    { id: 'lab', label: 'LAB', value: formatLabCss(c), mapped: false },
    { id: 'lch', label: 'LCH', value: formatLchCss(c), mapped: false },
    { id: 'oklab', label: 'OKLAB', value: formatOklabCss(c), mapped: false },
    { id: 'oklch', label: 'OKLCH', value: formatOklchCss(c), mapped: false },
    { id: 'cmyk', label: 'CMYK', value: formatCmyk(c), mapped: out },
  ];
}

/** Compact, lossless-enough serialization: hex if it fits sRGB, else oklch(). */
export function serialize(c: Color): string {
  if (isInRgb(c)) return hexAuto(c);
  return formatOklchCss(c);
}

const namedKeys = Object.keys(colorsNamed).filter((k) => k !== 'transparent');
// Many CSS names are aliases (gray/grey, aqua/cyan, ...). Prefer the first one.
const namedUnique = namedKeys.filter((k, i) => namedKeys.findIndex((j) => (colorsNamed as any)[j] === (colorsNamed as any)[k]) === i);
let nearestFn: ((c: any, n?: number) => string[]) | null = null;
export function nearestNamed(c: Color): { name: string; hex: string; deltaE: number } {
  nearestFn ??= nearest(namedUnique, differenceCiede2000()) as any;
  const name = nearestFn!(srgb(c), 1)[0];
  const de = differenceCiede2000()(srgb(c), name);
  return { name, hex: formatHex(name)!, deltaE: round(de, 2) };
}

// ---------------------------------------------------------------- Contrast

/** Composite a (possibly translucent) color over an opaque background in sRGB. */
export function flatten(fg: Color, bg: Color): Rgb {
  const b = srgb({ ...bg, alpha: 1 });
  const f = srgb(fg);
  const a = f.alpha ?? 1;
  return { mode: 'rgb', r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a) };
}

export function contrastRatio(fg: Color, bg: Color): number {
  const b = srgb({ ...bg, alpha: 1 });
  return wcagContrast(flatten(fg, b), b);
}

export const WCAG = {
  normal: { AA: 4.5, AAA: 7 },
  large: { AA: 3, AAA: 4.5 },
  ui: { AA: 3 },
} as const;

/**
 * WCAG ratios are compared unrounded (4.48 fails 4.5). Display with two decimals, but never
 * round up onto a threshold (4.497 shows 4.49, not a misleading 4.50).
 */
export function formatRatio(r: number) {
  let v = Math.round(r * 100) / 100;
  if ([3, 4.5, 7].includes(v) && r < v) v = Math.floor(r * 100) / 100;
  return v.toFixed(2);
}

/** APCA-W3 0.0.98G-4g lightness contrast (Lc). Positive: dark text on light bg. */
export function apcaLc(fg: Color, bg: Color): number {
  const b = srgb({ ...bg, alpha: 1 });
  const t = flatten(fg, b);
  const Y = (c: Rgb) => 0.2126729 * c.r ** 2.4 + 0.7151522 * c.g ** 2.4 + 0.072175 * c.b ** 2.4;
  const clampBlack = (y: number) => (y > 0.022 ? y : y + (0.022 - y) ** 1.414);
  const yt = clampBlack(Y(t));
  const yb = clampBlack(Y(b));
  if (Math.abs(yb - yt) < 0.0005) return 0;
  let out: number;
  if (yb > yt) {
    const s = (yb ** 0.56 - yt ** 0.57) * 1.14;
    out = s < 0.1 ? 0 : s - 0.027;
  } else {
    const s = (yb ** 0.65 - yt ** 0.62) * 1.14;
    out = s > -0.1 ? 0 : s + 0.027;
  }
  return out * 100;
}

export function apcaGuidance(lc: number): string {
  const a = Math.abs(lc);
  if (a >= 90) return 'Preferred for body text and fine print';
  if (a >= 75) return 'Minimum for body text (fluent reading)';
  if (a >= 60) return 'Content text that is not body copy';
  if (a >= 45) return 'Large or bold headlines only';
  if (a >= 30) return 'Spot text, placeholders, non-text UI';
  if (a >= 15) return 'Only for non-text dividers or decoration';
  return 'Not readable: invisible for text';
}

export interface Suggestion {
  color: Color;
  hex: string;
  ratio: number;
  deltaL: number;
  alreadyPasses: boolean;
}

/**
 * Find the closest foreground that reaches `target` contrast against `bg` by changing
 * only OKLCH lightness (hue and chroma are kept, chroma is only reduced when needed to fit sRGB).
 * Returns null when no lightness reaches the target (e.g. target 21 on a mid-grey).
 */
export function suggestForeground(fg: Color, bg: Color, target: number): Suggestion | null {
  const base = toOklch(srgb({ ...fg, alpha: 1 }));
  const alpha = fg.alpha;
  const current = contrastRatio(fg, bg);
  const make = (l: number): { color: Color; hex: string; ratio: number } => {
    const cand: Oklch = { mode: 'oklch', l, c: base.c ?? 0, h: base.h };
    const h = hex(cand);
    const parsed = parseColor(h)!;
    const color = alpha !== undefined && alpha < 1 ? { ...parsed, alpha } : parsed;
    return { color, hex: h, ratio: contrastRatio(color, bg) };
  };
  if (current >= target) {
    return { color: fg, hex: hexAuto(fg), ratio: current, deltaL: 0, alreadyPasses: true };
  }
  const step = 0.0025;
  let best: { color: Color; hex: string; ratio: number; deltaL: number } | null = null;
  for (const dir of [1, -1]) {
    for (let l = base.l + dir * step; l >= -1e-9 && l <= 1 + 1e-9; l += dir * step) {
      const s = make(clamp01(l));
      if (s.ratio >= target) {
        const d = Math.abs(l - base.l);
        if (!best || d < best.deltaL) best = { ...s, deltaL: d };
        break;
      }
    }
  }
  if (!best) return null;
  return { ...best, deltaL: round(best.deltaL * (Math.sign(toOklch(best.color).l - base.l) || 1), 4), alreadyPasses: false };
}

/** Black or white, whichever reads better on the given color. */
export function readableOn(c: Color): '#000000' | '#ffffff' {
  return contrastRatio({ mode: 'rgb', r: 0, g: 0, b: 0 }, c) >= contrastRatio({ mode: 'rgb', r: 1, g: 1, b: 1 }, c) ? '#000000' : '#ffffff';
}

// ---------------------------------------------------------------- Palettes

export type Harmony = 'complementary' | 'analogous' | 'triadic' | 'split-complementary' | 'tetradic' | 'monochrome';
export const HARMONIES: { id: Harmony; label: string }[] = [
  { id: 'complementary', label: 'Complementary' },
  { id: 'analogous', label: 'Analogous' },
  { id: 'triadic', label: 'Triadic' },
  { id: 'split-complementary', label: 'Split-complementary' },
  { id: 'tetradic', label: 'Tetradic' },
  { id: 'monochrome', label: 'Monochrome' },
];

const HUE_OFFSETS: Record<Harmony, number[]> = {
  complementary: [0, 180],
  analogous: [0, -30, 30, -60, 60],
  triadic: [0, 120, 240],
  'split-complementary': [0, 150, 210],
  tetradic: [0, 90, 180, 270],
  monochrome: [0],
};

export const PALETTE_SIZE = 5;

/**
 * Build a 5-color palette from a base color using OKLCH hue rotation. Harmonies with
 * fewer than five hues are filled with lighter/darker variants of their hues.
 */
export function harmony(base: Color, kind: Harmony, size = PALETTE_SIZE): string[] {
  const b = toOklch(srgb({ ...base, alpha: 1 }));
  const L = b.l;
  const C = b.c ?? 0;
  const H = b.h ?? 0;
  const offsets = HUE_OFFSETS[kind];
  const out: string[] = [];
  if (kind === 'monochrome') {
    const ls = [0, 0.16, -0.16, 0.3, -0.3].map((d) => L + d).map((l) => (l > 0.97 ? 0.97 - (l - 0.97) * 0.5 : l < 0.15 ? 0.15 + (0.15 - l) * 0.5 : l));
    for (let i = 0; i < size; i++) out.push(hex({ mode: 'oklch', l: ls[i % ls.length], c: C * (i === 0 ? 1 : 0.85), h: H }));
    return out;
  }
  const n = offsets.length;
  for (let i = 0; i < size; i++) {
    const off = offsets[i % n];
    const tier = Math.floor(i / n); // 0 = pure hue, 1 = lighter, 2 = darker
    const dl = tier === 0 ? 0 : tier % 2 === 1 ? 0.18 : -0.18;
    let l = L + dl;
    if (l > 0.96 || l < 0.2) l = L - dl; // flip direction if we'd hit the end
    out.push(hex({ mode: 'oklch', l: Math.min(0.97, Math.max(0.15, l)), c: tier === 0 ? C : C * 0.8, h: (H + off + 360) % 360 }));
  }
  return out;
}

export const TONAL_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
// Lightness and relative chroma per step, modelled on Tailwind v4's OKLCH palettes.
const TONAL_L = [0.971, 0.936, 0.885, 0.808, 0.704, 0.637, 0.577, 0.505, 0.444, 0.396, 0.27];
const TONAL_C = [0.13, 0.27, 0.48, 0.75, 0.94, 1, 0.96, 0.85, 0.72, 0.6, 0.44];

export interface Tone {
  step: number;
  hex: string;
  oklch: Oklch;
  css: string;
}

/** 11-step 50–950 tonal scale. Lightness is fixed per step (monotonic), hue is kept, chroma follows a bell curve. */
export function tonalScale(base: Color): Tone[] {
  const b = toOklch(srgb({ ...base, alpha: 1 }));
  const peak = Math.max(b.c ?? 0, 0);
  const h = b.h ?? 0;
  return TONAL_STEPS.map((step, i) => {
    const want: Oklch = { mode: 'oklch', l: TONAL_L[i], c: peak * TONAL_C[i], h };
    const fit = clampChroma(want, 'oklch', 'rgb') as Oklch;
    const o: Oklch = { mode: 'oklch', l: TONAL_L[i], c: fit.c ?? 0, h };
    return { step, hex: hex(o), oklch: o, css: formatOklchCss(o) };
  });
}

/** Index in TONAL_STEPS whose lightness is closest to the base color. */
export function closestStep(base: Color): number {
  const l = toOklch(srgb(base)).l;
  let best = 0;
  TONAL_L.forEach((v, i) => {
    if (Math.abs(v - l) < Math.abs(TONAL_L[best] - l)) best = i;
  });
  return best;
}

/** A random but pleasant base color (mid lightness, moderate chroma). */
export function randomBase(rand = Math.random): string {
  return hex({ mode: 'oklch', l: 0.5 + rand() * 0.3, c: 0.08 + rand() * 0.12, h: rand() * 360 });
}

export function slugify(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'brand'
  );
}

export function exportCss(palette: string[], scale: Tone[], name: string) {
  const n = slugify(name);
  const lines = [':root {'];
  palette.forEach((c, i) => lines.push(`  --palette-${i + 1}: ${c};`));
  lines.push('');
  scale.forEach((t) => lines.push(`  --${n}-${t.step}: ${t.hex};`));
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function exportTailwind(palette: string[], scale: Tone[], name: string) {
  const n = slugify(name);
  const lines = ['/* Tailwind CSS v4: add to your main CSS file */', '@import "tailwindcss";', '', '@theme {'];
  scale.forEach((t) => lines.push(`  --color-${n}-${t.step}: ${t.css};`));
  palette.forEach((c, i) => lines.push(`  --color-palette-${i + 1}: ${c};`));
  lines.push('}', '', '/* Tailwind CSS v3: tailwind.config.js', 'module.exports = {', '  theme: {', '    extend: {', '      colors: {');
  lines.push(`        '${n}': {`);
  scale.forEach((t) => lines.push(`          ${t.step}: '${t.hex}',`));
  lines.push('        },');
  lines.push(`        palette: { ${palette.map((c, i) => `${i + 1}: '${c}'`).join(', ')} },`);
  lines.push('      },', '    },', '  },', '}; */');
  return lines.join('\n') + '\n';
}

export function exportJson(palette: string[], scale: Tone[], name: string, harmonyKind: string, base: string) {
  const n = slugify(name);
  return (
    JSON.stringify(
      {
        name: n,
        base,
        harmony: harmonyKind,
        palette,
        scale: Object.fromEntries(scale.map((t) => [String(t.step), { hex: t.hex, oklch: t.css }])),
      },
      null,
      2,
    ) + '\n'
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A self-contained SVG swatch sheet: the palette on top, the tonal scale below. */
export function swatchSvg(palette: string[], scale: Tone[], name: string) {
  const W = 1100;
  const pw = W / palette.length;
  const sw = W / scale.length;
  const H = 360;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, system-ui, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  ];
  palette.forEach((c, i) => {
    const col = parseColor(c)!;
    const fg = readableOn(col);
    parts.push(`<rect x="${round(i * pw, 2)}" y="0" width="${round(pw + 0.5, 2)}" height="220" fill="${c}"/>`);
    parts.push(`<text x="${round(i * pw + 16, 2)}" y="200" font-size="20" font-weight="600" fill="${fg}">${esc(c.toUpperCase())}</text>`);
  });
  scale.forEach((t, i) => {
    const fg = readableOn(parseColor(t.hex)!);
    parts.push(`<rect x="${round(i * sw, 2)}" y="220" width="${round(sw + 0.5, 2)}" height="140" fill="${t.hex}"/>`);
    parts.push(`<text x="${round(i * sw + 10, 2)}" y="320" font-size="15" font-weight="700" fill="${fg}">${t.step}</text>`);
    parts.push(`<text x="${round(i * sw + 10, 2)}" y="342" font-size="12" fill="${fg}">${t.hex}</text>`);
  });
  parts.push(`<title>${esc(slugify(name))} palette</title>`, '</svg>');
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------- Gradients

export type GradientType = 'linear' | 'radial' | 'conic';
export type GradientSpace = 'srgb' | 'oklab' | 'oklch';
export interface Stop {
  color: string;
  pos: number; // 0..100
}
export interface GradientState {
  type: GradientType;
  angle: number;
  space: GradientSpace;
  stops: Stop[];
}

export function sortedStops(stops: Stop[]) {
  return [...stops].sort((a, b) => a.pos - b.pos);
}

function prefix(g: GradientState, withSpace: boolean) {
  const sp = withSpace && g.space !== 'srgb' ? `in ${g.space}` : '';
  if (g.type === 'linear') return [`${round(g.angle, 1)}deg`, sp].filter(Boolean).join(' ');
  if (g.type === 'radial') return ['circle at center', sp].filter(Boolean).join(' ');
  return [`from ${round(g.angle, 1)}deg at center`, sp].filter(Boolean).join(' ');
}

/** The CSS gradient function, e.g. `linear-gradient(90deg in oklch, #ff0000 0%, #0000ff 100%)`. */
export function gradientCss(g: GradientState) {
  const stops = sortedStops(g.stops)
    .map((s) => `${s.color} ${round(s.pos, 1)}%`)
    .join(', ');
  return `${g.type}-gradient(${prefix(g, true)}, ${stops})`;
}

/** Same gradient approximated in plain sRGB with extra stops sampled in the chosen space, for older browsers. */
export function gradientFallbackCss(g: GradientState, samplesPerSegment = 4) {
  const st = sortedStops(g.stops);
  if (g.space === 'srgb') return gradientCss(g);
  const out: string[] = [];
  for (let i = 0; i < st.length; i++) {
    out.push(`${hex(parseColor(st[i].color)!)} ${round(st[i].pos, 1)}%`);
    if (i < st.length - 1) {
      const f = interpolate([st[i].color, st[i + 1].color], g.space);
      for (let k = 1; k < samplesPerSegment; k++) {
        const t = k / samplesPerSegment;
        out.push(`${hex(f(t) as Color)} ${round(st[i].pos + (st[i + 1].pos - st[i].pos) * t, 1)}%`);
      }
    }
  }
  return `${g.type}-gradient(${prefix(g, false)}, ${out.join(', ')})`;
}

export function gradientCssBlock(g: GradientState) {
  const main = gradientCss(g);
  if (g.space === 'srgb') return `background: ${main};\n`;
  return `background: ${gradientFallbackCss(g)};\nbackground: ${main};\n`;
}

/** Color at position (0..100) of the gradient, interpolated in its space. */
export function colorAt(g: GradientState, pos: number): string {
  const st = sortedStops(g.stops);
  if (pos <= st[0].pos) return hex(parseColor(st[0].color)!);
  if (pos >= st[st.length - 1].pos) return hex(parseColor(st[st.length - 1].color)!);
  for (let i = 0; i < st.length - 1; i++) {
    if (pos >= st[i].pos && pos <= st[i + 1].pos) {
      const span = st[i + 1].pos - st[i].pos || 1;
      const f = interpolate([st[i].color, st[i + 1].color], g.space === 'srgb' ? 'rgb' : g.space);
      return hex(f((pos - st[i].pos) / span) as Color);
    }
  }
  return st[0].color;
}

// ---------------------------------------------------------------- Image palette (k-means in OKLab)

export interface Cluster {
  hex: string;
  share: number; // 0..1
}

/** Small seeded PRNG so extraction is deterministic for the same image. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
const LUT = new Float32Array(256).map((_, i) => srgbToLinear(i / 255));

function linToOklab(r: number, g: number, b: number, out: Float32Array, o: number) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/**
 * Extract a palette from RGBA pixel data with k-means++ in OKLab.
 * Fully transparent pixels are ignored. Returns clusters sorted by share (largest first).
 */
export function extractPalette(data: Uint8ClampedArray | Uint8Array, k: number, maxIter = 24, seed = 1): Cluster[] {
  const n0 = data.length / 4;
  const pts = new Float32Array(n0 * 3);
  let n = 0;
  for (let i = 0; i < n0; i++) {
    if (data[i * 4 + 3] < 128) continue;
    linToOklab(LUT[data[i * 4]], LUT[data[i * 4 + 1]], LUT[data[i * 4 + 2]], pts, n * 3);
    n++;
  }
  if (n === 0) return [];
  k = Math.max(1, Math.min(k, n));
  const rand = mulberry32(seed);
  const cent = new Float32Array(k * 3);
  // k-means++ seeding
  const d2 = new Float32Array(n).fill(Infinity);
  let pick = Math.floor(rand() * n);
  for (let c = 0; c < k; c++) {
    cent.set(pts.subarray(pick * 3, pick * 3 + 3), c * 3);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dl = pts[i * 3] - cent[c * 3], da = pts[i * 3 + 1] - cent[c * 3 + 1], db = pts[i * 3 + 2] - cent[c * 3 + 2];
      const d = dl * dl + da * da + db * db;
      if (d < d2[i]) d2[i] = d;
      sum += d2[i];
    }
    if (sum === 0) {
      k = c + 1; // fewer distinct colors than requested
      break;
    }
    let r = rand() * sum;
    pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= d2[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
  }
  const assign = new Int32Array(n);
  const counts = new Float64Array(k);
  const sums = new Float64Array(k * 3);
  for (let it = 0; it < maxIter; it++) {
    let changed = 0;
    counts.fill(0);
    sums.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = pts[i * 3] - cent[c * 3], da = pts[i * 3 + 1] - cent[c * 3 + 1], db = pts[i * 3 + 2] - cent[c * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (assign[i] !== best || it === 0) changed++;
      assign[i] = best;
      counts[best]++;
      sums[best * 3] += pts[i * 3];
      sums[best * 3 + 1] += pts[i * 3 + 1];
      sums[best * 3 + 2] += pts[i * 3 + 2];
    }
    for (let c = 0; c < k; c++) {
      if (!counts[c]) continue;
      cent[c * 3] = sums[c * 3] / counts[c];
      cent[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
      cent[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
    }
    if (it > 0 && changed === 0) break;
  }
  const res: Cluster[] = [];
  for (let c = 0; c < k; c++) {
    if (!counts[c]) continue;
    res.push({ hex: hex({ mode: 'oklab', l: cent[c * 3], a: cent[c * 3 + 1], b: cent[c * 3 + 2] }), share: counts[c] / n });
  }
  // Merge clusters that round to the same hex.
  const merged = new Map<string, number>();
  for (const r of res) merged.set(r.hex, (merged.get(r.hex) ?? 0) + r.share);
  return [...merged].map(([hex, share]) => ({ hex, share })).sort((a, b) => b.share - a.share);
}

// ---------------------------------------------------------------- Color vision deficiency simulation

export type Vision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia' | 'achromatopsia';
export const VISIONS: { id: Vision; label: string; note: string }[] = [
  { id: 'normal', label: 'Normal vision', note: 'Trichromat' },
  { id: 'protanopia', label: 'Protanopia', note: 'No red cones, about 1% of men' },
  { id: 'deuteranopia', label: 'Deuteranopia', note: 'No green cones, about 1% of men' },
  { id: 'tritanopia', label: 'Tritanopia', note: 'No blue cones, rare' },
  { id: 'achromatopsia', label: 'Achromatopsia', note: 'No color vision, very rare' },
];

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
export const CVD_MATRICES: Record<Exclude<Vision, 'normal'>, number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
  achromatopsia: [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722],
};

export function simulateRgb255(r: number, g: number, b: number, v: Vision): [number, number, number] {
  if (v === 'normal') return [r, g, b];
  const m = CVD_MATRICES[v];
  const lr = LUT[r], lg = LUT[g], lb = LUT[b];
  const o = (i: number) => Math.round(clamp01(linearToSrgb(m[i] * lr + m[i + 1] * lg + m[i + 2] * lb)) * 255);
  return [o(0), o(3), o(6)];
}

export function simulate(hexColor: string, v: Vision): string {
  const c = srgb(parseColor(hexColor)!);
  const [r, g, b] = simulateRgb255(Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), v);
  return formatHex({ mode: 'rgb', r: r / 255, g: g / 255, b: b / 255 })!;
}

/** Pairs of palette colors that become hard to tell apart under a given simulation. */
export function confusablePairs(colors: string[], v: Vision, threshold = 10): [number, number, number][] {
  const sim = colors.map((c) => simulate(c, v));
  const de = differenceCiede2000();
  const out: [number, number, number][] = [];
  for (let i = 0; i < sim.length; i++)
    for (let j = i + 1; j < sim.length; j++) {
      const original = de(colors[i], colors[j]);
      const d = de(sim[i], sim[j]);
      if (d < threshold && original >= threshold) out.push([i, j, round(d, 1)]);
    }
  return out;
}

export function simulateImageData(src: ImageData | { data: Uint8ClampedArray }, dst: { data: Uint8ClampedArray }, v: Vision) {
  const s = src.data, d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    const [r, g, b] = simulateRgb255(s[i], s[i + 1], s[i + 2], v);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = s[i + 3];
  }
}
