import { runToolTest, assert, expectDownload, FIXTURES, OUT_DIR } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

// ---------------------------------------------------------------- fixtures
// Pixels are drawn with a canvas in the page (a convenient encoder); the EXIF block (big-endian
// TIFF with orientation 6 + GPS) is hand-crafted here and spliced into the JPEG as an APP1 segment.
const DIR = path.join(FIXTURES, 'image-studio');
fs.mkdirSync(DIR, { recursive: true });
const F = {
  large: path.join(DIR, 'large.png'),
  gps: path.join(DIR, 'photo-gps.jpg'),
  alpha: path.join(DIR, 'transparent.png'),
  svg: path.join(DIR, 'vector.svg'),
  dupPng: path.join(DIR, 'photo.png'),
  dupJpg: path.join(DIR, 'photo.jpg'),
  txt: path.join(DIR, 'notes.txt'),
  fake: path.join(DIR, 'fake.png'),
  broken: path.join(DIR, 'broken.png'),
};

const ascii = (s) => Buffer.from(`${s}\0`, 'latin1');
const short = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const long = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const rationals = (pairs) => Buffer.concat(pairs.map(([n, d]) => Buffer.concat([long(n), long(d)])));
const E = {
  ascii: (tag, s) => ({ tag, type: 2, count: s.length + 1, data: ascii(s) }),
  short: (tag, v) => ({ tag, type: 3, count: 1, data: short(v) }),
  long: (tag, v) => ({ tag, type: 4, count: 1, data: long(v) }),
  rat: (tag, pairs) => ({ tag, type: 5, count: pairs.length, data: rationals(pairs) }),
};
function ifdSize(entries) {
  return 2 + entries.length * 12 + 4 + entries.reduce((s, e) => s + (e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
}
function ifd(entries, start) {
  entries = [...entries].sort((a, b) => a.tag - b.tag);
  const head = Buffer.alloc(2 + entries.length * 12 + 4);
  head.writeUInt16BE(entries.length, 0);
  let off = start + head.length;
  const data = [];
  entries.forEach((e, i) => {
    const p = 2 + i * 12;
    head.writeUInt16BE(e.tag, p);
    head.writeUInt16BE(e.type, p + 2);
    head.writeUInt32BE(e.count, p + 4);
    if (e.data.length <= 4) e.data.copy(head, p + 8);
    else {
      head.writeUInt32BE(off, p + 8);
      data.push(e.data);
      if (e.data.length & 1) data.push(Buffer.alloc(1));
      off += e.data.length + (e.data.length & 1);
    }
  });
  return Buffer.concat([head, ...data]);
}
function exifApp1() {
  const exif = [E.ascii(0x9003, '2023:07:21 09:15:42')];
  const gps = [
    E.ascii(1, 'N'), E.rat(2, [[51, 1], [30, 1], [2640, 100]]),
    E.ascii(3, 'W'), E.rat(4, [[0, 1], [7, 1], [3960, 100]]),
  ];
  const ifd0 = (oExif, oGps) => [
    E.ascii(0x010f, 'TestCam'), E.ascii(0x0110, 'Fixture 6'), E.short(0x0112, 6),
    E.ascii(0x0132, '2023:07:21 09:15:42'), E.long(0x8769, oExif), E.long(0x8825, oGps),
  ];
  const o0 = 8;
  const oExif = o0 + ifdSize(ifd0(0, 0));
  const oGps = oExif + ifdSize(exif);
  const tiff = Buffer.concat([Buffer.from('MM\0\x2a', 'latin1'), long(o0), ifd(ifd0(oExif, oGps), o0), ifd(exif, oExif), ifd(gps, oGps)]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), short(payload.length + 2), payload]);
}
function withExif(jpeg) {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, at), exifApp1(), jpeg.subarray(at)]);
}

