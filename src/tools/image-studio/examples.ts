// Sample images generated in the page (no downloads), including a JPEG with real EXIF + GPS
// so the privacy features have something to show.

type TagVal =
  | { tag: number; type: 1; v: number[] }
  | { tag: number; type: 2; v: string }
  | { tag: number; type: 3; v: number[] }
  | { tag: number; type: 4; v: number[] }
  | { tag: number; type: 5; v: [number, number][] };

const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 } as const;
const count = (t: TagVal) => (t.type === 2 ? t.v.length + 1 : t.v.length);
const byteLen = (t: TagVal) => count(t) * SIZE[t.type];

function ifdSize(entries: TagVal[]) {
  let data = 0;
  for (const e of entries) {
    const n = byteLen(e);
    if (n > 4) data += n + (n & 1);
  }
  return 2 + entries.length * 12 + 4 + data;
}

function writeIfd(dv: DataView, at: number, entries: TagVal[]) {
  entries.sort((a, b) => a.tag - b.tag);
  dv.setUint16(at, entries.length, true);
  let data = at + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => {
    const p = at + 2 + i * 12;
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, count(e), true);
    const n = byteLen(e);
    let q = p + 8;
    if (n > 4) { dv.setUint32(p + 8, data, true); q = data; data += n + (n & 1); }
    if (e.type === 2) { for (let k = 0; k < e.v.length; k++) dv.setUint8(q + k, e.v.charCodeAt(k) & 0x7f); dv.setUint8(q + e.v.length, 0); }
    else if (e.type === 1) e.v.forEach((x, k) => dv.setUint8(q + k, x));
    else if (e.type === 3) e.v.forEach((x, k) => dv.setUint16(q + k * 2, x, true));
    else if (e.type === 4) e.v.forEach((x, k) => dv.setUint32(q + k * 4, x, true));
    else e.v.forEach(([a, b], k) => { dv.setUint32(q + k * 8, a, true); dv.setUint32(q + k * 8 + 4, b, true); });
  });
  dv.setUint32(at + 2 + entries.length * 12, 0, true);
}

const toDms = (deg: number): [number, number][] => {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = Math.round(((a - d) * 60 - m) * 60 * 10000);
  return [[d, 1], [m, 1], [s, 10000]];
};

export interface ExifFields {
  make: string; model: string; software: string; date: string; orientation: number; lat: number; lon: number;
}

/** Build a little-endian TIFF/EXIF block with IFD0, Exif IFD and GPS IFD. */
export function buildExif(f: ExifFields): Uint8Array {
  const exif: TagVal[] = [{ tag: 0x9003, type: 2, v: f.date }, { tag: 0x920a, type: 5, v: [[26, 1]] }];
  const gps: TagVal[] = [
    { tag: 0, type: 1, v: [2, 3, 0, 0] },
    { tag: 1, type: 2, v: f.lat >= 0 ? 'N' : 'S' },
    { tag: 2, type: 5, v: toDms(f.lat) },
    { tag: 3, type: 2, v: f.lon >= 0 ? 'E' : 'W' },
    { tag: 4, type: 5, v: toDms(f.lon) },
  ];
  const ifd0: TagVal[] = [
    { tag: 0x010f, type: 2, v: f.make },
    { tag: 0x0110, type: 2, v: f.model },
    { tag: 0x0112, type: 3, v: [f.orientation] },
    { tag: 0x0131, type: 2, v: f.software },
    { tag: 0x0132, type: 2, v: f.date },
    { tag: 0x8769, type: 4, v: [0] },
    { tag: 0x8825, type: 4, v: [0] },
  ];
  const o0 = 8;
  const oExif = o0 + ifdSize(ifd0);
  const oGps = oExif + ifdSize(exif);
  const total = oGps + ifdSize(gps);
  (ifd0[5] as { v: number[] }).v = [oExif];
  (ifd0[6] as { v: number[] }).v = [oGps];
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0], 0);
  dv.setUint32(4, o0, true);
  writeIfd(dv, o0, ifd0);
  writeIfd(dv, oExif, exif);
  writeIfd(dv, oGps, gps);
  return out;
}

/** Insert an APP1 EXIF segment into a JPEG (after SOI / JFIF APP0). */
export function insertExif(jpeg: Uint8Array, tiff: Uint8Array): Uint8Array {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const segLen = 2 + 6 + tiff.length;
  const seg = new Uint8Array(2 + segLen);
  seg.set([0xff, 0xe1, segLen >> 8, segLen & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(tiff, 10);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, at));
  out.set(seg, at);
  out.set(jpeg.subarray(at), at + seg.length);
  return out;
}

