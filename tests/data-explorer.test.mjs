import { runToolTest, assert, expectDownload, FIXTURES } from './harness.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Papa = require('papaparse');

// Fixture files are generated here on every run (safe to gitignore).
const FIX = path.join(FIXTURES, 'data-explorer');
fs.mkdirSync(FIX, { recursive: true });
const log = process.env.DX_DEBUG ? (m) => console.log(`  · ${m}`) : () => {};

// ---------------------------------------------------------------- fixtures
const TRICKY = [
  'id,name,city,amount,joined,active,notes',
  '1,"Smith, John",Zürich,10.5,2024-01-15,true,"line one',
  'line two"',
  '2,Ana,São Paulo,,2024-02-01,false,plain',
  '3,"Quote ""Q"" Lee",東京,30.25,2024-03-10,yes,',
  '4,Émile,Kraków,-4,2024-04-05,no,"comma, inside"',
  '5,,Oslo,100,,true,🎉 party',
].join('\n');
const TRICKY_SEMI = [
  'id;name;city;amount;joined;active;notes',
  '1;"Smith; John";Zürich;10,5;2024-01-15;true;"line one',
  'line two"',
  '2;Ana;São Paulo;;2024-02-01;false;plain',
  '3;"Quote ""Q"" Lee";東京;30,25;2024-03-10;yes;',
  '4;Émile;Kraków;-4;2024-04-05;no;"semi; inside"',
  '5;;Oslo;100;;true;🎉 party',
].join('\r\n');
const EXPECTED_TYPES = { id: 'integer', name: 'string', city: 'string', amount: 'float', joined: 'date', active: 'boolean', notes: 'string' };
const JSON_ROWS = [
  { sku: 'A-1', price: 9.99, qty: 3, inStock: true, added: '2025-01-02', dims: { w: 10, h: 4 } },
  { sku: 'B-2', price: 24.5, qty: 0, inStock: false, added: '2025-02-11', dims: { w: 3, h: 7 } },
  { sku: 'C-3', price: null, qty: 12, inStock: true, added: '2025-03-30', dims: { w: 8, h: 8 } },
];
const NDJSON = ['{"user":"ada","score":91,"ts":"2025-05-01T10:00:00Z"}', '{"user":"linus","score":78,"ts":"2025-05-01T11:30:00Z"}', '', '{"user":"grace","score":99.5,"ts":"2025-05-02T09:15:00Z"}'].join('\n');

const files = {
  tricky: path.join(FIX, 'tricky.csv'),
  semi: path.join(FIX, 'tricky-semicolon.csv'),
  json: path.join(FIX, 'products.json'),
  ndjson: path.join(FIX, 'scores.ndjson'),
  big: path.join(FIX, 'big-200k.csv'),
};
fs.writeFileSync(files.tricky, TRICKY);
fs.writeFileSync(files.semi, TRICKY_SEMI);
fs.writeFileSync(files.json, JSON.stringify(JSON_ROWS, null, 2));
fs.writeFileSync(files.ndjson, NDJSON);

const BIG_ROWS = 200_000;
function makeBig() {
  // 200k rows x 20 columns, deterministic.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cats = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  const head = ['row_id', 'day', 'category', 'flag', 'label'];
  for (let i = 1; i <= 10; i++) head.push(`m${i}`);
  for (let i = 1; i <= 5; i++) head.push(`n${i}`);
  const lines = [head.join(',')];
  const start = Date.UTC(2020, 0, 1);
  for (let r = 0; r < BIG_ROWS; r++) {
    const d = new Date(start + (r % 1500) * 86400000).toISOString().slice(0, 10);
    const row = [r + 1, d, cats[r % cats.length], r % 3 === 0 ? 'true' : 'false', `item ${r % 997}`];
    for (let i = 0; i < 10; i++) row.push((rnd() * 1000).toFixed(2));
    for (let i = 0; i < 5; i++) row.push(Math.floor(rnd() * 500));
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}
if (!fs.existsSync(files.big) || fs.statSync(files.big).size < 1e6) fs.writeFileSync(files.big, makeBig());

// ---------------------------------------------------------------- helpers
const dsRev = (page, key) => page.$eval('#dx', (e, k) => Number(e.dataset[k] || 0), key);
/** Run an action and wait for a #dx data-* counter to increase. */
async function after(page, key, fn, timeout = 30000) {
  const r = await dsRev(page, key);
  await fn();
  await page.waitForFunction(([k, r]) => Number(document.querySelector('#dx').dataset[k] || 0) > r, [key, r], { timeout });
}
const chartRev = (page) => page.$eval('#dx-chart-panel', (e) => Number(e.dataset.chartRev || 0));
async function chartAfter(page, fn) {
  const r = await chartRev(page);
  await fn();
  await page.waitForFunction((r) => Number(document.querySelector('#dx-chart-panel').dataset.chartRev || 0) > r, r, { timeout: 30000 });
}
const fileInput = '#dx-drop input[type=file]';
const loadFile = (page, f) => after(page, 'rev', () => page.setInputFiles(fileInput, f));
const loadSample = (page, id) => after(page, 'rev', () => page.click(`[data-sample="${id}"]`));
const headers = (page, sel = '#dx-grid') =>
  page.$$eval(`${sel} .dx-hcell`, (hs) => hs.map((h) => ({ name: h.querySelector('.dx-hname').textContent, type: h.dataset.type, c: Number(h.dataset.c) })));
const colIndex = async (page, name, sel = '#dx-grid') => {
  const h = (await headers(page, sel)).find((x) => x.name === name);
  assert.ok(h, `column ${name} should be visible`);
  return h.c;
};
/** Text of the rendered rows (in view order), one array of cell texts per row, keyed by column name. */
const rows = (page, sel = '#dx-grid', n = 8) =>
  page.$eval(
    sel,
    (root, n) => {
      const names = Array.from(root.querySelectorAll('.dx-hcell')).map((h) => h.querySelector('.dx-hname').textContent);
      return Array.from(root.querySelectorAll('.dx-body .dx-row:not([hidden])'))
        .sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i))
        .slice(0, n)
        .map((r) => Object.fromEntries(Array.from(r.children).slice(1).map((c, i) => [names[i], c.textContent])));
    },
    n,
  );