async function makeFixtures(page) {
  const r = await page.evaluate(async () => {
    const enc = async (c, type, q) => {
      const blob = await new Promise((res) => c.toBlob(res, type, q));
      const u = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
    // Large PNG: gradient + noise (photo-like, so lossy formats shrink it a lot)
    const [L, l] = canvas(2400, 1600);
    const g = l.createLinearGradient(0, 0, 2400, 1600);
    g.addColorStop(0, '#0f766e'); g.addColorStop(0.5, '#f59e0b'); g.addColorStop(1, '#7c3aed');
    l.fillStyle = g; l.fillRect(0, 0, 2400, 1600);
    const id = l.getImageData(0, 0, 2400, 1600);
    let seed = 7;
    for (let i = 0; i < id.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = (seed % 24) - 12;
      id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
    }
    l.putImageData(id, 0, 0);
    // JPEG 600×400: left half red, right half blue (orientation 6 turns left into top)
    const [J, j] = canvas(600, 400);
    j.fillStyle = '#ff0000'; j.fillRect(0, 0, 300, 400);
    j.fillStyle = '#0000ff'; j.fillRect(300, 0, 300, 400);
    // Transparent PNG 300×200 with an opaque green square in the middle
    const [T, t] = canvas(300, 200);
    t.fillStyle = '#00ff00'; t.fillRect(100, 50, 100, 100);
    // Small images for the duplicate-name check
    const [D, d] = canvas(320, 240);
    d.fillStyle = '#334155'; d.fillRect(0, 0, 320, 240); d.fillStyle = '#facc15'; d.fillRect(40, 40, 100, 100);
    return {
      large: await enc(L, 'image/png'), gps: await enc(J, 'image/jpeg', 0.92), alpha: await enc(T, 'image/png'),
      dupPng: await enc(D, 'image/png'), dupJpg: await enc(D, 'image/jpeg', 0.9),
    };
  });
  fs.writeFileSync(F.large, Buffer.from(r.large, 'base64'));
  fs.writeFileSync(F.gps, withExif(Buffer.from(r.gps, 'base64')));
  fs.writeFileSync(F.alpha, Buffer.from(r.alpha, 'base64'));
  fs.writeFileSync(F.dupPng, Buffer.from(r.dupPng, 'base64'));
  fs.writeFileSync(F.dupJpg, Buffer.from(r.dupJpg, 'base64'));
  fs.writeFileSync(F.svg, '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#2563eb"/><circle cx="60" cy="40" r="25" fill="#fde047"/></svg>\n');
  fs.writeFileSync(F.txt, 'Shopping list\n- milk\n- eggs\n');
  fs.writeFileSync(F.fake, 'This is not really a PNG file, just text with a misleading name.\n');
  const png = fs.readFileSync(F.dupPng);
  fs.writeFileSync(F.broken, Buffer.concat([png.subarray(0, 60), Buffer.alloc(400, 0x5a)]));
}

// ---------------------------------------------------------------- inspection helpers
function magic(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /avi[fs]/.test(buf.toString('latin1', 8, 12))) return 'avif';
  return '?';
}
/** JPEG marker list up to the start of scan. */
function jpegMarkers(buf) {
  const out = [];
  let p = 2;
  while (p + 4 <= buf.length && buf[p] === 0xff) {
    const m = buf[p + 1];
    out.push(m);
    if (m === 0xda) break;
    p += 2 + buf.readUInt16BE(p + 2);
  }
  return out;
}
function assertNoMetadata(buf, label) {
  assert.ok(!buf.includes(Buffer.from('Exif\0\0', 'latin1')), `${label}: no Exif block`);
  assert.ok(!buf.includes(Buffer.from('TestCam', 'latin1')), `${label}: camera make is gone`);
  if (magic(buf) === 'jpeg') assert.ok(!jpegMarkers(buf).includes(0xe1), `${label}: no APP1 segment`);
  if (magic(buf) === 'png') assert.ok(!buf.includes(Buffer.from('eXIf', 'latin1')), `${label}: no eXIf chunk`);
  if (magic(buf) === 'webp') assert.ok(!buf.includes(Buffer.from('EXIF', 'latin1')), `${label}: no EXIF chunk`);
}
/** Decode a file in the page; returns its size and RGBA samples at fractional points. */
async function decode(page, file, pts = []) {
  const b64 = (Buffer.isBuffer(file) ? file : fs.readFileSync(file)).toString('base64');
  return page.evaluate(async ({ b64, pts }) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const px = pts.map(([fx, fy]) => Array.from(g.getImageData(Math.floor(fx * (bmp.width - 1)), Math.floor(fy * (bmp.height - 1)), 1, 1).data));
    return { w: bmp.width, h: bmp.height, px };
  }, { b64, pts });
}
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ---------------------------------------------------------------- UI helpers
const fileInput = '#is-drop input[type=file]';
const item = (page, name) => page.locator(`.is-item:has(.is-name[title="${name}"])`);
const data = (page, name) => item(page, name).evaluate((el) => ({ ...el.dataset }));
async function settle(page) {
  await page.waitForTimeout(450); // longer than the settings debounce
  await page.waitForFunction(
    () => ![...document.querySelectorAll('.is-item')].some((e) => ['queued', 'working', 'reading'].includes(e.dataset.status)),
    null, { timeout: 90000 },
  );
}
const setRange = (page, sel, v) => page.$eval(sel, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const fmt = (page, f) => page.click(`#is-settings [data-fmt="${f}"]`);
const download = (page, name) => expectDownload(page, () => item(page, name).locator('[data-act="download"]').click());
const noOverflow = async (page, msg) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w, `${msg}: horizontal overflow ${o.sw} > ${o.w}`);
};
const dims = async (page, name) => { const d = await data(page, name); return [+d.outW, +d.outH]; };

