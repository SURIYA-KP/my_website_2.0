import { runToolTest, assert, expectDownload, FIXTURES } from './harness.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const Papa = require('papaparse');

// Fixture files are generated here on every run (safe to gitignore).
const FIX = path.join(FIXTURES, 'json-studio');
fs.mkdirSync(FIX, { recursive: true });

// ---------------------------------------------------------------- helpers
const rev = (page) => page.$eval('#jss', (e) => Number(e.dataset.rev || 0));
/** Replace the input (like typing/pasting) and wait for validation to run. */
async function setInput(page, text) {
  const r = await rev(page);
  await page.fill('#jss-input', text);
  await page.waitForFunction((r) => Number(document.querySelector('#jss').dataset.rev) > r, r);
}
/** Run an action that rewrites the input and wait for re-validation. */
async function act(page, fn) {
  const r = await rev(page);
  await fn();
  await page.waitForFunction((r) => Number(document.querySelector('#jss').dataset.rev) > r, r);
}
const input = (page) => page.inputValue('#jss-input');
const badge = (page) => page.textContent('#jss-valid');
const clip = (page) => page.evaluate(() => navigator.clipboard.readText());
/** Clipboard writes are async: poll briefly, then assert. */
async function clipIs(page, expected, msg) {
  await page.waitForFunction(async (e) => (await navigator.clipboard.readText()) === e, expected, { timeout: 2000, polling: 50 }).catch(() => {});
  await clipIs(page, expected, msg);
}
const setClip = (page, t) => page.evaluate((t) => navigator.clipboard.writeText(t), t);
const cmd = (page, name) => page.click(`.jss-toolbar [data-cmd="${name}"]`);
const tab = async (page, name) => {
  await page.click(`[data-tabs="out"] [data-tab="${name}"]`);
  await page.waitForSelector(`[data-tabpanel="out:${name}"]:not([hidden])`);
};
/** Wait until a code view holds text, then return it. */
const viewText = async (page, id) => {
  await page.waitForSelector(`#${id} .jss-cv-line`);
  return page.$eval(`#${id}`, (e) => e.textContent);
};
const noOverflow = async (page, label) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w, `${label}: horizontal overflow (${o.sw} > ${o.w})`);
};
const read = (f) => fs.readFileSync(f.path, 'utf8');
const treeRow = (page, key, nth = 0) => page.locator('.jss-row', { has: page.locator(`.jss-k:text-is("${key}")`) }).nth(nth);
const errorBox = async (page) => ({
  text: (await page.textContent('#jss-msg')).replace(/\s+/g, ' ').trim(),
  pos: await page.textContent('.jss-msg-pos'),
  gutter: await page.$eval('.jss-gutter-inner', (g) => g.querySelector('.is-error')?.textContent ?? null),
  band: await page.$eval('.jss-errband', (b) => !b.hidden),
});

const SAMPLE = '{"b":1,"a":[true,null,{"c":"x"}],"d":{},"e":"é\\n"}';
const SAMPLE_2 = '{\n  "b": 1,\n  "a": [\n    true,\n    null,\n    {\n      "c": "x"\n    }\n  ],\n  "d": {},\n  "e": "é\\n"\n}';
const SAMPLE_4 = '{\n    "b": 1,\n    "a": [\n        true,\n        null,\n        {\n            "c": "x"\n        }\n    ],\n    "d": {},\n    "e": "é\\n"\n}';
const SAMPLE_TAB = '{\n\t"b": 1,\n\t"a": [\n\t\ttrue,\n\t\tnull,\n\t\t{\n\t\t\t"c": "x"\n\t\t}\n\t],\n\t"d": {},\n\t"e": "é\\n"\n}';