const count = async (page) => (await page.textContent('#dx-count')).replace(/\s+/g, ' ').trim();
const shown = async (page) => Number((await count(page)).match(/Showing ([\d,]+)/)[1].replace(/,/g, ''));
const stat = (page, key) => page.$eval(`#dx-prof-body [data-stat="${key}"] dd`, (d) => d.textContent.trim());
const read = (f) => fs.readFileSync(f.path, 'utf8');
const parseCsv = (text) => Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data;
const noOverflow = async (page, label) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w, `${label}: page has horizontal overflow (${o.sw} > ${o.w})`);
};
const tab = async (page, name) => {
  await page.click(`[data-tabs="dx"] [data-tab="${name}"]`);
  await page.waitForSelector(`[data-tabpanel="dx:${name}"]:not([hidden])`);
};
/** Fraction of canvas pixels that differ from the background colour (top-left pixel). */
const inkRatio = (page) =>
  page.$eval('#dx-chart', (c) => {
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const [r0, g0, b0] = [data[0], data[1], data[2]];
    let ink = 0;
    for (let i = 0; i < data.length; i += 16) if (Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) > 40) ink++;
    return ink / (data.length / 16);
  });
const setSelect = (page, sel, value) => page.selectOption(sel, String(value));
const runSql = async (page, sql) => {
  await page.fill('#dx-sql', sql);
  await after(page, 'sqlRev', () => page.press('#dx-sql', 'Control+Enter'));
};
const openFilter = async (page, name) => {
  const c = await colIndex(page, name);
  await page.click(`#dx-grid .dx-fbtn[data-c="${c}"]`);
  await page.waitForSelector('#dx-pop:not([hidden])');
};

