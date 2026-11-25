import { runToolTest, assert, expectDownload, FIXTURES } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const jsQRmod = require('jsqr');
const jsQR = jsQRmod.default ?? jsQRmod;
const QRCode = require('qrcode');

// ---------------------------------------------------------------- helpers (Node side)
/** Decode a PNG buffer with jsQR, compositing transparency over white first. */
function decodePng(buf) {
  const png = PNG.sync.read(buf);
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    d[i] = Math.round(d[i] * a + 255 * (1 - a));
    d[i + 1] = Math.round(d[i + 1] * a + 255 * (1 - a));
    d[i + 2] = Math.round(d[i + 2] * a + 255 * (1 - a));
    d[i + 3] = 255;
  }
  const r = jsQR(new Uint8ClampedArray(d.buffer, d.byteOffset, d.length), png.width, png.height);
  return { text: r ? r.data : null, width: png.width, height: png.height };
}
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

/** A blank helper page (outside the tool) for rasterizing SVG / composing fixtures with a canvas. */
async function helperPage(context) {
  const p = await context.newPage();
  await p.setContent('<!doctype html><body></body>');
  return p;
}
/** Draw an image (data URL) on a white canvas in the helper page and return PNG bytes. */
async function rasterize(helper, dataUrl, size = 640) {
  const b64 = await helper.evaluate(async ({ dataUrl, size }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    return c.toDataURL('image/png').split(',')[1];
  }, { dataUrl, size });
  return Buffer.from(b64, 'base64');
}

// ---------------------------------------------------------------- fixtures
// Generated deterministically on every run into tests/fixtures/qr-studio/.
const DIR = path.join(FIXTURES, 'qr-studio');
fs.mkdirSync(DIR, { recursive: true });
const F = {
  photo: path.join(DIR, 'photo-with-qr.png'),
  noqr: path.join(DIR, 'no-qr.png'),
  phish: path.join(DIR, 'disguised-link.png'),
  logo: path.join(DIR, 'logo.png'),
  txt: path.join(DIR, 'notes.txt'),
};
const PHOTO_URL = 'https://example.org/menu?table=12';
const PHISH_URL = 'https://www.paypal.com@login-check.example/verify';

async function makeFixtures(context) {
  const helper = await helperPage(context);
  const qr1 = await QRCode.toDataURL(PHOTO_URL, { margin: 2, width: 300, errorCorrectionLevel: 'M' });
  const qr2 = await QRCode.toDataURL(PHISH_URL, { margin: 4, width: 360 });
  const out = await helper.evaluate(async ({ qr1, qr2 }) => {
    const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
    const scene = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#d9c7a7'); g.addColorStop(1, '#8a6f4e');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 18; i++) {
        ctx.fillStyle = `hsla(${(i * 47) % 360}, 45%, ${35 + (i % 4) * 10}%, 0.55)`;
        ctx.beginPath(); ctx.arc((i * 137) % w, (i * 89) % h, 20 + (i % 5) * 12, 0, Math.PI * 2); ctx.fill();
      }
      return [c, ctx];
    };
    const [photo, pctx] = scene(900, 680);
    // A "table card": white paper, slightly rotated, holding the code.
    pctx.save(); pctx.translate(470, 330); pctx.rotate(0.21);
    pctx.fillStyle = '#fbfbf8'; pctx.shadowColor = 'rgba(0,0,0,.35)'; pctx.shadowBlur = 18;
    pctx.fillRect(-190, -230, 380, 460); pctx.shadowBlur = 0;
    pctx.fillStyle = '#333'; pctx.font = 'bold 28px sans-serif'; pctx.textAlign = 'center';
    pctx.fillText('Scan for the menu', 0, -190);
    pctx.drawImage(await load(qr1), -150, -160, 300, 300);
    pctx.restore();
    const [noqr, nctx] = scene(640, 480);
    nctx.fillStyle = '#222'; nctx.font = 'bold 44px sans-serif'; nctx.fillText('No code here', 150, 250);
    for (let i = 0; i < 6; i++) { nctx.fillStyle = i % 2 ? '#111' : '#eee'; nctx.fillRect(60 + i * 30, 320, 30, 30); }
    const phish = document.createElement('canvas');
    phish.width = phish.height = 360;
    phish.getContext('2d').drawImage(await load(qr2), 0, 0);
    const logo = document.createElement('canvas');
    logo.width = logo.height = 200;
    const l = logo.getContext('2d');
    const lg = l.createLinearGradient(0, 0, 200, 200); lg.addColorStop(0, '#f97316'); lg.addColorStop(1, '#db2777');
    l.fillStyle = lg; l.beginPath(); l.arc(100, 100, 96, 0, Math.PI * 2); l.fill();
    l.fillStyle = '#fff'; l.font = 'bold 110px sans-serif'; l.textAlign = 'center'; l.textBaseline = 'middle'; l.fillText('Q', 100, 108);
    const b64 = (c) => c.toDataURL('image/png').split(',')[1];
    return { photo: b64(photo), noqr: b64(noqr), phish: b64(phish), logo: b64(logo) };
  }, { qr1, qr2 });
  for (const k of ['photo', 'noqr', 'phish', 'logo']) fs.writeFileSync(F[k], Buffer.from(out[k], 'base64'));
  fs.writeFileSync(F.txt, 'Not an image.\n');
  await helper.close();
}