// ================================================================ main flow (desktop)
await runToolTest('json-studio', async ({ page, context, shot, BASE_URL }) => {
  await page.waitForSelector('#jss[data-ready]');

  // ---------- loads the example by default
  assert.equal(await badge(page), 'Valid JSON');
  const example = JSON.parse(await input(page));
  assert.equal(example.users.length, 3, 'example API response is preloaded');
  assert.match(await page.textContent('[data-stat="keys"]'), /^\d+$/);
  assert.equal(await page.textContent('[data-stat="depth"]'), '7');
  assert.equal(await page.textContent('[data-stat="arrays"]'), '10');
  assert.match(await page.textContent('[data-stat="size"]'), /KB \([\d,]+ bytes\)/);
  assert.match(await viewText(page, 'jss-fmt-view'), /"requestId": "req_7f3a9c21"/);
  await shot('example');

  // ---------- format with 2 / 4 / tab, minify (exact output)
  await setInput(page, SAMPLE);
  assert.equal(await page.textContent('[data-stat="keys"]'), '5');
  assert.equal(await page.textContent('[data-stat="depth"]'), '3');
  assert.equal(await page.textContent('[data-stat="arrays"]'), '1');
  await act(page, () => cmd(page, 'format'));
  assert.equal(await input(page), SAMPLE_2, 'format, 2 spaces');
  await page.selectOption('#jss-indent', '4');
  await act(page, () => cmd(page, 'format'));
  assert.equal(await input(page), SAMPLE_4, 'format, 4 spaces');
  await page.selectOption('#jss-indent', 'tab');
  await act(page, () => cmd(page, 'format'));
  assert.equal(await input(page), SAMPLE_TAB, 'format, tabs');
  await act(page, () => cmd(page, 'minify'));
  assert.equal(await input(page), SAMPLE, 'minify');
  await page.keyboard.press('Control+z');
  await page.waitForFunction((t) => document.querySelector('#jss-input').value === t, SAMPLE_TAB);
  await page.selectOption('#jss-indent', '2');
  // Formatted tab follows the indent setting.
  await act(page, () => cmd(page, 'minify'));
  assert.equal((await viewText(page, 'jss-fmt-view')).includes('"c": "x"'), true);
  // Shift+Alt+F formats too.
  await page.focus('#jss-input');
  await act(page, () => page.keyboard.press('Shift+Alt+F'));
  assert.equal(await input(page), SAMPLE_2, 'Shift+Alt+F formats');

  // ---------- Tab indents inside the editor
  await page.$eval('#jss-input', (t) => (t.focus(), t.setSelectionRange(2, 2)));
  await act(page, () => page.keyboard.press('Tab'));
  assert.equal((await input(page)).split('\n')[1], '    "b": 1,', 'Tab inserts the indent unit');
  await act(page, () => page.keyboard.press('Shift+Tab'));
  assert.equal(await input(page), SAMPLE_2, 'Shift+Tab outdents');

  // ---------- sort keys (recursive, arrays keep order)
  await setInput(page, '{"zeta":{"b":2,"a":1},"alpha":[{"y":1,"x":[{"d":0,"c":0}]}],"Mid":null}');
  await act(page, () => cmd(page, 'sort'));
  assert.equal(
    await input(page),
    '{\n  "Mid": null,\n  "alpha": [\n    {\n      "x": [\n        {\n          "c": 0,\n          "d": 0\n        }\n      ],\n      "y": 1\n    }\n  ],\n  "zeta": {\n    "a": 1,\n    "b": 2\n  }\n}',
  );

  // ---------- escape / unescape
  await setInput(page, '{"a":"x\\"y","n":1}');
  await act(page, () => cmd(page, 'escape'));
  assert.equal(await input(page), '"{\\"a\\":\\"x\\\\\\"y\\",\\"n\\":1}"', 'escape');
  assert.equal(await page.textContent('[data-stat="type"]'), 'string');
  await act(page, () => cmd(page, 'unescape'));
  assert.equal(await input(page), '{\n  "a": "x\\"y",\n  "n": 1\n}', 'unescape (pretty-prints escaped JSON)');
  await setInput(page, 'line1\\nline2 \\"q\\"');
  await act(page, () => cmd(page, 'unescape'));
  assert.equal(await input(page), 'line1\nline2 "q"', 'unescape without surrounding quotes');

  // ---------- copy / download the input
  await setInput(page, SAMPLE_2);
  await setClip(page, '');
  await cmd(page, 'copy');
  await clipIs(page, SAMPLE_2, 'copy');
  const dlIn = await expectDownload(page, () => cmd(page, 'download'));
  assert.equal(read(dlIn), SAMPLE_2, 'download writes the input');
  assert.match(dlIn.filename, /\.json$/);

  // ---------- errors: line, column, hint, highlighted + jumpable line
  const cases = [
    {
      name: 'trailing comma',
      text: '{\n  "a": 1,\n  "b": 2,\n}',
      pos: 'Line 3, column 9',
      msg: "Trailing comma before '}'",
      hint: 'JSON does not allow a comma after the last item',
      line: '3',
    },
    {
      name: 'single quotes',
      text: "{\n  'name': 'Ada'\n}",
      pos: 'Line 2, column 3',
      msg: 'Property names must use double quotes, not single quotes',
      hint: 'need "double quotes"',
      line: '2',
    },
    {
      name: 'missing comma',
      text: '[\n  {"a": 1}\n  {"a": 2}\n]',
      pos: 'Line 3, column 3',
      msg: "Expected ',' or ']' after the array item",
      hint: 'a comma is missing between two items',
      line: '3',
    },
    {
      name: 'unclosed brace',
      text: '{\n  "a": {\n    "b": 1\n  }\n',
      pos: 'Line 5, column 1',
      msg: 'Unexpected end of input',
      hint: "The '{' opened at line 1, column 1 is never closed.",
      line: '5',
    },
    { name: 'comment', text: '{\n  // note\n  "a": 1\n}', pos: 'Line 2, column 3', msg: 'Comments are not allowed in JSON', hint: 'JSON has no comments', line: '2' },
    { name: 'NaN', text: '{"a": NaN}', pos: 'Line 1, column 7', msg: 'NaN is not valid JSON', hint: 'Use null', line: '1' },
    { name: 'undefined', text: '[1, undefined]', pos: 'Line 1, column 5', msg: 'undefined is not valid JSON', hint: 'not JSON', line: '1' },
    { name: 'unquoted key', text: '{\n  id: 1\n}', pos: 'Line 2, column 3', msg: "Property name 'id' must be in double quotes", hint: 'Write "id" instead of id', line: '2' },
    { name: 'mismatch', text: '{"a": [1, 2}', pos: 'Line 1, column 12', msg: "Expected ',' or ']'", hint: 'Bracket mismatch', line: '1' },
  ];
  for (const c of cases) {
    await setInput(page, c.text);
    assert.equal(await badge(page), 'Invalid', `${c.name}: badge`);
    const e = await errorBox(page);
    assert.equal(e.pos, c.pos, `${c.name}: position`);
    assert.ok(e.text.includes(c.msg), `${c.name}: message, got "${e.text}"`);
    assert.ok(e.text.includes(c.hint), `${c.name}: hint, got "${e.text}"`);
    assert.equal(e.gutter, c.line, `${c.name}: gutter marks the error line`);
    assert.ok(e.band, `${c.name}: error line highlighted`);
    if (c.name === 'trailing comma') await shot('error-trailing-comma');
  }
  // "Go to line" selects the error position in the editor.
  await setInput(page, '{\n  "a": 1,\n  "b": 2,\n}');
  await page.click('[data-msg-action="goto"]');
  const sel = await page.$eval('#jss-input', (t) => [document.activeElement === t, t.selectionStart]);
  assert.deepEqual(sel, [true, 20], 'Go to line focuses and selects the bad comma');
  assert.ok(!(await page.isHidden('#jss-stale')), 'outputs say they show the last valid version');
  // Actions refuse invalid input with a helpful toast.
  await cmd(page, 'format');
  await page.waitForSelector('.toast-error:has-text("Fix the error on line 3")');

  // A long document jumps to an error far below.
  const long = Array.from({ length: 300 }, (_, k) => `  "k${k}": ${k},`).join('\n');
  await setClip(page, `{\n${long}\n  "last": 1,,\n}`);
  await page.$eval('#jss-input', (t) => (t.focus(), t.select()));
  await act(page, () => page.keyboard.press('Control+v'));
  assert.equal(await page.textContent('.jss-msg-pos'), 'Line 302, column 13');
  const scrolled = await page.$eval('#jss-input', (t) => t.scrollTop);
  assert.ok(scrolled > 4000, `pasting scrolls to the error line (scrollTop ${scrolled})`);
  assert.equal(await page.$eval('.jss-gutter-inner', (g) => g.querySelector('.is-error')?.textContent), '302');

  // ---------- Fix it: lenient repair with a list of changes, and undo
  const JSON5ISH = `// user record
{
  name: 'Ada',   /* inline comment */
  active: True,
  score: NaN,
  "tags": ['x', "y",],
  nested: {a: None, b: undefined,},
  'quote': 'it\\'s',
}`;
  await setInput(page, JSON5ISH);
  assert.equal(await badge(page), 'Invalid');
  await act(page, () => page.click('[data-msg-action="fix"]'));
  assert.equal(await badge(page), 'Valid JSON');
  assert.deepEqual(JSON.parse(await input(page)), { name: 'Ada', active: true, score: null, tags: ['x', 'y'], nested: { a: null, b: null }, quote: "it's" });
  assert.equal(await input(page), JSON.stringify(JSON.parse(await input(page)), null, 2), 'repaired output is formatted');
  const fixed = await page.textContent('#jss-fixed-text');
  for (const part of ['2 comments removed', '3 trailing commas removed', '6 keys quoted', '4 strings re-quoted', '2 Python literals converted', '2 × NaN/Infinity/undefined → null'])
    assert.ok(fixed.includes(part), `fix summary mentions "${part}": ${fixed}`);
  await shot('repaired');
  await act(page, () => page.click('#jss-fixed [data-cmd="undo"]'));
  assert.equal(await input(page), JSON5ISH, 'Undo restores the original');
  assert.ok(await page.isHidden('#jss-fixed'));
  // Unrepairable input explains why.
  await setInput(page, '{"a": @}');
  await page.click('[data-msg-action="fix"]');
  await page.waitForSelector('.toast-error:has-text("Could not repair")');

  // ---------- Example / clear / empty state
  await act(page, () => cmd(page, 'clear'));
  assert.equal(await badge(page), 'Empty');
  assert.ok(await page.isVisible('[data-tabpanel="out:formatted"] .jss-out-empty'), 'empty state shown');
  await act(page, () => page.click('[data-tabpanel="out:formatted"] .jss-out-empty [data-cmd="example"]'));
  assert.deepEqual(JSON.parse(await input(page)), example);

  // ---------- tree: badges, counts, expand / collapse
  await tab(page, 'tree');
  await page.waitForSelector('.jss-row');
  const usersRow = treeRow(page, 'users');
  assert.match(await usersRow.textContent(), /array.*3 items/);
  assert.match(await treeRow(page, 'pagination').textContent(), /object.*4 keys/);
  assert.match(await treeRow(page, 'active').textContent(), /true.*boolean/);
  const rowCount = () => page.$eval('#jss-tree', (t) => t.querySelector('.jss-tree-inner').offsetHeight);
  const initial = await rowCount();
  await treeRow(page, 'pagination').locator('[data-toggle]').click();
  assert.ok((await rowCount()) < initial, 'clicking the caret collapses a node');
  await page.click('#jss-collapse');
  assert.equal(await page.locator('.jss-row').count(), 7, 'collapse all shows the root and its 6 keys');
  await page.click('#jss-expand');
  assert.ok((await rowCount()) > initial, 'expand all opens everything');
  await page.click('#jss-collapse');

  // ---------- tree search: highlights, auto-expands, next / previous
  await page.fill('#jss-search', 'grace');
  await page.waitForFunction(() => document.querySelector('#jss-search-count').textContent === '1 of 3');
  const marks = await page.$$eval('.jss-row mark', (m) => m.map((x) => x.textContent.toLowerCase()));
  assert.equal(marks.length, 3, 'three matches highlighted');
  assert.ok(marks.every((m) => m === 'grace'));
  assert.equal(await page.locator('.jss-row.is-current').count(), 1);
  await page.click('#jss-search-next');
  assert.equal(await page.textContent('#jss-search-count'), '2 of 3');
  await page.press('#jss-search', 'Shift+Enter');
  assert.equal(await page.textContent('#jss-search-count'), '1 of 3');
  await page.fill('#jss-search', 'postcode');
  await page.waitForFunction(() => document.querySelector('#jss-search-count').textContent === '1 of 2');
  assert.ok((await page.locator('.jss-row.is-match').count()) >= 1, 'key matches are highlighted');
  await shot('tree-search');
  await page.fill('#jss-search', 'no-such-thing');
  await page.waitForFunction(() => document.querySelector('#jss-search-count').textContent === 'No matches');
  await page.fill('#jss-search', '');
  await page.waitForFunction(() => document.querySelector('#jss-search-count').textContent === '');

  // ---------- tree path copy: JSONPath and JS, key with spaces, odd keys
  await page.click('#jss-expand');
  await treeRow(page, 'last login').click();
  await clipIs(page, "$.users[0]['last login']", 'click copies JSONPath');
  assert.equal(await page.textContent('#jss-path-jp'), "$.users[0]['last login']");
  assert.equal(await page.textContent('#jss-path-js'), 'data.users[0]["last login"]');
  await page.click('#jss-copy-js');
  await clipIs(page, 'data.users[0]["last login"]', 'JS path copy');
  await page.click('[data-copies="js"]');
  await treeRow(page, 'rate-limit').click();
  await clipIs(page, 'data.meta["rate-limit"]', 'JS mode: click copies JS path');
  await page.click('#jss-copy-jp');
  await clipIs(page, "$.meta['rate-limit']");
  await page.click('[data-copies="jsonpath"]');
  await treeRow(page, 'city', 1).click();
  await clipIs(page, '$.users[2].address.city');
  // Keyboard: arrows move, Enter copies.
  await page.focus('#jss-tree');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await clipIs(page, '$.users[2].address.postcode', 'keyboard navigation + Enter copies');
  await shot('tree-path');

  // ---------- YAML: view, copy, download, round trip
  await tab(page, 'yaml');
  const yamlView = await viewText(page, 'jss-yaml-view');
  assert.ok(yamlView.includes('last login:'));
  const dlYaml = await expectDownload(page, () => page.click('[data-cmd="out-download"]'));
  assert.match(dlYaml.filename, /\.yaml$/);
  assert.deepEqual(yaml.load(read(dlYaml)), example, 'downloaded YAML parses back to the same data');
  await page.click('[data-cmd="out-copy"]');
  await clipIs(page, read(dlYaml), 'YAML copy equals download');
  await shot('yaml');
  // YAML pasted into the input converts back to JSON.
  await setClip(page, read(dlYaml));
  await page.$eval('#jss-input', (t) => (t.focus(), t.select()));
  await act(page, () => page.keyboard.press('Control+v'));
  await page.waitForFunction(() => document.querySelector('#jss-input').value.startsWith('{'));
  assert.deepEqual(JSON.parse(await input(page)), example, 'pasted YAML → JSON round trip');
  // Typed YAML is recognised and offered for conversion.
  await setInput(page, 'name: Ada\nroles:\n  - admin\n  - editor\n');
  await page.waitForSelector('[data-msg-action="convert"]');
  assert.match(await page.textContent('#jss-msg'), /looks like YAML/);
  await act(page, () => page.click('[data-msg-action="convert"]'));
  assert.deepEqual(JSON.parse(await input(page)), { name: 'Ada', roles: ['admin', 'editor'] });
  // Paste button reads the clipboard.
  await setClip(page, 'a: 1\nb: [x, y]\n');
  await act(page, () => cmd(page, 'paste'));
  assert.deepEqual(JSON.parse(await input(page)), { a: 1, b: ['x', 'y'] }, 'Paste button converts YAML');

  // ---------- CSV: rows picker, delimiter, flatten, round trip
  await act(page, () => cmd(page, 'example'));
  await tab(page, 'csv');
  await viewText(page, 'jss-csv-view');
  assert.equal(JSON.parse(await page.inputValue('#jss-csv-rows')).join('.'), 'users', 'rows default to the biggest array of objects');
  assert.match(await page.textContent('#jss-csv-info'), /^3 rows × \d+ columns$/);
  const dlCsv = await expectDownload(page, () => page.click('[data-cmd="out-download"]'));
  const csv = read(dlCsv);
  const header = csv.split('\n')[0].split(',');
  for (const col of ['id', 'name', 'last login', 'roles.0', 'address.city', 'address.geo.lat', 'orders.0.items.1.sku', 'nickname']) assert.ok(header.includes(col), `CSV has column ${col}`);
  const parsed = Papa.parse(csv, { header: true }).data;
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]['address.city'], 'London');
  assert.equal(parsed[1].email, 'null');
  await shot('csv');
  // Round trip: open the downloaded CSV and compare with the original rows.
  const csvFile = path.join(FIX, 'users.csv');
  fs.writeFileSync(csvFile, csv);
  await act(page, () => page.setInputFiles('#jss-open input[type=file]', csvFile));
  assert.deepEqual(JSON.parse(await input(page)), example.users, 'CSV → JSON round trip equals the users array');
  // Delimiter and whole-document rows.
  await act(page, () => cmd(page, 'example'));
  await page.selectOption('#jss-csv-delim', ';');
  await page.waitForFunction(() => document.querySelector('#jss-csv-view').textContent.includes(';'));
  const dlSemi = await expectDownload(page, () => page.click('[data-cmd="out-download"]'));
  assert.ok(read(dlSemi).split('\n')[0].startsWith('id;name;email;active;last login;roles.0'), 'semicolon delimiter');
  assert.deepEqual(
    Papa.parse(read(dlSemi), { header: true, delimiter: ';' }).data.map((r) => r.name),
    ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'],
  );
  await page.selectOption('#jss-csv-rows', '[]');
  await page.waitForFunction(() => document.querySelector('#jss-csv-info').textContent.startsWith('1 row '));
  await page.selectOption('#jss-csv-delim', ',');

  // ---------- TypeScript (exact output)
  const TS_SAMPLE = {
    id: 7,
    name: 'Ada',
    tags: ['a', 'b'],
    profile: { bio: null, links: [{ url: 'https://a.example', label: 'Home' }, { url: 'https://b.example' }] },
    orders: [
      { id: 'o1', total: 9.5, status: 'paid', note: 'gift' },
      { id: 'o2', total: 12, status: null, items: [{ sku: 'k', qty: 1 }] },
    ],
    scores: [1, 'two', null],
    'last login': '2026-01-01',
    empty: [],
    meta: {},
  };
  await setInput(page, JSON.stringify(TS_SAMPLE));
  await tab(page, 'ts');
  await page.fill('#jss-ts-root', 'user profile');
  await page.waitForFunction(() => document.querySelector('#jss-ts-view').textContent.includes('UserProfile'));
  await page.click('[data-cmd="out-copy"]');
  assert.equal(
    await clip(page),
    `export interface UserProfile {
  id: number;
  name: string;
  tags: string[];
  profile: Profile;
  orders: Order[];
  scores: (string | number | null)[];
  "last login": string;
  empty: unknown[];
  meta: Record<string, unknown>;
}

export interface Profile {
  bio: null;
  links: Link[];
}

export interface Link {
  url: string;
  label?: string;
}

export interface Order {
  id: string;
  total: number;
  status: string | null;
  note?: string;
  items?: Item[];
}

export interface Item {
  sku: string;
  qty: number;
}
`,
  );
  await shot('typescript');
  await page.selectOption('#jss-ts-style', 'type');
  await page.check('#jss-ts-ro');
  await page.waitForFunction(() => document.querySelector('#jss-ts-view').textContent.includes('readonly'));
  const dlTs = await expectDownload(page, () => page.click('[data-cmd="out-download"]'));
  assert.match(dlTs.filename, /\.ts$/);
  const ts = read(dlTs);
  assert.ok(ts.startsWith('export type UserProfile = {\n  readonly id: number;'), ts.slice(0, 80));
  assert.ok(ts.includes('  readonly orders: readonly Order[];\n'));
  assert.ok(ts.includes('export type Link = {\n  readonly url: string;\n  readonly label?: string;\n};'));
  // A root array merges element shapes.
  await setInput(page, '[{"a":1},{"a":"x","b":{"c":true}}]');
  await page.fill('#jss-ts-root', '');
  await page.selectOption('#jss-ts-style', 'interface');
  await page.uncheck('#jss-ts-ro');
  await page.waitForFunction(() => document.querySelector('#jss-ts-view').textContent.startsWith('1export type Root = RootItem[];'));
  await page.click('[data-cmd="out-copy"]');
  await clipIs(page, 'export type Root = RootItem[];\n\nexport interface RootItem {\n  a: string | number;\n  b?: B;\n}\n\nexport interface B {\n  c: boolean;\n}\n');

  // ---------- Formatted output: copy + download
  await tab(page, 'formatted');
  await setInput(page, SAMPLE);
  const dlFmt = await expectDownload(page, () => page.click('[data-cmd="out-download"]'));
  assert.equal(read(dlFmt), SAMPLE_2, 'formatted download');

  // ---------- file open: .json, .yaml, .csv
  const files = {
    'order.json': '{"order":{"id":42,"lines":[{"sku":"A","qty":2}]}}',
    'config.yaml': 'server:\n  host: localhost\n  port: 8080\n  tls: false\nfeatures:\n  - search\n  - export\nowner: ~\n',
    'people.csv': 'name,age,address.city,active\nAda,36,London,true\n"Turing, Alan",41,Wilmslow,false\n',
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(FIX, name), text);
  await act(page, () => page.setInputFiles('#jss-open input[type=file]', path.join(FIX, 'order.json')));
  assert.equal(await input(page), files['order.json'], '.json opens as is');
  assert.equal(await badge(page), 'Valid JSON');
  await page.waitForSelector('.toast:has-text("Opened order.json")');
  const dlName = await expectDownload(page, () => cmd(page, 'download'));
  assert.equal(dlName.filename, 'order.json', 'download keeps the opened name');
  await act(page, () => page.setInputFiles('#jss-open input[type=file]', path.join(FIX, 'config.yaml')));
  assert.deepEqual(JSON.parse(await input(page)), { server: { host: 'localhost', port: 8080, tls: false }, features: ['search', 'export'], owner: null }, '.yaml converts');
  await act(page, () => page.setInputFiles('#jss-open input[type=file]', path.join(FIX, 'people.csv')));
  assert.deepEqual(JSON.parse(await input(page)), [
    { name: 'Ada', age: 36, address: { city: 'London' }, active: true },
    { name: 'Turing, Alan', age: 41, address: { city: 'Wilmslow' }, active: false },
  ], '.csv converts with types and nesting');
  // A broken file opens with the error shown.
  fs.writeFileSync(path.join(FIX, 'broken.json'), '{"a": 1,}');
  await act(page, () => page.setInputFiles('#jss-open input[type=file]', path.join(FIX, 'broken.json')));
  assert.equal(await badge(page), 'Invalid');
  assert.equal(await page.textContent('.jss-msg-pos'), 'Line 1, column 8');
  // Drag and drop onto the page.
  await act(page, async () => {
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(['{"dropped": true}'], 'drop.json', { type: 'application/json' }));
      return d;
    });
    await page.dispatchEvent('#jss-input', 'drop', { dataTransfer: dt });
  });
  assert.equal(await input(page), '{"dropped": true}', 'drop a file');

  // ---------- share via URL hash
  await setInput(page, '{"shared":true,"list":[1,2,3],"text":"héllo"}');
  assert.equal(await page.getAttribute('[data-cmd="share"]', 'aria-disabled'), 'false');
  await cmd(page, 'share');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('#json='));
  const url = await clip(page);
  assert.ok(url.startsWith(`${BASE_URL}/tools/json-studio/#json=`), url);
  assert.equal(page.url(), url, 'address bar updated');
  const p2 = await context.newPage();
  await p2.goto(url, { waitUntil: 'networkidle' });
  await p2.waitForSelector('#jss[data-ready]');
  assert.equal(await p2.inputValue('#jss-input'), '{"shared":true,"list":[1,2,3],"text":"héllo"}', 'share link round trip');
  await p2.close();
  await setInput(page, JSON.stringify({ big: 'x'.repeat(9000) }));
  assert.equal(await page.getAttribute('[data-cmd="share"]', 'aria-disabled'), 'true', 'share disabled over 8 KB');
  assert.match(await page.getAttribute('[data-cmd="share"]', 'title'), /limited to 8 KB/);
  await cmd(page, 'share');
  await page.waitForSelector('.toast-error:has-text("limited to 8 KB")');
  assert.equal(await page.textContent('#jss-share-note'), 'Share: over 8 KB');
  await page.evaluate(() => history.replaceState(null, '', location.pathname));

  // ---------- 5 MB input stays responsive (time-boxed)
  await tab(page, 'formatted');
  const t0 = Date.now();
  await page.evaluate(() => {
    window.__longest = 0;
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (window.__longest = Math.max(window.__longest, e.duration)))).observe({ type: 'longtask', buffered: false });
    const items = [];
    let size = 0;
    for (let k = 0; size < 5.2e6; k++) {
      const o = { id: k, name: `user ${k}`, email: `u${k}@example.com`, active: k % 3 === 0, score: k * 1.5, tags: ['a', 'b', k % 7 ? 'c' : 'needle'], address: { city: `City ${k % 100}`, zip: String(10000 + k) } };
      items.push(o);
      size += JSON.stringify(o).length + 6;
    }
    const ta = document.querySelector('#jss-input');
    ta.value = JSON.stringify({ items }, null, 1);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#jss-valid').textContent === 'Valid JSON' && Number(document.querySelector('#jss-stats').dataset.bytes) > 5e6, null, { timeout: 8000 });
  await page.waitForSelector('#jss-fmt-view .jss-cv-line');
  const loadMs = Date.now() - t0;
  assert.ok(loadMs < 6000, `5 MB validated + formatted in ${loadMs} ms`);
  // Interactions stay quick.
  let t = Date.now();
  await tab(page, 'tree');
  await page.waitForSelector('.jss-row');
  await treeRow(page, 'items').locator('[data-toggle]').click();
  await treeRow(page, '0').waitFor();
  const treeMs = Date.now() - t;
  t = Date.now();
  await page.fill('#jss-search', 'needle');
  await page.waitForFunction(() => /^1 of [\d,]+$/.test(document.querySelector('#jss-search-count').textContent), null, { timeout: 5000 });
  const searchMs = Date.now() - t;
  await page.fill('#jss-search', '');
  t = Date.now();
  await page.click('#jss-tree', { position: { x: 200, y: 60 } });
  await page.mouse.wheel(0, 40000);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const scrollMs = Date.now() - t;
  const longest = await page.evaluate(() => window.__longest);
  console.log(`  5 MB: load ${loadMs} ms, tree ${treeMs} ms, search ${searchMs} ms, scroll ${scrollMs} ms, longest task ${Math.round(longest)} ms`);
  assert.ok(treeMs < 2500, `tree opens in ${treeMs} ms`);
  assert.ok(searchMs < 4000, `search runs in ${searchMs} ms`);
  assert.ok(scrollMs < 1000, `scrolling the tree takes ${scrollMs} ms`);
  assert.ok(longest < 2500, `no main-thread freeze (longest task ${Math.round(longest)} ms)`);
  assert.ok((await page.locator('.jss-row').count()) < 200, 'tree is virtualized');
  assert.equal(await page.getAttribute('[data-cmd="share"]', 'aria-disabled'), 'true');
  await shot('large');
  await act(page, () => cmd(page, 'clear'));
});

