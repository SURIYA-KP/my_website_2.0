// The tools hub: every ready tool is listed, category chips and search filter correctly.
import { runToolTest, assert } from './harness.mjs';
import fs from 'node:fs';

const registry = fs.readFileSync(new URL('../src/data/tools.ts', import.meta.url), 'utf8');
const readyCount = (registry.match(/ready: true/g) || []).length;

for (const opts of [{ path: '/tools/' }, { path: '/tools/', viewport: { width: 390, height: 844 }, colorScheme: 'dark' }]) {
  await runToolTest('hub', async ({ page }) => {
    const cards = page.locator('.tool-card');
    assert.equal(await cards.count(), readyCount, 'every ready tool has a card');
    for (const href of await cards.evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
      assert.ok(href.startsWith('/my_website_2.0/tools/'), `card link includes the base path: ${href}`);
    }
    await page.click('.hub-chip[data-cat="AI & ML"]');
    assert.deepEqual(await page.$$eval('.tool-card:not([hidden]) .tool-card-name', (e) => e.map((x) => x.textContent)), ['Optimizer Race', 'ML Lab']);
    await page.click('.hub-chip[data-cat=""]');
    await page.fill('#tool-search', 'pdf');
    assert.deepEqual(await page.$$eval('.tool-card:not([hidden]) .tool-card-name', (e) => e.map((x) => x.textContent)), ['PDF Toolkit']);
    await page.fill('#tool-search', 'no-such-tool');
    assert.ok(await page.isVisible('#no-results'), 'empty state shows');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
  }, opts);
}
