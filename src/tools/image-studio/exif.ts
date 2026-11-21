// Minimal, defensive metadata reader: finds EXIF (JPEG APP1, PNG eXIf, WebP EXIF), XMP, ICC and
// comments, and decodes the handful of EXIF tags that matter for privacy. No dependencies.

export interface ImageMeta {
  hasExif: boolean;
  make?: string;
  model?: string;
  lens?: string;
  software?: string;
  artist?: string;
  copyright?: string;
  serial?: string;
  dateTime?: string;
  orientation?: number;
  exposure?: string;
  fNumber?: string;
  iso?: number;
  focalLength?: string;
  hasGps: boolean;
  gps?: { lat?: number; lon?: number; alt?: number };
  hasXmp: boolean;
  hasIcc: boolean;
  hasComment: boolean;
  hasText: boolean;
}

const empty = (): ImageMeta => ({ hasExif: false, hasGps: false, hasXmp: false, hasIcc: false, hasComment: false, hasText: false });

const ascii = (b: Uint8Array, start: number, len: number) => {
  let s = '';
  for (let i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

export function parseMeta(buf: ArrayBuffer): ImageMeta {
  const meta = empty();
  const b = new Uint8Array(buf);
  try {
    if (b[0] === 0xff && b[1] === 0xd8) parseJpeg(b, meta);
    else if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') parsePng(b, meta);
    else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') parseWebp(b, meta);
  } catch {
    /* corrupt metadata: report what we found so far */
  }
  return meta;
}

function parseJpeg(b: Uint8Array, meta: ImageMeta) {
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const len = (b[p + 2] << 8) | b[p + 3];
    const start = p + 4;
    if (marker === 0xe1) {
      if (ascii(b, start, 6) === 'Exif\0\0') parseTiff(b, start + 6, meta);
      else if (ascii(b, start, 28).startsWith('http://ns.adobe.com/xap/1.0/')) meta.hasXmp = true;
    } else if (marker === 0xe2 && ascii(b, start, 11) === 'ICC_PROFILE') meta.hasIcc = true;
    else if (marker === 0xfe) meta.hasComment = true;
    p = start + len - 2;
  }
}

function parsePng(b: Uint8Array, meta: ImageMeta) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p);
    const type = ascii(b, p + 4, 4);
    const start = p + 8;
    if (type === 'eXIf') parseTiff(b, start, meta);
    else if (type === 'iCCP') meta.hasIcc = true;
    else if (type === 'iTXt' && ascii(b, start, 17) === 'XML:com.adobe.xmp') meta.hasXmp = true;
    else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      meta.hasText = true;
      // Some tools store raw EXIF as a hex "Raw profile type exif" text chunk.
      if (ascii(b, start, 25).startsWith('Raw profile type exif')) meta.hasExif = true;
    } else if (type === 'IEND') break;
    p = start + len + 4;
  }
}