// ---------------------------------------------------------------- page helpers
async function selectType(page, id) {
  await page.click(`.qrs-type[data-type="${id}"]`);
  await page.waitForSelector(`.qrs-type[data-type="${id}"][aria-checked="true"]`);
}
async function setFields(page, fields) {
  for (const [id, value] of Object.entries(fields)) {
    const sel = `#qrs-f-${id}`;
    const tag = await page.$eval(sel, (el) => (el.tagName === 'INPUT' ? el.type : el.tagName.toLowerCase()));
    if (tag === 'checkbox') await page.setChecked(sel, !!value);
    else if (tag === 'select') await page.selectOption(sel, value);
    else await page.fill(sel, value);
  }
}
const payloadOf = (page) => page.inputValue('#qrs-payload');
async function downloadPngAndDecode(page) {
  const dl = await expectDownload(page, () => page.click('#qrs-dl-png'));
  const buf = fs.readFileSync(dl.path);
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', 'download is a PNG');
  return { ...decodePng(buf), filename: dl.filename, buf };
}
async function setColor(page, id, value) {
  await page.$eval(id, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, x: r.x, right: r.right }; });

/** Screenshots are full-page: scroll to the top first so the sticky header is not captured mid-page. */
const topShot = (page, shot) => async (name) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(80); return shot(name); };