// ================================================================ desktop: main flow
await runToolTest('image-studio', async ({ page, shot }) => {
  assert.match(await page.textContent('#is-privacy'), /never leave this device/);
  assert.ok(await page.isVisible('#is-sample'), 'sample button visible');
  assert.ok(await page.isVisible('#is-drop'), 'dropzone visible');
  await shot('empty');
  await makeFixtures(page);

  // ---- Sample images generated in the browser
  await page.click('#is-sample');
  await page.waitForFunction(() => document.querySelectorAll('.is-item').length === 4);
  await settle(page);
  assert.equal(await page.locator('.is-item[data-status="done"]').count(), 4, 'all samples processed');
  assert.ok(await page.isVisible('#is-gps-alert'), 'sample JPEG triggers the GPS alert');
  assert.match(await page.textContent('#is-totals'), /Saved/);
  await shot('samples');
  await page.click('#is-clear');
  assert.equal(await page.locator('.is-item').count(), 0);
  assert.ok(await page.isVisible('#is-sample'), 'empty state is back');

  // ---- EXIF: GPS warning, orientation 6 applied, metadata stripped
  await page.setInputFiles(fileInput, [F.gps]);
  await settle(page);
  const gpsItem = item(page, 'photo-gps.jpg');
  assert.match(await gpsItem.locator('.is-chip-gps').textContent(), /Contains GPS location/);
  assert.match(await page.textContent('#is-gps-alert'), /1 image contains GPS location/);
  await gpsItem.locator('.is-meta summary').click();
  const metaText = await gpsItem.locator('.is-meta').textContent();
  assert.match(metaText, /TestCam Fixture 6/);
  assert.match(metaText, /2023-07-21 09:15:42/);
  assert.match(metaText, /51\.50733° N, 0\.12767° W/, 'GPS coordinates decoded');
  assert.match(metaText, /All removed/);
  let d = await data(page, 'photo-gps.jpg');
  assert.deepEqual([+d.srcW, +d.srcH, +d.outW, +d.outH], [400, 600, 400, 600], 'orientation 6 swaps the dimensions');
  let dl = await download(page, 'photo-gps.jpg');
  assert.equal(dl.filename, 'photo-gps.webp');
  let buf = fs.readFileSync(dl.path);
  assert.equal(magic(buf), 'webp');
  assertNoMetadata(buf, 'webp from EXIF jpeg');
  let dec = await decode(page, dl.path, [[0.5, 0.1], [0.5, 0.9]]);
  assert.deepEqual([dec.w, dec.h], [400, 600]);
  assert.ok(near(dec.px[0], [255, 0, 0, 255]), `top is red after rotation (${dec.px[0]})`);
  assert.ok(near(dec.px[1], [0, 0, 255, 255]), `bottom is blue after rotation (${dec.px[1]})`);
  await fmt(page, 'jpeg');
  await settle(page);
  dl = await download(page, 'photo-gps.jpg');
  buf = fs.readFileSync(dl.path);
  assert.equal(magic(buf), 'jpeg');
  assertNoMetadata(buf, 'jpeg from EXIF jpeg');
  dec = await decode(page, dl.path);
  assert.deepEqual([dec.w, dec.h], [400, 600], 'JPEG output keeps the applied orientation');
  await shot('gps-warning');
  await page.click('#is-clear');

  // ---- Conversion to each format (large PNG)
  await page.setInputFiles(fileInput, [F.large]);
  await settle(page);
  const formats = await page.$$eval('#is-settings [data-fmt]', (els) => els.map((e) => e.dataset.fmt));
  assert.deepEqual(formats.slice(0, 4), ['keep', 'jpeg', 'png', 'webp']);
  const canAvif = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const b = await new Promise((r) => c.toBlob(r, 'image/avif'));
    return b?.type === 'image/avif';
  });
  assert.equal(formats.includes('avif'), canAvif, 'AVIF is offered exactly when canvas can encode it');
  for (const f of ['jpeg', 'png', 'webp', ...(canAvif ? ['avif'] : []), 'keep']) {
    await fmt(page, f);
    await settle(page);
    dl = await download(page, 'large.png');
    buf = fs.readFileSync(dl.path);
    const expect = f === 'keep' ? 'png' : f;
    assert.equal(magic(buf), expect, `${f}: magic bytes`);
    assert.equal(dl.filename, `large.${{ jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' }[expect]}`);
    assert.equal(dl.size, +(await data(page, 'large.png')).outSize, `${f}: shown size matches the file`);
    dec = await decode(page, dl.path);
    assert.deepEqual([dec.w, dec.h], [2400, 1600], `${f}: decoded dimensions`);
  }
  await fmt(page, 'webp');
  await settle(page);
  assert.match(await item(page, 'large.png').locator('.is-save-pct').textContent(), /^−\d+%$/);

  // ---- Resize math for each mode
  await page.selectOption('#is-g-rmode', 'fit');
  await page.fill('#is-g-fw', '800');
  await page.fill('#is-g-fh', '800');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [800, 533], 'fit 800×800');
  await page.fill('#is-g-fh', '');
  await page.fill('#is-g-fw', '1000');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [1000, 667], 'fit width only');
  await page.fill('#is-g-fw', '4000');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [2400, 1600], 'fit never enlarges');
  await page.selectOption('#is-g-rmode', 'percent');
  await setRange(page, '#is-g-pct', 25);
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [600, 400], 'percent 25');
  dl = await download(page, 'large.png');
  dec = await decode(page, dl.path);
  assert.deepEqual([dec.w, dec.h], [600, 400], 'resized file has the new size');
  await page.selectOption('#is-g-rmode', 'exact');
  assert.ok(await page.isChecked('#is-settings [data-r="lock"]'), 'aspect lock on by default');
  await page.fill('#is-g-ew', '1200');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [1200, 800], 'exact width, aspect locked');
  await page.fill('#is-g-eh', '400');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [600, 400], 'exact height, aspect locked');
  await page.uncheck('#is-settings [data-r="lock"]');
  await page.fill('#is-g-ew', '500');
  await page.fill('#is-g-eh', '300');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [500, 300], 'exact, unlocked (stretched)');
  await page.check('#is-settings [data-r="lock"]');
  await page.selectOption('#is-g-rmode', 'none');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [2400, 1600]);

  // ---- Target file size (binary search on quality, then on scale)
  await fmt(page, 'jpeg');
  await page.check('#is-g-ten');
  await page.fill('#is-settings [data-r="tval"]', '150');
  await settle(page);
  d = await data(page, 'large.png');
  assert.ok(+d.outSize <= 150 * 1024, `JPEG under 150 KB (${d.outSize})`);
  assert.match(await item(page, 'large.png').locator('.is-status').textContent(), /fits the 150 KB target/);
  dl = await download(page, 'large.png');
  assert.ok(dl.size <= 150 * 1024 && magic(fs.readFileSync(dl.path)) === 'jpeg', 'downloaded JPEG is under the target');
  await fmt(page, 'png');
  await page.fill('#is-settings [data-r="tval"]', '300');
  await settle(page);
  d = await data(page, 'large.png');
  assert.ok(+d.outSize <= 300 * 1024, `PNG under 300 KB by scaling (${d.outSize})`);
  assert.ok(+d.outW < 2400, 'lossless target shrinks the dimensions');
  dl = await download(page, 'large.png');
  buf = fs.readFileSync(dl.path);
  assert.ok(dl.size <= 300 * 1024 && magic(buf) === 'png');
  dec = await decode(page, dl.path);
  assert.deepEqual([dec.w, dec.h], [+d.outW, +d.outH]);
  assert.ok(Math.abs(dec.w / dec.h - 1.5) < 0.01, 'aspect ratio kept while scaling');
  await page.uncheck('#is-g-ten');
  await fmt(page, 'webp');
  await settle(page);
  await page.click('#is-clear');

  // ---- Transparent PNG → JPEG uses the background color; WebP keeps alpha
  await page.setInputFiles(fileInput, [F.alpha]);
  await settle(page);
  dl = await download(page, 'transparent.png');
  dec = await decode(page, dl.path, [[0, 0], [0.5, 0.5]]);
  assert.equal(dec.px[0][3], 0, 'WebP keeps transparency');
  await page.click('#is-settings .is-more summary');
  await page.fill('#is-settings [data-r="bghex"]', '#ff0000');
  await fmt(page, 'jpeg');
  await settle(page);
  assert.match(await item(page, 'transparent.png').locator('.is-note').textContent(), /filled with #ff0000/);
  dl = await download(page, 'transparent.png');
  dec = await decode(page, dl.path, [[0.02, 0.02], [0.5, 0.5]]);
  assert.equal(magic(fs.readFileSync(dl.path)), 'jpeg');
  assert.ok(near(dec.px[0], [255, 0, 0, 255], 12), `corner is the background color (${dec.px[0]})`);
  assert.ok(near(dec.px[1], [0, 255, 0, 255], 20), `square stays green (${dec.px[1]})`);
  await page.click('#is-settings [data-bg="#ffffff"]');
  await fmt(page, 'webp');
  await page.click('#is-clear');

  // ---- SVG rasterization scale
  await page.setInputFiles(fileInput, [F.svg]);
  await settle(page);
  assert.deepEqual(await dims(page, 'vector.svg'), [240, 160], 'SVG at 2×');
  await page.selectOption('#is-g-svg', '3');
  await settle(page);
  assert.deepEqual(await dims(page, 'vector.svg'), [360, 240], 'SVG at 3×');
  dl = await download(page, 'vector.svg');
  dec = await decode(page, dl.path, [[0.5, 0.5], [0.05, 0.05]]);
  assert.deepEqual([dec.w, dec.h], [360, 240]);
  assert.ok(near(dec.px[0], [253, 224, 71, 255]) && near(dec.px[1], [37, 99, 235, 255]), 'SVG content rendered');
  assert.match(await item(page, 'vector.svg').locator('.is-suggest').textContent(), /vector/, 'SVG growth is explained');
  await page.selectOption('#is-g-svg', '2');
  await page.click('#is-clear');

  // ---- Bad files show clear errors
  await page.setInputFiles(fileInput, [F.txt, F.fake, F.broken]);
  await settle(page);
  assert.equal(await page.locator('.is-item[data-status="error"]').count(), 3);
  assert.match(await item(page, 'notes.txt').locator('[role=alert]').textContent(), /text file, not an image/);
  assert.match(await item(page, 'fake.png').locator('[role=alert]').textContent(), /text file despite its \.png name/);
  assert.match(await item(page, 'broken.png').locator('[role=alert]').textContent(), /could not be decoded/i);
  assert.ok(await item(page, 'broken.png').locator('[data-act="download"]').isDisabled(), 'no download for failed items');
  assert.match(await page.textContent('#is-count'), /3 images · 3 failed/);
  await shot('errors');
  await page.click('#is-clear');

  // ---- Per-image override + ZIP with de-duplicated names
  await page.setInputFiles(fileInput, [F.dupPng, F.dupJpg, F.gps]);
  await settle(page);
  await item(page, 'photo-gps.jpg').locator('[data-act="settings"]').click();
  assert.ok(await page.isVisible('#is-item-dlg'));
  await page.click('#is-item-form [data-fmt="png"]');
  await page.click('#is-item-apply');
  await settle(page);
  assert.equal((await data(page, 'photo-gps.jpg')).outFormat, 'png', 'override applies to one image');
  assert.equal((await data(page, 'photo.png')).outFormat, 'webp', 'other images keep the global settings');
  assert.ok(await item(page, 'photo-gps.jpg').locator('.is-chip', { hasText: 'Custom settings' }).isVisible());
  assert.ok(await item(page, 'photo-gps.jpg').locator('.is-save.is-worse').isVisible(), 'bigger output is flagged');
  assert.match(await item(page, 'photo-gps.jpg').locator('.is-suggest').textContent(), /JPEG or WebP/);
  await shot('override-larger');
  dl = await download(page, 'photo.jpg');
  assert.equal(dl.filename, 'photo-2.webp', 'single download uses the de-duplicated name');
  dl = await expectDownload(page, () => page.click('#is-zip'));
  assert.equal(dl.filename, 'images.zip');
  const zip = unzipSync(fs.readFileSync(dl.path));
  assert.deepEqual(Object.keys(zip).sort(), ['photo-2.webp', 'photo-gps.png', 'photo.webp']);
  for (const [name, bytes] of Object.entries(zip)) {
    const b = Buffer.from(bytes);
    assert.equal(magic(b), name.split('.').pop(), `${name} in ZIP has the right format`);
    assertNoMetadata(b, `${name} in ZIP`);
    dec = await decode(page, b);
    assert.deepEqual([dec.w, dec.h], name === 'photo-gps.png' ? [400, 600] : [320, 240], `${name} dimensions`);
  }
  // Back to global
  await item(page, 'photo-gps.jpg').locator('[data-act="settings"]').click();
  await page.click('#is-item-reset');
  await settle(page);
  assert.equal((await data(page, 'photo-gps.jpg')).outFormat, 'webp');
  // Totals
  const saved = +(await page.getAttribute('#is-saved', 'data-saved'));
  const expected = await page.$$eval('.is-item', (els) => els.reduce((s, e) => s + +e.dataset.srcSize - +e.dataset.outSize, 0));
  assert.equal(saved, expected, 'total saved = sum of per-image savings');
  assert.match(await page.textContent('#is-totals'), /3 converted/);
  await page.click('#is-clear');

  // ---- Before/after viewer
  await page.setInputFiles(fileInput, [F.large]);
  await settle(page);
  await item(page, 'large.png').locator('[data-act="compare"]').click();
  await page.waitForSelector('#is-cmp[open]');
  const divider = page.locator('#is-cmp-divider');
  assert.equal(await divider.getAttribute('aria-valuenow'), '50');
  const clip0 = await page.$eval('.is-cmp-after', (e) => e.style.clipPath);
  await divider.focus();
  for (let k = 0; k < 5; k++) await page.keyboard.press('ArrowRight');
  assert.equal(await divider.getAttribute('aria-valuenow'), '60', 'keyboard moves the divider');
  const box = await page.locator('#is-cmp-stage').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  assert.equal(await divider.getAttribute('aria-valuenow'), '25', 'mouse drag moves the divider');
  assert.notEqual(await page.$eval('.is-cmp-after', (e) => e.style.clipPath), clip0, 'clip follows the divider');
  const z0 = await page.textContent('[data-cmp="zoom"]');
  await page.click('[data-cmp="in"]');
  assert.notEqual(await page.textContent('[data-cmp="zoom"]'), z0, 'zoom in');
  await page.click('[data-cmp="actual"]');
  assert.equal(await page.textContent('[data-cmp="zoom"]'), '100%');
  await page.click('[data-cmp="fit"]');
  await shot('compare');
  await page.keyboard.press('Escape');
  assert.ok(!(await page.isVisible('#is-cmp')), 'Esc closes the viewer');

  // ---- Crop / rotate / flip
  await item(page, 'large.png').locator('[data-act="crop"]').click();
  await page.waitForSelector('#is-crop[open]');
  await page.click('[data-crop="rotr"]');
  assert.match(await page.textContent('[data-crop="info"]'), /1600 × 2400 px · rotated 90°/);
  await shot('crop');
  await page.click('[data-crop="apply"]');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [1600, 2400], 'rotation swaps the output');
  assert.ok(await item(page, 'large.png').locator('.is-chip', { hasText: 'Rotated 90°' }).isVisible());
  await item(page, 'large.png').locator('[data-act="crop"]').click();
  await page.selectOption('[data-crop="aspect"]', '1:1');
  await page.click('[data-crop="fliph"]');
  await page.click('[data-crop="apply"]');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [1600, 1600], '1:1 crop');
  dl = await download(page, 'large.png');
  dec = await decode(page, dl.path);
  assert.deepEqual([dec.w, dec.h], [1600, 1600]);
  // Free crop by dragging a box on the canvas
  await item(page, 'large.png').locator('[data-act="crop"]').click();
  await page.click('[data-crop="reset"]');
  const c0 = await page.locator('#is-crop canvas').boundingBox();
  const cv = { x: c0.x + 10, y: c0.y + 10, width: c0.width - 20, height: c0.height - 20 }; // image inside the handle margin
  await page.mouse.move(cv.x + cv.width * 0.1, cv.y + cv.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(cv.x + cv.width * 0.6, cv.y + cv.height * 0.7, { steps: 8 });
  await page.mouse.up();
  await page.click('[data-crop="apply"]');
  await settle(page);
  const [cw, ch] = await dims(page, 'large.png');
  assert.ok(Math.abs(cw - 1200) < 40 && Math.abs(ch - 800) < 40, `dragged crop ≈ 1200×800 (${cw}×${ch})`);
  // Cancel leaves the edit alone; reset removes it
  await item(page, 'large.png').locator('[data-act="crop"]').click();
  await page.click('[data-crop="rotl"]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(450);
  assert.deepEqual(await dims(page, 'large.png'), [cw, ch], 'cancel keeps the previous edit');
  await item(page, 'large.png').locator('[data-act="crop"]').click();
  await page.click('[data-crop="reset"]');
  await page.click('[data-crop="apply"]');
  await settle(page);
  assert.deepEqual(await dims(page, 'large.png'), [2400, 1600], 'reset removes the edit');

  // ---- Paste an image with Ctrl+V
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 50; c.height = 40;
    c.getContext('2d').fillRect(0, 0, 50, 40);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await settle(page);
  assert.deepEqual(await dims(page, 'pasted-image-1.png'), [50, 40], 'pasted image processed');
  await item(page, 'pasted-image-1.png').locator('[data-act="remove"]').click();
  assert.equal(await page.locator('.is-item').count(), 1, 'remove one image');
});