// ================================================================ desktop: main flow
await runToolTest('data-explorer', async ({ page, shot }) => {
  await page.waitForSelector('#dx[data-ready]');

  // ---------- empty state
  log('empty state');
  assert.ok(await page.isVisible('#dx-drop'), 'dropzone visible before data is loaded');
  assert.equal(await page.locator('[data-sample]').count(), 3, 'three sample datasets offered');
  assert.match(await page.textContent('.dx-privacy'), /never leaves this device/);
  assert.ok(!(await page.isVisible('#dx-work')), 'workspace hidden until data is loaded');
  await shot('empty');

  // ---------- tricky CSV: quotes, embedded newlines, empty cells, unicode
  log('tricky csv');
  await loadFile(page, files.tricky);
  let hs = await headers(page);
  assert.deepEqual(Object.fromEntries(hs.map((h) => [h.name, h.type])), EXPECTED_TYPES, 'inferred column types (comma CSV)');
  assert.match(await page.textContent('#dx-ds-meta'), /5 rows · 7 columns/);
  assert.match(await count(page), /Showing 5 of 5 rows/);
  let r = await rows(page);
  assert.equal(r[0].name, 'Smith, John', 'quoted comma kept in one cell');
  assert.match(r[0].notes, /line one ↵ line two/, 'newline inside quotes stays in the cell');
  assert.equal(r[2].name, 'Quote "Q" Lee', 'escaped quotes');
  assert.equal(r[2].city, '東京', 'unicode');
  assert.equal(r[4].notes, '🎉 party');
  assert.equal(r[1].amount, '—', 'empty numeric cell shown as missing');
  assert.equal(r[4].name, '—', 'empty text cell shown as missing');
  assert.equal(r[0].joined, '2024-01-15');
  assert.equal(r[2].active, 'true', '"yes" read as boolean true');
  assert.equal(r[3].amount, '-4');

  // ---------- profile: mean / median of a known column
  log('profile');
  await after(page, 'profRev', () => setSelect(page, '#dx-prof-col', hs.find((h) => h.name === 'amount').c));
  assert.equal(await stat(page, 'mean'), '34.1875', 'mean of amount');
  assert.equal(await stat(page, 'median'), '20.375', 'median of amount');
  assert.equal(await stat(page, 'min'), '-4');
  assert.equal(await stat(page, 'max'), '100');
  assert.match(await stat(page, 'missing'), /^1 \(20\.0%\)$/, 'missing count and percent');
  assert.equal(await stat(page, 'unique'), '4');
  assert.ok(await page.isVisible('#dx-prof-body .dx-hist'), 'histogram shown for a numeric column');
  // click a cell to profile its column
  await after(page, 'profRev', () => page.click('#dx-grid .dx-body .dx-row[data-i="0"] .dx-cell[data-c="2"]'));
  assert.equal(await page.textContent('.dx-prof-name'), 'city');
  assert.equal(await stat(page, 'unique'), '5');
  assert.ok(await page.isVisible('#dx-prof-body .dx-top'), 'top values for a text column');
  await after(page, 'profRev', () => setSelect(page, '#dx-prof-col', hs.find((h) => h.name === 'joined').c));
  assert.equal(await stat(page, 'min'), '2024-01-15', 'date range: earliest');
  assert.equal(await stat(page, 'max'), '2024-04-05', 'date range: latest');

  // ---------- sort (missing values last)
  log('sort');
  const amountC = await colIndex(page, 'amount');
  await after(page, 'viewRev', () => page.click(`#dx-grid .dx-hcell[data-c="${amountC}"] .dx-hbtn`));
  r = await rows(page);
  assert.deepEqual(r.map((x) => x.amount), ['-4', '10.5', '30.25', '100', '—'], 'ascending numeric sort, missing last');
  assert.equal(await page.getAttribute(`#dx-grid .dx-hcell[data-c="${amountC}"]`, 'aria-sort'), 'ascending');
  await after(page, 'viewRev', () => page.click(`#dx-grid .dx-hcell[data-c="${amountC}"] .dx-hbtn`));
  r = await rows(page);
  assert.deepEqual(r.map((x) => x.amount), ['100', '30.25', '10.5', '-4', '—'], 'descending');
  await after(page, 'viewRev', () => page.click(`#dx-grid .dx-hcell[data-c="${amountC}"] .dx-hbtn`));
  r = await rows(page);
  assert.deepEqual(r.map((x) => x.id), ['1', '2', '3', '4', '5'], 'third click restores the original order');

  // ---------- semicolon-delimited version with decimal commas
  log('semicolon csv');
  await loadFile(page, files.semi);
  hs = await headers(page);
  assert.deepEqual(Object.fromEntries(hs.map((h) => [h.name, h.type])), EXPECTED_TYPES, 'inferred column types (semicolon CSV)');
  assert.match(await page.textContent('#dx-ds-meta'), /semicolon-separated/);
  assert.match(await page.textContent('#dx-ds-meta'), /decimal commas/);
  r = await rows(page);
  assert.equal(r[0].name, 'Smith; John');
  assert.equal(r[0].amount, '10.5', 'decimal comma parsed as a number');
  assert.equal(r[3].notes, 'semi; inside');
  assert.match(await page.textContent('#dx-delim option[value="auto"]'), /semicolon/);
  // Forcing a different delimiter re-parses the same file
  await after(page, 'rev', () => setSelect(page, '#dx-delim', ','));
  hs = await headers(page);
  assert.equal(hs[0].name, 'id;name;city;amount;joined;active;notes', 'comma delimiter on a semicolon file: the whole header is one field');
  assert.equal(await page.inputValue('#dx-delim'), ',');
  await after(page, 'rev', () => setSelect(page, '#dx-delim', 'auto'));
  assert.equal((await headers(page)).length, 7);
  await shot('tricky-semicolon');

  // ---------- JSON + NDJSON
  log('json');
  await loadFile(page, files.json);
  hs = await headers(page);
  assert.deepEqual(
    Object.fromEntries(hs.map((h) => [h.name, h.type])),
    { sku: 'string', price: 'float', qty: 'integer', inStock: 'boolean', added: 'date', 'dims.w': 'integer', 'dims.h': 'integer' },
    'JSON array of objects (nested objects flattened)',
  );
  assert.match(await page.textContent('#dx-ds-meta'), /3 rows · 7 columns.*JSON/);
  log('ndjson');
  await loadFile(page, files.ndjson);
  hs = await headers(page);
  assert.deepEqual(Object.fromEntries(hs.map((h) => [h.name, h.type])), { user: 'string', score: 'float', ts: 'date' }, 'NDJSON');
  r = await rows(page);
  assert.deepEqual(r.map((x) => x.user), ['ada', 'linus', 'grace']);
  assert.equal(r[1].ts, '2025-05-01 11:30');

  // ---------- paste: pipe-delimited text (auto-detected) and JSON
  log('paste');
  await page.click('#dx-paste-btn');
  await page.waitForSelector('#dx-paste[open]');
  await page.fill('#dx-paste-text', 'city|population|capital\nLagos|15388000|no\nNairobi|4397073|yes\nAccra|2514000|yes\n');
  await after(page, 'rev', () => page.click('#dx-paste-load'));
  hs = await headers(page);
  assert.deepEqual(hs.map((h) => `${h.name}:${h.type}`), ['city:string', 'population:integer', 'capital:boolean'], 'pipe-delimited paste');
  assert.match(await page.textContent('#dx-ds-meta'), /pipe-separated/);
  await page.click('#dx-paste-btn');
  await page.fill('#dx-paste-text', JSON.stringify([{ a: 1, b: 'x' }, { a: 2.5, b: 'y' }]));
  await after(page, 'rev', () => page.press('#dx-paste-text', 'Control+Enter'));
  hs = await headers(page);
  assert.deepEqual(hs.map((h) => `${h.name}:${h.type}`), ['a:float', 'b:string'], 'pasted JSON');

  // ---------- error path: invalid JSON shows a clear message, keeps the current data
  log('error path');
  const bad = path.join(FIX, 'broken.json');
  fs.writeFileSync(bad, '[{"a": 1}, {"a": ]');
  await after(page, 'errors', () => page.setInputFiles(fileInput, bad));
  assert.match(await page.textContent('#dx-error'), /Could not open broken\.json: .*valid JSON/);
  assert.equal((await headers(page)).length, 2, 'previous dataset stays loaded after an error');
  const empty = path.join(FIX, 'empty.csv');
  fs.writeFileSync(empty, '');
  await after(page, 'errors', () => page.setInputFiles(fileInput, empty));
  assert.match(await page.textContent('#dx-error'), /empty/i);

  // ---------- sales sample: multi-sort, filters, search, columns, exports
  log('sales sample');
  await after(page, 'rev', () => setSelect(page, '#dx-sample-sel', 'sales'));
  assert.ok(await page.isHidden('#dx-error'), 'error cleared after a successful load');
  assert.match(await count(page), /Showing 2,000 of 2,000 rows/);
  hs = await headers(page);
  assert.equal(hs.length, 12);
  assert.equal(hs.find((h) => h.name === 'Order Date').type, 'date');
  assert.equal(hs.find((h) => h.name === 'Returned').type, 'boolean');
  assert.equal(hs.find((h) => h.name === 'Revenue').type, 'float');
  assert.equal(hs.find((h) => h.name === 'Units').type, 'integer');
  assert.equal(await page.textContent('.dx-prof-name'), 'Revenue', 'profile defaults to the main measure');
  assert.match((await rows(page))[0]['Order ID'], /^\d{5}$/, 'ID columns are shown without digit grouping');

  // Full export (baseline for later checks)
  let dl = await expectDownload(page, () => page.click('#dx-exp-csv'));
  assert.equal(dl.filename, 'sales-orders.csv');
  const all = parseCsv(read(dl));
  assert.equal(all.length, 2000, 'full CSV export has every row');
  assert.deepEqual(Object.keys(all[0]), hs.map((h) => h.name), 'CSV header = visible columns in order');

  // Multi-sort: Region asc, then Shift+click Units desc
  const regionC = await colIndex(page, 'Region');
  const unitsC = await colIndex(page, 'Units');
  await after(page, 'viewRev', () => page.click(`#dx-grid .dx-hcell[data-c="${regionC}"] .dx-hbtn`));
  await after(page, 'viewRev', () => page.click(`#dx-grid .dx-hcell[data-c="${unitsC}"] .dx-hbtn`, { modifiers: ['Shift'] }));
  await after(page, 'viewRev', () => page.click(`#dx-grid .dx-hcell[data-c="${unitsC}"] .dx-hbtn`, { modifiers: ['Shift'] }));
  assert.equal(await page.getAttribute(`#dx-grid .dx-hcell[data-c="${unitsC}"]`, 'aria-sort'), 'descending');
  assert.equal(await page.getAttribute(`#dx-grid .dx-hcell[data-c="${regionC}"]`, 'aria-sort'), 'ascending', 'shift-click keeps the first sort');
  assert.match(await page.textContent(`#dx-grid .dx-hcell[data-c="${unitsC}"] .dx-sort`), /▼2/, 'sort priority shown');
  dl = await expectDownload(page, () => page.click('#dx-exp-csv'));
  let out = parseCsv(read(dl));
  const expectSorted = [...all].sort((a, b) => (a.Region < b.Region ? -1 : a.Region > b.Region ? 1 : 0) || Number(b.Units) - Number(a.Units)); // stable: ties keep file order
  assert.deepEqual(out.map((x) => x['Order ID']), expectSorted.map((x) => x['Order ID']), 'exported rows follow the multi-column sort');
  r = await rows(page, '#dx-grid', 3);
  assert.equal(r[0].Region, 'Central');
  assert.equal(r[0].Units, String(Math.max(...all.filter((x) => x.Region === 'Central').map((x) => Number(x.Units)))));

  // Category filter: Region = North
  await openFilter(page, 'Region');
  assert.equal(await page.locator('#dx-pop .dx-pick').count(), 5, 'five regions to pick from');
  await after(page, 'viewRev', () => page.click('#dx-pop [data-all="0"]'));
  assert.match(await count(page), /Showing 0 of 2,000/);
  assert.ok(await page.isVisible('#dx-grid .dx-noresults'), 'empty-result message');
  await after(page, 'viewRev', () => page.check('#dx-pop .dx-pick[data-v="north"] input'));
  await page.click('#dx-pop [data-act="done"]');
  const northN = all.filter((x) => x.Region === 'North').length;
  assert.equal(await shown(page), northN, 'category filter count');
  assert.ok(await page.isVisible(`#dx-grid .dx-fbtn.is-active[data-c="${regionC}"]`), 'filter button shows active state');
  assert.match(await page.textContent('#dx-chips'), /Region is North/);

  // Numeric range: Units >= 5
  await openFilter(page, 'Units');
  await page.fill('#dx-pop [data-k="min"]', '5');
  await after(page, 'viewRev', () => page.press('#dx-pop [data-k="min"]', 'Enter'));
  const expNU = all.filter((x) => x.Region === 'North' && Number(x.Units) >= 5);
  assert.equal(await shown(page), expNU.length, 'numeric range filter');
  assert.match(await page.textContent('#dx-chips'), /Units ≥ 5/);

  // Date range: first half of 2024
  await openFilter(page, 'Order Date');
  await page.fill('#dx-pop [data-k="min"]', '2024-03-01');
  await page.fill('#dx-pop [data-k="max"]', '2024-06-30');
  await after(page, 'viewRev', () => page.press('#dx-pop [data-k="max"]', 'Enter'));
  const expDate = expNU.filter((x) => x['Order Date'] >= '2024-03-01' && x['Order Date'] <= '2024-06-30');
  assert.equal(await shown(page), expDate.length, 'date range filter (inclusive end date)');

  // Text contains: Product contains "lamp"
  await openFilter(page, 'Product');
  await page.click('#dx-pop [data-mode="text"]');
  await page.fill('#dx-pop [data-k="q"]', 'lamp');
  await after(page, 'viewRev', () => page.press('#dx-pop [data-k="q"]', 'Enter'));
  const expText = expDate.filter((x) => /lamp/i.test(x.Product));
  assert.ok(expText.length > 0, 'fixture sanity: some lamps sold');
  assert.equal(await shown(page), expText.length, 'text contains filter');
  for (const row of await rows(page, '#dx-grid', 50)) {
    assert.equal(row.Region, 'North');
    assert.match(row.Product, /lamp/i);
  }
  // Export filtered + sorted rows as JSON and CSV
  dl = await expectDownload(page, () => page.click('#dx-exp-json'));
  assert.equal(dl.filename, 'sales-orders-filtered.json');
  const js = JSON.parse(read(dl));
  const expJs = [...expText].sort((a, b) => Number(b.Units) - Number(a.Units));
  assert.deepEqual(js.map((x) => x['Order ID']), expJs.map((x) => Number(x['Order ID'])), 'JSON export = filtered rows in sorted order');
  assert.equal(typeof js[0].Revenue, 'number');
  assert.equal(typeof js[0].Returned, 'boolean');
  assert.match(js[0]['Order Date'], /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(js[0]), hs.map((h) => h.name));
  await shot('filtered');

  // Profile follows the filters
  assert.match(await page.textContent('.dx-prof-scope'), new RegExp(`${expText.length} filtered rows of 2,000`));

  // Remove one chip, then clear all
  await after(page, 'viewRev', () => page.click('#dx-chips .dx-chip:last-child .dx-chip-x'));
  assert.equal(await shown(page), expDate.length, 'removing the text chip restores those rows');
  await after(page, 'viewRev', () => page.click('#dx-clear'));
  assert.equal(await shown(page), 2000);
  assert.ok(await page.isHidden('#dx-chips'));

  // Global search
  await page.fill('#dx-search', 'kraków');
  await page.waitForFunction(() => /Showing 0 of/.test(document.querySelector('#dx-count').textContent));
  await page.fill('#dx-search', 'mei chen');
  await page.waitForFunction(() => !/Showing (0|2,000) of/.test(document.querySelector('#dx-count').textContent));
  assert.equal(await shown(page), all.filter((x) => x['Sales Rep'] === 'Mei Chen').length, 'global search');
  await after(page, 'viewRev', () => page.click('#dx-chips .dx-chip-x'));
  assert.equal(await page.inputValue('#dx-search'), '', 'clearing the search chip empties the box');

  // Column show/hide
  await page.click('#dx-cols-btn');
  await page.waitForSelector('#dx-pop:not([hidden])');
  await page.uncheck('#dx-pop .dx-pick:has-text("Sales Rep") input');
  await page.uncheck('#dx-pop .dx-pick:has-text("Discount") input');
  await page.keyboard.press('Escape');
  assert.ok(await page.isHidden('#dx-pop'), 'Escape closes the popover');
  hs = await headers(page);
  assert.equal(hs.length, 10);
  assert.ok(!hs.some((h) => h.name === 'Sales Rep'));
  assert.match(await page.textContent('#dx-cols-n'), /10\/12/);
  dl = await expectDownload(page, () => page.click('#dx-exp-csv'));
  out = parseCsv(read(dl));
  assert.ok(!('Sales Rep' in out[0]) && !('Discount' in out[0]), 'hidden columns are not exported');
  await page.click('#dx-cols-btn');
  await page.click('#dx-pop [data-all="1"]');
  await page.keyboard.press('Escape');
  assert.equal((await headers(page)).length, 12);

  // Number format
  await page.selectOption('#dx-numfmt', 'fixed2');
  r = await rows(page, '#dx-grid', 1);
  assert.match(r[0].Revenue, /^\d{1,3}(,\d{3})*\.\d{2}$/, 'two-decimal number format');
  await page.selectOption('#dx-numfmt', 'auto');
  await shot('table');

  // ---------- charts
  log('charts');
  await chartAfter(page, () => tab(page, 'chart'));
  assert.ok(await page.isHidden('#dx-ch-error'), 'default chart renders');
  assert.ok((await inkRatio(page)) > 0.02, 'bar chart has visible pixels');
  assert.match(await page.getAttribute('#dx-chart', 'aria-label'), /Sum of Revenue by Region/);
  await shot('chart-bar');
  dl = await expectDownload(page, () => page.click('#dx-ch-png'));
  const png = fs.readFileSync(dl.path);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'valid PNG signature');
  assert.equal(png.subarray(12, 16).toString(), 'IHDR');
  assert.ok(png.readUInt32BE(16) > 300 && png.readUInt32BE(20) > 200, 'PNG has real dimensions');
  assert.match(dl.filename, /\.png$/);

  // group by
  await chartAfter(page, () => setSelect(page, '#dx-ch-group', hs.find((h) => h.name === 'Category').c));
  assert.ok(await page.isHidden('#dx-ch-error'));
  // scatter
  await chartAfter(page, () => page.click('[data-ctype="scatter"]'));
  await chartAfter(page, () => setSelect(page, '#dx-ch-x', hs.find((h) => h.name === 'Units').c));
  await chartAfter(page, () => setSelect(page, '#dx-ch-y', hs.find((h) => h.name === 'Revenue').c));
  assert.ok(await page.isHidden('#dx-ch-error'), 'scatter renders');
  assert.ok((await inkRatio(page)) > 0.01, 'scatter chart has visible pixels');
  assert.match(await page.getAttribute('#dx-chart', 'aria-label'), /Revenue vs Units/);
  await shot('chart-scatter');
  // histogram, line (dates bucketed), pie, doughnut
  await chartAfter(page, () => page.click('[data-ctype="histogram"]'));
  assert.ok(await page.isHidden('#dx-ch-error'), 'histogram renders');
  assert.ok((await inkRatio(page)) > 0.02);
  await chartAfter(page, () => page.click('[data-ctype="line"]'));
  await chartAfter(page, () => setSelect(page, '#dx-ch-x', hs.find((h) => h.name === 'Order Date').c));
  assert.ok(await page.isVisible('[data-f="bucket"]'), 'date step control for a date X axis');
  await chartAfter(page, () => setSelect(page, '#dx-ch-bucket', 'month'));
  assert.match(await page.getAttribute('#dx-chart', 'aria-label'), /\(month\)/);
  assert.ok((await inkRatio(page)) > 0.01, 'line chart has visible pixels');
  await chartAfter(page, () => page.click('[data-ctype="pie"]'));
  await chartAfter(page, () => setSelect(page, '#dx-ch-x', hs.find((h) => h.name === 'Category').c));
  assert.ok(await page.isHidden('[data-f="group"]'), 'pie has no group-by');
  assert.ok((await inkRatio(page)) > 0.05, 'pie chart has visible pixels');
  await chartAfter(page, () => page.click('[data-ctype="doughnut"]'));
  await chartAfter(page, () => setSelect(page, '#dx-ch-agg', 'mean'));
  assert.match(await page.getAttribute('#dx-chart', 'aria-label'), /Mean of Revenue by Category/);
  await shot('chart-doughnut');
  await chartAfter(page, () => page.click('[data-ctype="bar"]'));
  // theme change redraws the chart with the new colours
  const bgBefore = await page.$eval('#dx-chart', (c) => Array.from(c.getContext('2d').getImageData(2, 2, 1, 1).data.slice(0, 3)));
  await chartAfter(page, () => page.evaluate(() => (document.documentElement.dataset.theme = 'dark')));
  const bgAfter = await page.$eval('#dx-chart', (c) => Array.from(c.getContext('2d').getImageData(2, 2, 1, 1).data.slice(0, 3)));
  assert.deepEqual(bgBefore, [255, 255, 255], 'light chart background');
  assert.deepEqual(bgAfter, [0x19, 0x19, 0x1c], 'chart redrawn with the dark background');
  await shot('chart-dark-toggle');
  await chartAfter(page, () => page.evaluate(() => (document.documentElement.dataset.theme = 'light')));
  // Chart follows the table filters
  await tab(page, 'table');
  await openFilter(page, 'Region');
  await after(page, 'viewRev', () => page.click('#dx-pop [data-all="0"]'));
  await after(page, 'viewRev', () => page.check('#dx-pop .dx-pick[data-v="west"] input'));
  await page.keyboard.press('Escape');
  await chartAfter(page, () => tab(page, 'chart'));
  assert.match(await page.textContent('#dx-ch-note'), new RegExp(`${all.filter((x) => x.Region === 'West').length} filtered rows`));
  await tab(page, 'table');
  await after(page, 'viewRev', () => page.click('#dx-clear'));
  assert.equal(await shown(page), 2000, 'clear filters right after picking values');
  await page.waitForTimeout(300); // a late debounced edit must not bring the filter back
  assert.equal(await shown(page), 2000);

  // ---------- SQL
  log('sql');
  await after(page, 'sqlRev', () => tab(page, 'sql'), 60000); // lazy-loads alasql and runs the example
  assert.ok(await page.isHidden('#dx-sql-error'), 'example query runs');
  assert.equal(await page.textContent('#dx-sql-filtered-label'), 'Only the filtered rows');
  assert.match(await page.inputValue('#dx-sql'), /GROUP BY Region/);
  assert.match(await page.textContent('#dx-sql-quote'), /\[Order ID\]|\[Order Date\]|\[Sales Rep\]/, 'quoting hint uses a real column');
  assert.equal(await page.locator('#dx-sql-cols .dx-sql-col').count(), 12);
  assert.ok(await page.locator('#dx-sql-cols [data-ins="[Unit Price]"]').count(), 'columns with spaces are offered quoted');

  await runSql(page, 'SELECT Region, COUNT(*) AS n, ROUND(SUM(Revenue), 2) AS revenue, ROUND(AVG([Unit Price]), 4) AS avg_price\nFROM data\nGROUP BY Region\nORDER BY Region');
  assert.ok(await page.isHidden('#dx-sql-error'));
  assert.match(await page.textContent('#dx-sql-status'), /^5 rows · 4 columns/);
  const expected = {};
  for (const x of all) {
    const e = (expected[x.Region] ??= { n: 0, revenue: 0, price: 0 });
    e.n++;
    e.revenue += Number(x.Revenue);
    e.price += Number(x['Unit Price']);
  }
  dl = await expectDownload(page, () => page.click('#dx-sql-json'));
  const sqlJson = JSON.parse(read(dl));
  assert.equal(dl.filename, 'query-result.json');
  assert.deepEqual(sqlJson.map((x) => x.Region), Object.keys(expected).sort());
  for (const x of sqlJson) {
    const e = expected[x.Region];
    assert.equal(x.n, e.n, `count for ${x.Region}`);
    assert.ok(Math.abs(x.revenue - e.revenue) < 0.02, `sum for ${x.Region}: ${x.revenue} vs ${e.revenue}`);
    assert.ok(Math.abs(x.avg_price - e.price / e.n) < 0.001, `mean for ${x.Region}`);
  }
  const sqlRows = await rows(page, '#dx-sql-grid', 10);
  assert.equal(sqlRows.length, 5, 'result shown in the table component');
  assert.deepEqual(Object.keys(sqlRows[0]), ['Region', 'n', 'revenue', 'avg_price']);
  dl = await expectDownload(page, () => page.click('#dx-sql-csv'));
  const sqlCsv = parseCsv(read(dl));
  assert.deepEqual(sqlCsv.map((x) => Number(x.n)), sqlJson.map((x) => x.n), 'CSV export of the query result');
  await shot('sql');

  // Errors
  await runSql(page, 'SELEC * FROM data');
  assert.ok(await page.isVisible('#dx-sql-error'));
  assert.match(await page.textContent('#dx-sql-error'), /Query failed.*Parse error/s);
  assert.match(await page.textContent('#dx-sql-error'), /brackets/);
  await shot('sql-error');
  await runSql(page, 'SELECT * FROM sales');
  assert.match(await page.textContent('#dx-sql-error'), /does not exist.*table is called data/s);
  await runSql(page, 'DELETE FROM data');
  assert.match(await page.textContent('#dx-sql-error'), /Only SELECT queries/);
  await runSql(page, 'SELECT Regoin FROM data');
  assert.match(await page.textContent('#dx-sql-error'), /Unknown column: Regoin \(did you mean Region\?\).*case-sensitive/s);
  // Examples run on click; Run button works too
  await after(page, 'sqlRev', () => page.click('#dx-sql-examples [data-ex="0"]'));
  assert.ok(await page.isHidden('#dx-sql-error'), 'error cleared after a good query');
  assert.match(await page.textContent('#dx-sql-status'), /^100 rows/);
  // Click-to-insert a column
  await page.fill('#dx-sql', 'SELECT ');
  await page.focus('#dx-sql');
  await page.press('#dx-sql', 'End');
  await page.click('#dx-sql-cols [data-ins="[Sales Rep]"]');
  assert.equal(await page.inputValue('#dx-sql'), 'SELECT [Sales Rep]');

  // Use result as dataset
  await runSql(page, "SELECT Category, [Sales Rep], SUM(Units) AS units FROM data WHERE Region = 'East' GROUP BY Category, [Sales Rep] ORDER BY units DESC");
  const nRes = Number((await page.textContent('#dx-sql-status')).match(/^([\d,]+) rows/)[1]);
  const expCombos = new Set(all.filter((x) => x.Region === 'East').map((x) => `${x.Category}|${x['Sales Rep']}`)).size;
  assert.equal(nRes, expCombos);
  await after(page, 'rev', () => page.click('#dx-sql-use'));
  assert.ok(await page.isVisible('[data-tabpanel="dx:table"]'), 'switches to the table');
  assert.match(await page.textContent('#dx-ds-meta'), new RegExp(`${nRes} rows · 3 columns`));
  assert.deepEqual((await headers(page)).map((h) => `${h.name}:${h.type}`), ['Category:string', 'Sales Rep:string', 'units:integer']);
  assert.ok(await page.isVisible('#dx-back'), 'back button offered');
  assert.ok(await page.isHidden('#dx-parse-opts'), 'no delimiter options for a query result');
  r = await rows(page, '#dx-grid', 2);
  assert.ok(Number(r[0].units) >= Number(r[1].units), 'result keeps its ORDER BY');
  // The derived dataset is fully explorable: query it again
  await tab(page, 'sql');
  assert.match(await page.inputValue('#dx-sql'), /WHERE Region = 'East'/, 'your own query is kept, not replaced by an example');
  await runSql(page, 'SELECT SUM(units) AS total_units FROM data');
  const unitsEast = all.filter((x) => x.Region === 'East').reduce((s, x) => s + Number(x.Units), 0);
  assert.equal((await rows(page, '#dx-sql-grid', 1))[0].total_units.replace(/,/g, ''), String(unitsEast), 'queries run against the new dataset');
  await tab(page, 'table');
  await after(page, 'rev', () => page.click('#dx-back'));
  assert.match(await page.textContent('#dx-ds-meta'), /2,000 rows · 12 columns/);
  assert.ok(await page.isHidden('#dx-back'));

  // SQL over just the filtered rows
  await openFilter(page, 'Region');
  await after(page, 'viewRev', () => page.click('#dx-pop [data-all="0"]'));
  await after(page, 'viewRev', () => page.check('#dx-pop .dx-pick[data-v="south"] input'));
  await page.keyboard.press('Escape');
  await tab(page, 'sql');
  const southN = all.filter((x) => x.Region === 'South').length;
  assert.equal(await page.textContent('#dx-sql-filtered-label'), `Only the ${southN} filtered rows`);
  await page.fill('#dx-sql', 'SELECT COUNT(*) AS c FROM data');
  await after(page, 'sqlRev', () => page.check('#dx-sql-filtered'));
  assert.equal((await rows(page, '#dx-sql-grid', 1))[0].c, String(southN), 'query sees only the filtered rows');
  await after(page, 'sqlRev', () => page.uncheck('#dx-sql-filtered'));
  assert.equal((await rows(page, '#dx-sql-grid', 1))[0].c, '2,000');
});