// ================================================================= desktop, light
await runToolTest('qr-studio', async ({ page, context, shot: rawShot }) => {
  const shot = topShot(page, rawShot);
  await makeFixtures(context);
  const helper = await helperPage(context);

  // ---- loads with a ready example
  await page.waitForSelector('#qrs-svg svg');
  assert.equal(await payloadOf(page), 'https://example.com/welcome');
  assert.match(await page.textContent('#qrs-badges'), /Version \d+/);
  assert.match(await page.textContent('#qrs-cap-label'), /bytes/);
  assert.match(await page.textContent('#qrs-cap-value'), /% of v\d+/);
  await shot('create-default');

  // ---- every content type round-trips through the downloaded PNG
  const cases = [
    { type: 'url', fields: { url: 'example.com/path?q=1&x=ü' }, expect: 'https://example.com/path?q=1&x=ü' },
    { type: 'text', fields: { text: 'Hello\nwörld ✓ 42' }, expect: 'Hello\nwörld ✓ 42' },
    {
      type: 'wifi',
      fields: { ssid: 'Café "Corner"; 2,4:G', password: String.raw`p@ss\word;"x"`, auth: 'WPA', hidden: true },
      expect: String.raw`WIFI:T:WPA;S:Café \"Corner\"\; 2\,4\:G;P:p@ss\\word\;\"x\";H:true;;`,
    },
    {
      type: 'vcard',
      fields: {
        first: 'Grace', last: 'Hopper', phone: '+1 555 0199', email: 'grace@example.com', org: 'Navy; Research, Lab', title: 'Rear Admiral',
        url: 'https://example.com/grace', street: '1 Main St', city: 'Arlington', region: 'VA', zip: '22201', country: 'USA',
      },
      expect: [
        'BEGIN:VCARD', 'VERSION:3.0', 'N:Hopper;Grace;;;', 'FN:Grace Hopper', String.raw`ORG:Navy\; Research\, Lab`, 'TITLE:Rear Admiral',
        'TEL;TYPE=CELL:+1 555 0199', 'EMAIL;TYPE=INTERNET:grace@example.com', 'URL:https://example.com/grace',
        'ADR;TYPE=WORK:;;1 Main St;Arlington;VA;22201;USA', 'END:VCARD',
      ].join('\r\n'),
    },
    {
      type: 'email', fields: { to: 'a@example.com', subject: 'Hi there & welcome', body: 'Line1\nLine2' },
      expect: 'mailto:a@example.com?subject=Hi%20there%20%26%20welcome&body=Line1%0D%0ALine2',
    },
    { type: 'sms', fields: { number: '+1 (555) 0100', message: 'STOP now' }, expect: 'SMSTO:+15550100:STOP now' },
    { type: 'phone', fields: { number: '+44 20 7946 0958' }, expect: 'tel:+442079460958' },
    { type: 'geo', fields: { lat: '51.5007', lng: '-0.1246', label: 'Big Ben' }, expect: 'geo:51.5007,-0.1246?q=51.5007,-0.1246(Big%20Ben)' },
    {
      type: 'event',
      fields: { summary: 'Launch; party, v2', allday: false, start: '2026-12-04T09:30', end: '2026-12-04T11:00', location: 'Hall 3', description: 'Line one\nLine two', utc: false },
      expect: ['BEGIN:VEVENT', String.raw`SUMMARY:Launch\; party\, v2`, 'DTSTART:20261204T093000', 'DTEND:20261204T110000', 'LOCATION:Hall 3', String.raw`DESCRIPTION:Line one\nLine two`, 'END:VEVENT'].join('\r\n'),
    },
  ];
  for (const c of cases) {
    await selectType(page, c.type);
    await setFields(page, c.fields);
    // (a textarea's value normalizes CRLF to LF, so compare the shown payload with LF line ends)
    assert.equal(await payloadOf(page), c.expect.replace(/\r\n/g, '\n'), `${c.type}: payload text`);
    const d = await downloadPngAndDecode(page);
    assert.equal(d.text, c.expect, `${c.type}: decoded PNG must equal payload exactly`);
    assert.match(d.filename, new RegExp(`^qr-${c.type}-\\d+\\.png$`));
    if (c.type === 'wifi') await shot('create-wifi');
    if (c.type === 'event') await shot('create-event');
  }

  // Wi-Fi: open network drops the password and disables the field
  await selectType(page, 'wifi');
  await setFields(page, { auth: 'nopass', hidden: false });
  assert.equal(await payloadOf(page), 'WIFI:T:nopass;S:Café \\"Corner\\"\\; 2\\,4\\:G;;');
  assert.equal(await page.isDisabled('#qrs-f-password'), true);
  await setFields(page, { auth: 'WPA', hidden: true });

  // Event: all-day uses DATE values with an exclusive end
  await selectType(page, 'event');
  await page.setChecked('#qrs-f-allday', true);
  assert.equal(await page.getAttribute('#qrs-f-start', 'type'), 'date');
  const allDay = await payloadOf(page);
  assert.match(allDay, /DTSTART;VALUE=DATE:20261204\r?\nDTEND;VALUE=DATE:20261205/);
  await page.setChecked('#qrs-f-allday', false);
  // Validation: end before start
  await page.fill('#qrs-f-end', '2026-12-03T08:00');
  assert.match(await page.textContent('#qrs-form-error'), /ends before it starts/);
  assert.equal(await page.isDisabled('#qrs-dl-png'), true, 'export disabled while invalid');
  assert.match(await page.textContent('#qrs-empty-text'), /ends before/);
  await page.fill('#qrs-f-end', '2026-12-04T11:00');
  assert.equal(await page.isHidden('#qrs-form-error'), true);

  // Geo validation
  await selectType(page, 'geo');
  await page.fill('#qrs-f-lat', '123');
  assert.match(await page.textContent('#qrs-form-error'), /Latitude/);
  await page.fill('#qrs-f-lat', '51.5007');

  // ---- advanced: edit the raw payload by hand
  await selectType(page, 'text');
  await page.check('#qrs-edit-raw');
  assert.equal(await page.getAttribute('#qrs-payload', 'readonly'), null);
  await page.fill('#qrs-payload', 'RAW:custom payload 123');
  await page.waitForTimeout(250);
  let d = await downloadPngAndDecode(page);
  assert.equal(d.text, 'RAW:custom payload 123');
  assert.match(d.filename, /^qr-custom-/);
  assert.equal(await page.$eval('#qrs-form', (f) => f.hasAttribute('inert')), true, 'form paused while editing raw text');
  await page.uncheck('#qrs-edit-raw');
  assert.equal(await payloadOf(page), 'Hello\nwörld ✓ 42');

  // ---- too much data
  await page.fill('#qrs-f-text', 'x'.repeat(5000));
  await page.waitForSelector('#qrs-empty:not([hidden])');
  assert.match(await page.textContent('#qrs-empty-text'), /Too much data/);
  await page.fill('#qrs-f-text', 'Hello\nwörld ✓ 42');
  await page.waitForSelector('#qrs-svg svg');

  // ---- PNG size option
  await selectType(page, 'url');
  for (const px of [256, 777, 2048]) {
    await page.fill('#qrs-size', String(px));
    await page.press('#qrs-size', 'Tab');
    d = await downloadPngAndDecode(page);
    assert.deepEqual(pngSize(d.buf), { width: px, height: px }, `PNG is ${px}px`);
    assert.equal(d.text, 'https://example.com/path?q=1&x=ü');
  }
  await page.fill('#qrs-size', '9000');
  await page.press('#qrs-size', 'Tab');
  assert.equal(await page.inputValue('#qrs-size'), '2048', 'size clamps to 2048');
  await page.fill('#qrs-size', '1024');
  await page.press('#qrs-size', 'Tab');
  assert.equal(await page.inputValue('#qrs-size-range'), '1024');

  // ---- SVG export: valid XML that still decodes once rasterized
  const svgDl = await expectDownload(page, () => page.click('#qrs-dl-svg'));
  assert.equal(svgDl.filename, 'qr-url.svg');
  const svgText = fs.readFileSync(svgDl.path, 'utf8');
  const xml = await helper.evaluate((s) => {
    const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
    return { err: doc.getElementsByTagName('parsererror').length, root: doc.documentElement.nodeName, vb: doc.documentElement.getAttribute('viewBox') };
  }, svgText);
  assert.deepEqual([xml.err, xml.root], [0, 'svg'], 'SVG parses as XML');
  assert.match(xml.vb, /^0 0 \d+ \d+$/);
  d = decodePng(await rasterize(helper, `data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}`));
  assert.equal(d.text, 'https://example.com/path?q=1&x=ü', 'rasterized SVG decodes');

  // ---- styled: dots + rounded eyes + gradient + eye colour + logo (forces level H)
  await page.selectOption('#qrs-ecl', 'L');
  await page.click('[data-opt="module"] [data-val="dots"]');
  await page.click('[data-opt="eye"] [data-val="rounded"]');
  await page.check('#qrs-gradient');
  await page.waitForSelector('#qrs-gradtype:not([hidden])');
  const gw = await box(page, '#qrs-gradtype');
  assert.ok(gw.w < 220, `gradient select keeps its natural width (got ${gw.w}px)`);
  await setColor(page, '#qrs-fg', '#1e3a8a');
  await setColor(page, '#qrs-fg2', '#7c3aed');
  await page.selectOption('#qrs-gradtype', 'diagonal');
  await page.check('#qrs-eye-custom');
  await setColor(page, '#qrs-eyec', '#be123c');
  await page.setInputFiles('#qrs-logo-file', F.logo);
  await page.waitForSelector('#qrs-logo-remove:not([hidden])');
  assert.equal(await page.inputValue('#qrs-ecl'), 'H', 'logo forces level H');
  assert.equal(await page.isDisabled('#qrs-ecl'), true);
  assert.match(await page.textContent('#qrs-badges'), /ECL H/);
  const svgEl = await page.$eval('#qrs-svg svg', (s) => ({ image: !!s.querySelector('image'), grad: !!s.querySelector('linearGradient') }));
  assert.deepEqual(svgEl, { image: true, grad: true });
  // the logo slider cannot exceed 20% of the area; a big logo raises the version and warns
  assert.equal(await page.getAttribute('#qrs-logo-size', 'max'), '20');
  const setLogoSize = (v) => page.$eval('#qrs-logo-size', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await setLogoSize(20);
  assert.match(await page.textContent('#qrs-logo-size-val'), /20%/);
  assert.match(await page.textContent('#qrs-warnings'), /error-correction budget|more than error correction can repair/);
  assert.match(await page.textContent('#qrs-warnings'), /Version raised from \d+ to \d+/);
  await setLogoSize(16);
  assert.match(await page.textContent('#qrs-logo-size-val'), /16%/);
  d = await downloadPngAndDecode(page);
  assert.equal(d.text, 'https://example.com/path?q=1&x=ü', 'styled PNG with logo still decodes');
  const styledSvg = fs.readFileSync((await expectDownload(page, () => page.click('#qrs-dl-svg'))).path, 'utf8');
  d = decodePng(await rasterize(helper, `data:image/svg+xml;base64,${Buffer.from(styledSvg).toString('base64')}`, 800));
  assert.equal(d.text, 'https://example.com/path?q=1&x=ü', 'styled SVG with embedded logo decodes');
  await page.click('#qrs-test');
  await page.waitForFunction(() => /Scans correctly/.test(document.querySelector('#qrs-test-result')?.textContent ?? ''));
  await shot('create-styled-logo');

  // circle and leaf eyes + rounded modules + radial gradient decode too
  await page.click('[data-opt="module"] [data-val="rounded"]');
  await page.click('[data-opt="eye"] [data-val="leaf"]');
  await page.selectOption('#qrs-gradtype', 'radial');
  d = await downloadPngAndDecode(page);
  assert.equal(d.text, 'https://example.com/path?q=1&x=ü', 'rounded + leaf decodes');
  await page.click('[data-opt="eye"] [data-val="circle"]');
  d = await downloadPngAndDecode(page);
  assert.equal(d.text, 'https://example.com/path?q=1&x=ü', 'circle eyes decode');

  // remove logo: level returns to the user's choice
  await page.click('#qrs-logo-remove');
  assert.equal(await page.inputValue('#qrs-ecl'), 'L');
  assert.equal(await page.isDisabled('#qrs-ecl'), false);
  await page.selectOption('#qrs-ecl', 'M');

  // ---- transparent background exports a PNG with alpha
  await page.check('#qrs-transparent');
  assert.match(await page.textContent('#qrs-warnings'), /Transparent background/);
  d = await downloadPngAndDecode(page);
  const png = PNG.sync.read(d.buf);
  assert.equal(png.data[3], 0, 'corner pixel is transparent');
  assert.equal(d.text, 'https://example.com/path?q=1&x=ü');
  assert.equal(await page.$eval('#qrs-svg svg', (s) => s.querySelector(':scope > rect') === null), true, 'no background rect');
  await page.uncheck('#qrs-transparent');

  // ---- contrast warnings
  await page.click('.qrs-preset[data-preset="0"]'); // Classic
  assert.equal((await page.textContent('#qrs-warnings')).trim(), '', 'no warnings for black on white');
  await setColor(page, '#qrs-fg', '#c8c8c8');
  assert.match(await page.textContent('#qrs-warnings'), /Very low contrast \(1\.\d:1\)/);
  await setColor(page, '#qrs-fg', '#8a8a8a');
  assert.match(await page.textContent('#qrs-warnings'), /Low contrast \(3\.\d:1\)/);
  await setColor(page, '#qrs-fg', '#ffffff');
  await setColor(page, '#qrs-bg', '#111111');
  assert.match(await page.textContent('#qrs-warnings'), /Inverted colours/);
  await shot('create-warnings');
  await page.click('.qrs-preset[data-preset="0"]');
  // quiet zone warning
  await page.$eval('#qrs-margin', (el) => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await page.textContent('#qrs-warnings'), /Quiet zone of 1 module/);
  await page.$eval('#qrs-margin', (el) => { el.value = '4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('[data-opt="module"] [data-val="square"]');
  await page.click('[data-opt="eye"] [data-val="square"]');

  // ---- copy payload + copy image
  await page.click('#qrs-copy-payload');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://example.com/path?q=1&x=ü');
  await page.click('#qrs-copy-img');
  await page.waitForFunction(() => /Image copied|does not allow/.test(document.querySelector('.toast-host')?.textContent ?? ''));
  const clipTypes = await page.evaluate(async () => {
    try { return (await navigator.clipboard.read()).flatMap((i) => i.types); } catch (e) { return [String(e)]; }
  });
  assert.ok(clipTypes.includes('image/png'), `clipboard holds a PNG (got ${clipTypes})`);

  // ================================================================ SCAN
  await page.click('[data-tab="scan"]');
  await page.waitForSelector('#qrs-panel-scan:not([hidden])');
  assert.equal(await page.isHidden('#qrs-panel-create'), true);
  await shot('scan-empty');
  const fileInput = '#qrs-drop input[type=file]';

  // photo with a rotated code on a busy background
  await page.setInputFiles(fileInput, F.photo);
  await page.waitForSelector('#qrs-result-url');
  assert.equal(await page.textContent('#qrs-result-url'), PHOTO_URL);
  assert.equal(await page.textContent('#qrs-result-host'), 'example.org');
  assert.match(await page.textContent('#qrs-img-msg'), /QR code found/);
  assert.equal(await page.isVisible('#qrs-img-preview'), true);
  assert.equal(await page.$('.qrs-url-warning'), null, 'no warning for an honest link');
  // nothing navigates on its own; Open link opens a new tab only when clicked
  assert.match(page.url(), /tools\/qr-studio\/$/);
  await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
  const openBtn = page.locator('#qrs-result [data-action="open"]');
  assert.equal((await openBtn.textContent()).trim(), 'Open link');
  await openBtn.click();
  const opened = await page.evaluate(() => window.__opened);
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], PHOTO_URL);
  assert.match(opened[0][2], /noopener/);
  await shot('scan-photo');

  // disguised link: visible host differs from the real one
  await page.setInputFiles(fileInput, F.phish);
  await page.waitForSelector('.qrs-url-warning');
  assert.equal(await page.textContent('#qrs-result-host'), 'login-check.example');
  assert.match(await page.textContent('.qrs-url-warning'), /www\.paypal\.com@.*login-check\.example/);
  assert.equal((await openBtn.textContent()).trim(), 'Open anyway');
  await shot('scan-disguised-link');

  // an image without a QR code
  await page.setInputFiles(fileInput, F.noqr);
  await page.waitForFunction(() => /No QR code found/.test(document.querySelector('#qrs-img-msg')?.textContent ?? ''));
  assert.match(await page.getAttribute('#qrs-img-msg', 'class'), /alert-warning/);
  // not an image at all
  await page.setInputFiles(fileInput, F.txt);
  await page.waitForFunction(() => /not an image/.test(document.querySelector('#qrs-img-msg')?.textContent ?? ''));
  await shot('scan-no-qr');

  // paste a screenshot (Ctrl+V) — dispatch a paste event carrying the image file
  const photoB64 = fs.readFileSync(F.photo).toString('base64');
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, photoB64);
  await page.waitForFunction(() => /Pasted image/.test(document.querySelector('#qrs-result')?.textContent ?? ''));
  assert.equal(await page.textContent('#qrs-result-url'), PHOTO_URL);

  // drag and drop onto the dropzone
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    const zone = document.querySelector('#qrs-drop');
    zone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, fs.readFileSync(F.phish).toString('base64'));
  await page.waitForFunction(() => document.querySelector('#qrs-result-host')?.textContent === 'login-check.example');

  // Wi-Fi code from the Create tab: details + copy password
  await page.click('[data-tab="create"]');
  await selectType(page, 'wifi');
  await page.click('[data-tab="scan"]');
  await page.click('#qrs-scan-sample');
  await page.waitForFunction(() => document.querySelector('#qrs-result-badge')?.textContent === 'Wi-Fi');
  const wifiText = await page.textContent('#qrs-result');
  assert.match(wifiText, /Café "Corner"; 2,4:G/);
  assert.match(wifiText, /WPA/);
  assert.match(wifiText, /Hidden\s*Yes/);
  await page.click('#qrs-result [data-action="copy-password"]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), String.raw`p@ss\word;"x"`);
  await shot('scan-wifi');

  // vCard: shows its fields
  await page.click('[data-tab="create"]');
  await selectType(page, 'vcard');
  await page.click('[data-tab="scan"]');
  await page.click('#qrs-scan-sample');
  await page.waitForFunction(() => document.querySelector('#qrs-result-badge')?.textContent === 'Contact');
  const rows = await page.$$eval('#qrs-result .qrs-kv tr', (trs) => Object.fromEntries(trs.map((tr) => [tr.querySelector('th').textContent, tr.querySelector('td').textContent])));
  assert.equal(rows.Name, 'Grace Hopper');
  assert.equal(rows.Organization, 'Navy; Research, Lab');
  assert.equal(rows.Email, 'grace@example.com');
  assert.equal(rows.Phone, '+1 555 0199');
  assert.equal(rows.Address, '1 Main St, Arlington, VA, 22201, USA');
  const vcf = await expectDownload(page, () => page.click('#qrs-result [data-action="save-vcf"]'));
  assert.match(fs.readFileSync(vcf.path, 'utf8'), /^BEGIN:VCARD\r\n[\s\S]*FN:Grace Hopper\r\n[\s\S]*END:VCARD\r\n$/);

  // event: fields + .ics download wraps it in a VCALENDAR
  await page.click('[data-tab="create"]');
  await selectType(page, 'event');
  await page.click('[data-tab="scan"]');
  await page.click('#qrs-scan-sample');
  await page.waitForFunction(() => document.querySelector('#qrs-result-badge')?.textContent === 'Event');
  assert.match(await page.textContent('#qrs-result'), /Launch; party, v2[\s\S]*2026-12-04 09:30/);
  const ics = await expectDownload(page, () => page.click('#qrs-result [data-action="save-ics"]'));
  assert.match(fs.readFileSync(ics.path, 'utf8'), /^BEGIN:VCALENDAR\r\nVERSION:2.0[\s\S]*BEGIN:VEVENT[\s\S]*END:VCALENDAR\r\n$/);

  // plain text: shown with copy
  await page.click('[data-tab="create"]');
  await selectType(page, 'text');
  await page.click('[data-tab="scan"]');
  await page.click('#qrs-scan-sample');
  await page.waitForFunction(() => document.querySelector('#qrs-result-badge')?.textContent === 'Text');
  assert.equal(await page.textContent('#qrs-result-text'), 'Hello\nwörld ✓ 42');
  await page.click('#qrs-result [data-action="copy-raw"]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Hello\nwörld ✓ 42');

  // ---- session history (memory only)
  const hist = await page.$$eval('#qrs-history li', (li) => li.length);
  assert.equal(hist, 8, 'every successful scan is in the history');
  await page.click('#qrs-history li:last-child button');
  assert.equal(await page.textContent('#qrs-result-url'), PHOTO_URL, 'clicking a history entry shows it again');
  await shot('scan-history');

  // ---- camera: headless has no camera -> a clear message, no page errors
  await page.click('#qrs-cam-start');
  await page.waitForFunction(() => {
    const m = document.querySelector('#qrs-cam-msg');
    return m && !m.hidden && !/Starting/.test(m.textContent);
  }, null, { timeout: 15000 });
  const camMsg = await page.textContent('#qrs-cam-msg');
  assert.match(camMsg, /camera/i);
  assert.match(await page.getAttribute('#qrs-cam-msg', 'class'), /alert-error/);
  assert.equal(await page.textContent('#qrs-cam-state'), 'Error');
  assert.equal(await page.isEnabled('#qrs-cam-start'), true, 'can retry');
  await shot('scan-camera-unavailable');

  // permission denied
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await page.click('#qrs-cam-start');
  await page.waitForFunction(() => /blocked/.test(document.querySelector('#qrs-cam-msg')?.textContent ?? ''));

  // a working (simulated) camera: canvas stream showing a code -> rAF loop finds it and outlines it
  const camQr = await QRCode.toDataURL('https://example.net/from-camera', { margin: 4, width: 420 });
  await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const ctx = c.getContext('2d');
    const draw = () => { ctx.fillStyle = '#556'; ctx.fillRect(0, 0, 640, 480); ctx.drawImage(img, 130, 50, 380, 380); };
    draw();
    window.__camTimer = setInterval(draw, 50);
    navigator.mediaDevices.getUserMedia = async () => { window.__camStream = c.captureStream(20); return window.__camStream; };
  }, camQr);
  await page.click('#qrs-cam-start');
  await page.waitForFunction(() => document.querySelector('#qrs-cam-state')?.textContent === 'Scanning');
  await page.waitForFunction(() => document.querySelector('#qrs-result-url')?.textContent === 'https://example.net/from-camera', null, { timeout: 15000 });
  assert.match(await page.textContent('#qrs-result'), /Camera/);
  assert.equal(await page.isEnabled('#qrs-cam-stop'), true);
  await page.waitForSelector('#qrs-video-wrap.is-hit');
  const overlayInk = await page.$eval('#qrs-overlay', (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return n;
  });
  assert.ok(overlayInk > 500, 'detected outline is drawn on the overlay');
  await page.waitForTimeout(600);
  const camHits = await page.$$eval('#qrs-history li', (li) => li.filter((l) => /from-camera/.test(l.textContent)).length);
  assert.equal(camHits, 1, 'the same code seen repeatedly is recorded once');
  await shot('scan-camera-live');
  // leaving the tab stops the camera
  await page.click('[data-tab="create"]');
  assert.equal(await page.evaluate(() => window.__camStream.getTracks().every((t) => t.readyState === 'ended')), true, 'camera stopped on tab change');
  await page.click('[data-tab="scan"]');
  assert.equal(await page.textContent('#qrs-cam-state'), 'Off');
  assert.equal(await page.isDisabled('#qrs-cam-stop'), true);
  // explicit stop
  await page.click('#qrs-cam-start');
  await page.waitForFunction(() => document.querySelector('#qrs-cam-state')?.textContent === 'Scanning');
  await page.click('#qrs-cam-stop');
  assert.equal(await page.evaluate(() => window.__camStream.getTracks().every((t) => t.readyState === 'ended')), true, 'camera stopped by Stop');
  await page.evaluate(() => clearInterval(window.__camTimer));

  // clear history
  await page.click('#qrs-history-clear');
  assert.equal(await page.$$eval('#qrs-history li', (li) => li.length), 0);
  assert.equal(await page.isVisible('#qrs-history-empty'), true);

  // layout sanity: camera controls are not squashed
  const sel = await box(page, '#qrs-cam-select');
  assert.ok(sel.w > 150, `camera picker has room (got ${sel.w}px)`);
  assert.ok(await noOverflow(page));
  await helper.close();
});