// ================================================================ phone viewport
await runToolTest('json-studio', async ({ page, shot }) => {
  await page.waitForSelector('#jss[data-ready]');
  await noOverflow(page, 'initial');
  await shot('mobile');
  const inBox = await page.locator('.jss-in').boundingBox();
  const outBox = await page.locator('.jss-out').boundingBox();
  assert.ok(outBox.y >= inBox.y + inBox.height - 1, 'input and output are stacked');
  assert.ok(inBox.width <= 390 && outBox.width <= 390);
  await setInput(page, '{"b":2,"a":[1,2,],}');
  await noOverflow(page, 'error');
  await shot('mobile-error');
  await act(page, () => page.click('[data-msg-action="fix"]'));
  assert.equal(await input(page), '{\n  "b": 2,\n  "a": [\n    1,\n    2\n  ]\n}');
  await act(page, () => cmd(page, 'sort'));
  assert.equal(await input(page), '{\n  "a": [\n    1,\n    2\n  ],\n  "b": 2\n}');
  await act(page, () => cmd(page, 'example'));
  for (const name of ['tree', 'yaml', 'csv', 'ts']) {
    await tab(page, name);
    await noOverflow(page, `${name} tab`);
  }
  await tab(page, 'tree');
  await treeRow(page, 'requestId').click();
  await clipIs(page, '$.requestId');
  await noOverflow(page, 'tree path');
  await shot('mobile-tree');
}, { viewport: { width: 390, height: 844 } });

// ================================================================ dark theme
await runToolTest('json-studio', async ({ page, shot }) => {
  await page.waitForSelector('#jss[data-ready]');
  await shot('dark-formatted');
  await tab(page, 'tree');
  await page.fill('#jss-search', 'ada');
  await page.waitForFunction(() => /of/.test(document.querySelector('#jss-search-count').textContent));
  await treeRow(page, 'email').first().click();
  await shot('dark-tree');
  await setInput(page, "{\n  'a': 1\n}");
  await shot('dark-error');
  await tab(page, 'ts');
  await shot('dark-ts');
  const bg = await page.$eval('.jss-ta-wrap', (e) => getComputedStyle(e.closest('.jss-editor')).backgroundColor);
  assert.notEqual(bg, 'rgb(255, 255, 255)', 'editor follows the dark theme');
}, { colorScheme: 'dark' });
