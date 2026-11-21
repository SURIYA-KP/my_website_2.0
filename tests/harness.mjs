// Shared Playwright harness for tool tests.
//
// Usage (tests/<slug>.test.mjs):
//   import { runToolTest, assert } from './harness.mjs';
//   await runToolTest('json-studio', async ({ page, shot }) => {
//     await page.fill('#input', '{"a":1}');
//     assert.equal(await page.textContent('#status'), 'Valid JSON');
//     await shot('formatted');
//   });
//
// Every test automatically fails if the page:
//   - makes a network request to any origin other than the local server,
//   - throws an uncaught error, or logs console.error (unless `allowConsoleErrors` matches),
//   - leaves anything in localStorage / sessionStorage / IndexedDB / cookies.
import { createRequire } from 'node:module';
// Uses the machine's pre-installed Playwright (resolved like require() does, honoring NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { assert };
export const BASE_URL = process.env.BASE_URL || 'http://localhost:4321';
const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.join(here, 'output');
export const FIXTURES = path.join(here, 'fixtures');

export async function runToolTest(slug, fn, opts = {}) {
  const { viewport = { width: 1366, height: 900 }, allowConsoleErrors = [], colorScheme = 'light' } = opts;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const base = new URL(BASE_URL);
  const external = [];
  const errors = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (['data:', 'blob:', 'about:'].includes(u.protocol)) return;
    if (u.host !== base.host) external.push(req.url());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (allowConsoleErrors.some((re) => re.test(text))) return;
    errors.push(`console.error: ${text}`);
  });
  let n = 0;
  const shot = async (name) => {
    const file = path.join(OUT_DIR, `${slug}-${String(++n).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };
  const started = Date.now();
  try {
    await page.goto(`${BASE_URL}/tools/${slug}/`, { waitUntil: 'networkidle' });
    await fn({ page, context, browser, shot, slug, BASE_URL });

    const storage = await page.evaluate(async () => {
      const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
      return { local: localStorage.length, session: sessionStorage.length, dbs, cookie: document.cookie };
    });
    assert.equal(storage.local, 0, 'localStorage must stay empty');
    assert.equal(storage.session, 0, 'sessionStorage must stay empty');
    assert.deepEqual(storage.dbs, [], 'IndexedDB must stay empty');
    assert.equal(storage.cookie, '', 'cookies must stay empty');
    assert.deepEqual(external, [], `external network requests are not allowed:\n${external.join('\n')}`);
    assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`);
    console.log(`PASS ${slug} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    try { await shot('FAILURE'); } catch {}
    console.error(`FAIL ${slug}\n${e?.stack || e}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

/** Wait for a download triggered by `action` and return { filename, path, size }. */
export async function expectDownload(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download'), action()]);
  const file = path.join(OUT_DIR, `dl-${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  return { filename: dl.suggestedFilename(), path: file, size: fs.statSync(file).size };
}