// ================================================================= phone viewport
await runToolTest('qr-studio', async ({ page, shot: rawShot }) => {
  const shot = topShot(page, rawShot);
  await page.waitForSelector('#qrs-svg svg');
  assert.ok(await noOverflow(page), 'no horizontal overflow (create)');
  // the type picker, preview and form fit inside the viewport
  const w = await page.evaluate(() => window.innerWidth);
  for (const s of ['.qrs-types', '#qrs-stage', '#qrs-form', '.qrs-actions', '.qrs-size-row']) {
    const b = await box(page, s);
    assert.ok(b.x >= 0 && b.right <= w + 0.5, `${s} fits on screen`);
  }
  const sizeInput = await box(page, '#qrs-size');
  assert.ok(sizeInput.w >= 70, `size input not squashed (got ${sizeInput.w}px)`);
  const stage = await box(page, '#qrs-svg svg');
  assert.ok(stage.w >= 220, `preview is large enough on a phone (got ${stage.w}px)`);
  await shot('mobile-create');

  await selectType(page, 'wifi');
  await setFields(page, { ssid: 'Phone Net', password: 'a;b,c' });
  assert.ok(await noOverflow(page));
  const d = await downloadPngAndDecode(page);
  assert.equal(d.text, String.raw`WIFI:T:WPA;S:Phone Net;P:a\;b\,c;;`);
  await page.check('#qrs-gradient');
  const gw = await box(page, '#qrs-gradtype');
  assert.ok(gw.w < 220, `gradient select not stretched on mobile (got ${gw.w}px)`);
  assert.ok(await noOverflow(page));
  await shot('mobile-create-wifi');

  await page.click('[data-tab="scan"]');
  assert.ok(await noOverflow(page), 'no horizontal overflow (scan)');
  await page.setInputFiles('#qrs-drop input[type=file]', F.photo);
  await page.waitForSelector('#qrs-result-url');
  assert.ok(await noOverflow(page), 'no overflow with a result');
  const order = await page.evaluate(() => ['.qrs-card-image', '.qrs-card-result', '.qrs-card-camera', '.qrs-card-history'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'on phones the result comes right after the image picker');
  const camSel = await box(page, '#qrs-cam-select');
  assert.ok(camSel.w > 200, `camera picker spans the row on mobile (got ${camSel.w}px)`);
  assert.equal(await page.isHidden('#qrs-cam-torch'), true, 'torch hidden without a camera');
  await shot('mobile-scan');
}, { viewport: { width: 390, height: 844 } });

// ================================================================= dark theme
await runToolTest('qr-studio', async ({ page, shot: rawShot }) => {
  const shot = topShot(page, rawShot);
  await page.waitForSelector('#qrs-svg svg');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lum = (bg.match(/\d+/g) || []).slice(0, 3).reduce((a, b) => a + +b, 0);
  assert.ok(lum < 200, `dark background (got ${bg})`);
  // The code itself stays dark-on-light so it scans in dark mode too.
  assert.equal(await page.$eval('#qrs-svg svg > rect', (r) => r.getAttribute('fill')), '#ffffff');
  await selectType(page, 'vcard');
  await shot('dark-create');
  await page.click('[data-tab="scan"]');
  await page.setInputFiles('#qrs-drop input[type=file]', F.phish);
  await page.waitForSelector('.qrs-url-warning');
  await shot('dark-scan');
}, { colorScheme: 'dark' });