function parseWebp(b: Uint8Array, meta: ImageMeta) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12;
  while (p + 8 <= b.length) {
    const type = ascii(b, p, 4);
    const len = dv.getUint32(p + 4, true);
    const start = p + 8;
    if (type === 'EXIF') parseTiff(b, ascii(b, start, 6) === 'Exif\0\0' ? start + 6 : start, meta);
    else if (type === 'XMP ') meta.hasXmp = true;
    else if (type === 'ICCP') meta.hasIcc = true;
    p = start + len + (len & 1);
  }
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function parseTiff(b: Uint8Array, base: number, meta: ImageMeta) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const order = ascii(b, base, 2);
  if (order !== 'II' && order !== 'MM') return;
  const le = order === 'II';
  const u16 = (o: number) => dv.getUint16(base + o, le);
  const u32 = (o: number) => dv.getUint32(base + o, le);
  if (u16(2) !== 42) return;
  meta.hasExif = true;

  type Entry = { tag: number; type: number; count: number; off: number };
  const readIfd = (off: number): Entry[] => {
    if (!off || base + off + 2 > b.length) return [];
    const n = u16(off);
    const out: Entry[] = [];
    for (let i = 0; i < n && i < 512; i++) {
      const e = off + 2 + i * 12;
      if (base + e + 12 > b.length) break;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      out.push({ tag: u16(e), type, count, off: size <= 4 ? e + 8 : u32(e + 8) });
    }
    return out;
  };
  const str = (e: Entry) => {
    if (base + e.off + e.count > b.length) return undefined;
    return ascii(b, base + e.off, e.count).replace(/\0+$/, '').trim() || undefined;
  };
  const num = (e: Entry, i = 0): number => {
    const o = e.off + i * (TYPE_SIZE[e.type] ?? 1);
    switch (e.type) {
      case 1: case 7: return b[base + o];
      case 3: return u16(o);
      case 4: return u32(o);
      case 9: return dv.getInt32(base + o, le);
      case 5: { const d = u32(o + 4); return d ? u32(o) / d : 0; }
      case 10: { const d = dv.getInt32(base + o + 4, le); return d ? dv.getInt32(base + o, le) / d : 0; }
      default: return NaN;
    }
  };

  const ifd0 = readIfd(u32(4));
  let exifOff = 0, gpsOff = 0;
  for (const e of ifd0) {
    switch (e.tag) {
      case 0x010f: meta.make = str(e); break;
      case 0x0110: meta.model = str(e); break;
      case 0x0112: meta.orientation = num(e); break;
      case 0x0131: meta.software = str(e); break;
      case 0x0132: meta.dateTime ??= str(e); break;
      case 0x013b: meta.artist = str(e); break;
      case 0x8298: meta.copyright = str(e); break;
      case 0x8769: exifOff = num(e); break;
      case 0x8825: gpsOff = num(e); break;
    }
  }
  for (const e of readIfd(exifOff)) {
    switch (e.tag) {
      case 0x9003: meta.dateTime = str(e) ?? meta.dateTime; break;
      case 0xa434: meta.lens = str(e); break;
      case 0xa431: meta.serial = str(e); break;
      case 0x829a: { const v = num(e); if (v > 0) meta.exposure = v < 1 ? `1/${Math.round(1 / v)} s` : `${+v.toFixed(1)} s`; break; }
      case 0x829d: { const v = num(e); if (v > 0) meta.fNumber = `f/${+v.toFixed(1)}`; break; }
      case 0x8827: meta.iso = num(e); break;
      case 0x920a: { const v = num(e); if (v > 0) meta.focalLength = `${+v.toFixed(1)} mm`; break; }
    }
  }
  if (gpsOff) {
    const gps = readIfd(gpsOff);
    if (gps.length) {
      const get = (t: number) => gps.find((e) => e.tag === t);
      const dms = (e?: Entry) => (e && e.count >= 3 ? num(e, 0) + num(e, 1) / 60 + num(e, 2) / 3600 : undefined);
      const latRef = get(1), lonRef = get(3), altRef = get(5), alt = get(6);
      let lat = dms(get(2));
      let lon = dms(get(4));
      if (lat !== undefined && latRef && str(latRef)?.startsWith('S')) lat = -lat;
      if (lon !== undefined && lonRef && str(lonRef)?.startsWith('W')) lon = -lon;
      const g: ImageMeta['gps'] = {};
      if (lat !== undefined && Number.isFinite(lat)) g.lat = lat;
      if (lon !== undefined && Number.isFinite(lon)) g.lon = lon;
      if (alt) g.alt = num(alt) * (altRef && num(altRef) === 1 ? -1 : 1);
      // Any GPS entry (even timestamp-only) is location-related; flag it.
      meta.hasGps = true;
      meta.gps = g;
    }
  }
}

/** Short human-readable list of what metadata is present. */
export function metaSummary(m: ImageMeta): string[] {
  const out: string[] = [];
  if (m.hasGps) out.push('GPS location');
  if (m.make || m.model) out.push('camera');
  if (m.dateTime) out.push('date');
  if (m.serial) out.push('serial number');
  if (m.hasExif && !out.length) out.push('EXIF');
  if (m.hasXmp) out.push('XMP');
  if (m.hasIcc) out.push('color profile');
  if (m.hasComment || m.hasText) out.push('text');
  return out;
}

export function hasAnyMeta(m: ImageMeta | null | undefined): boolean {
  return !!m && (m.hasExif || m.hasXmp || m.hasIcc || m.hasComment || m.hasText);
}

export function formatCoord(v: number | undefined, pos: string, neg: string): string {
  if (v === undefined) return '?';
  return `${Math.abs(v).toFixed(5)}° ${v >= 0 ? pos : neg}`;
}