// ================================================================ 200k rows: load + scroll budget
await runToolTest('data-explorer', async ({ page, shot }) => {
  await page.waitForSelector('#dx[data-ready]');
  log('big file');
  const t0 = Date.now();
  let sawProgress = false;
  const watch = page.waitForSelector('#dx-progress:not([hidden])', { timeout: 10000 }).then(() => (sawProgress = true)).catch(() => {});
  await loadFile(page, files.big);
  const loadMs = Date.now() - t0;
  await watch;
  log(`loaded 200k rows in ${loadMs} ms`);
  assert.ok(sawProgress, 'progress bar shown while parsing');
  assert.ok(loadMs < 25000, `200k x 20 file should load within 25 s (took ${loadMs} ms)`);
  assert.match(await page.textContent('#dx-ds-meta'), /200,000 rows · 20 columns/);
  const hs = await headers(page);
  assert.equal(hs.find((h) => h.name === 'row_id').type, 'integer');
  assert.equal(hs.find((h) => h.name === 'day').type, 'date');
  assert.equal(hs.find((h) => h.name === 'flag').type, 'boolean');
  assert.equal(hs.find((h) => h.name === 'm1').type, 'float');
  // Only a screenful of rows is in the DOM
  const domRows = await page.locator('#dx-grid .dx-body .dx-row').count();
  assert.ok(domRows < 80, `table is virtualized (${domRows} row elements)`);

  // Scroll through the table: each jump must paint the right rows quickly
  const scrollMs = await page.$eval('#dx-grid .dx-grid', async (sc) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const t = performance.now();
    for (let k = 1; k <= 40; k++) {
      sc.scrollTop = (sc.scrollHeight * k) / 41;
      await frame();
    }
    return performance.now() - t;
  });
  log(`40 scroll frames in ${Math.round(scrollMs)} ms`);
  assert.ok(scrollMs < 4000, `scrolling 40 frames should take < 4 s (took ${Math.round(scrollMs)} ms)`);
  // Jump to the end: the last row is rendered
  await page.$eval('#dx-grid .dx-grid', (sc) => (sc.scrollTop = sc.scrollHeight));
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#dx-grid .dx-body .dx-row:not([hidden]) .dx-num')).some((c) => c.textContent === '200000'));
  // Sticky header stays at the top of the scroller
  const pos = await page.$eval('#dx-grid', (g) => g.querySelector('.dx-head').getBoundingClientRect().top - g.getBoundingClientRect().top);
  assert.ok(Math.abs(pos) <= 2, `header is sticky (offset ${pos})`);
  await shot('big-scrolled');

  // Sort 200k rows within budget
  const m1 = hs.find((h) => h.name === 'm1').c;
  const t1 = Date.now();
  await after(page, 'viewRev', () => page.click(`#dx-grid .dx-hcell[data-c="${m1}"] .dx-hbtn`));
  const sortMs = Date.now() - t1;
  log(`sorted in ${sortMs} ms`);
  assert.ok(sortMs < 5000, `sorting 200k rows should take < 5 s (took ${sortMs} ms)`);
  const firsts = (await rows(page, '#dx-grid', 3)).map((x) => Number(x.m1.replace(/,/g, '')));
  assert.ok(firsts[0] <= firsts[1] && firsts[1] <= firsts[2], 'sorted ascending');
  // Filter 200k rows
  await page.fill('#dx-search', 'item 996');
  await page.waitForFunction(() => /Showing [\d,]+ of 200,000/.test(document.querySelector('#dx-count').textContent) && !/Showing 200,000/.test(document.querySelector('#dx-count').textContent), null, { timeout: 15000 });
  const n = Number((await page.textContent('#dx-count')).match(/Showing ([\d,]+)/)[1].replace(/,/g, ''));
  assert.ok(n > 150 && n < 260, `search narrows 200k rows (${n})`);
});

