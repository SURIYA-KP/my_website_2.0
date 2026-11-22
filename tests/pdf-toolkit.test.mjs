import { runToolTest, assert, expectDownload, FIXTURES } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, PDFName, PDFHexString, PDFRawStream, rgb } from 'pdf-lib';
import { unzipSync } from 'fflate';

// ---------------------------------------------------------------- fixtures (generated with pdf-lib in Node)
// Every page has a distinctive MediaBox width so page order can be checked in the output without
// text extraction: Doc A page n is 500+n pt wide, Doc B page n is 600+n, Big page n is 1000+n.
const DIR = path.join(FIXTURES, 'pdf-toolkit');
fs.mkdirSync(DIR, { recursive: true });

async function makeDoc(label, n, base, height) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle(`Fixture ${label}`);
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage([base + i, height]);
    page.drawRectangle({ x: 0, y: height - 60, width: base + i, height: 60, color: rgb(0.3, 0.3, 0.8) });
    page.drawText(`${label} - Page ${i}`, { x: 40, y: height - 120, size: 28, font });
    page.drawText(String(i), { x: 200, y: 260, size: 140, font });
  }
  return doc.save();
}

async function makeEncrypted() {
  // A real-looking Standard security handler (RC4, R2) in the trailer. pdf-lib cannot decrypt it.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 400]).drawText('Secret', { x: 50, y: 200, size: 30, font });
  const hex = (n, seed) => Array.from({ length: n }, (_, i) => ((i * 37 + seed) & 255).toString(16).padStart(2, '0')).join('');
  const enc = doc.context.obj({
    Filter: 'Standard', V: 1, R: 2, Length: 40, P: -44,
    O: PDFHexString.of(hex(32, 7)), U: PDFHexString.of(hex(32, 99)),
  });
  doc.context.trailerInfo.Encrypt = doc.context.register(enc);
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(hex(16, 3)), PDFHexString.of(hex(16, 3))]);
  return doc.save({ useObjectStreams: false });
}

