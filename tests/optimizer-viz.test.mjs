// Optimizer Race: maths checks through the page's window.__optviz hook (so they also run against a
// production build), then the UI end to end: desktop light, phone, dark theme.
import { runToolTest, assert } from './harness.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);
const waitFor = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const st = (page) => page.evaluate(() => window.__optviz.state());

async function canvasStats(page, sel = '#opt-canvas') {
  return page.$eval(sel, (c) => {
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const seen = new Set();
    let lo = 255, hi = 0;
    for (let i = 0; i < data.length; i += 4 * 11) {
      seen.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
      const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
    const p = (Math.floor(c.height * 0.1) * c.width + Math.floor(c.width * 0.9)) * 4;
    return { colors: seen.size, spread: hi - lo, w: c.width, h: c.height, probe: (data[p] + data[p + 1] + data[p + 2]) / 3 };
  });
}
async function clickAt(page, rx, ry) {
  await page.$eval('#opt-canvas', (el) => el.scrollIntoView({ block: 'center' }));
  const box = await page.locator('#opt-canvas').boundingBox();
  await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
  return box;
}
async function pause(page) {
  if (await page.evaluate(() => window.__optviz.playing)) await page.click('#opt-play');
  await waitFor(page, () => !window.__optviz.playing);
}
const expectedWorld = (view, rx, ry) => [view.xmin + rx * (view.xmax - view.xmin), view.ymax - ry * (view.ymax - view.ymin)];

// =====================================================================================
// 1. Desktop, light theme: maths + full UI
// =====================================================================================
await runToolTest('optimizer-viz', async ({ page, context, shot, BASE_URL }) => {
  await waitFor(page, () => window.__optviz && window.__optviz.state().runners.length === 8);

  // ------------------------------------------------------------------ gradients vs central differences
  const fd = await page.evaluate(() => {
    const E = window.__optviz;
    const ls = [...E.LANDSCAPES, E.makeBowl(1), E.makeBowl(3), E.makeBowl(100)];
    const out = [];
    for (const l of ls) {
      const v = l.view;
      const pts = [l.start, [0.31, -0.67], [1.13, 0.42], [-1.37, 1.71], [2.21, -0.93], [-0.52, -1.24]];
      for (let i = 0; i < 6; i++) pts.push([v.xmin + ((i * 0.37 + 0.13) % 1) * (v.xmax - v.xmin), v.ymin + ((i * 0.61 + 0.29) % 1) * (v.ymax - v.ymin)]);
      for (const [x, y] of pts) {
        const [gx, gy] = l.grad(x, y);
        const hx = 1e-6 * Math.max(1, Math.abs(x)), hy = 1e-6 * Math.max(1, Math.abs(y));
        const fx = (l.f(x + hx, y) - l.f(x - hx, y)) / (2 * hx);
        const fy = (l.f(x, y + hy) - l.f(x, y - hy)) / (2 * hy);
        const rel = Math.hypot(gx - fx, gy - fy) / Math.max(Math.hypot(fx, fy), 1e-6);
        out.push({ id: l.id, x, y, rel });
      }
    }
    return out;
  });
  assert.equal(new Set(fd.map((r) => r.id)).size, 8, 'all 8 landscapes checked');
  for (const r of fd) assert.ok(r.rel < 1e-5, `${r.id} gradient at (${r.x.toFixed(3)}, ${r.y.toFixed(3)}): relative error ${r.rel}`);

  // ------------------------------------------------------------------ hand-computed updates
  // f = x² + 3y², ∇f = (2x, 6y), θ0 = (1, 1). Values below are worked out by hand (see comments).
  const steps = await page.evaluate(() => {
    const E = window.__optviz;
    const g = (x, y) => [2 * x, 6 * y];
    const run = (id, h, n = 2) => {
      const s = E.createState(1, 1);
      const pts = [];
      for (let i = 0; i < n; i++) { E.stepOptimizer(id, s, h, g); pts.push([s.x, s.y]); }
      return { pts, m: [...s.m], v: [...s.v] };
    };
    return {
      sgd: run('sgd', { lr: 0.1 }),
      momentum: run('momentum', { lr: 0.1, mu: 0.9 }),
      nesterov: run('nesterov', { lr: 0.1, mu: 0.9 }),
      adam: run('adam', { lr: 0.1, b1: 0.9, b2: 0.999, eps: 1e-8 }),
      adamw: run('adamw', { lr: 0.1, b1: 0.9, b2: 0.999, eps: 1e-8, wd: 0.1 }),
      lion: run('lion', { lr: 0.1, b1: 0.9, b2: 0.99, wd: 0 }),
      lionwd: run('lion', { lr: 0.1, b1: 0.9, b2: 0.99, wd: 0.5 }, 1),
      adagrad: run('adagrad', { lr: 0.5, eps: 1e-8 }, 1),
      rmsprop: run('rmsprop', { lr: 0.01, rho: 0.9, eps: 1e-8 }, 1),
    };
  });
  const pt = (got, exp, tol, msg) => { near(got[0], exp[0], tol, `${msg} x`); near(got[1], exp[1], tol, `${msg} y`); };
  // SGD: θ1 = (1 − 0.2, 1 − 0.6); θ2 = (0.8 − 0.16, 0.4 − 0.24)
  pt(steps.sgd.pts[0], [0.8, 0.4], 1e-12, 'SGD step 1');
  pt(steps.sgd.pts[1], [0.64, 0.16], 1e-12, 'SGD step 2');
  // Momentum: v1 = (−0.2, −0.6); v2 = 0.9·v1 − 0.1·(1.6, 2.4) = (−0.34, −0.78); θ2 = (0.46, −0.38)
  pt(steps.momentum.pts[0], [0.8, 0.4], 1e-12, 'Momentum step 1');
  pt(steps.momentum.pts[1], [0.46, -0.38], 1e-12, 'Momentum step 2');
  pt(steps.momentum.m, [-0.34, -0.78], 1e-12, 'Momentum velocity');
  // Nesterov: look-ahead (0.8, 0.4) + 0.9·(−0.2, −0.6) = (0.62, −0.14), g = (1.24, −0.84),
  // v2 = (−0.18 − 0.124, −0.54 + 0.084) = (−0.304, −0.456); θ2 = (0.496, −0.056)
  pt(steps.nesterov.pts[0], [0.8, 0.4], 1e-12, 'Nesterov step 1');
  pt(steps.nesterov.pts[1], [0.496, -0.056], 1e-12, 'Nesterov step 2');
  // Adam: step 1 = lr·sign(g) → (0.9, 0.9). Step 2: m = (0.36, 1.08), v = (0.007236, 0.065124),
  // m̂ = m/0.19, v̂ = v/0.001999 → m̂/√v̂ = 0.9958779 per coordinate → θ2 = 0.9 − 0.09958779
  pt(steps.adam.pts[0], [0.9, 0.9], 1e-8, 'Adam step 1');
  pt(steps.adam.pts[1], [0.8004122, 0.8004122], 1e-6, 'Adam step 2');
  pt(steps.adam.m, [0.36, 1.08], 1e-8, 'Adam first moment');
  pt(steps.adam.v, [0.007236, 0.065124], 1e-9, 'Adam second moment');
  // AdamW: θ1 = 1 − 0.1·(1 + 0.1·1) = 0.89. Step 2: g = (1.78, 5.34), m̂/√v̂ = 0.995281,
  // θ2 = 0.89 − 0.1·(0.995281 + 0.1·0.89) = 0.7815719. Decay is decoupled: m holds no λθ term.
  pt(steps.adamw.pts[0], [0.89, 0.89], 1e-8, 'AdamW step 1');
  pt(steps.adamw.pts[1], [0.7815719, 0.7815719], 1e-6, 'AdamW step 2');
  pt(steps.adamw.m, [0.358, 1.074], 1e-8, 'AdamW first moment ignores weight decay');
  // Lion: c = 0.1·g > 0 → θ1 = 0.9; m1 = 0.01·g = (0.02, 0.06); c2 > 0 → θ2 = 0.8; m2 = 0.99·m1 + 0.01·(1.8, 5.4)
  pt(steps.lion.pts[0], [0.9, 0.9], 1e-12, 'Lion step 1');
  pt(steps.lion.pts[1], [0.8, 0.8], 1e-12, 'Lion step 2');
  pt(steps.lion.m, [0.0378, 0.1134], 1e-12, 'Lion momentum uses β2');
  pt(steps.lionwd.pts[0], [0.85, 0.85], 1e-12, 'Lion decoupled weight decay: 1 − 0.1·(1 + 0.5)');
  // AdaGrad: θ1 = 1 − 0.5·2/√4 = 0.5; RMSProp: θ1 = 1 − 0.01·2/√0.4
  pt(steps.adagrad.pts[0], [0.5, 0.5], 1e-8, 'AdaGrad step 1');
  pt(steps.rmsprop.pts[0], [1 - 0.01 * 2 / Math.sqrt(0.4), 1 - 0.01 * 6 / Math.sqrt(3.6)], 1e-8, 'RMSProp step 1');

  // ------------------------------------------------------------------ Adam bias correction: first step = η
  const bias = await page.evaluate(() => {
    const E = window.__optviz;
    const out = [];
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (const [b1, b2] of [[0.9, 0.999], [0.5, 0.9], [0.99, 0.9999]]) {
      for (let k = 0; k < 10; k++) {
        const gx = rnd() * 10 ** (rnd() * 3), gy = rnd() * 10 ** (rnd() * 3);
        const lr = 0.01 + Math.abs(rnd()) * 0.2;
        for (const id of ['adam', 'adamw']) {
          const s = E.createState(0, 0);
          E.stepOptimizer(id, s, { lr, b1, b2, eps: 1e-12, wd: 0 }, () => [gx, gy]);
          out.push({ id, dx: Math.abs(s.x) / lr, dy: Math.abs(s.y) / lr, sx: Math.sign(-s.x) === Math.sign(gx) });
        }
      }
    }
    return out;
  });
  for (const b of bias) {
    near(b.dx, 1, 1e-6, `${b.id} first step |Δx| = η`);
    near(b.dy, 1, 1e-6, `${b.id} first step |Δy| = η`);
    assert.ok(b.sx, 'first step points down the gradient');
  }

  // ------------------------------------------------------------------ convergence, divergence, classification
  const races = await page.evaluate(() => {
    const E = window.__optviz;
    const run = (l, ids, over = {}, start = l.start, maxSteps = l.maxSteps) => {
      const r = new E.Race({ landscape: l, start, optimizers: ids.map((id) => ({ id, hyper: { ...E.defaultHyper(id, l), ...(over[id] || {}) } })), noise: 0, clip: 0, maxSteps, seed: 1 });
      r.runToEnd();
      return r.runners.map((u) => ({ id: u.id, status: u.status, doneAt: u.doneAt, end: u.end, x: u.state.x, y: u.state.y }));
    };
    const bowl = E.getLandscape('bowl');
    return {
      bowl: run(bowl, E.OPTIMIZER_IDS),
      bowlK5: run(E.getLandscape('bowl', 5), E.OPTIMIZER_IDS),
      huge: run(bowl, ['sgd', 'momentum', 'nesterov', 'adagrad', 'rmsprop'], { sgd: { lr: 50 }, momentum: { lr: 50 }, nesterov: { lr: 50 }, adagrad: { lr: 1e5 }, rmsprop: { lr: 1e5 } }),
      boundedAdam: run(bowl, ['adam'], { adam: { lr: 3 } }, bowl.start, 300),
      saddleExact: run(E.getLandscape('saddle'), ['sgd'], {}, [-1.5, 0], 3000),
      classify: {
        rastrigin: E.classifyPoint(E.getLandscape('rastrigin'), 3.98, 3.98),
        saddle: E.classifyPoint(E.getLandscape('saddle'), 0.001, 0),
        himmel: [[3, 2], [-2.805118, 3.131312], [-3.77931, -3.283186], [3.584428, -1.848126]].map(([x, y]) => E.classifyPoint(E.getLandscape('himmelblau'), x + 1e-3, y - 1e-3)),
        camelLocal: E.classifyPoint(E.getLandscape('camel'), -1.6071, -0.5687),
      },
    };
  });
  for (const r of [...races.bowl, ...races.bowlK5]) {
    assert.equal(r.status, 'converged', `${r.id} converges on the convex bowl at default settings (got ${r.status})`);
    assert.ok(r.doneAt <= 800, `${r.id} converged within 800 steps (${r.doneAt})`);
    assert.ok(Math.hypot(r.end[0], r.end[1]) < 0.05, `${r.id} ends near (0, 0): ${r.end}`);
  }
  for (const r of races.huge) assert.equal(r.status, 'diverged', `${r.id} with a huge learning rate is flagged as diverged`);
  for (const r of races.huge.filter((r) => ['sgd', 'momentum', 'nesterov'].includes(r.id))) assert.ok(r.doneAt < 30, `${r.id} diverges fast (${r.doneAt})`);
  assert.notEqual(races.boundedAdam[0].status, 'diverged', 'Adam’s steps are bounded by η, so η = 3 does not explode');
  assert.equal(races.saddleExact[0].status, 'saddle', 'SGD started exactly on the ridge stops at the saddle');
  assert.equal(races.classify.rastrigin, 'local-min');
  assert.equal(races.classify.saddle, 'saddle');
  assert.deepEqual(races.classify.himmel, ['converged', 'converged', 'converged', 'converged'], 'all four Himmelblau minima are global');
  assert.equal(races.classify.camelLocal, 'local-min');

  // ------------------------------------------------------------------ hash codec (pure)
  const codec = await page.evaluate(() => {
    const E = window.__optviz;
    const hyper = {};
    for (const id of E.OPTIMIZER_IDS) hyper[id] = E.defaultHyper(id, E.getLandscape('beale'));
    hyper.adam = { lr: 0.0123, b1: 0.85, b2: 0.995, eps: 1e-7 };
    const s = { landscape: 'beale', kappa: 20, start: [1.25, -0.5], enabled: ['sgd', 'adam', 'lion'], hyper, noise: 0.3, clip: 5, maxSteps: 1200, speed: 5, selected: 'adam' };
    const h = E.encodeHash(s);
    return { h, d: E.decodeHash('#' + h), junk: E.decodeHash('#l=nope&s=a,b&o=xyz:1;sgd:abc&m=-5') };
  });
  assert.equal(codec.d.landscape, 'beale');
  assert.deepEqual(codec.d.start, [1.25, -0.5]);
  assert.deepEqual(codec.d.enabled, ['sgd', 'adam', 'lion']);
  assert.deepEqual(codec.d.hyper.adam, { lr: 0.0123, b1: 0.85, b2: 0.995, eps: 1e-7 });
  assert.equal(codec.d.noise, 0.3);
  assert.equal(codec.d.clip, 5);
  assert.equal(codec.d.maxSteps, 1200);
  assert.equal(codec.d.selected, 'adam');
  assert.equal(codec.junk.landscape, undefined, 'unknown landscape ignored');
  assert.equal(codec.junk.start, undefined, 'malformed start ignored');
  assert.deepEqual(codec.junk.enabled, ['sgd'], 'unknown optimizer dropped');
  assert.equal(codec.junk.maxSteps, 10, 'max steps clamped');

  // ------------------------------------------------------------------ UI: loaded state
  const s0 = await st(page);
  assert.equal(s0.landscape, 'bowl');
  assert.equal(await page.locator('#opt-legend .opt-row').count(), 8, '8 racers in the standings');
  assert.equal(await page.locator('#opt-strip .opt-land').count(), 8, '8 landscape thumbnails');
  const cs = await canvasStats(page);
  assert.ok(cs.colors > 60 && cs.spread > 60, `canvas is not blank (${cs.colors} colours, spread ${cs.spread})`);
  const thumb = await canvasStats(page, '#opt-strip .opt-land:nth-child(2) canvas');
  assert.ok(thumb.colors > 15, 'landscape thumbnails are rendered');
  await page.waitForTimeout(600);
  await shot('desktop-autoplay');

  // ------------------------------------------------------------------ click sets the start point
  await pause(page);
  const view = await page.evaluate(() => window.__optviz.view);
  await clickAt(page, 0.3, 0.32);
  const s1 = await st(page);
  const [ex, ey] = expectedWorld(view, 0.3, 0.32);
  const tolX = (view.xmax - view.xmin) / 150, tolY = (view.ymax - view.ymin) / 150;
  near(s1.start[0], ex, tolX, 'start x from click');
  near(s1.start[1], ey, tolY, 'start y from click');
  const startText = await page.textContent('#opt-start');
  const shown = startText.replace(/−/g, '-').match(/-?[\d.]+(e-?\d+)?/g).map(Number);
  near(shown[0], s1.start[0], 1e-3 * Math.max(1, Math.abs(s1.start[0])), 'reported start x');
  near(shown[1], s1.start[1], 1e-3 * Math.max(1, Math.abs(s1.start[1])), 'reported start y');
  assert.ok(s1.runners.every((r) => r.steps >= 0), 'race restarted');
  assert.equal(await page.isHidden('#opt-hint'), true, 'launch hint hides after the first click');
  // every optimizer starts at the clicked point
  const firsts = await page.evaluate(() => window.__optviz.race.runners.map((r) => [r.xs[0], r.ys[0]]));
  for (const f of firsts) assert.deepEqual(f, s1.start, 'all optimizers start at the clicked point');
  await waitFor(page, () => window.__optviz.state().step > 5);

  // ------------------------------------------------------------------ hover readout
  const box = await page.locator('#opt-canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await waitFor(page, () => !document.getElementById('opt-readout').hidden);
  const ro = (await page.textContent('#opt-readout')).replace(/−/g, '-');
  const [rx, ry, rf] = ro.match(/-?[\d.]+(e-?\d+)?/g).map(Number);
  const [cx, cy] = expectedWorld(view, 0.5, 0.5);
  near(rx, cx, tolX, 'hover x');
  near(ry, cy, tolY, 'hover y');
  near(rf, cx * cx / 20 + cy * cy, 0.05 + 0.02 * Math.abs(rf), 'hover f');
  await page.mouse.move(box.x - 30, box.y - 30);
  await waitFor(page, () => document.getElementById('opt-readout').hidden);

  // ------------------------------------------------------------------ reset / play / step
  await pause(page);
  await page.click('#opt-reset');
  let s = await st(page);
  assert.equal(s.step, 0, 'reset puts the race back at step 0');
  assert.equal(await page.textContent('#opt-step-num'), '0');
  const legendSteps = () => page.$$eval('#opt-legend [data-field=steps]', (els) => els.map((e) => +e.textContent));
  assert.ok((await legendSteps()).every((v) => v === 0), 'legend step counters at 0');
  await page.click('#opt-step');
  assert.equal((await st(page)).step, 1, 'single step advances by one');
  assert.ok((await legendSteps()).every((v) => v === 1), 'legend step counters at 1');
  await page.click('#opt-play');
  await waitFor(page, () => window.__optviz.state().step > 40);
  await pause(page);
  const steps1 = await legendSteps();
  assert.ok(steps1.every((v) => v > 20), `play advances every step counter (${steps1})`);
  assert.ok(+(await page.textContent('#opt-step-num')) > 40, 'step readout advances');

  // ------------------------------------------------------------------ run a full race to the finish
  await page.selectOption('#opt-speed', '50');
  await page.click('#opt-play');
  await waitFor(page, () => window.__optviz.state().finished && !window.__optviz.playing);
  s = await st(page);
  assert.ok(s.podium.length >= 6, `most racers converge from this start (${s.podium})`);
  const firstRow = page.locator('#opt-legend .opt-row').filter({ has: page.locator('[data-place="1"]') });
  assert.equal(await firstRow.count(), 1, 'exactly one winner badge');
  assert.equal(await firstRow.getAttribute('data-opt'), s.podium[0], 'winner badge on the first finisher');
  const winnerPill = await firstRow.locator('[data-field=status]').textContent();
  assert.match(winnerPill, /^converged @ \d+$/, 'status pill reads "converged @ N"');
  assert.match(await page.textContent('#opt-summary'), /wins at step \d+/);
  assert.match(await page.textContent('#opt-play'), /Replay/);
  // visual order follows the finishing order
  const order = await page.$$eval('#opt-legend .opt-row', (rows) => rows.map((r) => ({ id: r.dataset.opt, o: +r.style.order })).sort((a, b) => a.o - b.o).map((r) => r.id));
  assert.deepEqual(order.slice(0, s.podium.length), s.podium, 'standings sorted by finishing order');
  await shot('desktop-finished');

  // ------------------------------------------------------------------ toggling an optimizer
  await page.uncheck('[data-toggle=adam]');
  assert.equal(await page.locator('#opt-legend [data-opt=adam]').count(), 0, 'Adam removed from the standings');
  assert.ok(!(await st(page)).enabled.includes('adam'));
  assert.equal(await page.locator('#opt-legend .opt-row').count(), 7);
  await page.check('[data-toggle=adam]');
  assert.equal(await page.locator('#opt-legend [data-opt=adam]').count(), 1, 'Adam back in the standings');
  for (const id of ['sgd', 'momentum', 'nesterov', 'adagrad', 'rmsprop', 'adam', 'adamw', 'lion']) await page.uncheck(`[data-toggle=${id}]`);
  assert.equal(await page.locator('#opt-legend .opt-row').count(), 0);
  assert.equal(await page.isVisible('#opt-legend-empty'), true, 'empty-state message when nobody races');
  for (const id of ['sgd', 'momentum', 'nesterov', 'adagrad', 'rmsprop', 'adam', 'adamw', 'lion']) await page.check(`[data-toggle=${id}]`);
  await pause(page);

  // ------------------------------------------------------------------ select + explanation (KaTeX)
  await page.click('#opt-racers [data-select=lion]');
  assert.equal((await st(page)).selected, 'lion');
  assert.match(await page.textContent('#opt-ex-name'), /Lion/);
  await waitFor(page, () => document.getElementById('opt-root').dataset.katex === 'ready');
  assert.ok(await page.locator('#opt-ex-tex .katex').count(), 'update equations rendered with KaTeX');
  assert.ok(await page.locator('#opt-formula .katex').count(), 'landscape formula rendered with KaTeX');
  assert.match(await page.textContent('#opt-ex-tex .katex-mathml'), /sign/, 'Lion equations mention sign');
  assert.ok(await page.locator('#opt-ex-tips li.is-mine').count() >= 1, 'a Lion-specific tip is highlighted');
  assert.match(await page.textContent('#opt-ex-tips li:first-child'), /Lion/, 'Lion’s tip comes first');
  assert.match(await page.textContent('#opt-tune-title'), /Lion/);
  assert.deepEqual(await page.$$eval('#opt-tune [data-key]', (els) => els.map((e) => e.dataset.key)), ['lr', 'b1', 'b2', 'wd'], 'Lion exposes η, β1, β2, λ');
  // tuning the learning rate (number input) updates the config and the racer list
  await page.fill('#opt-hp-lr-num', '0.07');
  assert.equal((await st(page)).hyper.lion.lr, 0.07);
  assert.match(await page.textContent('#opt-racers [data-opt=lion] [data-lr]'), /0\.07/);
  // slider for β1 (nines scale: 0.5 → 0.99)
  await page.$eval('#opt-hp-b1', (el) => { el.value = '500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  near((await st(page)).hyper.lion.b1, 0.99, 1e-9, 'β1 slider half-way = 0.99');
  await page.click('#opt-tune-reset');
  assert.deepEqual((await st(page)).hyper.lion, { lr: 0.04, b1: 0.9, b2: 0.99, wd: 0 }, 'defaults restored');
  // clicking a standings row also selects
  await page.click('#opt-legend [data-opt=nesterov] [data-select]');
  assert.equal((await st(page)).selected, 'nesterov');
  assert.match(await page.textContent('#opt-ex-name'), /Nesterov/);

  // ------------------------------------------------------------------ condition number slider
  await page.$eval('#opt-kappa', (el) => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal((await st(page)).kappa, 100);
  assert.match(await page.textContent('#opt-kappa-out'), /100/);
  await waitFor(page, () => /100/.test(document.getElementById('opt-formula').textContent));

  // ------------------------------------------------------------------ gradient settings
  await page.$eval('#opt-noise', (el) => { el.value = '0.4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal((await st(page)).noise, 0.4);
  assert.match(await page.textContent('#opt-noise-out'), /σ = 0\.4/);
  await page.selectOption('#opt-clip', '2');
  assert.equal((await st(page)).clip, 2);
  const clipped = await page.evaluate(() => {
    const r = window.__optviz.race.runners[0];
    return Math.hypot(...r.grad(100, 100));
  });
  near(clipped, 2, 1e-9, 'gradient norm is clipped');
  await page.selectOption('#opt-max', '200');
  assert.equal((await st(page)).maxSteps, 200);

  // ------------------------------------------------------------------ landscape strip
  for (const id of ['rosenbrock', 'beale', 'himmelblau', 'saddle', 'rastrigin', 'camel', 'noisy', 'bowl']) {
    await page.click(`#opt-strip [data-land=${id}]`);
    const sl = await st(page);
    assert.equal(sl.landscape, id);
    assert.equal(await page.getAttribute(`#opt-strip [data-land=${id}]`, 'aria-pressed'), 'true');
    assert.equal(await page.isVisible('#opt-kappa-field'), id === 'bowl', 'κ slider only for the bowl');
    const exp = await page.evaluate((lid) => window.__optviz.getLandscape(lid).start, id);
    assert.deepEqual(sl.start, exp, `${id}: default start point`);
    const c = await canvasStats(page);
    assert.ok(c.colors > 40, `${id}: canvas rendered`);
    if (id === 'rastrigin') await shot('rastrigin');
  }
  await pause(page);

  // ------------------------------------------------------------------ presets
  const presets = await page.evaluate(() => window.__optviz.PRESETS.map((p) => ({ id: p.id, name: p.name, landscape: p.landscape, kappa: p.kappa, ids: Object.keys(p.optimizers), start: p.start, select: p.select })));
  assert.equal(presets.length, 5);
  for (const p of presets) {
    await page.click(`[data-preset="${p.id}"]`);
    const sp = await st(page);
    assert.equal(sp.landscape, p.landscape, `${p.id}: landscape`);
    if (p.kappa) assert.equal(sp.kappa, p.kappa, `${p.id}: κ`);
    assert.deepEqual([...sp.enabled].sort(), [...p.ids].sort(), `${p.id}: optimizers`);
    assert.deepEqual(sp.start, p.start, `${p.id}: start`);
    assert.equal(sp.selected, p.select, `${p.id}: selected`);
    assert.deepEqual((await page.$$eval('#opt-legend .opt-row', (r) => r.map((e) => e.dataset.opt))).sort(), [...p.ids].sort(), `${p.id}: legend`);
    assert.equal(await page.textContent('#opt-lesson-title'), p.name, `${p.id}: lesson card`);
    assert.equal(await page.getAttribute(`[data-preset="${p.id}"]`, 'aria-pressed'), 'true');
    assert.equal(sp.playing, true, `${p.id}: preset starts the race`);
  }
  // "Learning rate too high": run it out and check the labels
  await page.click('[data-preset="lr-high"]');
  await page.selectOption('#opt-speed', '50');
  await waitFor(page, () => window.__optviz.state().finished);
  const lrHigh = Object.fromEntries((await st(page)).runners.map((r) => [r.id, r.status]));
  assert.equal(lrHigh.sgd, 'diverged');
  assert.equal(lrHigh.momentum, 'diverged');
  assert.notEqual(lrHigh.adam, 'diverged');
  assert.match(await page.textContent('#opt-legend [data-opt=sgd] [data-field=status]'), /^diverged @ \d+$/);
  assert.equal(await page.textContent('#opt-legend [data-opt=sgd] [data-field=rank]'), '✕');
  await shot('preset-lr-high');
  // Saddle preset: Adam escapes long before SGD
  await page.click('[data-preset="saddle"]');
  await page.selectOption('#opt-speed', '50');
  await waitFor(page, () => window.__optviz.state().finished);
  const sad = Object.fromEntries((await st(page)).runners.map((r) => [r.id, r]));
  assert.equal(sad.rmsprop.status, 'converged');
  assert.ok(sad.rmsprop.doneAt < sad.sgd.doneAt && sad.momentum.doneAt < sad.sgd.doneAt, 'adaptive and momentum methods escape the saddle before SGD');
  await page.click('[data-preset="rosenbrock"]');
  await page.selectOption('#opt-speed', '50');
  await waitFor(page, () => window.__optviz.state().finished);
  const ros = await st(page);
  assert.equal(ros.podium[0], 'adam', 'Adam wins the Rosenbrock lesson');
  await shot('preset-rosenbrock');

  // ------------------------------------------------------------------ share hash round trip
  await page.click('[data-preset="momentum"]');
  await pause(page);
  await clickAt(page, 0.2, 0.25);
  await pause(page);
  await page.$eval('#opt-noise', (el) => { el.value = '0.15'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#opt-racers [data-select=nesterov]');
  await page.fill('#opt-hp-mu-num', '0.95');
  await page.click('#opt-share');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const href = await page.evaluate(() => location.href);
  assert.equal(clip, href, 'share copies the current URL');
  assert.match(href, /#l=bowl&k=50&s=/, 'hash encodes landscape and κ');
  const before = await st(page);
  const p2 = await context.newPage();
  const errs = [];
  p2.on('pageerror', (e) => errs.push(e.message));
  await p2.goto(href, { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => window.__optviz, null, { timeout: 20000 });
  const after = await p2.evaluate(() => window.__optviz.state());
  for (const k of ['landscape', 'kappa', 'start', 'enabled', 'selected', 'noise', 'clip', 'maxSteps', 'speed']) assert.deepEqual(after[k], before[k], `hash round trip: ${k}`);
  for (const id of before.enabled) assert.deepEqual(after.hyper[id], before.hyper[id], `hash round trip: ${id} hyperparameters`);
  assert.equal(after.hyper.nesterov.mu, 0.95);
  assert.deepEqual(errs, []);
  await p2.close();
  // editing the hash by hand applies it
  await page.evaluate(() => { location.hash = 'l=himmelblau&s=-0.3,-0.9&o=sgd:0.01;lion:0.02,0.9,0.99,0&n=0&c=0&m=800&v=2&sel=lion'; });
  await waitFor(page, () => window.__optviz.state().landscape === 'himmelblau');
  const hs = await st(page);
  assert.deepEqual(hs.enabled, ['sgd', 'lion']);
  assert.deepEqual(hs.start, [-0.3, -0.9]);

  // ------------------------------------------------------------------ keyboard
  await page.focus('#opt-canvas');
  await page.keyboard.press('ArrowRight');
  const kx = (await st(page)).start[0];
  assert.ok(kx > -0.3, `ArrowRight moves the start point (${kx})`);
  await page.keyboard.press('Enter');
  await waitFor(page, () => window.__optviz.state().step > 3);
  await page.keyboard.press(' ');
  await waitFor(page, () => !window.__optviz.playing);
  const sn = (await st(page)).step;
  await page.keyboard.press('n');
  assert.equal((await st(page)).step, sn + 1, 'N steps once');
  await page.keyboard.press('r');
  assert.equal((await st(page)).step, 0, 'R resets');
  await shot('desktop-final');
});

// =====================================================================================
// 2. Phone viewport: layout + tap to set the start
// =====================================================================================
await runToolTest('optimizer-viz', async ({ page, shot }) => {
  await waitFor(page, () => window.__optviz && window.__optviz.state().runners.length === 8);
  await page.waitForTimeout(800);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(overflow, 'no horizontal page overflow at 390px');
  const cb = await page.locator('#opt-canvas').boundingBox();
  assert.ok(cb.width >= 320 && cb.width <= 390, `canvas fits the width (${cb.width})`);
  // stage comes before the controls
  const stageY = (await page.locator('.opt-stage').boundingBox()).y;
  const ctrlY = (await page.locator('.opt-ctrl').boundingBox()).y;
  assert.ok(stageY < ctrlY, 'controls stack below the canvas');
  assert.equal(await page.isVisible('.opt-stage .opt-hide-xs'), false, 'button labels hidden on a phone');
  // inputs are not squashed
  const sel = await page.locator('#opt-speed').boundingBox();
  assert.ok(sel.width > 90, `speed select readable (${sel.width})`);
  // tap (touch pointer) on the canvas sets the start
  await pause(page);
  const view = await page.evaluate(() => window.__optviz.view);
  await page.$eval('#opt-canvas', (c) => {
    const r = c.getBoundingClientRect();
    const opts = { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: r.left + r.width * 0.7, clientY: r.top + r.height * 0.6 };
    c.dispatchEvent(new PointerEvent('pointerdown', opts));
    c.dispatchEvent(new PointerEvent('pointerup', opts));
  });
  const s = await st(page);
  const [ex, ey] = expectedWorld(view, 0.7, 0.6);
  near(s.start[0], ex, (view.xmax - view.xmin) / 100, 'tap x');
  near(s.start[1], ey, (view.ymax - view.ymin) / 100, 'tap y');
  assert.equal(await page.isVisible('#opt-readout'), true, 'tap shows the readout');
  await waitFor(page, () => window.__optviz.state().step > 10);
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(overflow2, 'still no overflow while racing');
  await shot('mobile');
}, { viewport: { width: 390, height: 844 } });

// =====================================================================================
// 3. Dark theme + live theme switch
// =====================================================================================
await runToolTest('optimizer-viz', async ({ page, shot }) => {
  await waitFor(page, () => window.__optviz && window.__optviz.state().runners.length === 8);
  await page.click('[data-preset="rosenbrock"]');
  await page.selectOption('#opt-speed', '50');
  await waitFor(page, () => window.__optviz.state().finished);
  const dark = await canvasStats(page);
  assert.ok(dark.colors > 40, 'dark canvas rendered');
  assert.ok(dark.probe < 150, `dark heatmap is dark (${dark.probe})`);
  await waitFor(page, () => document.getElementById('opt-root').dataset.katex === 'ready');
  await shot('dark');
  await page.click('#theme-toggle');
  await page.waitForTimeout(300);
  const light = await canvasStats(page);
  assert.ok(light.probe > dark.probe + 60, `theme switch re-renders the heatmap (${dark.probe} → ${light.probe})`);
  await shot('dark-toggled-light');
}, { colorScheme: 'dark' });
