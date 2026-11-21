import { runToolTest, assert, expectDownload } from './harness.mjs';
import fs from 'node:fs';

// ---------------------------------------------------------------- helpers (run in the page)
const ROOT = `document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])')`;

/** Bounding box of an element in document (root user-space) units. */
const docBox = (page, sel) =>
  page.evaluate(
    ([sel, ROOT]) => {
      const root = document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])');
      const el = root.querySelector(sel);
      if (!el) return null;
      const bb = el.getBBox();
      const m = root.getScreenCTM().inverse().multiply(el.getScreenCTM());
      const pts = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x + bb.width, bb.y + bb.height], [bb.x, bb.y + bb.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
      return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
    },
    [sel, ROOT],
  );
/** Center of an element on screen. */
const screenCenter = (page, sel) =>
  page.evaluate(
    ([sel, ROOT]) => {
      const r = document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    [sel, ROOT],
  );
const attr = (page, sel, name) => page.evaluate(([sel, name, ROOT]) => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector(sel)?.getAttribute(name) ?? null, [sel, name, ROOT]);
const exists = (page, sel) => page.evaluate(([sel, ROOT]) => !!document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector(sel), [sel, ROOT]);
const selectedLayers = (page) => page.$$eval('.svgs-layer[aria-selected="true"] .svgs-layer-name', (els) => els.map((e) => e.textContent));
const zoom = (page) => page.evaluate((ROOT) => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').getScreenCTM().a, ROOT);
const codeText = (page) => page.inputValue('#svgs-code-text');
const loadSample = async (page, id) => {
  await page.selectOption('#svgs-sample', id);
  await page.waitForFunction((ROOT) => !!document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])'), ROOT);
};
const expand = async (page, name) => {
  const row = page.locator(`.svgs-layer:has(.svgs-layer-name:text-is("${name}"))`);
  if ((await row.getAttribute('aria-expanded')) === 'false') await row.locator('.svgs-twisty').click();
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);
const drag = async (page, from, to, steps = 8) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
};
const handle = (page, id) =>
  page.$eval(`.svgs-overlay [data-handle="${id}"]`, (h) => {
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

const AI_REPLY = `Sure! Here's a simple badge for your project. I grouped the parts and gave them ids so they're easy to tweak.

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" width="200" height="120" onload="alert(1)">
  <script>alert('pwned')</script>
  <g id="badge">
    <rect id="pill" x="10" y="20" width="180" height="80" rx="40" fill="#22c55e" onclick="steal()"/>
    <text id="label" x="100" y="70" text-anchor="middle" font-size="28" fill="#fff">Passing</text>
  </g>
  <a href="javascript:alert(2)"><circle id="dot" cx="30" cy="60" r="8" fill="#fff"/></a>
  <image href="https://evil.example.com/track.png" width="10" height="10"/>
</svg>
\`\`\`

You can change the color by editing the \`fill\` on the rect. Let me know if you want a dark variant!`;

const RAW_TWO = `Option A is minimal: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Option A</title><circle id="a-circle" cx="50" cy="50" r="40" fill="#f59e0b"/></svg>
and option B is bolder: <svg viewBox="0 0 100 100"><title>Option B</title><rect id="b-square" x="10" y="10" width="80" height="80" fill="#0ea5e9"/></svg> Which do you prefer?`;

const MERMAID_REPLY = `Here is the flow as a Mermaid diagram:

\`\`\`mermaid
flowchart LR
  A[Start] --> B{Is it working?}
  B -->|Yes| C[Ship it]
  B -->|No| D[Debug]
  D --> B
\`\`\`

Paste it into any Mermaid renderer.`;

// ====================================================================== desktop, light
await runToolTest('svg-studio', async ({ page, shot }) => {
  await page.waitForSelector('.svgs-layer');
  assert.ok(await exists(page, '#cabin'), 'the illustration sample is loaded by default');
  await shot('default');

  // ---------------------------------------------------------- paste from AI: fenced svg + sanitization
  await page.click('[data-cmd="paste-ai"]');
  await page.fill('#svgs-paste-text', AI_REPLY);
  await page.click('#svgs-paste-go');
  await page.waitForFunction((ROOT) => !!document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#pill'), ROOT);
  assert.equal(await page.isVisible('#svgs-dlg-paste'), false, 'dialog closes after loading');
  const unsafe = await page.evaluate((ROOT) => {
    const root = document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])');
    const all = [root, ...root.querySelectorAll('*')];
    return {
      scripts: root.querySelectorAll('script').length,
      handlers: all.filter((e) => [...e.attributes].some((a) => a.name.startsWith('on'))).length,
      js: all.filter((e) => [...e.attributes].some((a) => /javascript:/i.test(a.value))).length,
      external: all.filter((e) => [...e.attributes].some((a) => /https?:/.test(a.value) && a.name !== 'xmlns')).length,
    };
  }, ROOT);
  assert.deepEqual(unsafe, { scripts: 0, handlers: 0, js: 0, external: 0 }, 'script, on* handlers, javascript: and external refs removed');
  const warn = await page.textContent('#svgs-warnings');
  assert.match(warn, /script/i);
  assert.match(warn, /external images/i);
  assert.doesNotMatch(await codeText(page), /<script|onclick|onload|javascript:/i, 'code panel is clean');
  await shot('pasted-ai');

  // ---------------------------------------------------------- raw svgs inside text: pick one of two
  await page.click('[data-cmd="paste-ai"]');
  await page.fill('#svgs-paste-text', RAW_TWO);
  await page.click('#svgs-paste-go');
  await page.waitForSelector('.svgs-cand');
  assert.equal(await page.locator('.svgs-cand').count(), 2, 'two candidates offered');
  assert.match(await page.textContent('#svgs-candidates'), /Option A[\s\S]*Option B/);
  await page.click('.svgs-cand:nth-of-type(2)');
  await page.waitForFunction((ROOT) => !!document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#b-square'), ROOT);
  assert.equal(await page.isVisible('#svgs-dlg-paste'), false);

  // ---------------------------------------------------------- Ctrl+V anywhere and file open
  await page.click('.svgs-viewport', { position: { x: 5, y: 5 } });
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect id="pasted-rect" width="50" height="50" fill="red"/></svg>');
    document.querySelector('#svgs-viewport').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await page.waitForFunction((ROOT) => !!document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#pasted-rect'), ROOT);
  assert.equal(await page.evaluate((ROOT) => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').getAttribute('viewBox'), ROOT), '0 0 50 50', 'a missing viewBox is added from width/height');
  await page.setInputFiles('#svgs-file', { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle id="from-file" cx="10" cy="10" r="9"/></svg>') });
  await page.waitForFunction((ROOT) => !!document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#from-file'), ROOT);

  // ---------------------------------------------------------- mermaid reply routes to the Mermaid flow
  await page.click('[data-cmd="paste-ai"]');
  await page.fill('#svgs-paste-text', MERMAID_REPLY);
  await page.click('#svgs-paste-go');
  await page.waitForSelector('#svgs-dlg-mermaid[open]');
  assert.match(await page.inputValue('#svgs-mermaid-text'), /^flowchart LR/);
  assert.equal(await page.isVisible('#svgs-mermaid-info'), true);
  await page.click('[value="cancel"] >> visible=true');

  // ---------------------------------------------------------- selection on the canvas
  await loadSample(page, 'illustration');
  await page.waitForFunction((ROOT) => !!document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#cabin'), ROOT);
  const wall = await screenCenter(page, '#window-left');
  await page.mouse.click(wall.x, wall.y);
  assert.deepEqual(await selectedLayers(page), ['cabin'], 'click selects the top-level group');
  assert.equal(await page.locator('.svgs-overlay [data-handle]').count(), 9, '8 resize handles + rotate');
  await page.mouse.dblclick(wall.x, wall.y);
  assert.deepEqual(await selectedLayers(page), ['window-left'], 'double-click drills into the group');
  await page.keyboard.press('Escape');
  assert.deepEqual(await selectedLayers(page), ['cabin'], 'Esc selects the parent');
  // Alt-click selects the inner element directly.
  const door = await screenCenter(page, '#door');
  await page.keyboard.down('Alt');
  await page.mouse.click(door.x, door.y);
  await page.keyboard.up('Alt');
  assert.deepEqual(await selectedLayers(page), ['door']);
  // Shift-click toggles multi-select.
  const sun = await screenCenter(page, '#sun');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.mouse.click(sun.x, sun.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(wall.x, wall.y);
  await page.keyboard.up('Shift');
  assert.deepEqual((await selectedLayers(page)).sort(), ['cabin', 'sun']);
  // Clicking a layer row selects it on the canvas.
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("ground")) .svgs-layer-name');
  assert.deepEqual(await selectedLayers(page), ['ground']);
  assert.match(await page.textContent('#svgs-status'), /<rect>\s*ground/);
  await shot('selected');

  // ---------------------------------------------------------- zoom with Ctrl+wheel, pan with Space+drag
  const zBefore = await zoom(page);
  const vpBox = await page.locator('#svgs-viewport').boundingBox();
  await page.mouse.move(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  assert.ok((await zoom(page)) > zBefore * 1.2, 'Ctrl+wheel zooms in');
  const sunA = await screenCenter(page, '#sun');
  await page.keyboard.down('Space');
  await drag(page, { x: vpBox.x + 20, y: vpBox.y + 20 }, { x: vpBox.x + 70, y: vpBox.y + 50 });
  await page.keyboard.up('Space');
  const sunB = await screenCenter(page, '#sun');
  near(sunB.x - sunA.x, 50, 1, 'Space+drag pans');
  near(sunB.y - sunA.y, 30, 1, 'Space+drag pans (y)');

  // ---------------------------------------------------------- drag in document units
  await page.click('[data-cmd="fit"]');
  let z = await zoom(page);
  const sun0 = await docBox(page, '#sun');
  const s0 = await screenCenter(page, '#sun');
  await drag(page, s0, { x: s0.x + 60, y: s0.y + 30 });
  const sun1 = await docBox(page, '#sun');
  near(sun1.cx - sun0.cx, 60 / z, 0.6, 'sun moved in x by screen delta / zoom');
  near(sun1.cy - sun0.cy, 30 / z, 0.6, 'sun moved in y');
  assert.match(await attr(page, '#sun', 'transform'), /^translate\(/);
  assert.match(await codeText(page), /id="sun"[^>]*transform="translate\(/, 'code panel shows the move');

  // Nested: tree-2 is inside #trees and has translate(150 286) scale(0.75); zoom the canvas first.
  await page.click('[data-cmd="zoom-in"]');
  await page.click('[data-cmd="zoom-in"]');
  z = await zoom(page);
  const t2 = await screenCenter(page, '#tree-2 path');
  await page.mouse.click(t2.x, t2.y);
  await page.mouse.dblclick(t2.x, t2.y);
  assert.deepEqual(await selectedLayers(page), ['tree-2']);
  const tb0 = await docBox(page, '#tree-2');
  await drag(page, t2, { x: t2.x - 40, y: t2.y + 24 });
  const tb1 = await docBox(page, '#tree-2');
  near(tb1.cx - tb0.cx, -40 / z, 0.6, 'nested transformed element follows the pointer (x)');
  near(tb1.cy - tb0.cy, 24 / z, 0.6, 'nested transformed element follows the pointer (y)');
  near(tb1.w, tb0.w, 0.01, 'size unchanged');
  assert.match(await attr(page, '#tree-2', 'transform'), /scale\(0\.75\)/, 'scale kept in the composed transform');
  // Arrow keys nudge in document units.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const tb2 = await docBox(page, '#tree-2');
  near(tb2.cx - tb1.cx, 1, 0.01, 'arrow nudges 1 unit');
  near(tb2.cy - tb1.cy, 10, 0.01, 'shift+arrow nudges 10 units');

  // ---------------------------------------------------------- resize + rotate
  await page.click('[data-cmd="fit"]');
  z = await zoom(page);
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("sun")) .svgs-layer-name');
  const r0 = await docBox(page, '#sun');
  const e = await handle(page, 'e');
  await drag(page, e, { x: e.x + 50, y: e.y });
  const r1 = await docBox(page, '#sun');
  near(r1.w - r0.w, 50 / z, 0.8, 'east handle widens by the drag distance');
  near(r1.h, r0.h, 0.01, 'height unchanged');
  near(r1.x, r0.x, 0.6, 'west edge stays put');
  assert.match(await attr(page, '#sun', 'transform'), /scale\(/);
  // Shift + corner keeps the aspect ratio.
  const se = await handle(page, 'se');
  await page.keyboard.down('Shift');
  await drag(page, se, { x: se.x + 30, y: se.y + 5 });
  await page.keyboard.up('Shift');
  const r2 = await docBox(page, '#sun');
  near(r2.w / r2.h, r1.w / r1.h, 0.01, 'aspect ratio kept with Shift');
  // Rotate the cabin by 90° around its center.
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("cabin")) .svgs-layer-name');
  const c0 = await docBox(page, '#cabin');
  const rot = await handle(page, 'rot');
  const cc = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.svgs-overlay [data-handle]')].filter((h) => h.dataset.handle !== 'rot').map((h) => h.getBoundingClientRect());
    return { x: p.reduce((s, r) => s + r.left + r.width / 2, 0) / p.length, y: p.reduce((s, r) => s + r.top + r.height / 2, 0) / p.length };
  });
  const rad = Math.hypot(rot.x - cc.x, rot.y - cc.y);
  await page.keyboard.down('Shift');
  await drag(page, rot, { x: cc.x + rad, y: cc.y + 1 }, 12);
  await page.keyboard.up('Shift');
  assert.match(await attr(page, '#cabin', 'transform'), /rotate\(90\)/, 'rotated 90° (snapped with Shift)');
  const c1 = await docBox(page, '#cabin');
  near(c1.cx, c0.cx, 0.6, 'rotation keeps the center (x)');
  near(c1.cy, c0.cy, 0.6, 'rotation keeps the center (y)');
  near(c1.w, c0.h, 0.6, 'rotated box: width becomes height');
  await shot('rotated');

  // Multi-selection: resize the union box in screen space; marquee selection.
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("ground")) .svgs-layer-name');
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("sun")) .svgs-layer-name', { modifiers: ['Shift'] });
  assert.deepEqual((await selectedLayers(page)).sort(), ['ground', 'sun']);
  const g0 = await docBox(page, '#ground');
  const u0 = await docBox(page, '#sun');
  const n = await handle(page, 'n');
  await drag(page, n, { x: n.x, y: n.y - 40 });
  const g1 = await docBox(page, '#ground');
  const u1 = await docBox(page, '#sun');
  near(g1.y + g1.h, g0.y + g0.h, 0.6, 'anchor (bottom edge) fixed for the group resize');
  assert.ok(u1.h > u0.h + 5 && g1.h > g0.h + 5, 'both elements stretched');
  await page.keyboard.press('Control+z');
  near((await docBox(page, '#sun')).h, u0.h, 0.01, 'undo multi resize');
  await page.fill('#svgs-p-fill', '#abcdef');
  await page.press('#svgs-p-fill', 'Enter');
  assert.deepEqual([await attr(page, '#sun', 'fill'), await attr(page, '#ground', 'fill')], ['#abcdef', '#abcdef'], 'multi-select fill applies to all');
  await page.keyboard.press('Control+z');
  // Marquee from empty canvas space (left of the drawing) across the birds.
  const birds = await page.evaluate(() => {
    const r = document.querySelector('#svgs-host').shadowRoot.querySelector('#birds').getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  });
  const vp = await page.locator('#svgs-viewport').boundingBox();
  await drag(page, { x: vp.x + 6, y: birds.t - 4 }, { x: birds.r + 4, y: birds.b + 4 });
  assert.deepEqual(await selectedLayers(page), ['birds'], 'marquee selects the enclosed group (not the full-size background)');
  await page.mouse.click(vp.x + 6, vp.y + 6);
  assert.deepEqual(await selectedLayers(page), [], 'click on empty canvas clears the selection');

  // Document settings when nothing is selected.
  await page.fill('#svgs-a-width', '320');
  await page.press('#svgs-a-width', 'Enter');
  assert.equal(await page.evaluate(() => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').getAttribute('width')), '320');
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').getAttribute('width')), '640', 'Enter leaves the field so Ctrl+Z undoes the document');
  await page.click('[data-fit-viewbox]');
  const vb = await page.evaluate(() => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').getAttribute('viewBox'));
  assert.notEqual(vb, '0 0 640 400', 'viewBox fitted to the (rotated, moved) content');
  await page.keyboard.press('Control+z');
  await page.click('[data-bg="dark"]');
  assert.equal(await page.getAttribute('.svgs-paper', 'data-bg'), 'dark');
  await page.click('[data-cmd="grid"]');
  assert.equal(await page.isVisible('.svgs-grid'), true, 'grid shown');
  await shot('dark-bg-grid');
  await page.click('[data-cmd="grid"]');
  await page.click('[data-bg="checker"]');

  // ---------------------------------------------------------- properties panel ↔ canvas ↔ code
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("sun")) .svgs-layer-name');
  await page.fill('#svgs-p-fill', '#ff0000');
  await page.press('#svgs-p-fill', 'Enter');
  assert.equal(await page.evaluate((ROOT) => getComputedStyle(document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#sun')).fill, ROOT), 'rgb(255, 0, 0)');
  assert.match(await codeText(page), /<circle id="sun"[^>]*fill="#ff0000"/);
  // Opacity slider.
  await page.fill('#svgs-opacity', '0.5');
  await page.dispatchEvent('#svgs-opacity', 'change');
  assert.equal(await attr(page, '#sun', 'opacity'), '0.5');
  // Styles that live in a class rule: editing writes where it takes effect (style attr).
  await expand(page, 'trees');
  await expand(page, 'tree-1');
  await page.click('.svgs-layer[aria-level="3"]:has-text("path.tree-top") .svgs-layer-name');
  await page.fill('#svgs-p-fill', '#0000ff');
  await page.press('#svgs-p-fill', 'Enter');
  assert.equal(await page.evaluate((ROOT) => getComputedStyle(document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#tree-1 path')).fill, ROOT), 'rgb(0, 0, 255)', 'class-styled fill overridden');
  // Gradient stops are editable from the element that uses them.
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("sky-background")) .svgs-layer-name');
  assert.equal(await page.locator('.svgs-stop').count(), 3, 'gradient stops listed');
  await page.fill('[data-stop-text="0"]', '#123456');
  await page.press('[data-stop-text="0"]', 'Enter');
  assert.equal(await attr(page, '#sky stop', 'stop-color'), '#123456');
  // Text editing.
  await loadSample(page, 'logo');
  await expand(page, 'wordmark');
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("name")) .svgs-layer-name');
  await page.fill('[data-text]', 'Lumen Studio');
  await page.press('[data-text]', 'Tab');
  assert.equal(await page.evaluate((ROOT) => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#name').textContent, ROOT), 'Lumen Studio');
  await page.fill('#svgs-a-font-size', '40');
  await page.press('#svgs-a-font-size', 'Enter');
  assert.equal(await attr(page, '#name', 'font-size'), '40');
  // Geometry + all-attributes table.
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("background")) .svgs-layer-name');
  await page.fill('#svgs-a-rx', '4');
  await page.press('#svgs-a-rx', 'Enter');
  assert.equal(await attr(page, '#background', 'rx'), '4');
  await page.fill('.svgs-add-attr [name="name"]', 'data-role');
  await page.fill('.svgs-add-attr [name="value"]', 'card');
  await page.click('.svgs-add-attr button');
  assert.equal(await attr(page, '#background', 'data-role'), 'card');
  await page.click('[data-remove-attr="data-role"]');
  assert.equal(await attr(page, '#background', 'data-role'), null);

  // Code edit → canvas (debounced), and a parse error keeps the last good document.
  await page.click('.svgs-tab[data-pane="code"]');
  let src = await codeText(page);
  await page.fill('#svgs-code-text', src.replace(/<circle id="bulb" cx="60"/, '<circle id="bulb" cx="75"'));
  await page.waitForFunction((ROOT) => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#bulb')?.getAttribute('cx') === '75', ROOT);
  assert.match(await page.textContent('.svgs-code-status'), /in sync/);
  src = await codeText(page);
  await page.fill('#svgs-code-text', src.replace('<g id="wordmark">', '<g id="wordmark"'));
  await page.waitForSelector('.svgs-code-status.is-error');
  assert.match(await page.textContent('.svgs-code-status'), /Line \d+/);
  assert.equal(await page.locator('.svgs-gutter .is-error').count(), 1, 'error line marked in the gutter');
  assert.ok(await exists(page, '#wordmark'), 'last good document kept');
  await shot('code-error');
  await page.fill('#svgs-code-text', src);
  await page.waitForSelector('.svgs-code-status:not(.is-error)');
  await page.click('.svgs-tab[data-pane="props"]');

  // ---------------------------------------------------------- undo / redo
  await loadSample(page, 'illustration');
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("sun")) .svgs-layer-name');
  await page.fill('#svgs-p-fill', 'rebeccapurple');
  await page.press('#svgs-p-fill', 'Enter');
  const before = await docBox(page, '#sun');
  const sc = await screenCenter(page, '#sun');
  await drag(page, sc, { x: sc.x + 25, y: sc.y }, 10);
  await page.click('.svgs-viewport', { position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+z');
  near((await docBox(page, '#sun')).cx, before.cx, 0.01, 'one undo reverts the whole drag');
  assert.equal(await attr(page, '#sun', 'fill'), 'rebeccapurple');
  await page.keyboard.press('Control+z');
  assert.equal(await attr(page, '#sun', 'fill'), '#fff7ed', 'second undo reverts the fill');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await attr(page, '#sun', 'fill'), 'rebeccapurple', 'redo');
  await page.keyboard.press('Control+y');
  assert.ok((await docBox(page, '#sun')).cx > before.cx + 1, 'redo the drag');

  // ---------------------------------------------------------- delete, duplicate, group, ungroup, reorder
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("ground")) .svgs-layer-name');
  await page.keyboard.press('Delete');
  assert.equal(await exists(page, '#ground'), false, 'deleted');
  await page.keyboard.press('Control+z');
  assert.equal(await exists(page, '#ground'), true, 'undo delete');

  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("cabin")) .svgs-layer-name');
  await page.keyboard.press('Control+d');
  assert.ok(await exists(page, '#cabin-copy'), 'duplicate gets a new id');
  const ids = await page.evaluate((ROOT) => [...document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelectorAll('[id]')].map((e) => e.id), ROOT);
  assert.equal(new Set(ids).size, ids.length, 'all ids unique after duplicate');
  assert.ok(ids.includes('door-copy'), 'children get new ids too');
  assert.deepEqual(await selectedLayers(page), ['cabin-copy']);

  // Ungroup a translated group: children keep their position.
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("cabin")) .svgs-layer-name');
  assert.deepEqual(await selectedLayers(page), ['cabin']);
  const door0 = await docBox(page, '#door');
  await page.keyboard.press('Control+Shift+g');
  assert.equal(await exists(page, '#cabin'), false, 'group removed');
  assert.equal(await page.evaluate((ROOT) => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#door').parentElement === document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])'), ROOT), true, 'children moved up');
  const door1 = await docBox(page, '#door');
  near(door1.x, door0.x, 0.01, 'ungroup keeps x');
  near(door1.y, door0.y, 0.01, 'ungroup keeps y');
  assert.equal((await selectedLayers(page)).length, 6, 'released children are selected');
  // Group them again.
  await page.keyboard.press('Control+g');
  const gid = await page.evaluate((ROOT) => document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelector('#door').parentElement.id, ROOT);
  assert.match(gid, /^group-\d+$/, 'new group created');
  near((await docBox(page, '#door')).x, door0.x, 0.01, 'grouping keeps positions');

  // Reorder: send sun to the back, then bring it forward.
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("sun")) .svgs-layer-name');
  const order = () => page.evaluate((ROOT) => [...document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').children].map((c) => c.id).filter(Boolean), ROOT);
  await page.click('[data-cmd="back"]');
  assert.equal((await order())[0], 'sun', 'sent to back');
  await page.click('[data-cmd="forward"]');
  assert.deepEqual((await order()).slice(0, 2), ['sky-background', 'sun'], 'brought forward one step');
  await page.click('[data-cmd="front"]');
  assert.equal((await order()).at(-1), 'sun', 'brought to front');
  // Drag a layer row below another one (= behind it in the drawing).
  await page.dragAndDrop('.svgs-layer:has(.svgs-layer-name:text-is("sun"))', '.svgs-layer:has(.svgs-layer-name:text-is("ground"))', { targetPosition: { x: 30, y: 26 } });
  const o2 = await order();
  assert.equal(o2.indexOf('sun'), o2.indexOf('ground') - 1, `layers drag and drop reorders: ${o2.join(',')}`);

  // Visibility + lock toggles.
  await page.hover('.svgs-layer:has(.svgs-layer-name:text-is("sun"))');
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("sun")) [data-act="eye"]');
  assert.equal(await attr(page, '#sun', 'display'), 'none', 'hidden');
  await page.hover('.svgs-layer:has(.svgs-layer-name:text-is("sun"))');
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("sun")) [data-act="eye"]');
  assert.equal(await attr(page, '#sun', 'display'), null, 'shown again');
  await page.hover('.svgs-layer:has(.svgs-layer-name:text-is("mountains"))');
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("mountains")) [data-act="lock"]');
  assert.equal(await attr(page, '#mountains', 'data-studio-lock'), 'true');
  await page.click('.svgs-viewport', { position: { x: 4, y: 4 } });
  const mt = await screenCenter(page, '#mountain-front');
  await page.mouse.click(mt.x, mt.y + 10);
  assert.notDeepEqual(await selectedLayers(page), ['mountains'], 'locked group cannot be selected on the canvas');
  // Rename from the layers panel.
  await page.dblclick('.svgs-layer:has(.svgs-layer-name:text-is("birds")) .svgs-layer-name');
  await page.fill('.svgs-layer-rename', 'seagulls');
  await page.press('.svgs-layer-rename', 'Enter');
  assert.ok(await exists(page, '#seagulls'), 'renamed via layers');

  // ---------------------------------------------------------- export: SVG + PNG
  await page.click('.svgs-layer:has(.svgs-layer-name:text-is("sun")) .svgs-layer-name');
  await page.fill('#svgs-p-fill', '#00ff88');
  await page.press('#svgs-p-fill', 'Enter');
  await page.click('[data-cmd="export"]');
  await page.fill('#svgs-export-name', 'my scene');
  const svgDl = await expectDownload(page, () => page.click('#svgs-dl-svg'));
  assert.equal(svgDl.filename, 'my scene.svg');
  const svgText = fs.readFileSync(svgDl.path, 'utf8');
  const parsed = await page.evaluate((t) => {
    const d = new DOMParser().parseFromString(t, 'image/svg+xml');
    return { err: !!d.querySelector('parsererror'), root: d.documentElement.localName, ns: d.documentElement.namespaceURI };
  }, svgText);
  assert.deepEqual(parsed, { err: false, root: 'svg', ns: 'http://www.w3.org/2000/svg' }, 'downloaded SVG is valid XML');
  assert.match(svgText, /id="sun"[^>]*fill="#00ff88"/, 'contains the edits');
  assert.match(svgText, /id="seagulls"/);
  assert.doesNotMatch(svgText, /data-studio-/, 'no editor-only attributes');
  // Minified variant.
  await page.check('#svgs-minify');
  const minDl = await expectDownload(page, () => page.click('#svgs-dl-svg'));
  const minText = fs.readFileSync(minDl.path, 'utf8');
  assert.ok(minText.length < svgText.length && !/\n\s/.test(minText), 'minified is smaller and single-line');
  // PNG 2x.
  await page.click('[data-scale="2"]');
  const pngDl = await expectDownload(page, () => page.click('#svgs-dl-png'));
  const png = fs.readFileSync(pngDl.path);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  assert.equal(png.readUInt32BE(16), 1280, 'PNG width 2x');
  assert.equal(png.readUInt32BE(20), 800, 'PNG height 2x');
  await page.click('[data-scale="1"]');
  await page.check('input[name="svgs-pngbg"][value="solid"]');
  const png1 = fs.readFileSync((await expectDownload(page, () => page.click('#svgs-dl-png'))).path);
  assert.equal(png1.readUInt32BE(16), 640, 'PNG width 1x');
  await page.click('#svgs-copy-png');
  await page.waitForSelector('.toast:has-text("PNG copied")');
  await page.keyboard.press('Escape');

  // Copy for AI.
  await page.click('[data-cmd="copy-ai"]');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^Here is my edited SVG\. Please/);
  assert.match(clip, /```svg\n<svg[\s\S]*<\/svg>\n```/);
  assert.doesNotMatch(clip, /data-studio-/);

  // ---------------------------------------------------------- animation pause / play
  await loadSample(page, 'loader');
  await page.waitForSelector('#svgs-anim:not([hidden])');
  const animState = () =>
    page.evaluate((ROOT) => {
      const root = document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])');
      return { smil: root.animationsPaused(), css: document.querySelector('#svgs-host').shadowRoot.getAnimations().map((a) => a.playState) };
    }, ROOT);
  let st = await animState();
  assert.equal(st.smil, false);
  assert.ok(st.css.length > 0 && st.css.every((s) => s === 'running'), 'CSS animation running');
  await page.click('#svgs-play');
  st = await animState();
  assert.equal(st.smil, true, 'SMIL paused');
  assert.ok(st.css.every((s) => s === 'paused'), 'CSS animation paused');
  assert.equal(await page.textContent('#svgs-play .svgs-play-label'), 'Play');
  const halo = await screenCenter(page, '#halo');
  await page.mouse.click(halo.x + 60, halo.y);
  assert.equal((await selectedLayers(page)).length, 1, 'selection works while paused');
  await page.click('#svgs-play');
  st = await animState();
  assert.equal(st.smil, false, 'SMIL playing again');
  assert.ok(st.css.every((s) => s === 'running'));
  await page.click('[data-cmd="restart"]');
  await shot('loader');

  // ---------------------------------------------------------- Mermaid template → editable SVG
  await page.click('[data-cmd="mermaid"]');
  await page.selectOption('#svgs-template', 'flowchart');
  await page.click('#svgs-mermaid-go');
  await page.waitForSelector('#svgs-dlg-mermaid', { state: 'hidden', timeout: 30000 });
  const mer = await page.evaluate((ROOT) => {
    const root = document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])');
    return {
      fo: root.querySelectorAll('foreignObject').length,
      texts: [...root.querySelectorAll('text')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
      width: root.getAttribute('width'),
      id: root.id + ' ' + root.querySelectorAll('*').length,
    };
  }, ROOT);
  assert.equal(mer.fo, 0, 'no foreignObject labels');
  assert.ok(mer.texts.includes('Security scan'), `node labels are <text>: ${mer.id} ${mer.texts.join(' | ')}`);
  assert.ok(Number(mer.width) > 100, 'mermaid svg has a real width');
  const label = await page.evaluate((ROOT) => {
    const t = [...document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelectorAll('text')].find((x) => x.textContent.replace(/\s+/g, ' ').trim() === 'Security scan');
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, ROOT);
  await page.keyboard.down('Alt');
  await page.mouse.click(label.x, label.y);
  await page.keyboard.up('Alt');
  await page.waitForSelector('[data-text]');
  await page.fill('[data-text]', 'Vulnerability scan');
  await page.press('[data-text]', 'Tab');
  const texts2 = await page.evaluate((ROOT) => [...document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelectorAll('text')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()), ROOT);
  assert.ok(texts2.includes('Vulnerability scan'), 'mermaid label edited');
  assert.match(await codeText(page), /Vulnerability scan/);
  await shot('mermaid');

  // Every template renders.
  const templateIds = await page.$$eval('#svgs-template option', (o) => o.map((x) => x.value).filter(Boolean));
  assert.ok(templateIds.length >= 9, 'about ten templates');
  for (const id of templateIds) {
    await page.click('[data-cmd="mermaid"]');
    await page.selectOption('#svgs-template', id);
    await page.click('#svgs-mermaid-go');
    await page.waitForSelector('#svgs-dlg-mermaid', { state: 'hidden', timeout: 30000 }).catch(async () => {
      throw new Error(`template ${id} failed: ${await page.textContent('#svgs-mermaid-error')}`);
    });
    const info = await page.evaluate((ROOT) => ({ texts: document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelectorAll('text').length, fo: document.querySelector('#svgs-host').shadowRoot.querySelector('svg:not([aria-hidden])').querySelectorAll('foreignObject').length }), ROOT);
    assert.ok(info.texts > 2, `template ${id} has text labels`);
    assert.equal(info.fo, 0, `template ${id} has no foreignObject`);
  }
  // A syntax error is reported in the dialog.
  await page.click('[data-cmd="mermaid"]');
  await page.fill('#svgs-mermaid-text', 'flowchart LR\n  A --> B -->');
  await page.click('#svgs-mermaid-go');
  await page.waitForSelector('#svgs-mermaid-error:not([hidden])');
  await page.keyboard.press('Escape');

  // Prompt for AI is copyable.
  await page.click('[data-cmd="paste-ai"]');
  await page.click('.svgs-prompt summary');
  await page.click('[data-cmd="copy-prompt"]');
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /grouped|Group related parts/);
  await page.fill('#svgs-paste-text', 'no svg here, sorry');
  await page.click('#svgs-paste-go');
  assert.equal(await page.isVisible('#svgs-paste-error'), true, 'helpful error when nothing is found');
  await page.keyboard.press('Escape');
});

// ====================================================================== dark theme
await runToolTest(
  'svg-studio',
  async ({ page, shot }) => {
    await page.waitForSelector('.svgs-layer');
    await loadSample(page, 'chart');
    const bar = await screenCenter(page, '#bar-q3');
    await page.mouse.click(bar.x, bar.y);
    await page.mouse.dblclick(bar.x, bar.y);
    assert.deepEqual(await selectedLayers(page), ['bar-q3']);
    await shot('dark');
    await page.click('.svgs-tab[data-pane="code"]');
    await shot('dark-code');
  },
  { colorScheme: 'dark' },
);

// ====================================================================== mobile
await runToolTest(
  'svg-studio',
  async ({ page, shot }) => {
    await page.waitForSelector('.svgs-layer', { state: 'attached' });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(await overflow(), 'no horizontal overflow');
    await shot('mobile');
    const sun = await screenCenter(page, '#sun');
    await page.mouse.click(sun.x, sun.y);
    assert.match(await page.textContent('#svgs-status'), /sun/);
    await page.click('.svgs-tab[data-pane="props"]');
    await page.fill('#svgs-p-fill', '#ff00aa');
    await page.press('#svgs-p-fill', 'Enter');
    assert.equal(await attr(page, '#sun', 'fill'), '#ff00aa');
    await page.click('.svgs-tab[data-pane="layers"]');
    assert.ok(await page.isVisible('.svgs-layers'), 'layers tab visible');
    assert.deepEqual(await selectedLayers(page), ['sun']);
    await shot('mobile-layers');
    await page.click('.svgs-tab[data-pane="code"]');
    assert.ok(await page.isVisible('#svgs-code-text'));
    assert.ok(await overflow(), 'no horizontal overflow with panels');
    await page.click('[data-cmd="export"]');
    assert.ok(await overflow(), 'no overflow with the export dialog');
    await shot('mobile-export');
    const dl = await expectDownload(page, () => page.click('#svgs-dl-png'));
    const png = fs.readFileSync(dl.path);
    assert.equal(png.readUInt32BE(16), 1280);
  },
  { viewport: { width: 390, height: 844 } },
);