// ================================================================ phone viewport
await runToolTest(
  'data-explorer',
  async ({ page, shot }) => {
    await page.waitForSelector('#dx[data-ready]');
    await noOverflow(page, 'empty state');
    await shot('mobile-empty');
    await loadSample(page, 'weather');
    await noOverflow(page, 'table');
    assert.match(await count(page), /Showing 1,464 of 1,464 rows/);
    // The table scrolls sideways inside its own box
    const g = await page.$eval('#dx-grid .dx-grid', (sc) => ({ sw: sc.scrollWidth, cw: sc.clientWidth, w: sc.getBoundingClientRect().width }));
    assert.ok(g.sw > g.cw, 'table has more columns than fit, so it scrolls inside');
    assert.ok(g.w <= 390, 'table box fits the screen');
    await page.$eval('#dx-grid .dx-grid', (sc) => (sc.scrollLeft = 400));
    await noOverflow(page, 'after scrolling the table sideways');
    await page.waitForTimeout(50);
    const numLeft = await page.$eval('#dx-grid .dx-body .dx-row:not([hidden]) .dx-num', (n) => n.getBoundingClientRect().left - n.closest('.dx-grid').getBoundingClientRect().left);
    assert.ok(Math.abs(numLeft) <= 1, `row numbers stay pinned while scrolling sideways (${numLeft})`);
    // Controls are laid out sensibly: search is full width, selects are not squashed
    const lay = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { search: r('#dx-search').width, numfmt: r('#dx-numfmt').width, prof: r('.dx-profile').top, grid: r('#dx-grid').bottom, sample: r('#dx-sample-sel').width };
    });
    assert.ok(lay.search > 300, `search box spans the width (${lay.search})`);
    assert.ok(lay.numfmt > 90 && lay.numfmt < 200, `number format select keeps its natural width (${lay.numfmt})`);
    assert.ok(lay.sample > 90 && lay.sample < 200, `samples select keeps its natural width (${lay.sample})`);
    assert.ok(lay.prof >= lay.grid, 'profile panel stacks below the table');
    // Tap a header to sort, open a filter popover inside the viewport
    const cityC = await colIndex(page, 'city');
    await after(page, 'viewRev', () => page.click(`#dx-grid .dx-hcell[data-c="${cityC}"] .dx-hbtn`));
    assert.equal((await rows(page, '#dx-grid', 1))[0].city, 'Lisbon');
    await page.click(`#dx-grid .dx-fbtn[data-c="${cityC}"]`);
    const pop = await page.$eval('#dx-pop', (p) => { const r = p.getBoundingClientRect(); return { l: r.left, r: r.right }; });
    assert.ok(pop.l >= 0 && pop.r <= 390, 'filter popover stays on screen');
    await noOverflow(page, 'filter popover open');
    await shot('mobile-filter');
    await page.keyboard.press('Escape');
    await shot('mobile-table');
    await chartAfter(page, () => tab(page, 'chart'));
    await noOverflow(page, 'chart');
    assert.ok((await inkRatio(page)) > 0.02, 'chart renders on a phone');
    await shot('mobile-chart');
    await after(page, 'sqlRev', () => tab(page, 'sql'), 60000);
    await noOverflow(page, 'sql');
    assert.ok(await page.isHidden('#dx-sql-error'));
    await shot('mobile-sql');
  },
  { viewport: { width: 390, height: 844 } },
);

// ================================================================ dark theme
await runToolTest(
  'data-explorer',
  async ({ page, shot }) => {
    await page.waitForSelector('#dx[data-ready]');
    await shot('dark-empty');
    await loadSample(page, 'traffic');
    const hs = await headers(page);
    assert.equal(hs.find((h) => h.name === 'timestamp').type, 'date');
    assert.equal(hs.find((h) => h.name === 'converted').type, 'boolean');
    assert.equal(hs.find((h) => h.name === 'revenue_usd').type, 'float');
    await openFilter(page, 'device');
    await shot('dark-filter');
    await page.keyboard.press('Escape');
    await shot('dark-table');
    await chartAfter(page, () => tab(page, 'chart'));
    const bg = await page.$eval('#dx-chart', (c) => Array.from(c.getContext('2d').getImageData(2, 2, 1, 1).data.slice(0, 3)));
    assert.deepEqual(bg, [0x19, 0x19, 0x1c], 'chart uses the dark surface colour');
    await shot('dark-chart');
    await after(page, 'sqlRev', () => tab(page, 'sql'), 60000);
    await runSql(page, 'SELEC oops');
    await shot('dark-sql-error');
  },
  { colorScheme: 'dark' },
);