// ================================================================ phone
await runToolTest('image-studio', async ({ page, shot }) => {
  await noOverflow(page, 'empty');
  await shot('mobile-empty');
  await page.click('#is-sample');
  await page.waitForFunction(() => document.querySelectorAll('.is-item').length === 4);
  await settle(page);
  await noOverflow(page, 'with images');
  assert.ok(!(await page.locator('#is-settings-panel').evaluate((e) => e.open)), 'settings start collapsed on a phone');
  await page.click('#is-settings-panel summary');
  await fmt(page, 'jpeg');
  await settle(page);
  assert.equal(await page.locator('.is-item[data-out-format="jpeg"]').count(), 4, 'main flow works on a phone');
  await noOverflow(page, 'settings open');
  await shot('mobile-list');
  await item(page, 'city-street.jpg').locator('[data-act="compare"]').click();
  await page.waitForSelector('#is-cmp[open]');
  const box = await page.locator('#is-cmp-stage').boundingBox();
  assert.ok(box.width <= 390, 'viewer fits the screen');
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
  assert.equal(await page.getAttribute('#is-cmp-divider', 'aria-valuenow'), '80', 'tap moves the divider');
  await shot('mobile-compare');
  await page.screenshot({ path: path.join(OUT_DIR, 'image-studio-mobile-compare-viewport.png') });
  await page.keyboard.press('Escape');
  await item(page, 'city-street.jpg').locator('[data-act="crop"]').click();
  await page.waitForSelector('#is-crop[open]');
  await shot('mobile-crop');
  await page.screenshot({ path: path.join(OUT_DIR, 'image-studio-mobile-crop-viewport.png') });
  await page.click('#is-crop .is-dlg-foot [data-crop="cancel"]');
  const z = await expectDownload(page, () => page.click('#is-zip'));
  assert.equal(Object.keys(unzipSync(fs.readFileSync(z.path))).length, 4, 'ZIP works on a phone');
  await noOverflow(page, 'end');
}, { viewport: { width: 390, height: 844 } });

// ================================================================ dark theme
await runToolTest('image-studio', async ({ page, shot }) => {
  await shot('dark-empty');
  await page.click('#is-sample');
  await page.waitForFunction(() => document.querySelectorAll('.is-item').length === 4);
  await settle(page);
  await item(page, 'city-street.jpg').locator('.is-meta summary').click();
  await shot('dark-list');
  await item(page, 'logo-transparent.png').locator('[data-act="compare"]').click();
  await page.waitForSelector('#is-cmp[open]');
  await shot('dark-compare');
}, { colorScheme: 'dark' });
