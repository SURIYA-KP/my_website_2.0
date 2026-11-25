import { runToolTest, assert, expectDownload, FIXTURES } from './harness.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- fixtures (regenerated every run)
const FIX = path.join(FIXTURES, 'dev-toolkit');
fs.mkdirSync(FIX, { recursive: true });
// 2.5 MB of deterministic pseudo-random bytes: hashed in several 4 MB-or-less chunks by the worker.
const SAMPLE = path.join(FIX, 'sample.bin');
{
  const parts = [];
  let seed = Buffer.from('dev-toolkit fixture');
  for (let n = 0; n < 2.5 * 1024 * 1024; n += 64) {
    seed = crypto.createHash('sha512').update(seed).digest();
    parts.push(seed);
  }
  fs.writeFileSync(SAMPLE, Buffer.concat(parts).subarray(0, 2.5 * 1024 * 1024 + 123));
}
const HELLO = path.join(FIX, 'hello.txt');
fs.writeFileSync(HELLO, 'Hello, Dev Toolkit! héllo 🌍\n');
const sampleBytes = fs.readFileSync(SAMPLE);

const here = path.dirname(fileURLToPath(import.meta.url));
const WORDS = new Set(fs.readFileSync(path.join(here, '../src/tools/dev-toolkit/wordlist.ts'), 'utf8').split('`')[1].trim().split(/\s+/));

const log = process.env.DT_DEBUG ? (m) => console.log(`  · ${m}`) : () => {};
const b64u = (b) => Buffer.from(b).toString('base64url');
const nodeHash = (algo, data, enc = 'hex') => crypto.createHash(algo).update(data).digest(enc);

// ---------------------------------------------------------------- helpers
async function openTab(page, t) {
  await page.click(`#dt-tab-${t}`);
  await page.waitForSelector(`#dt-panel-${t}[data-ready]:not([hidden])`);
}
const val = (page, sel) => page.inputValue(sel);
const txt = async (page, sel) => ((await page.textContent(sel)) ?? '').trim();
/** Value cell of the key/value row whose key matches. */
const kv = (page, container, key) =>
  page.$eval(container, (c, key) => {
    const row = [...c.querySelectorAll('.dt-kv-row')].find((r) => r.querySelector('.dt-kv-key')?.textContent.trim() === key);
    return row ? row.querySelector('.dt-kv-val').textContent.trim() : null;
  }, key);
const waitText = (page, sel, re, timeout = 5000) =>
  page.waitForFunction(([sel, src, flags]) => new RegExp(src, flags).test(document.querySelector(sel)?.textContent ?? ''), [sel, re.source, re.flags], { timeout });
const waitValue = (page, sel, expected, timeout = 5000) =>
  page.waitForFunction(([sel, e]) => document.querySelector(sel)?.value === e, [sel, expected], { timeout }).catch(async () => {
    assert.equal(await val(page, sel), expected, `${sel} value`);
  });
const waitKv = (page, container, key, expected, timeout = 5000) =>
  page
    .waitForFunction(([c, key, e]) => {
      const row = [...document.querySelectorAll(`${c} .dt-kv-row`)].find((r) => r.querySelector('.dt-kv-key')?.textContent.trim() === key);
      return row?.querySelector('.dt-kv-val').textContent.trim() === e;
    }, [container, key, expected], { timeout })
    .catch(async () => assert.equal(await kv(page, container, key), expected, `${container} › ${key}`));
async function clipIs(page, expected, msg) {
  await page.waitForFunction(async (e) => (await navigator.clipboard.readText()) === e, expected, { timeout: 2000, polling: 50 }).catch(() => {});
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected, msg);
}
const noOverflow = async (page, label) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w, `${label}: horizontal overflow (${o.sw} > ${o.w})`);
};
const readDl = (d) => fs.readFileSync(d.path);