/* ---------- Procedural drawings ---------- */

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d')! };
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, q));

function landscape(w: number, h: number) {
  const { c, ctx } = canvas(w, h);
  const r = rng(7);
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.7);
  sky.addColorStop(0, '#1d2b64');
  sky.addColorStop(0.45, '#c0587e');
  sky.addColorStop(0.8, '#f8b15d');
  sky.addColorStop(1, '#fde3a7');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const sx = w * 0.62, sy = h * 0.56;
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.5);
  glow.addColorStop(0, 'rgba(255,240,200,0.95)');
  glow.addColorStop(0.12, 'rgba(255,214,140,0.8)');
  glow.addColorStop(1, 'rgba(255,180,120,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  const layers = ['#6d4a7a', '#4d3566', '#2f2449', '#1a1530'];
  layers.forEach((col, i) => {
    const base = h * (0.55 + i * 0.1);
    ctx.beginPath();
    ctx.moveTo(0, h);
    let y = base;
    for (let x = 0; x <= w; x += w / 120) {
      y += (r() - 0.5) * h * 0.035 + (base - y) * 0.06;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
  });
  // Film grain so the PNG behaves like a real photo (large, compressible as lossy).
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 18;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function street(w: number, h: number) {
  const { c, ctx } = canvas(w, h);
  const r = rng(42);
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#8ec5fc');
  sky.addColorStop(1, '#e0f0ff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  let x = 0;
  while (x < w) {
    const bw = w * (0.06 + r() * 0.1);
    const bh = h * (0.3 + r() * 0.5);
    const hue = Math.floor(r() * 360);
    ctx.fillStyle = `hsl(${hue} 25% ${35 + r() * 25}%)`;
    ctx.fillRect(x, h - bh - h * 0.12, bw, bh);
    ctx.fillStyle = 'rgba(255,240,180,0.85)';
    for (let wy = h - bh - h * 0.1; wy < h - h * 0.16; wy += h * 0.045)
      for (let wx = x + bw * 0.12; wx < x + bw - bw * 0.15; wx += bw * 0.22)
        if (r() > 0.35) ctx.fillRect(wx, wy, bw * 0.1, h * 0.025);
    x += bw + w * 0.005;
  }
  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, h * 0.88, w, h * 0.12);
  ctx.fillStyle = '#f5f5f5';
  for (let lx = 0; lx < w; lx += w / 12) ctx.fillRect(lx, h * 0.935, w / 24, h * 0.01);
  return c;
}

function logo(s: number) {
  const { c, ctx } = canvas(s, s);
  const g = ctx.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, '#6366f1');
  g.addColorStop(1, '#ec4899');
  ctx.fillStyle = g;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    ctx.lineTo(s / 2 + Math.cos(a) * s * 0.42, s / 2 + Math.sin(a) * s * 0.42);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = s * 0.025;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.27, 0, Math.PI * 2);
  ctx.stroke();
  return c;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
  <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>
  <rect width="240" height="160" rx="18" fill="url(#g)"/>
  <circle cx="70" cy="62" r="20" fill="#fde68a"/>
  <path d="M0 140 L60 86 L104 120 L150 70 L240 140 L240 160 L0 160 Z" fill="#1e293b" opacity="0.85"/>
  <text x="120" y="38" font-family="sans-serif" font-size="18" font-weight="700" fill="#fff">vector.svg</text>
</svg>`;

export async function makeExamples(): Promise<File[]> {
  const files: File[] = [];
  files.push(new File([await toBlob(landscape(2400, 1600), 'image/png')], 'mountain-sunset.png', { type: 'image/png' }));
  const jpg = new Uint8Array(await (await toBlob(street(1600, 1067), 'image/jpeg', 0.95)).arrayBuffer());
  const exif = buildExif({
    make: 'Example Optics', model: 'EX-200 Demo', software: 'Image Studio sample', date: '2024:06:14 18:42:07',
    orientation: 1, lat: 48.858222, lon: 2.2945,
  });
  files.push(new File([insertExif(jpg, exif) as BlobPart], 'city-street.jpg', { type: 'image/jpeg' }));
  files.push(new File([await toBlob(logo(900), 'image/png')], 'logo-transparent.png', { type: 'image/png' }));
  files.push(new File([SVG], 'vector-badge.svg', { type: 'image/svg+xml' }));
  return files;
}
