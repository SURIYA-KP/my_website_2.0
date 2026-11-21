// File type sniffing and image preparation (browser only).

export type Kind = 'pdf' | 'png' | 'jpg' | 'webp' | 'image';

export function sniff(buf: ArrayBuffer, name: string, mime: string): Kind | null {
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024));
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  // %PDF- may legally appear anywhere in the first 1024 bytes.
  for (let i = 0; i + 5 <= b.length; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return 'pdf';
  }
  if (/^image\/(gif|bmp|avif|x-icon)$/.test(mime) || /\.(gif|bmp|avif)$/i.test(name)) return 'image';
  return null;
}

export const looksLikePdfName = (name: string, mime: string) => /\.pdf$/i.test(name) || mime === 'application/pdf';

function pngSize(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

/** Returns JPEG size and EXIF orientation (1 when absent). */
function jpegInfo(b: Uint8Array): { w: number; h: number; orientation: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 2;
  let orientation = 1;
  while (o + 4 < b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const marker = b[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { o += marker === 0xff ? 1 : 2; continue; }
    const len = v.getUint16(o + 2);
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(o + 4, o + 8)) === 'Exif') {
      try {
        const t = o + 10;
        const le = v.getUint16(t) === 0x4949;
        const ifd = t + v.getUint32(t + 4, le);
        const n = v.getUint16(ifd, le);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, le) === 0x0112) orientation = v.getUint16(e + 8, le);
        }
      } catch { /* ignore malformed EXIF */ }
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: v.getUint16(o + 5), w: v.getUint16(o + 7), orientation };
    }
    o += 2 + len;
  }
  return null;
}

export interface PreparedImage {
  bytes: ArrayBuffer;
  mime: 'png' | 'jpg';
  w: number;
  h: number;
  url: string;
}

async function viaCanvas(blob: Blob): Promise<PreparedImage> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob); // honours EXIF orientation
  } catch {
    throw new Error('the browser could not decode this image');
  }
  const w = bmp.width;
  const h = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  // Keep transparency as PNG; opaque images become a compact JPEG.
  let opaque = true;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 16) if (data[i] < 255) { opaque = false; break; }
  const type = opaque ? 'image/jpeg' : 'image/png';
  const out = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encoding failed'))), type, 0.92));
  canvas.width = canvas.height = 0;
  return { bytes: await out.arrayBuffer(), mime: opaque ? 'jpg' : 'png', w, h, url: URL.createObjectURL(out) };
}

export async function prepareImage(buf: ArrayBuffer, kind: Kind, mime: string): Promise<PreparedImage> {
  const u8 = new Uint8Array(buf);
  if (kind === 'png' && u8.length > 24) {
    const { w, h } = pngSize(u8);
    if (w > 0 && h > 0) return { bytes: buf, mime: 'png', w, h, url: URL.createObjectURL(new Blob([buf], { type: 'image/png' })) };
  }
  if (kind === 'jpg') {
    const info = jpegInfo(u8);
    if (info && info.w > 0 && info.h > 0 && info.orientation === 1) {
      return { bytes: buf, mime: 'jpg', w: info.w, h: info.h, url: URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' })) };
    }
  }
  // WebP, GIF, BMP, rotated JPEGs and anything unusual: decode and re-encode through a canvas.
  const r = await viaCanvas(new Blob([buf], { type: mime || 'image/' + kind }));
  if (!r.w || !r.h) {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = r.url; });
    r.w = img.naturalWidth; r.h = img.naturalHeight;
  }
  return r;
}