const F = {
  a: path.join(DIR, 'doc-a.pdf'),
  b: path.join(DIR, 'doc-b.pdf'),
  big: path.join(DIR, 'big-150.pdf'),
  enc: path.join(DIR, 'encrypted.pdf'),
  random: path.join(DIR, 'random-bytes.pdf'),
  junk: path.join(DIR, 'truncated.pdf'),
  txt: path.join(DIR, 'notes.txt'),
  png: path.join(DIR, 'landscape.png'),
  jpg: path.join(DIR, 'portrait.jpg'),
};
fs.writeFileSync(F.a, await makeDoc('Doc A', 5, 500, 700));
fs.writeFileSync(F.b, await makeDoc('Doc B', 3, 600, 800));
fs.writeFileSync(F.big, await makeDoc('Big', 150, 1000, 1400));
fs.writeFileSync(F.enc, await makeEncrypted());
let seed = 12345;
fs.writeFileSync(F.random, Buffer.from(Array.from({ length: 4096 }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255)));
fs.writeFileSync(F.junk, Buffer.concat([Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R'), Buffer.alloc(300, 0x41)]));
fs.writeFileSync(F.txt, 'just some notes\n');

// ---------------------------------------------------------------- output inspection
const label = (w) => (w > 1000 ? `G${w - 1000}` : w > 600 ? `B${w - 600}` : w > 500 ? `A${w - 500}` : `?${w}`);
async function readPdf(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  const pages = doc.getPages().map((p) => {
    const { width, height } = p.getMediaBox();
    const xobjects = p.node.Resources()?.lookup(PDFName.of('XObject'));
    const image = !!xobjects && xobjects.keys().some((k) => {
      const x = xobjects.lookup(k);
      return x instanceof PDFRawStream && x.dict.get(PDFName.of('Subtype'))?.toString() === '/Image';
    });
    const blank = !p.node.Contents();
    return { w: Math.round(width * 100) / 100, h: Math.round(height * 100) / 100, rot: p.getRotation().angle, blank, image, id: blank ? 'blank' : image ? 'img' : label(Math.round(width)) };
  });
  return { doc, pages, ids: pages.map((p) => p.id), rots: pages.map((p) => p.rot) };
}

// ---------------------------------------------------------------- UI helpers
const fileInput = '#pt-drop input[type=file]';
const tiles = (page) => page.locator('#pt-grid .pt-tile');
const tile = (page, i) => tiles(page).nth(i);
/** Order of pages in the grid as Doc/page ids (A1, B2, blank, img). */
const gridOrder = (page) =>
  page.$$eval('#pt-grid .pt-tile', (els) =>
    els.map((el) => {
      const name = el.querySelector('.pt-name').textContent;
      const pg = el.querySelector('.pt-pg').textContent.replace('p. ', '');
      if (name === 'Blank page') return 'blank';
      if (pg === 'image') return 'img';
      return (name.includes('doc-a') ? 'A' : name.includes('doc-b') ? 'B' : 'G') + pg;
    }),
  );
const gridRots = (page) => page.$$eval('#pt-grid .pt-tile', (els) => els.map((el) => { const m = el.getAttribute('aria-label').match(/rotated (\d+)/); return m ? +m[1] : 0; }));
const center = async (loc) => {
  const b = await loc.locator('.pt-thumb').boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
};
const selectOnly = async (page, i) => {
  await page.click('#pt-sel-none');
  await tile(page, i).locator('.pt-thumb').click({ position: { x: 60, y: 70 } });
};
const ctrlClick = (page, i) => tile(page, i).locator('.pt-thumb').click({ position: { x: 60, y: 70 }, modifiers: ['Control'] });
const download = (page, sel) => expectDownload(page, () => page.click(sel));
const waitTiles = (page, n) => page.waitForFunction((n) => document.querySelectorAll('#pt-grid .pt-tile').length === n, n, { timeout: 20000 });
const noOverflow = async (page, msg) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w, `${msg}: horizontal overflow ${o.sw} > ${o.w}`);
};

/** Generate the PNG and JPEG fixtures with a canvas (the tool page is a convenient browser). */
async function makeImages(page) {
  if (fs.existsSync(F.png) && fs.existsSync(F.jpg)) return;
  const r = await page.evaluate(async () => {
    const make = async (w, h, type, text) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#0e7490'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#fde68a'; g.beginPath(); g.arc(w / 2, h / 2, Math.min(w, h) / 3, 0, 7); g.fill();
      g.fillStyle = '#111'; g.font = 'bold 40px sans-serif'; g.fillText(text, 20, 50);
      const blob = await new Promise((res) => c.toBlob(res, type, 0.9));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const b of buf) s += String.fromCharCode(b);
      return btoa(s);
    };
    return { png: await make(400, 300, 'image/png', 'PNG'), jpg: await make(300, 400, 'image/jpeg', 'JPG') };
  });
  fs.writeFileSync(F.png, Buffer.from(r.png, 'base64'));
  fs.writeFileSync(F.jpg, Buffer.from(r.jpg, 'base64'));
}