// ================================================================ main flow (desktop, light)
await runToolTest('dev-toolkit', async ({ page, shot, BASE_URL }) => {
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  await page.waitForSelector('#dt[data-ready] #dt-panel-base64[data-ready]');
  assert.ok(!requested.some((u) => /wordlist|password/i.test(u)), 'the word list must not load before the Passwords tab opens');

  // ------------------------------------------------------------ Base64
  log('base64');
  const HELLO_TXT = 'héllo 🌍';
  assert.equal(await val(page, '#b64-in'), HELLO_TXT, 'example preloaded');
  assert.equal(await val(page, '#b64-out'), Buffer.from(HELLO_TXT).toString('base64'));
  assert.equal(await val(page, '#b64-out'), 'aMOpbGxvIPCfjI0=');
  assert.equal(await txt(page, '#b64-detect'), 'Auto: encoding');
  await page.check('#b64-urlsafe');
  await page.check('#b64-nopad');
  assert.equal(await val(page, '#b64-out'), Buffer.from(HELLO_TXT).toString('base64url'));
  // A string whose Base64 contains + and / shows the URL-safe alphabet
  await page.fill('#b64-in', '<<???>>');
  assert.equal(await val(page, '#b64-out'), 'PDw_Pz8-Pg');
  await page.uncheck('#b64-urlsafe');
  await page.uncheck('#b64-nopad');
  assert.equal(await val(page, '#b64-out'), 'PDw/Pz8+Pg==');
  // decode (auto-detected), standard and URL-safe
  await page.fill('#b64-in', 'aMOpbGxvIPCfjI0=');
  assert.equal(await txt(page, '#b64-detect'), 'Auto: decoding');
  assert.equal(await val(page, '#b64-out'), HELLO_TXT);
  await page.fill('#b64-in', 'aMOpbGxvIPCfjI0');
  assert.equal(await val(page, '#b64-out'), HELLO_TXT, 'unpadded input decodes');
  await page.fill('#b64-in', 'PDw_Pz8-Pg');
  assert.equal(await val(page, '#b64-out'), '<<???>>', 'URL-safe input decodes');
  // swap round trip
  await page.click('#b64-swap');
  assert.equal(await val(page, '#b64-in'), '<<???>>');
  assert.equal(await val(page, '#b64-out'), 'PDw/Pz8+Pg==');
  // explicit decode with bad input shows an error
  await page.click('#b64-mode [data-value="decode"]');
  await page.fill('#b64-in', 'abc$');
  assert.match(await txt(page, '#b64-status'), /Invalid Base64 character “\$”/);
  await page.fill('#b64-in', 'aGVsbG8=');
  assert.equal(await val(page, '#b64-out'), 'hello');
  // copy
  await page.click('[data-copy="b64-out"]');
  await clipIs(page, 'hello', 'copy output');
  await page.click('#b64-mode [data-value="auto"]');

  // file → Base64
  await page.setInputFiles('#b64-drop input[type=file]', HELLO);
  await waitValue(page, '#b64-file-out', fs.readFileSync(HELLO).toString('base64'));
  assert.match(await txt(page, '#b64-file-info'), /hello\.txt/);
  assert.match(await txt(page, '#b64-file-info'), /File \d+ B/, 'shows the size');
  await page.click('#b64-file-fmt [data-value="dataurl"]');
  assert.equal(await val(page, '#b64-file-out'), `data:text/plain;base64,${fs.readFileSync(HELLO).toString('base64')}`);
  const fdl = await expectDownload(page, () => page.click('#b64-file-dl'));
  assert.equal(readDl(fdl).toString(), `data:text/plain;base64,${fs.readFileSync(HELLO).toString('base64')}`);

  // Base64 → file: the preloaded example image previews and downloads as a real PNG
  await page.waitForSelector('#b64-dec-preview:not([hidden])');
  assert.match(await txt(page, '#b64-dec-info'), /PNG image/);
  assert.equal(await val(page, '#b64-dec-name'), 'decoded.png');
  assert.ok(await page.$eval('#b64-dec-preview', (i) => i.complete && i.naturalWidth === 64), 'preview image renders');
  const exampleB64 = (await val(page, '#b64-dec-in')).split(',')[1];
  const pngDl = await expectDownload(page, () => page.click('#b64-dec-dl'));
  assert.equal(pngDl.filename, 'decoded.png');
  assert.deepEqual(readDl(pngDl), Buffer.from(exampleB64, 'base64'));
  assert.equal(readDl(pngDl).subarray(1, 4).toString(), 'PNG');
  // a PDF detected from magic bytes, downloaded byte-for-byte
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n1 0 obj << >> endobj\n%%EOF\n')]);
  await page.fill('#b64-dec-in', pdfBytes.toString('base64'));
  await waitText(page, '#b64-dec-info', /PDF document/);
  assert.equal(await val(page, '#b64-dec-name'), 'decoded.pdf');
  assert.ok(await page.$eval('#b64-dec-preview', (i) => i.hidden), 'no preview for a PDF');
  const pdfDl = await expectDownload(page, () => page.click('#b64-dec-dl'));
  assert.deepEqual(readDl(pdfDl), pdfBytes);
  // the sample binary as a data URL with a custom name
  await page.fill('#b64-dec-name', 'my-data.bin');
  await page.fill('#b64-dec-in', `data:application/octet-stream;base64,${sampleBytes.subarray(0, 4096).toString('base64')}`);
  await waitText(page, '#b64-dec-info', /4,096 bytes/);
  const binDl = await expectDownload(page, () => page.click('#b64-dec-dl'));
  assert.equal(binDl.filename, 'my-data.bin');
  assert.deepEqual(readDl(binDl), sampleBytes.subarray(0, 4096));
  await page.fill('#b64-dec-in', 'not*base64');
  await waitText(page, '#b64-dec-status', /Invalid Base64 character/);
  assert.ok(await page.$eval('#b64-dec-dl', (b) => b.disabled), 'download disabled on error');
  await shot('base64');

  // ------------------------------------------------------------ URL
  log('url');
  await openTab(page, 'url');
  const urlText = 'name=Zoë & Co / 50% off? #deal';
  assert.equal(await val(page, '#url-out'), encodeURIComponent(urlText));
  await page.click('#url-mode [data-value="uri"]');
  assert.equal(await val(page, '#url-out'), encodeURI(urlText));
  await page.check('#url-plus');
  await page.click('#url-mode [data-value="component"]');
  assert.equal(await val(page, '#url-out'), encodeURIComponent(urlText).replace(/%20/g, '+'));
  await page.click('#url-swap');
  assert.equal(await val(page, '#url-out'), urlText, 'swap decodes back (with + as space)');
  await page.uncheck('#url-plus');
  await page.fill('#url-in', 'caf%C3%A9%2');
  assert.match(await txt(page, '#url-status'), /“%2” at position 10/);
  // parser + params table
  const startUrl = await val(page, '#url-parse');
  const u = new URL(startUrl);
  assert.equal(await val(page, '#url-protocol'), 'https:');
  assert.equal(await val(page, '#url-hostname'), u.hostname);
  assert.equal(await val(page, '#url-port'), '8443');
  assert.equal(await val(page, '#url-pathname'), '/v2/search');
  assert.equal(await val(page, '#url-hash'), '#results');
  assert.equal(await txt(page, '#url-param-count'), '4');
  assert.equal(await page.inputValue('#url-param-rows .dt-param:nth-child(1) [data-v]'), 'café au lait', 'values are shown decoded');
  // edit a value, add a parameter, remove one, change the host
  await page.fill('#url-param-rows .dt-param:nth-child(2) [data-v]', '3');
  await page.click('#url-add-param');
  await page.keyboard.type('lang');
  await page.fill('#url-param-rows .dt-param:nth-child(5) [data-v]', 'en & fr');
  await page.click('#url-param-rows .dt-param:nth-child(3) [data-remove]');
  await page.fill('#url-hostname', 'example.org');
  const expected = new URL(startUrl);
  expected.hostname = 'example.org';
  const sp = new URLSearchParams([['q', 'café au lait'], ['page', '3'], ['tag', 'sale'], ['lang', 'en & fr']]);
  expected.search = `?${sp}`;
  assert.equal(await val(page, '#url-parse'), expected.href);
  assert.equal(await txt(page, '#url-param-count'), '4');
  assert.equal(await val(page, '#url-origin'), 'https://example.org:8443');
  // typing a new URL re-parses
  await page.fill('#url-parse', 'http://localhost:3000/a/b?x=1#top');
  assert.equal(await val(page, '#url-port'), '3000');
  assert.equal(await txt(page, '#url-param-count'), '1');
  await page.click('#url-param-rows [data-remove]');
  assert.equal(await val(page, '#url-parse'), 'http://localhost:3000/a/b#top');
  assert.ok(await page.isVisible('#url-params-empty'), 'empty state for no params');
  await page.fill('#url-parse', 'not a url');
  assert.match(await txt(page, '#url-parse-status'), /Not a valid absolute URL/);
  await page.fill('#url-parse', startUrl);

  // ------------------------------------------------------------ HTML entities
  log('html');
  await openTab(page, 'html');
  const htmlIn = await val(page, '#html-in');
  assert.equal(await val(page, '#html-out'), '&lt;p class=&quot;note&quot;&gt;Caf&eacute; &copy; 2026 &mdash; &quot;quotes&quot; &amp; 5 &lt; 7 &check; &#127757;&lt;/p&gt;');
  await page.click('#html-swap');
  assert.equal(await page.getAttribute('#html-mode [data-value="decode"]', 'aria-pressed'), 'true');
  assert.equal(await val(page, '#html-out'), htmlIn, 'named round trip');
  await page.click('#html-mode [data-value="encode"]');
  await page.fill('#html-in', htmlIn);
  for (const fmt of ['dec', 'hex']) {
    await page.selectOption('#html-format', fmt);
    const enc = await val(page, '#html-out');
    assert.ok(fmt === 'dec' ? enc.includes('&#233;') : enc.includes('&#xE9;'), `${fmt} entities`);
    await page.click('#html-swap');
    assert.equal(await val(page, '#html-out'), htmlIn, `${fmt} round trip`);
    await page.click('#html-mode [data-value="encode"]');
    await page.fill('#html-in', htmlIn);
  }
  // Every named entity the encoder emits must mean the same thing to the browser's own parser.
  await page.selectOption('#html-format', 'named');
  await page.selectOption('#html-scope', 'all');
  let all = '';
  for (let c = 160; c <= 255; c++) all += String.fromCodePoint(c);
  all += 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρςστυφχψω ϑϒϖ ŒœŠšŸƒˆ˜–—‘’‚“”„†‡•…‰′″‹›‾⁄€ℑ℘ℜ™ℵ←↑→↓↔↵⇐⇑⇒⇓⇔∀∂∃∅∇∈∉∋∏∑−∗√∝∞∠∧∨∩∪∫∴∼≅≈≠≡≤≥⊂⊃⊄⊆⊇⊕⊗⊥⋅⌈⌉⌊⌋◊♠♣♥♦✓ <>&"\'';
  await page.fill('#html-in', all);
  const encodedAll = await val(page, '#html-out');
  assert.ok(!/&#\d/.test(encodedAll.replace(/&#39;|&#8194;|&#8195;|&#8201;|&#8204;|&#8205;|&#8206;|&#8207;/g, '')), 'all of these have names');
  assert.equal(await page.evaluate((s) => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }, encodedAll), all, 'browser decodes our named entities identically');
  await page.click('#html-swap');
  assert.equal(await val(page, '#html-out'), all, 'tool decodes them too');
  await page.fill('#html-in', '&#x1F600; &#128512; &hearts; &NotAnEntity; &#150; &amp;lt;');
  assert.equal(await val(page, '#html-out'), '😀 😀 ♥ &NotAnEntity; – &lt;');
  assert.match(await txt(page, '#html-stats'), /1 unknown name/);
  await page.click('#html-cheats [data-code="&copy;"]');
  await clipIs(page, '&copy;', 'entity cheat sheet copies');
  await page.click('#html-mode [data-value="encode"]');
  await page.selectOption('#html-scope', 'nonascii');
  await page.fill('#html-in', htmlIn);

  // ------------------------------------------------------------ JWT
  log('jwt');
  await openTab(page, 'jwt');
  assert.match(await txt(page, '#dt-panel-jwt .dt-note'), /Decoding is not verification/);
  // preloaded example is valid and verified
  await waitText(page, '#jwt-verify', /Signature verified/);
  assert.equal(await txt(page, '#jwt-time-badge'), 'Valid');
  const SECRET = 'my-known-secret-🔑';
  const now = Math.floor(Date.now() / 1000);
  const signNode = (header, payload, secret, algo = 'sha256') => {
    const h = b64u(JSON.stringify(header));
    const p = b64u(JSON.stringify(payload));
    return `${h}.${p}.${crypto.createHmac(algo, secret).update(`${h}.${p}`).digest('base64url')}`;
  };
  const expiredTok = signNode({ alg: 'HS256', typ: 'JWT' }, { sub: '42', name: 'Grace', iat: now - 7200, exp: now - 3600 }, SECRET);
  await page.fill('#jwt-in', expiredTok);
  await page.fill('#jwt-secret', SECRET);
  await waitText(page, '#jwt-verify', /Signature verified/);
  assert.equal(await txt(page, '#jwt-alg'), 'alg: HS256');
  assert.equal(JSON.parse(await txt(page, '#jwt-header')).alg, 'HS256');
  assert.deepEqual(JSON.parse(await txt(page, '#jwt-payload')), { sub: '42', name: 'Grace', iat: now - 7200, exp: now - 3600 });
  assert.equal(await txt(page, '#jwt-time-badge'), 'Expired');
  const expRow = await page.textContent('#jwt-claims [data-claim="exp"]');
  assert.ok(expRow.includes(new Date((now - 3600) * 1000).toISOString().replace('.000Z', 'Z')), 'exp as ISO date');
  assert.match(expRow, /1 hour ago|60 minutes ago/, 'exp relative time');
  await page.fill('#jwt-secret', 'wrong secret');
  await waitText(page, '#jwt-verify', /Invalid signature/);
  // secret given as Base64
  await page.selectOption('#jwt-secret-enc', 'base64');
  await page.fill('#jwt-secret', Buffer.from(SECRET).toString('base64'));
  await waitText(page, '#jwt-verify', /Signature verified/);
  await page.selectOption('#jwt-secret-enc', 'utf8');
  // tampered payload
  const [th, , ts] = expiredTok.split('.');
  await page.fill('#jwt-in', `${th}.${b64u(JSON.stringify({ sub: '42', admin: true }))}.${ts}`);
  await page.fill('#jwt-secret', SECRET);
  await waitText(page, '#jwt-verify', /Invalid signature/);
  assert.match(await txt(page, '#jwt-time-badge'), /never expires/);
  // not yet valid + HS512
  await page.fill('#jwt-in', signNode({ alg: 'HS512' }, { nbf: now + 86400, exp: now + 90000 }, SECRET, 'sha512'));
  await waitText(page, '#jwt-verify', /Signature verified/);
  assert.equal(await txt(page, '#jwt-time-badge'), 'Not yet valid');
  // malformed
  await page.fill('#jwt-in', 'abc.def');
  await waitText(page, '#jwt-status', /3 parts/);
  // RS256 with an SPKI PEM, and ES256 with a JWK
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rh = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const rp = b64u(JSON.stringify({ sub: 'rsa-user', exp: now + 600 }));
  const rsTok = `${rh}.${rp}.${crypto.sign('sha256', Buffer.from(`${rh}.${rp}`), rsa.privateKey).toString('base64url')}`;
  await page.fill('#jwt-in', rsTok);
  await page.waitForSelector('#jwt-pk:not([hidden])');
  assert.ok(await page.isHidden('#jwt-hs'), 'secret field hidden for RS256');
  await page.fill('#jwt-key', rsa.publicKey.export({ type: 'spki', format: 'pem' }));
  await waitText(page, '#jwt-verify', /Signature verified/);
  await page.fill('#jwt-key', rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }));
  await waitText(page, '#jwt-verify', /Signature verified/, 5000);
  const otherRsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await page.fill('#jwt-key', otherRsa.publicKey.export({ type: 'spki', format: 'pem' }));
  await waitText(page, '#jwt-verify', /Invalid signature/);
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const eh = b64u(JSON.stringify({ alg: 'ES256' }));
  const ep = b64u(JSON.stringify({ sub: 'ec-user' }));
  const esTok = `${eh}.${ep}.${crypto.sign('sha256', Buffer.from(`${eh}.${ep}`), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  await page.fill('#jwt-in', esTok);
  await page.fill('#jwt-key', JSON.stringify(ec.publicKey.export({ format: 'jwk' })));
  await waitText(page, '#jwt-verify', /Signature verified/);
  await page.fill('#jwt-key', rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await waitText(page, '#jwt-verify', /private key/);
  // create & sign: the token the tool makes verifies with Node's crypto
  const payload = { sub: 'made-in-tool', scope: ['read', 'write'], iat: now };
  await page.fill('#jwt-make-payload', JSON.stringify(payload));
  await page.fill('#jwt-make-secret', 'node-verifies-this');
  const madeOk = async (algo) => {
    await page.waitForFunction((p) => {
      const t = document.querySelector('#jwt-make-out').textContent;
      return t.split('.').length === 3 && t.split('.')[1] === p;
    }, b64u(JSON.stringify(payload)));
    const tok = (await txt(page, '#jwt-make-out')).trim();
    const [h, p, s] = tok.split('.');
    assert.equal(crypto.createHmac(algo, 'node-verifies-this').update(`${h}.${p}`).digest('base64url'), s, `${algo} signature checks out in Node`);
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), payload);
    return JSON.parse(Buffer.from(h, 'base64url'));
  };
  assert.deepEqual(await madeOk('sha256'), { alg: 'HS256', typ: 'JWT' });
  await page.selectOption('#jwt-make-alg', 'HS384');
  assert.equal((await madeOk('sha384')).alg, 'HS384');
  assert.equal(JSON.parse(await val(page, '#jwt-make-header')).alg, 'HS384', 'header alg follows the selector');
  await page.click('#jwt-make-load');
  await waitText(page, '#jwt-verify', /Signature verified/);
  assert.equal(await txt(page, '#jwt-alg'), 'alg: HS384');
  await page.fill('#jwt-make-payload', '{"broken": ');
  await waitText(page, '#jwt-make-status', /Payload:/);
  await page.selectOption('#jwt-make-alg', 'HS256');
  await page.fill('#jwt-make-payload', JSON.stringify(payload));
  await page.click('#jwt-example');
  await waitText(page, '#jwt-verify', /Signature verified/);
  await shot('jwt');

  // ------------------------------------------------------------ Hash
  log('hash');
  await openTab(page, 'hash');
  await waitKv(page, '#hash-results', 'MD5', '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(await kv(page, '#hash-results', 'MD5'), nodeHash('md5', 'abc'));
  for (const [a, n] of [['SHA-1', 'sha1'], ['SHA-256', 'sha256'], ['SHA-384', 'sha384'], ['SHA-512', 'sha512']]) assert.equal(await kv(page, '#hash-results', a), nodeHash(n, 'abc'), a);
  await page.fill('#hash-in', 'héllo 🌍\n');
  await waitKv(page, '#hash-results', 'SHA-256', nodeHash('sha256', 'héllo 🌍\n'));
  await page.click('#hash-fmt [data-value="base64"]');
  assert.equal(await kv(page, '#hash-results', 'SHA-256'), nodeHash('sha256', 'héllo 🌍\n', 'base64'));
  await page.click('#hash-fmt [data-value="HEX"]');
  assert.equal(await kv(page, '#hash-results', 'MD5'), nodeHash('md5', 'héllo 🌍\n').toUpperCase());
  await page.click('#hash-fmt [data-value="hex"]');
  // compare with expected
  await page.fill('#hash-expect', nodeHash('sha1', 'héllo 🌍\n').toUpperCase());
  assert.match(await txt(page, '#hash-compare'), /Match.*SHA-1/);
  assert.equal(await page.getAttribute('#hash-results [data-algo="SHA-1"]', 'class'), 'dt-kv-row dt-hash-row is-match');
  await page.fill('#hash-expect', `sha256:${nodeHash('sha256', 'héllo 🌍\n', 'base64')}`);
  assert.match(await txt(page, '#hash-compare'), /Match.*SHA-256/);
  await page.fill('#hash-expect', nodeHash('sha256', 'something else'));
  assert.match(await txt(page, '#hash-compare'), /No match.*SHA-256/);
  // HMAC: RFC 4231 test case 2
  await page.fill('#hash-in', 'what do ya want for nothing?');
  await page.check('#hash-hmac');
  await page.fill('#hash-key', 'Jefe');
  await waitKv(page, '#hash-results', 'HMAC-SHA-256', '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  assert.equal(await kv(page, '#hash-results', 'HMAC-SHA-512'), '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737');
  await page.selectOption('#hash-key-enc', 'hex');
  await page.fill('#hash-key', '4a656665');
  await waitKv(page, '#hash-results', 'HMAC-SHA-256', '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  await page.fill('#hash-expect', '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  assert.match(await txt(page, '#hash-compare'), /Match.*HMAC-SHA-256/);
  await page.selectOption('#hash-key-enc', 'utf8');
  await page.uncheck('#hash-hmac');
  await page.fill('#hash-expect', '');
  // file hashing in the worker, verified against Node
  await page.click('#hash-src [data-value="file"]');
  assert.ok(await page.isVisible('#hash-empty'), 'file mode empty state');
  await page.setInputFiles('#hash-drop input[type=file]', SAMPLE);
  await waitText(page, '#hash-progress-text', /Done/, 30000);
  for (const [a, n] of [['MD5', 'md5'], ['SHA-1', 'sha1'], ['SHA-256', 'sha256'], ['SHA-384', 'sha384'], ['SHA-512', 'sha512']])
    assert.equal(await kv(page, '#hash-results', a), nodeHash(n, sampleBytes), `file ${a}`);
  assert.match(await txt(page, '#hash-file-info'), /sample\.bin.*2\.5 MB/);
  await page.check('#hash-hmac');
  await page.fill('#hash-key', 'file-key');
  await waitText(page, '#hash-progress-text', /Done/, 30000);
  await waitKv(page, '#hash-results', 'HMAC-SHA-256', crypto.createHmac('sha256', 'file-key').update(sampleBytes).digest('hex'), 30000);
  await page.uncheck('#hash-hmac');
  await waitKv(page, '#hash-results', 'MD5', nodeHash('md5', sampleBytes), 30000);
  await page.fill('#hash-expect', nodeHash('md5', sampleBytes));
  assert.match(await txt(page, '#hash-compare'), /Match.*MD5/);
  await shot('hash-file');
  await page.fill('#hash-expect', '');
  await page.click('#hash-src [data-value="text"]');
  await waitKv(page, '#hash-results', 'MD5', nodeHash('md5', 'what do ya want for nothing?'));

  // ------------------------------------------------------------ UUID / IDs
  log('uuid');
  await openTab(page, 'uuid');
  const lines = async () => (await val(page, '#uuid-out')).split('\n');
  assert.equal((await lines()).length, 5, 'five v4 IDs preloaded');
  for (const id of await lines()) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await page.check('#uuid-upper');
  await page.check('#uuid-nohyph');
  for (const id of await lines()) assert.match(id, /^[0-9A-F]{12}4[0-9A-F]{3}[89AB][0-9A-F]{15}$/);
  await page.uncheck('#uuid-upper');
  await page.uncheck('#uuid-nohyph');
  // v7: version 7, variant 10, monotonic order, readable timestamp
  await page.click('#uuid-type [data-value="v7"]');
  await page.fill('#uuid-count', '1000');
  const t0 = Date.now();
  await page.click('#uuid-gen');
  const v7 = await lines();
  assert.equal(v7.length, 1000);
  assert.equal(new Set(v7).size, 1000, 'unique');
  for (const id of v7) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual([...v7].sort(), v7, 'v7 IDs sort in generation order (monotonic within a millisecond)');
  const ms0 = parseInt(v7[0].replace(/-/g, '').slice(0, 12), 16);
  assert.ok(Math.abs(ms0 - t0) < 5000, 'embedded timestamp is now');
  assert.equal(await val(page, '#uuid-inspect'), v7[0], 'first ID inspected automatically');
  assert.equal(await kv(page, '#uuid-inspect-out', 'Version'), '7 · Unix-time-ordered');
  assert.equal(await kv(page, '#uuid-inspect-out', 'Variant'), 'RFC 9562 / RFC 4122 (10xx)');
  assert.equal(await kv(page, '#uuid-inspect-out', 'Unix ms'), String(ms0));
  assert.ok((await kv(page, '#uuid-inspect-out', 'Timestamp')).startsWith(new Date(ms0).toISOString()));
  // RFC 9562 Appendix A.6 example
  await page.fill('#uuid-inspect', '017F22E2-79B0-7CC3-98C4-DC0C0C07398F');
  assert.match(await kv(page, '#uuid-inspect-out', 'Timestamp'), /^2022-02-22T19:22:22\.000Z/);
  // v1 (RFC 9562 A.1 example) and v4 and errors
  await page.fill('#uuid-inspect', 'C232AB00-9414-11EC-B3C8-9F6BDECED846');
  assert.match(await kv(page, '#uuid-inspect-out', 'Version'), /^1 · time-based/);
  assert.match(await kv(page, '#uuid-inspect-out', 'Timestamp'), /^2022-02-22T19:22:22\.000Z/);
  await page.fill('#uuid-inspect', 'nope');
  assert.match(await txt(page, '#uuid-inspect-status'), /Not a UUID/);
  const dl = await expectDownload(page, () => page.click('#uuid-dl'));
  assert.deepEqual(readDl(dl).toString().trim().split('\n'), v7, 'downloaded IDs match');
  // ULID and Nano ID
  await page.fill('#uuid-count', '50');
  await page.click('#uuid-type [data-value="ulid"]');
  const ul = await lines();
  assert.equal(ul.length, 50);
  for (const id of ul) assert.match(id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.deepEqual([...ul].sort(), ul, 'ULIDs are monotonic');
  assert.equal(await kv(page, '#uuid-inspect-out', 'Type'), 'ULID');
  await page.click('#uuid-type [data-value="nanoid"]');
  for (const id of await lines()) assert.match(id, /^[A-Za-z0-9_-]{21}$/);
  await page.fill('#uuid-nano-size', '12');
  await page.selectOption('#uuid-nano-alpha', 'hex');
  for (const id of await lines()) assert.match(id, /^[0-9a-f]{12}$/);
  await page.click('[data-copy="uuid-out"]');
  await clipIs(page, await val(page, '#uuid-out'), 'copy all IDs');
  await page.fill('#uuid-count', '5');
  await page.click('#uuid-type [data-value="v7"]');

  // ------------------------------------------------------------ Timestamps
  log('time');
  await openTab(page, 'time');
  assert.equal(await val(page, '#time-in'), '1700000000');
  assert.equal(await kv(page, '#time-out', 'ISO 8601 (UTC)'), '2023-11-14T22:13:20Z');
  assert.equal(await kv(page, '#time-out', 'Unix milliseconds'), '1700000000000');
  assert.match(await txt(page, '#time-detect'), /seconds \(10 digits\)/);
  assert.match(await kv(page, '#time-out', 'Relative'), /years? ago/);
  await page.fill('#time-in', '1700000000000');
  assert.match(await txt(page, '#time-detect'), /milliseconds \(13 digits\)/);
  assert.equal(await kv(page, '#time-out', 'ISO 8601 (UTC)'), '2023-11-14T22:13:20Z');
  await page.fill('#time-in', '1700000000123456789');
  assert.match(await txt(page, '#time-detect'), /nanoseconds/);
  assert.equal(await kv(page, '#time-out', 'ISO 8601 (UTC)'), '2023-11-14T22:13:20.123Z');
  await page.fill('#time-zone', 'America/New_York');
  await page.fill('#time-in', '1700000000');
  assert.equal(await kv(page, '#time-out', 'ISO 8601 (America/New_York)'), '2023-11-14T17:13:20-05:00');
  assert.equal(await kv(page, '#time-out', 'RFC 2822 (America/New_York)'), 'Tue, 14 Nov 2023 17:13:20 -0500');
  assert.match(await kv(page, '#time-out', 'Local time (America/New_York)'), /Tuesday, November 14, 2023 at 5:13:20\s?PM EST/);
  // local wall-clock time in the chosen zone → Unix
  await page.fill('#time-in', '2023-11-14 17:13:20');
  assert.equal(await kv(page, '#time-out', 'Unix seconds'), '1700000000');
  assert.match(await txt(page, '#time-detect'), /wall-clock time in America\/New_York/);
  await page.fill('#time-zone', 'Asia/Kolkata');
  await page.fill('#time-in', '2023-11-15T03:43:20');
  assert.equal(await kv(page, '#time-out', 'Unix seconds'), '1700000000');
  await page.fill('#time-in', 'Tue, 14 Nov 2023 22:13:20 +0000');
  assert.equal(await kv(page, '#time-out', 'Unix seconds'), '1700000000');
  assert.match(await txt(page, '#time-detect'), /RFC 2822/);
  await page.fill('#time-in', '2023-11-14T22:13:20Z');
  assert.equal(await kv(page, '#time-out', 'Unix seconds'), '1700000000');
  await page.fill('#time-in', 'yesterday-ish');
  assert.match(await txt(page, '#time-status'), /Could not read that/);
  await page.fill('#time-zone', 'Mars/Olympus');
  assert.match(await txt(page, '#time-status'), /not a time zone/);
  await page.fill('#time-zone', 'UTC');
  await page.fill('#time-in', '1700000000');
  // comparison row
  const zoneTime = (z) => page.$eval(`#time-zones [data-zone="${z}"] .dt-zone-time`, (e) => e.textContent);
  assert.equal(await zoneTime('Asia/Tokyo'), '07:13:20');
  assert.equal(await zoneTime('America/New_York'), '17:13:20');
  await page.fill('#time-add-zone', 'Australia/Adelaide');
  await page.click('#time-add-zone-btn');
  assert.equal(await zoneTime('Australia/Adelaide'), '08:43:20');
  await page.click('#time-zones [data-zone="Australia/Adelaide"] [data-remove]');
  assert.equal(await page.$('#time-zones [data-zone="Australia/Adelaide"]'), null);
  // live clock
  const nowS = Number(await txt(page, '#time-now-s'));
  assert.ok(Math.abs(nowS - Date.now() / 1000) < 3, 'live Unix seconds');
  const ms1 = await txt(page, '#time-now-ms');
  await page.waitForFunction((v) => document.querySelector('#time-now-ms').textContent !== v, ms1, { timeout: 3000 });
  await page.click('#time-use-now');
  assert.ok(Math.abs(Number(await val(page, '#time-in')) - Date.now() / 1000) < 3);
  await page.fill('#time-in', '1700000000');
  await shot('time');

  // ------------------------------------------------------------ Passwords
  log('password');
  await openTab(page, 'password');
  assert.ok(requested.some((u) => /wordlist|password/i.test(u)), 'Passwords code loads when the tab opens');
  const pw = () => txt(page, '#pw-out');
  const listItems = () => page.$$eval('#pw-list code', (els) => els.map((e) => e.textContent));
  assert.equal((await pw()).length, 20, 'default length');
  assert.equal((await listItems()).length, 10, 'generates several at once');
  // only lowercase + digits, length 32
  await page.uncheck('#pw-upper');
  await page.uncheck('#pw-symbols');
  await page.fill('#pw-len-num', '32');
  for (const p of [await pw(), ...(await listItems())]) {
    assert.match(p, /^[a-z0-9]{32}$/, 'length and charset');
    assert.ok(/[a-z]/.test(p) && /[0-9]/.test(p), 'contains every chosen set');
  }
  assert.match(await txt(page, '#pw-strength'), /165\.4 bits/);
  assert.match(await txt(page, '#pw-strength'), /Very strong/);
  // all sets, no look-alikes, custom symbols, min length
  await page.check('#pw-upper');
  await page.check('#pw-symbols');
  await page.check('#pw-ambig');
  await page.fill('#pw-symset', '#$');
  await page.fill('#pw-len-num', '8');
  for (const p of [await pw(), ...(await listItems())]) {
    assert.equal(p.length, 8);
    assert.match(p, /^[a-zA-Z2-9#$]+$/);
    assert.ok(!/[Il1|O0o]/.test(p), 'no look-alikes');
    assert.ok(/[a-z]/.test(p) && /[A-Z]/.test(p) && /[2-9]/.test(p) && /[#$]/.test(p), 'one of each set');
  }
  assert.match(await txt(page, '#pw-strength'), /Weak/);
  await page.selectOption('#pw-count', '50');
  assert.equal((await listItems()).length, 50);
  await page.click('#pw-list li:first-child button');
  await clipIs(page, (await listItems())[0], 'copy one');
  for (const id of ['#pw-lower', '#pw-upper', '#pw-digits', '#pw-symbols']) await page.uncheck(id);
  assert.match(await txt(page, '#pw-strength'), /Choose at least one character set/);
  for (const id of ['#pw-lower', '#pw-upper', '#pw-digits', '#pw-symbols']) await page.check(id);
  await page.fill('#pw-symset', '!@#$%^&*()-_=+[]{};:,.?/~');
  await page.uncheck('#pw-ambig');
  await page.fill('#pw-len-num', '20');
  const before = await pw();
  await page.click('#pw-regen');
  assert.notEqual(await pw(), before, 'regenerates');
  // passphrases
  await page.click('#pw-mode [data-value="passphrase"]');
  await page.fill('#pp-words-num', '6');
  for (const p of [await pw(), ...(await listItems())]) {
    const words = p.split('-');
    assert.equal(words.length, 6, `six words: ${p}`);
    assert.equal((p.match(/\d/g) ?? []).length, 1, 'one digit added');
    for (const w of words) {
      assert.match(w, /^[A-Z][a-z]+\d?$/, 'capitalized');
      assert.ok(WORDS.has(w.replace(/\d/g, '').toLowerCase()), `${w} is from the word list`);
    }
  }
  assert.match(await txt(page, '#pw-strength'), /\d+\.\d bits/);
  await page.selectOption('#pp-sep', ' ');
  await page.uncheck('#pp-cap');
  await page.uncheck('#pp-num');
  await page.fill('#pp-words-num', '4');
  const pp = await pw();
  assert.equal(pp.split(' ').length, 4);
  assert.ok(pp.split(' ').every((w) => WORDS.has(w)));
  assert.match(await txt(page, '#pw-strength'), /44\.0 bits/);
  assert.match(await txt(page, '#pp-info'), /2,048-word list/);
  await page.click('[data-copy="pw-out"]');
  await clipIs(page, pp, 'copy passphrase');
  await page.selectOption('#pw-count', '10');
  await page.check('#pp-cap');
  await page.check('#pp-num');
  await page.selectOption('#pp-sep', '-');
  await page.fill('#pp-words-num', '5');
  await shot('passwords');
  await page.click('#pw-mode [data-value="password"]');

  // ------------------------------------------------------------ Number bases
  log('bases');
  await openTab(page, 'bases');
  assert.equal(await val(page, '#nb-16'), 'DEADBEEF');
  assert.equal(await val(page, '#nb-2'), (3735928559).toString(2));
  assert.equal(await val(page, '#nb-8'), (3735928559).toString(8));
  assert.equal(await kv(page, '#nb-info', 'As signed 32-bit'), '-559038737');
  const big = 2n ** 128n + 12345n;
  await page.fill('#nb-10', big.toString());
  assert.equal(await val(page, '#nb-16'), big.toString(16).toUpperCase());
  assert.equal(await val(page, '#nb-2'), big.toString(2));
  assert.equal(await val(page, '#nb-custom'), big.toString(36));
  assert.match(await kv(page, '#nb-info', 'Safe JS number'), /^No/);
  await page.fill('#nb-16', '-0xFF');
  assert.equal(await val(page, '#nb-10'), '-255');
  assert.equal(await val(page, '#nb-2'), '-11111111');
  assert.equal(await kv(page, '#nb-info', "Two's complement (16-bit)"), '0xFF01');
  await page.fill('#nb-2', '0b1012');
  assert.match(await txt(page, '#nb-status'), /“2” is not a valid base-2 digit/);
  assert.equal(await val(page, '#nb-10'), '-255', 'other fields keep the last valid value');
  await page.fill('#nb-2', '1111_0000');
  assert.equal(await val(page, '#nb-10'), '240');
  await page.selectOption('#nb-custom-base', '7');
  assert.equal(await val(page, '#nb-custom'), (240).toString(7));
  await page.fill('#nb-custom', '-666');
  assert.equal(await val(page, '#nb-10'), String(-(6 * 49 + 6 * 7 + 6)));
  await page.check('#nb-group');
  await page.fill('#nb-10', '1234567890123');
  assert.equal(await val(page, '#nb-16'), '11F 71FB 04CB');
  assert.equal(await val(page, '#nb-2'), (1234567890123).toString(2).padStart(44, '0').replace(/\B(?=(.{4})+$)/g, ' '));
  await page.click('[data-copy="nb-16"]');
  await clipIs(page, '11F 71FB 04CB', 'copy hex');
  await page.uncheck('#nb-group');
  await page.fill('#nb-10', '3735928559');
  // bytes ⇄ units
  assert.equal(await kv(page, '#bu-human', 'Bytes'), '1,610,612,736');
  assert.equal(await kv(page, '#bu-human', 'Human (SI)'), '1.61 GB');
  assert.equal(await kv(page, '#bu-human', 'Human (IEC)'), '1.5 GiB');
  await page.fill('#bu-val', '1');
  await page.selectOption('#bu-unit', '1e9');
  assert.equal(await kv(page, '#bu-human', 'Human (IEC)'), '953.67 MiB');
  await page.fill('#bu-val', 'abc');
  assert.match(await txt(page, '#bu-status'), /Enter a number/);
  await page.fill('#bu-val', '1.5');
  await page.selectOption('#bu-unit', '1073741824');
  await shot('bases');

  // ------------------------------------------------------------ deep links, keyboard
  log('deep links');
  assert.equal(new URL(page.url()).hash, '#bases', 'active tab is in the URL hash');
  await page.goto(`${BASE_URL}/tools/dev-toolkit/#jwt`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#dt-panel-jwt[data-ready]:not([hidden])');
  assert.equal(await page.getAttribute('#dt-tab-jwt', 'aria-selected'), 'true');
  assert.ok(await page.isHidden('#dt-panel-base64'));
  await page.evaluate(() => (location.hash = '#uuid'));
  await page.waitForSelector('#dt-panel-uuid[data-ready]:not([hidden])');
  await page.goto(`${BASE_URL}/tools/dev-toolkit/?x=1#sha256`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#dt-panel-hash[data-ready]:not([hidden])');
  assert.equal(new URL(page.url()).hash, '#hash', 'aliases normalize to the tab name');
  await page.focus('#dt-tab-hash');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#dt-panel-uuid:not([hidden])');
  assert.equal(new URL(page.url()).hash, '#uuid');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dt-tab-uuid');
  await page.goto(`${BASE_URL}/tools/dev-toolkit/`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(new URL(page.url()).hash, '', 'no hash added on a plain visit');
  assert.equal(await page.getAttribute('#dt-tab-base64', 'aria-selected'), 'true');
});

// ================================================================ phone viewport
await runToolTest(
  'dev-toolkit',
  async ({ page, shot }) => {
    await page.waitForSelector('#dt[data-ready]');
    assert.ok(await page.isVisible('#dt-tab-select'), 'tab picker visible on phones');
    for (const t of ['base64', 'url', 'html', 'jwt', 'hash', 'uuid', 'time', 'password', 'bases']) {
      await page.selectOption('#dt-tab-select', t);
      await page.waitForSelector(`#dt-panel-${t}[data-ready]:not([hidden])`);
      assert.equal(new URL(page.url()).hash, `#${t}`);
      await page.waitForTimeout(150);
      await noOverflow(page, `mobile ${t}`);
      if (['base64', 'url', 'jwt', 'time', 'password'].includes(t)) await shot(`mobile-${t}`);
    }
    // a long unbroken token must wrap, not overflow
    await page.selectOption('#dt-tab-select', 'jwt');
    await page.fill('#jwt-in', `${'eyJ'.repeat(10)}.${'x'.repeat(400)}.sig`);
    await noOverflow(page, 'mobile long token');
  },
  { viewport: { width: 390, height: 844 } },
);

// ================================================================ dark theme
await runToolTest(
  'dev-toolkit',
  async ({ page, shot }) => {
    await page.waitForSelector('#dt[data-ready] #dt-panel-base64[data-ready]');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(bg, 'rgb(247, 247, 245)', 'dark background');
    await shot('dark-base64');
    for (const t of ['jwt', 'hash', 'time', 'password']) {
      await openTab(page, t);
      await page.waitForTimeout(150);
      await shot(`dark-${t}`);
    }
  },
  { colorScheme: 'dark' },
);

// Layout regressions: page-level overrides must beat the shared .tabs / .select rules.
await runToolTest('dev-toolkit', async ({ page, BASE_URL }) => {
  await page.goto(`${BASE_URL}/tools/dev-toolkit/#jwt`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#jwt-secret');
  const r = await page.evaluate(() => {
    const input = document.querySelector('#jwt-secret').getBoundingClientRect();
    const sel = document.querySelector('#jwt-secret-enc').getBoundingClientRect();
    const card = document.querySelector('#jwt-secret').closest('.card, .dt-card').getBoundingClientRect();
    return { input: input.width, selRight: sel.right, cardRight: card.right };
  });
  assert.ok(r.input > 200, `JWT secret input is squashed (${r.input}px wide)`);
  assert.ok(r.selRight <= r.cardRight, 'secret encoding select overflows its card');
});
await runToolTest(
  'dev-toolkit',
  async ({ page }) => {
    assert.equal(await page.isVisible('.dt-tabs'), false, 'tab bar should be hidden on phones');
    assert.equal(await page.isVisible('#dt-tab-select'), true, 'tool select should be visible on phones');
  },
  { viewport: { width: 390, height: 844 } },
);