// ================================================================ main desktop flow
await runToolTest('pdf-toolkit', async ({ page, shot }) => {
  // Empty state
  assert.ok(await page.isVisible('#pt-drop'), 'dropzone visible');
  assert.ok(await page.isVisible('#pt-sample'), 'sample button visible');
  assert.match(await page.textContent('#pt-privacy'), /never leave this device/);
  await shot('empty');
  await makeImages(page);

  // ---- Sample PDF button builds a document in the browser
  await page.click('#pt-sample');
  await waitTiles(page, 9);
  assert.equal(await page.locator('#pt-files .pt-file').count(), 3, 'sample has 3 files');
  await page.waitForSelector('#pt-grid .pt-tile .pt-face img', { timeout: 15000 });
  await page.click('#pt-clear');
  await waitTiles(page, 0);
  assert.ok(await page.isVisible('#pt-sample'), 'empty state back after clearing');

  // ---- Merge two files
  await page.setInputFiles(fileInput, [F.a, F.b]);
  await waitTiles(page, 8);
  assert.deepEqual(await gridOrder(page), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3']);
  const files = await page.$$eval('#pt-files .pt-file', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  assert.equal(files.length, 2);
  assert.match(files[0], /doc-a\.pdf.*5 pages · [\d.]+ KB/);
  assert.match(files[1], /doc-b\.pdf.*3 pages · [\d.]+ KB/);
  // Distinct colours per source file
  const colors = await page.$$eval('#pt-grid .pt-tile .pt-dot', (els) => [...new Set(els.map((e) => getComputedStyle(e).backgroundColor))]);
  assert.equal(colors.length, 2, 'each source has its own colour');
  // Lazy thumbnails eventually render
  await page.waitForFunction(() => document.querySelectorAll('#pt-grid .pt-face img').length === 8, null, { timeout: 15000 });
  assert.equal(await page.inputValue('#pt-filename'), 'doc-a-merged');
  await shot('merged-grid');

  let dl = await download(page, '#pt-merge');
  assert.equal(dl.filename, 'doc-a-merged.pdf');
  let out = await readPdf(dl.path);
  assert.deepEqual(out.ids, ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3'], 'merge order');
  assert.ok(out.pages.every((p) => p.rot === 0));
  const shownSize = await page.getAttribute('#pt-result [data-size]', 'data-size');
  assert.equal(+shownSize, dl.size, 'result card shows the output size');
  assert.match(await page.textContent('#pt-result'), /8 pages · [\d.]+ KB/);

  // ---- Drag reorder with the mouse: A1 to just after A3
  {
    const from = await center(tile(page, 0));
    const to = await center(tile(page, 2));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 5, { steps: 4 });
    assert.ok(await page.isVisible('.pt-ghost'), 'drag ghost shown');
    await page.mouse.move(to.b.x + to.b.width - 8, to.y, { steps: 10 });
    assert.ok(await page.isVisible('#pt-indicator'), 'insertion indicator shown');
    await page.mouse.up();
  }
  assert.deepEqual(await gridOrder(page), ['A2', 'A3', 'A1', 'A4', 'A5', 'B1', 'B2', 'B3'], 'after mouse drag');
  // Drag a multi-selection (B1 + B2) to the very start
  await selectOnly(page, 5);
  await ctrlClick(page, 6);
  assert.match(await page.textContent('#pt-count'), /2 of 8 pages selected/);
  {
    const from = await center(tile(page, 6));
    const to = await center(tile(page, 0));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.b.x + 6, to.y, { steps: 12 });
    assert.equal(await page.textContent('.pt-ghost b'), '2', 'ghost shows the count');
    await page.mouse.up();
  }
  assert.deepEqual(await gridOrder(page), ['B1', 'B2', 'A2', 'A3', 'A1', 'A4', 'A5', 'B3'], 'after multi drag');

  // ---- Undo / redo (keyboard and buttons)
  await page.keyboard.press('Control+z');
  assert.deepEqual(await gridOrder(page), ['A2', 'A3', 'A1', 'A4', 'A5', 'B1', 'B2', 'B3'], 'undo');
  await page.click('#pt-undo');
  assert.deepEqual(await gridOrder(page), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3'], 'undo twice');
  assert.ok(await page.isEnabled('#pt-redo'), 'redo available');
  await page.keyboard.press('Control+Shift+z');
  assert.deepEqual(await gridOrder(page), ['A2', 'A3', 'A1', 'A4', 'A5', 'B1', 'B2', 'B3'], 'redo');
  await page.click('#pt-redo');
  assert.deepEqual(await gridOrder(page), ['B1', 'B2', 'A2', 'A3', 'A1', 'A4', 'A5', 'B3'], 'redo twice');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await gridOrder(page), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3']);

  // ---- Keyboard: focus moves with arrows, Alt+arrow moves the page
  await selectOnly(page, 0);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.querySelector('.pt-num')?.textContent), '2', 'arrow moves focus');
  await page.keyboard.press('Space');
  assert.match(await page.textContent('#pt-count'), /2 of 8 pages selected/, 'space adds to selection');
  await page.click('#pt-sel-none');
  await tile(page, 1).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowRight');
  assert.deepEqual(await gridOrder(page), ['A1', 'A3', 'A4', 'A2', 'A5', 'B1', 'B2', 'B3'], 'Alt+Right twice');
  assert.equal(await page.evaluate(() => document.activeElement.querySelector('.pt-num')?.textContent), '4', 'focus follows the moved page');
  await page.keyboard.press('Alt+ArrowLeft');
  assert.deepEqual(await gridOrder(page), ['A1', 'A3', 'A2', 'A4', 'A5', 'B1', 'B2', 'B3'], 'Alt+Left');
  // Move buttons on a tile and in the toolbar
  await tile(page, 2).hover();
  await tile(page, 2).locator('[data-act="left"]').click();
  assert.deepEqual(await gridOrder(page), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3'], 'tile move button');
  await selectOnly(page, 7);
  await page.click('#pt-move-l');
  assert.deepEqual(await gridOrder(page), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B3', 'B2'], 'toolbar move button');
  await page.click('#pt-move-r');
  assert.deepEqual(await gridOrder(page), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3']);

  // ---- Rotate: per page (tile button) and the selection (toolbar + keyboard)
  await page.click('#pt-sel-none');
  await tile(page, 0).hover();
  await tile(page, 0).locator('[data-act="rotr"]').click();
  await selectOnly(page, 1);
  await ctrlClick(page, 2);
  await page.click('#pt-rotl');
  await tile(page, 5).focus();
  await page.click('#pt-sel-none');
  await tile(page, 5).focus();
  await page.keyboard.press('r');
  await page.keyboard.press('r');
  assert.deepEqual(await gridRots(page), [90, 270, 270, 0, 0, 180, 0, 0]);
  await shot('rotated');
  dl = await download(page, '#pt-merge');
  out = await readPdf(dl.path);
  assert.deepEqual(out.rots, [90, 270, 270, 0, 0, 180, 0, 0], '/Rotate in output');
  assert.deepEqual(out.ids, ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3']);

  // ---- Delete, duplicate, blank, reverse
  await selectOnly(page, 7);
  await page.keyboard.press('Delete'); // B3 gone
  await waitTiles(page, 7);
  await selectOnly(page, 0);
  await page.click('#pt-dup'); // A1 duplicated (keeps rotation)
  await waitTiles(page, 8);
  await selectOnly(page, 3);
  await page.click('#pt-blank'); // blank after A3
  await waitTiles(page, 9);
  assert.deepEqual(await gridOrder(page), ['A1', 'A1', 'A2', 'A3', 'blank', 'A4', 'A5', 'B1', 'B2']);
  await page.click('#pt-sel-none');
  await page.click('#pt-reverse');
  const expectedRev = ['B2', 'B1', 'A5', 'A4', 'blank', 'A3', 'A2', 'A1', 'A1'];
  assert.deepEqual(await gridOrder(page), expectedRev);
  dl = await download(page, '#pt-merge');
  out = await readPdf(dl.path);
  assert.deepEqual(out.ids, expectedRev, 'delete/duplicate/blank/reverse in output');
  assert.deepEqual(out.rots, [0, 180, 0, 0, 0, 270, 270, 90, 90]);
  const blankPage = out.pages[4];
  // A3 is 503x700 but rotated 270°, so it shows as landscape: the blank page copies that shape.
  assert.ok(blankPage.blank && blankPage.w === 700 && blankPage.h === 503, `blank page matches the page before it as displayed: ${JSON.stringify(blankPage)}`);
  // Undo the reverse and the blank insert, then redo one
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await gridOrder(page), ['A1', 'A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2']);
  await page.keyboard.press('Control+y');
  assert.deepEqual(await gridOrder(page), ['A1', 'A1', 'A2', 'A3', 'blank', 'A4', 'A5', 'B1', 'B2']);

  // ---- Selection helpers
  await page.click('#pt-sel-odd');
  assert.match(await page.textContent('#pt-count'), /5 of 9 pages selected/);
  await page.click('#pt-sel-even');
  assert.match(await page.textContent('#pt-count'), /4 of 9 pages selected/);
  await page.click('#pt-sel-all');
  assert.match(await page.textContent('#pt-count'), /9 of 9 pages selected/);

  // ---- Extract selected (shift-click range)
  await selectOnly(page, 2);
  await tile(page, 5).locator('.pt-thumb').click({ position: { x: 60, y: 70 }, modifiers: ['Shift'] });
  assert.match(await page.textContent('#pt-count'), /4 of 9 pages selected/);
  dl = await download(page, '#pt-extract');
  assert.equal(dl.filename, 'doc-a-merged-selected.pdf');
  out = await readPdf(dl.path);
  assert.deepEqual(out.ids, ['A2', 'A3', 'blank', 'A4'], 'extracted pages');
  assert.deepEqual(out.rots, [270, 270, 0, 0]);
  assert.match(await page.textContent('#pt-result'), /4 pages/);

  // ---- Preview: double-click, arrows, Enter
  await tile(page, 0).locator('.pt-thumb').dblclick({ position: { x: 60, y: 70 } });
  await page.waitForSelector('#pt-preview[open] canvas.pt-pv-page', { timeout: 10000 });
  assert.equal(await page.textContent('#pt-pv-title'), 'Page 1 of 9');
  await shot('preview');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.textContent('#pt-pv-title'), 'Page 2 of 9');
  await page.click('#pt-pv-next');
  assert.equal(await page.textContent('#pt-pv-title'), 'Page 3 of 9');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#pt-preview'), false);
  // Closing returns focus to the page that was being previewed
  await page.waitForFunction(() => document.activeElement?.querySelector('.pt-num')?.textContent === '3');
  await tile(page, 4).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#pt-preview[open]');
  assert.equal(await page.textContent('#pt-pv-sub'), 'Blank page');
  await page.click('#pt-pv-close');

  // ---- Split by ranges (with validation errors first)
  await page.click('[data-split="ranges"]');
  await page.fill('#pt-ranges', '1-3, 12');
  assert.match(await page.textContent('#pt-split-preview'), /Page 12 is out of range \(1–9\)/);
  assert.ok(await page.isDisabled('#pt-split-go'), 'invalid ranges disable split');
  assert.equal(await page.getAttribute('#pt-ranges', 'aria-invalid'), 'true');
  await page.fill('#pt-ranges', '1-3, abc');
  assert.match(await page.textContent('#pt-split-preview'), /“abc” is not a page or range/);
  await page.fill('#pt-ranges', '');
  assert.match(await page.textContent('#pt-split-preview'), /Enter page ranges/);
  await page.fill('#pt-ranges', '1-3, 5, 7-');
  assert.match(await page.textContent('#pt-split-preview'), /3 PDFs in a ZIP: 1-3 · 5 · 7-9/);
  dl = await download(page, '#pt-split-go');
  assert.equal(dl.filename, 'doc-a-merged-split.zip');
  let zip = unzipSync(fs.readFileSync(dl.path));
  let names = Object.keys(zip).sort();
  assert.deepEqual(names, ['doc-a-merged-01-p1-3.pdf', 'doc-a-merged-02-p5.pdf', 'doc-a-merged-03-p7-9.pdf']);
  const zipIds = [];
  for (const n of names) {
    fs.writeFileSync(path.join(DIR, '..', '..', 'output', `zip-${n}`), zip[n]);
    zipIds.push((await readPdf(path.join(DIR, '..', '..', 'output', `zip-${n}`))).ids);
  }
  assert.deepEqual(zipIds, [['A1', 'A1', 'A2'], ['blank'], ['A5', 'B1', 'B2']], 'split by ranges contents');

  // ---- Split every N
  await page.click('[data-split="every"]');
  await page.fill('#pt-split-n', '4');
  assert.match(await page.textContent('#pt-split-preview'), /3 PDFs/);
  dl = await download(page, '#pt-split-go');
  zip = unzipSync(fs.readFileSync(dl.path));
  names = Object.keys(zip).sort();
  assert.equal(names.length, 3);
  const counts = [];
  for (const n of names) counts.push((await PDFDocument.load(zip[n])).getPageCount());
  assert.deepEqual(counts, [4, 4, 1], 'split every 4 pages');
  // Each page separately
  await page.click('[data-split="single"]');
  assert.match(await page.textContent('#pt-split-preview'), /9 PDFs/);
  dl = await download(page, '#pt-split-go');
  zip = unzipSync(fs.readFileSync(dl.path));
  assert.equal(Object.keys(zip).length, 9);
  for (const n of Object.keys(zip)) assert.equal((await PDFDocument.load(zip[n])).getPageCount(), 1);

  // ---- Metadata
  await page.click('summary:has-text("Document properties")');
  await page.fill('#pt-title', 'Quarterly Pack');
  await page.fill('#pt-author', 'Test Author');
  await page.fill('#pt-filename', 'pack');
  dl = await download(page, '#pt-merge');
  assert.equal(dl.filename, 'pack.pdf');
  out = await readPdf(dl.path);
  assert.equal(out.doc.getTitle(), 'Quarterly Pack');
  assert.equal(out.doc.getAuthor(), 'Test Author');
  assert.equal(out.pages.length, 9);

  // ---- Remove a file from the file list (undoable)
  await page.click('#pt-files .pt-file:has-text("doc-b.pdf") [data-remove]');
  await waitTiles(page, 7);
  assert.equal(await page.locator('#pt-files .pt-file:not(.pt-file-blank)').count(), 1);
  await page.keyboard.press('Control+z');
  await waitTiles(page, 9);

  // ---- Images to PDF with A4 sizing
  await page.click('#pt-clear');
  await waitTiles(page, 0);
  await page.setInputFiles(fileInput, [F.png, F.jpg]);
  await waitTiles(page, 2);
  assert.deepEqual(await gridOrder(page), ['img', 'img']);
  await page.click('summary:has-text("Image pages")');
  await page.selectOption('#pt-imgsize', 'a4');
  await page.selectOption('#pt-margin', '10');
  await page.fill('#pt-title', '');
  dl = await download(page, '#pt-merge');
  out = await readPdf(dl.path);
  assert.equal(out.pages.length, 2);
  assert.ok(out.pages.every((p) => p.image), 'image pages contain the image');
  assert.deepEqual([out.pages[0].w, out.pages[0].h], [841.89, 595.28], 'landscape PNG on landscape A4');
  assert.deepEqual([out.pages[1].w, out.pages[1].h], [595.28, 841.89], 'portrait JPEG on portrait A4');
  assert.equal(out.doc.getTitle(), undefined, 'no title when left empty');
  // Fit to image: 400x300 px at 96 dpi = 300x225 pt plus 2x10 mm margins
  await page.selectOption('#pt-imgsize', 'fit');
  await page.selectOption('#pt-margin', '0');
  dl = await download(page, '#pt-merge');
  out = await readPdf(dl.path);
  assert.deepEqual([out.pages[0].w, out.pages[0].h], [300, 225], 'fit-to-image size');
  await shot('images');

  // ---- Errors: encrypted, corrupt, not a PDF, unsupported type
  await page.setInputFiles(fileInput, [F.enc, F.random, F.junk, F.txt]);
  await page.waitForSelector('#pt-errors:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('#pt-errors li').length === 4);
  const errs = await page.$$eval('#pt-errors li', (els) => els.map((e) => e.textContent));
  assert.match(errs[0], /^encrypted\.pdf: This PDF is password-protected\..*cannot decrypt.*Save as PDF/);
  assert.match(errs[1], /^random-bytes\.pdf: .*not a PDF/);
  assert.match(errs[2], /^truncated\.pdf: This PDF appears to be damaged/);
  assert.match(errs[3], /^notes\.txt: Not a PDF or a supported image/);
  assert.match(await page.textContent('#pt-errors'), /4 files could not be added/);
  assert.equal(await tiles(page).count(), 2, 'bad files add no pages');
  await shot('errors');
  await page.click('#pt-errors [data-dismiss]');
  assert.equal(await page.isVisible('#pt-errors'), false);
});

// ================================================================ 150 pages: loads fast, stays responsive, lazy thumbnails
await runToolTest('pdf-toolkit', async ({ page, shot }) => {
  await page.evaluate(() => {
    window.__maxGap = 0;
    let last = performance.now();
    const tick = (t) => { window.__maxGap = Math.max(window.__maxGap, t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await page.setInputFiles(fileInput, F.big);
  await waitTiles(page, 150);
  const loadMs = Date.now() - t0;
  assert.ok(loadMs < 8000, `150 pages should appear quickly (took ${loadMs} ms)`);
  assert.equal(await page.textContent('#pt-count'), '150 pages');
  await page.waitForTimeout(1500);
  const rendered = await page.$$eval('#pt-grid .pt-face img', (els) => els.length);
  assert.ok(rendered > 0 && rendered < 150, `thumbnails render lazily (${rendered} of 150 so far)`);
  // UI responds while thumbnails are rendering
  const t1 = Date.now();
  await page.click('#pt-sel-all');
  assert.equal(await page.textContent('#pt-count'), '150 of 150 pages selected');
  await page.click('#pt-rotr');
  assert.ok(Date.now() - t1 < 1500, `select-all + rotate stays snappy (${Date.now() - t1} ms)`);
  const gap = await page.evaluate(() => window.__maxGap);
  assert.ok(gap < 1000, `main thread never froze for long (longest frame gap ${Math.round(gap)} ms)`);
  // Scroll to the end: the last thumbnails render on demand
  await tile(page, 149).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !!document.querySelector('#pt-grid .pt-tile:last-child .pt-face img'), null, { timeout: 15000 });
  await page.keyboard.press('Control+z');
  await page.click('#pt-sel-none');
  // Export all 150 pages with progress
  const dl = await download(page, '#pt-merge');
  const out = await readPdf(dl.path);
  assert.equal(out.pages.length, 150);
  assert.equal(out.ids[0], 'G1');
  assert.equal(out.ids[149], 'G150');
  assert.ok(out.rots.every((r) => r === 0), 'undo of the rotation is reflected');
  await shot('big-document');
});

// ================================================================ phone viewport
await runToolTest('pdf-toolkit', async ({ page, shot }) => {
  await noOverflow(page, 'mobile empty state');
  await shot('mobile-empty');
  await page.setInputFiles(fileInput, [F.a, F.b]);
  await waitTiles(page, 8);
  await page.waitForFunction(() => document.querySelectorAll('#pt-grid .pt-face img').length >= 4, null, { timeout: 15000 });
  await noOverflow(page, 'mobile with pages');
  // The action bar is pinned to the bottom of the screen
  const bar = await page.locator('.pt-toolbar').boundingBox();
  assert.ok(bar.y + bar.height <= 844 + 1 && bar.y > 700, `action bar at the bottom (${JSON.stringify(bar)})`);
  await tile(page, 1).locator('.pt-thumb').click({ position: { x: 50, y: 60 } });
  await tile(page, 3).locator('.pt-thumb').click({ position: { x: 50, y: 60 }, modifiers: ['Control'] });
  assert.match(await page.textContent('#pt-count'), /2 of 8 pages selected/);
  // Move buttons on the selected tile are visible and work
  assert.ok(await tile(page, 3).locator('[data-act="right"]').isVisible());
  await shot('mobile-selected');
  await page.click('#pt-m-export');
  await page.waitForTimeout(600);
  const dl = await download(page, '#pt-extract');
  const out = await readPdf(dl.path);
  assert.deepEqual(out.ids, ['A2', 'A4'], 'mobile extract');
  await noOverflow(page, 'mobile after export');
  await shot('mobile-export');
  // Preview fills the screen
  await tile(page, 0).locator('.pt-thumb').dblclick({ position: { x: 50, y: 60 } });
  await page.waitForSelector('#pt-preview[open] canvas.pt-pv-page', { timeout: 10000 });
  await shot('mobile-preview');
  await page.keyboard.press('Escape');
}, { viewport: { width: 390, height: 844 } });

// ================================================================ dark theme
await runToolTest('pdf-toolkit', async ({ page, shot }) => {
  await shot('dark-empty');
  await page.click('#pt-sample');
  await waitTiles(page, 9);
  await page.waitForFunction(() => document.querySelectorAll('#pt-grid .pt-face img').length === 9, null, { timeout: 15000 });
  await selectOnly(page, 1);
  await ctrlClick(page, 6);
  await tile(page, 3).hover();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(17, 17, 19)', 'dark background');
  await shot('dark-grid');
  const dl = await download(page, '#pt-merge');
  const out = await readPdf(dl.path);
  assert.equal(out.pages.length, 9);
  assert.equal(out.pages.filter((p) => p.image).length, 1, 'sample image page included');
}, { colorScheme: 'dark' });
