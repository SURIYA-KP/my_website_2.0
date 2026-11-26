// ML Lab: pure-module checks (k-means, MLP maths) through the page's debug hook, then the UI
// end to end (desktop light, phone, dark). Works against the dev server and a production build.
import { runToolTest, assert } from './harness.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);

/** Count distinct-ish colours and luminance spread of a canvas (to prove it is not blank). */
async function canvasStats(page, sel) {
  return page.$eval(sel, (c) => {
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const seen = new Set();
    let lo = 255, hi = 0;
    for (let i = 0; i < data.length; i += 4 * 7) {
      seen.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
      const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (l < lo) lo = l; if (l > hi) hi = l;
    }
    const mid = ((Math.floor(c.height / 2) * c.width) + 4) * 4;
    return { colors: seen.size, spread: hi - lo, w: c.width, h: c.height, corner: [data[0], data[1], data[2]], mid: [data[mid], data[mid + 1], data[mid + 2]] };
  });
}
const cl = (page) => page.evaluate(() => window.__mllab.cluster);
const nn = (page) => page.evaluate(() => window.__mllab.nn);
const waitFor = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });

/** Drag across a canvas between two relative positions (0..1) with the mouse. */
async function drag(page, sel, from, to, steps = 12) {
  await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' }));
  const box = await page.locator(sel).boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps });
  await page.mouse.up();
}
async function clickAt(page, sel, rx, ry) {
  await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' }));
  const box = await page.locator(sel).boundingBox();
  await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
}
async function setRange(page, sel, value) {
  await page.$eval(sel, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
}

// =====================================================================================
// 1. Desktop, light theme
// =====================================================================================
await runToolTest('ml-lab', async ({ page, shot }) => {
  await page.waitForFunction(() => window.__mllab && window.__mllab.cluster.elbow === 10, null, { timeout: 20000 });

  // ------------------------------------------------------------------ k-means (pure module)
  const km = await page.evaluate(() => {
    const { kmeans: K, datasets: D, rng: R } = window.__mllab;
    const out = { recover: [], ppDistinct: true, ppDupes: [], randomDistinct: true, monotonic: [], suggest: [] };
    // (a) recovers the true centres of separated blobs
    for (const seed of [1, 2, 3, 4, 5]) {
      const { points, trueCenters } = D.makeClusterData('blobs', { n: 600, noise: 0.1, centers: 4, seed });
      const res = K.bestOfRestarts(points, 4, 5, seed);
      const used = new Set();
      let worst = 0;
      for (const t of trueCenters) {
        let best = -1, bd = Infinity;
        res.centroids.forEach((c, j) => { const d = Math.hypot(c.x - t.x, c.y - t.y); if (d < bd) { bd = d; best = j; } });
        used.add(best);
        worst = Math.max(worst, bd);
      }
      out.recover.push({ seed, worst, oneToOne: used.size === 4, converged: res.converged });
      out.suggest.push(K.suggestK(K.elbow(points, 8, 3, seed)));
    }
    // (b) k-means++ (and random init) pick distinct starting points
    for (let s = 1; s <= 30; s++) {
      const pts = D.makeClusterData('uniform', { n: 200, noise: 0, centers: 1, seed: s }).points;
      for (const method of ['kmeans++', 'random']) {
        const c = K.initCentroids(pts, 10, method, R.mulberry32(s));
        const keys = new Set(c.map((p) => `${p.x},${p.y}`));
        const onData = c.every((p) => pts.some((q) => q.x === p.x && q.y === p.y));
        if (keys.size !== 10 || !onData) { if (method === 'kmeans++') out.ppDistinct = false; else out.randomDistinct = false; }
      }
    }
    // duplicates: 5 locations x 40 copies; k = 5 must hit all 5 locations
    const locs = [[-0.8, -0.8], [0.8, -0.8], [0, 0], [-0.8, 0.8], [0.8, 0.8]];
    const dup = [];
    locs.forEach(([x, y]) => { for (let i = 0; i < 40; i++) dup.push({ x, y }); });
    for (let s = 1; s <= 20; s++) out.ppDupes.push(new Set(K.initCentroids(dup, 5, 'kmeans++', R.mulberry32(s)).map((p) => `${p.x},${p.y}`)).size);
    // (c) inertia never increases across assign / update phases
    for (const kind of ['blobs', 'uniform', 'moons', 'rings', 'aniso']) {
      for (const seed of [1, 2, 3]) {
        for (const init of ['random', 'kmeans++']) {
          const pts = D.makeClusterData(kind, { n: 300, noise: 0.4, centers: 5, seed }).points;
          let c = K.initCentroids(pts, 6, init, R.mulberry32(seed));
          const labels = new Int32Array(pts.length).fill(-1);
          const trace = [];
          for (let it = 0; it < 100; it++) {
            const a = K.assign(pts, c, labels);
            trace.push(a.inertia);
            if (a.changed === 0) break;
            c = K.update(pts, labels, c).centroids;
            trace.push(K.inertia(pts, labels, c));
          }
          let ok = true;
          for (let i = 1; i < trace.length; i++) if (trace[i] > trace[i - 1] + 1e-9) ok = false;
          out.monotonic.push({ kind, seed, init, ok, steps: trace.length });
        }
      }
    }
    return out;
  });
  for (const r of km.recover) {
    assert.ok(r.oneToOne, `seed ${r.seed}: each true centre should get its own centroid`);
    assert.ok(r.worst < 0.05, `seed ${r.seed}: centroid within 0.05 of every true centre (worst ${r.worst.toFixed(4)})`);
    assert.ok(r.converged, `seed ${r.seed}: converged`);
  }
  assert.deepEqual(km.suggest, [4, 4, 4, 4, 4], 'silhouette suggests k = 4 on four blobs');
  assert.ok(km.ppDistinct, 'k-means++ picks 10 distinct data points');
  assert.ok(km.randomDistinct, 'random init picks 10 distinct data points');
  assert.deepEqual(km.ppDupes, Array(20).fill(5), 'k-means++ never picks a duplicate location twice');
  const bad = km.monotonic.filter((m) => !m.ok);
  assert.deepEqual(bad, [], 'inertia must be non-increasing between phases');

  // ------------------------------------------------------------------ MLP (pure module)
  const mm = await page.evaluate(() => {
    const { mlp: M, datasets: D, Trainer } = window.__mllab;
    const out = { grad: [], conv: [], softmax: null, ce: null, stable: null, hand: null, adam: null };
    // (a) gradient check: analytic vs central finite differences, float64, every parameter group
    const archs = [[4, 5, 6, 3], [3, 2], [7, 8, 2]];
    for (const act of ['relu', 'tanh', 'sigmoid', 'gelu']) {
      for (const sizes of archs) {
        for (const l2 of [0, 0.01]) {
          const net = new M.MLP(sizes, act, 17);
          let s = 99;
          const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
          for (const b of net.b) for (let i = 0; i < b.length; i++) b[i] = rnd() * 0.3; // non-zero biases
          const n = 9, d = sizes[0], C = sizes[sizes.length - 1];
          const X = new Float64Array(n * d).map(() => rnd());
          const y = Int32Array.from({ length: n }, (_, i) => i % C);
          net.lossAndGrad(X, y, null, n, l2);
          const ga = net.grads().map((g) => g.slice());
          const ps = net.params();
          const names = [...net.W.map((_, l) => `W${l}`), ...net.b.map((_, l) => `b${l}`)];
          ps.forEach((p, k) => {
            let num = 0, den = 0;
            for (let i = 0; i < p.length; i++) {
              const o = p[i], h = 1e-5;
              p[i] = o + h; const lp = net.loss(X, y, null, n, l2);
              p[i] = o - h; const lm = net.loss(X, y, null, n, l2);
              p[i] = o;
              const gn = (lp - lm) / (2 * h);
              num += (gn - ga[k][i]) ** 2;
              den += gn * gn + ga[k][i] ** 2;
            }
            out.grad.push({ act, sizes: sizes.join('-'), l2, group: names[k], rel: den ? Math.sqrt(num) / Math.sqrt(den) : 0 });
          });
        }
      }
    }
    // (b) XOR and circles to >95% train accuracy within a bounded number of epochs, fixed seed
    const cases = [
      { name: 'xor', kind: 'xor', cfg: { hidden: [8], activation: 'tanh' } },
      { name: 'circles', kind: 'circles', cfg: { hidden: [8], activation: 'tanh' } },
      { name: 'xor-relu', kind: 'xor', cfg: { hidden: [8, 8], activation: 'relu' } },
    ];
    for (const c of cases) {
      const samples = D.splitTrainTest(D.makeClassData(c.kind, { n: 300, noise: 0.05, classes: 2, seed: 42 }), 0.2, 42);
      const tr = new Trainer({ features: ['x', 'y'], optimizer: 'adam', lr: 0.03, batchSize: 16, l2: 0, classes: 2, seed: 7, ...c.cfg }, samples);
      let epochs = 0, acc = 0;
      while (epochs < 300) { tr.trainEpoch(); epochs++; acc = tr.evaluate().trainAcc; if (acc > 0.95) break; }
      out.conv.push({ name: c.name, epochs, acc });
    }
    // (c) softmax / cross-entropy on hand-computed examples
    out.softmax = Array.from(M.softmax([1, 2, 3]));
    out.ce = M.crossEntropy(M.softmax([1, 2, 3]), 0);
    out.stable = Array.from(M.softmax([1000, 1001]));
    // one-layer net: z = W x + b, p = softmax(z), dL/dW = (p - onehot) x^T
    const net = new M.MLP([2, 2], 'tanh', 1);
    net.W[0].set([0.5, -1, 2, 0.25]); net.b[0].set([0.1, -0.2]);
    const loss = net.lossAndGrad(new Float64Array([1, 2]), [0], null, 1, 0);
    out.hand = { loss, p: Array.from(net.a[1]), gW: Array.from(net.gW[0]), gb: Array.from(net.gb[0]) };
    // Adam's first step has magnitude lr (bias correction)
    const p = [new Float64Array([1])], g = [new Float64Array([0.5])];
    const opt = new M.Optimizer('adam', p);
    opt.step(p, g, 0.1);
    out.adam = p[0][0];
    return out;
  });
  const worstGrad = mm.grad.reduce((a, b) => (b.rel > a.rel ? b : a));
  assert.ok(worstGrad.rel < 1e-4, `gradient check: worst relative error ${worstGrad.rel.toExponential(2)} (${worstGrad.act} ${worstGrad.sizes} ${worstGrad.group})`);
  assert.equal(mm.grad.length, 4 * 2 * (6 + 2 + 4), 'gradient check covered every parameter group');
  for (const c of mm.conv) assert.ok(c.acc > 0.95 && c.epochs < 300, `${c.name}: >95% train accuracy within 300 epochs (got ${(c.acc * 100).toFixed(1)}% after ${c.epochs})`);
  [0.09003057, 0.24472847, 0.66524096].forEach((v, i) => near(mm.softmax[i], v, 1e-7, `softmax([1,2,3])[${i}]`));
  near(mm.ce, 2.40760596, 1e-7, 'cross-entropy of class 0');
  near(mm.stable[0], 0.26894142, 1e-7, 'softmax is stable for large logits');
  // hand computation: z = [0.5*1 - 1*2 + 0.1, 2*1 + 0.25*2 - 0.2] = [-1.4, 2.3]
  const e0 = Math.exp(-1.4), e1 = Math.exp(2.3), p0 = e0 / (e0 + e1), p1 = e1 / (e0 + e1);
  near(mm.hand.loss, -Math.log(p0), 1e-12, 'hand-computed loss');
  near(mm.hand.p[0], p0, 1e-12, 'hand-computed p0');
  [(p0 - 1) * 1, (p0 - 1) * 2, p1 * 1, p1 * 2].forEach((v, i) => near(mm.hand.gW[i], v, 1e-12, `hand-computed dL/dW[${i}]`));
  near(mm.hand.gb[0], p0 - 1, 1e-12, 'hand-computed dL/db0');
  near(mm.adam, 0.9, 1e-6, 'Adam first step = lr');

  // ------------------------------------------------------------------ k-means UI
  let s = await cl(page);
  assert.equal(s.phase, 'init', 'starting centroids are placed on load');
  const stage0 = await canvasStats(page, '#km-canvas');
  assert.ok(stage0.colors > 8 && stage0.spread > 60, `clustering canvas is not blank (${stage0.colors} colours)`);
  assert.ok(stage0.w > 300 && Math.abs(stage0.w - stage0.h) <= 2, 'clustering canvas is square');
  const elbow = await canvasStats(page, '#km-elbow');
  assert.ok(elbow.colors > 4 && elbow.spread > 60, 'elbow chart renders');
  assert.match(await page.textContent('#km-elbow-note'), /Highest silhouette at k = 4/);
  assert.equal(await page.textContent('#km-use-best'), 'Use k = 4');
  assert.match(await page.getAttribute('#km-elbow', 'aria-label'), /k=1: inertia [\d.]+; k=2: inertia/);

  // k slider and suggested k
  await setRange(page, '#km-k', 2);
  assert.equal((await cl(page)).k, 2);
  assert.equal(await page.textContent('#km-k-out'), '2');
  assert.equal((await cl(page)).phase, 'empty', 'changing k resets the run');
  await page.click('#km-use-best');
  assert.equal((await cl(page)).k, 4, 'Use suggested k');
  await page.click('#km-init-random');
  assert.equal(await page.getAttribute('#km-init-random', 'aria-pressed'), 'true');
  await page.click('#km-init-pp');

  // step through the phases (uniform noise + random init takes many iterations)
  await page.click('[data-km-ds="uniform"]');
  await page.click('#km-init-random');
  await page.click('#km-reset');
  assert.equal((await cl(page)).phase, 'empty');
  assert.equal(await page.textContent('#km-step-label'), 'Initialize');
  await page.click('#km-step');
  assert.equal(await page.textContent('#km-step-label'), 'Assign');
  assert.equal(await page.textContent('#km-iter'), '0');
  assert.equal(await page.textContent('#km-inertia'), '–');
  const inertias = [];
  for (let i = 0; i < 8; i++) {
    await page.click('#km-step');
    const st = await cl(page);
    if (st.converged) break;
    inertias.push(st.inertia);
  }
  assert.ok(inertias.length >= 3, 'several steps before convergence');
  for (let i = 1; i < inertias.length; i++) assert.ok(inertias[i] <= inertias[i - 1] + 1e-9, `UI inertia non-increasing: ${inertias.join(', ')}`);
  assert.ok(Number(await page.textContent('#km-iter')) >= 2, 'iteration counter advances');
  assert.match(await page.textContent('#km-inertia'), /^\d+(\.\d+)?$/, 'inertia shown');
  assert.equal(await page.locator('#km-phases .is-on').count(), 1, 'the current phase is highlighted');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  const before = (await cl(page)).iteration;
  await page.keyboard.press('n'); await page.keyboard.press('n');
  assert.ok((await cl(page)).iteration > before, 'N key steps the algorithm');

  // play to convergence
  await page.selectOption('#km-speed', 'fast');
  await page.click('#km-reset');
  assert.equal(await page.textContent('#km-iter'), '0');
  await page.click('#km-play');
  assert.equal(await page.getAttribute('#km-play', 'aria-pressed'), 'true', 'play toggles to pause');
  await waitFor(page, () => window.__mllab.cluster.iteration >= 2);
  assert.match(await page.textContent('#km-inertia'), /^\d/, 'inertia updates while playing');
  await waitFor(page, () => window.__mllab.cluster.converged);
  assert.equal(await page.getAttribute('#km-play', 'aria-pressed'), 'false');
  assert.match(await page.textContent('#km-status'), /Converged after \d+ iterations?/);
  assert.ok(await page.isDisabled('#km-step'), 'step disabled once converged');
  assert.equal(await page.textContent('#km-step-label'), 'Converged');
  const iterDone = Number(await page.textContent('#km-iter'));
  assert.ok(iterDone >= 2);
  await shot('kmeans-converged');
  await page.click('#km-init-pp');


  // datasets + teaching tips
  await page.click('[data-km-ds="rings"]');
  assert.equal(await page.getAttribute('[data-km-ds="rings"]', 'aria-pressed'), 'true');
  assert.match(await page.textContent('#km-tip-title'), /rings/i);
  assert.ok(await page.isDisabled('#km-centers'), 'true-cluster count is disabled for rings');
  await page.click('#km-tip-try');
  assert.equal((await cl(page)).k, 2, 'tip action sets k = 2');
  await waitFor(page, () => window.__mllab.cluster.converged);
  await waitFor(page, () => window.__mllab.cluster.elbow === 10);
  await shot('kmeans-rings');
  for (const kind of ['moons', 'aniso', 'uniform', 'blobs']) {
    await page.click(`[data-km-ds="${kind}"]`);
    assert.equal(await page.getAttribute(`[data-km-ds="${kind}"]`, 'aria-pressed'), 'true');
    assert.ok((await cl(page)).n > 100, `${kind} generated`);
  }
  assert.match(await page.textContent('#km-tip-title'), /happy path/i);
  await page.click('#km-tip-next');
  assert.doesNotMatch(await page.textContent('#km-tip-title'), /happy path/i, 'Next idea cycles tips');
  await setRange(page, '#km-n', 500);
  await waitFor(page, () => window.__mllab.cluster.n === 500);
  const n1 = (await cl(page)).n;
  await page.click('#km-generate');
  assert.equal((await cl(page)).n, n1, 'resample keeps the point count');

  // painting and erasing
  await page.click('#km-clear');
  assert.equal((await cl(page)).n, 0);
  assert.ok(await page.isVisible('#km-empty'), 'empty state shown');
  assert.ok(await page.isDisabled('#km-play'));
  await drag(page, '#km-canvas', [0.2, 0.2], [0.4, 0.3]);
  const painted = (await cl(page)).n;
  assert.ok(painted >= 10, `painting adds points (${painted})`);
  assert.ok(!(await page.isVisible('#km-empty')));
  await setRange(page, '#km-brush', 0);
  assert.equal(await page.textContent('#km-brush-out'), 'dot');
  await clickAt(page, '#km-canvas', 0.8, 0.8);
  assert.equal((await cl(page)).n, painted + 1, 'a dot brush click adds exactly one point');
  await setRange(page, '#km-brush', 60);
  await drag(page, '#km-canvas', [0.6, 0.7], [0.85, 0.75]);
  await drag(page, '#km-canvas', [0.15, 0.75], [0.3, 0.85]);
  const painted2 = (await cl(page)).n;
  await page.click('#km-tool-erase');
  await drag(page, '#km-canvas', [0.2, 0.22], [0.4, 0.28], 20);
  const erased = (await cl(page)).n;
  assert.ok(erased < painted2, `erasing removes points (${painted2} -> ${erased})`);
  await page.click('#km-tool-paint');
  await setRange(page, '#km-k', 3);
  await page.click('#km-play');
  await waitFor(page, () => window.__mllab.cluster.converged);
  await waitFor(page, () => window.__mllab.cluster.elbow >= 2);
  await shot('kmeans-painted');

  // ------------------------------------------------------------------ neural network UI
  await page.click('#ml-lab-tab-nn');
  assert.ok(await page.isVisible('#nn-canvas'));
  assert.ok(!(await page.isVisible('#km-canvas')), 'other tab hidden');
  await waitFor(page, () => window.__mllab.nn.epoch > 5 && window.__mllab.nn.playing);
  let ns = await nn(page);
  assert.ok(ns.worker, 'training runs in a Web Worker');
  assert.deepEqual(ns.sizes, [2, 10, 10, 10, 2]);
  assert.equal(await page.locator('#nn-net .mll-node').count(), 2 + 30 + 2, 'diagram shows every neuron');
  assert.equal(await page.locator('#nn-net .mll-edge').count(), 20 + 100 + 100 + 20, 'diagram shows every weight');
  assert.match(await page.textContent('#nn-params'), /272 parameters/);

  // training raises accuracy (circles, from a fresh initialisation)
  await page.click('#nn-play'); // pause
  await waitFor(page, () => !window.__mllab.nn.playing);
  await page.click('[data-nn-ds="circles"]');
  await page.click('#nn-reset');
  await waitFor(page, () => window.__mllab.nn.epoch === 0);
  const acc0 = (await nn(page)).trainAcc;
  const accText0 = await page.textContent('#nn-train-acc');
  const edgeW = () => page.$$eval('#nn-net .mll-edge', (es) => es.map((e) => e.getAttribute('stroke-width') + e.getAttribute('stroke')).join('|'));
  const w0 = await edgeW();
  const v0 = Number(await page.getAttribute('#nn-net svg', 'data-version'));
  await page.click('#nn-step');
  await waitFor(page, () => window.__mllab.nn.epoch === 1);
  await page.waitForTimeout(100);
  assert.equal(await page.textContent('#nn-epoch'), '1', 'Step trains one epoch');
  assert.notEqual(await edgeW(), w0, 'network diagram edges update when the weights change');
  assert.ok(Number(await page.getAttribute('#nn-net svg', 'data-version')) > v0);
  await page.click('#nn-play');
  await waitFor(page, () => window.__mllab.nn.trainAcc > 0.95, null, 30000);
  ns = await nn(page);
  assert.ok(ns.trainAcc > acc0 + 0.2, `accuracy rises with training (${acc0} -> ${ns.trainAcc})`);
  await page.waitForTimeout(150);
  assert.notEqual(await page.textContent('#nn-train-acc'), accText0);
  assert.match(await page.textContent('#nn-test-acc'), /^\d+\.\d%$/);
  const loss = await canvasStats(page, '#nn-loss-chart');
  const accC = await canvasStats(page, '#nn-acc-chart');
  assert.ok(loss.colors > 3 && accC.colors > 3, 'loss and accuracy curves render');
  const heat = await canvasStats(page, '#nn-canvas');
  assert.ok(heat.colors > 30 && heat.spread > 60, `decision boundary heatmap is not blank (${heat.colors} colours)`);
  await shot('nn-circles-trained');

  // hidden-neuron inspector
  const hiddenNode = page.locator('#nn-net .mll-node.is-hidden').nth(3);
  await hiddenNode.hover();
  await page.waitForSelector('#nn-pop:not([hidden])');
  assert.match(await page.textContent('#nn-pop-title'), /Hidden 1 · neuron 4/);
  assert.match(await page.textContent('#nn-pop-sub'), /tanh output, range/);
  const pop = await canvasStats(page, '#nn-pop-canvas');
  assert.ok(pop.colors > 10, 'neuron activation map is drawn');
  assert.ok(await page.locator('#nn-net .mll-edge.is-lit').count() >= 12, 'edges of the hovered neuron are highlighted');
  await shot('nn-neuron-inspector');
  await page.mouse.move(5, 5);
  await page.waitForSelector('#nn-pop', { state: 'hidden' });

  // architecture, features, hyper-parameters
  await page.click('#nn-layers-minus');
  await waitFor(page, () => window.__mllab.nn.sizes.length === 4);
  assert.deepEqual((await nn(page)).sizes, [2, 10, 10, 2]);
  await page.locator('#nn-layer-list .ml-lab-layer').first().locator('button[data-d="1"]').click();
  await page.locator('[data-nn-feat="x2"]').check();
  await page.locator('[data-nn-feat="sinx"]').check();
  await waitFor(page, () => window.__mllab.nn.sizes.join() === '4,11,10,2');
  assert.equal(await page.locator('#nn-net .mll-node').count(), 4 + 11 + 10 + 2);
  assert.deepEqual((await page.locator('#nn-net text').allTextContents()).filter((t) => /^(x|y|x²|sin πx)$/.test(t)), ['x', 'y', 'x²', 'sin πx']);
  await page.click('#nn-layers-plus');
  await page.click('#nn-layers-plus');
  assert.equal(await page.textContent('#nn-layers-out'), '4');
  assert.ok(await page.isDisabled('#nn-layers-plus'), 'at most 4 hidden layers');
  for (let i = 0; i < 4; i++) await page.click('#nn-layers-minus');
  assert.ok(await page.isDisabled('#nn-layers-minus'), 'zero hidden layers allowed');
  await waitFor(page, () => window.__mllab.nn.sizes.join() === '4,2');
  for (const f of ['x2', 'sinx']) await page.locator(`[data-nn-feat="${f}"]`).uncheck();
  await page.locator('[data-nn-feat="x"]').uncheck();
  await page.locator('[data-nn-feat="y"]').click();
  assert.ok(await page.locator('[data-nn-feat="y"]').isChecked(), 'the last feature cannot be removed');
  await page.locator('[data-nn-feat="x"]').check();
  await page.selectOption('#nn-act', 'relu');
  assert.equal(await page.textContent('#nn-init'), 'He init');
  await page.selectOption('#nn-act', 'sigmoid');
  assert.equal(await page.textContent('#nn-init'), 'Xavier init');
  for (const [sel, v] of [['#nn-opt', 'momentum'], ['#nn-lr', '0.1'], ['#nn-batch', '0'], ['#nn-l2', '0.001'], ['#nn-speed', 'fast']]) await page.selectOption(sel, v);

  // presets that teach
  const presetIds = await page.$$eval('[data-preset]', (bs) => bs.map((b) => b.dataset.preset));
  assert.deepEqual(presetIds, ['xor', 'spiral', 'overfit', 'lr', 'features', 'vanish']);
  const expect = {
    xor: { hidden: [], features: ['x', 'y'], title: /XOR/ },
    spiral: { hidden: [4], features: ['x', 'y'], title: /Spiral/ },
    overfit: { hidden: [16, 16, 16], features: ['x', 'y'], title: /Overfitting/ },
    lr: { hidden: [8], features: ['x', 'y'], title: /Learning rate/ },
    features: { hidden: [], features: ['x2', 'y2'], title: /features/ },
    vanish: { hidden: [8, 8, 8, 8], features: ['x', 'y'], title: /sigmoid/ },
  };
  for (const id of presetIds) {
    await page.click(`[data-preset="${id}"]`);
    await waitFor(page, (pid) => window.__mllab.nn.preset === pid && window.__mllab.nn.epoch > 0 && window.__mllab.nn.playing, id);
    const st = await nn(page);
    assert.deepEqual(st.hidden, expect[id].hidden, `${id}: hidden layers`);
    assert.deepEqual(st.features, expect[id].features, `${id}: features`);
    assert.match(await page.textContent('#nn-lesson-title'), expect[id].title);
    assert.equal(await page.getAttribute(`[data-preset="${id}"]`, 'aria-pressed'), 'true');
    assert.ok(await page.isVisible('#nn-lesson-fix'), `${id}: offers a fix`);
  }
  assert.equal(await page.inputValue('#nn-act'), 'sigmoid');
  assert.equal(await page.inputValue('#nn-opt'), 'sgd');

  // XOR lesson: stuck without a hidden layer, solved by the fix
  await page.selectOption('#nn-speed', 'fast');
  await page.click('[data-preset="xor"]');
  await waitFor(page, () => window.__mllab.nn.preset === 'xor' && window.__mllab.nn.epoch >= 150);
  assert.ok((await nn(page)).trainAcc < 0.8, 'linear model cannot solve XOR');
  await page.click('#nn-lesson-fix');
  await waitFor(page, () => window.__mllab.nn.hidden.join() === '4' && window.__mllab.nn.trainAcc > 0.95, null, 30000);
  assert.match(await page.textContent('#nn-lesson-text'), /Hover a hidden neuron/);
  await shot('nn-xor-fixed');

  // learning-rate lesson: loss stays high
  await page.click('[data-preset="lr"]');
  await waitFor(page, () => window.__mllab.nn.preset === 'lr' && window.__mllab.nn.epoch >= 60);
  const lrState = await nn(page);
  assert.ok(lrState.trainAcc < 0.75, `lr = 10 never learns the ring (acc ${lrState.trainAcc}, loss ${lrState.trainLoss})`);
  await page.click('#nn-lesson-fix');
  await waitFor(page, () => window.__mllab.nn.trainAcc > 0.95, null, 30000);
  assert.equal(await page.inputValue('#nn-lr'), '0.3');

  // a manual change ends the lesson
  await page.selectOption('#nn-l2', '0.01');
  await waitFor(page, () => window.__mllab.nn.preset === null);
  assert.match(await page.textContent('#nn-lesson-title'), /Watch a network learn/);

  // adding and erasing points by hand
  await page.click('#nn-play');
  await waitFor(page, () => !window.__mllab.nn.playing);
  await page.click('#nn-clear');
  assert.equal((await nn(page)).n, 0);
  assert.ok(await page.isVisible('#nn-empty'));
  assert.ok(await page.isDisabled('#nn-play'), 'nothing to train on');
  await clickAt(page, '#nn-canvas', 0.25, 0.25);
  await clickAt(page, '#nn-canvas', 0.3, 0.2);
  await page.click('[data-nn-tool="1"]');
  await clickAt(page, '#nn-canvas', 0.75, 0.75);
  await clickAt(page, '#nn-canvas', 0.7, 0.8);
  assert.equal((await nn(page)).n, 4, 'clicks add points');
  assert.ok(!(await page.isDisabled('#nn-play')));
  await page.click('[data-nn-tool="erase"]');
  await clickAt(page, '#nn-canvas', 0.75, 0.75);
  assert.equal((await nn(page)).n, 3, 'eraser removes the point under the cursor');
  await page.click('#nn-play');
  await waitFor(page, () => window.__mllab.nn.epoch > 20 && window.__mllab.nn.trainAcc === 1);

  // three classes
  await page.click('[data-nn-ds="spiral"]');
  await page.click('#nn-cls-3');
  await waitFor(page, () => window.__mllab.nn.classes === 3 && window.__mllab.nn.sizes.at(-1) === 3);
  assert.ok(await page.isVisible('[data-nn-tool="2"]'), 'class C tool appears');
  assert.equal(await page.locator('#nn-net .mll-node').count() >= 5, true);
  await page.click('[data-nn-tool="2"]');
  const n3 = (await nn(page)).n;
  await clickAt(page, '#nn-canvas', 0.5, 0.05);
  assert.equal((await nn(page)).n, n3 + 1);
  await page.click('#nn-cls-2');
  await waitFor(page, () => window.__mllab.nn.classes === 2);
  assert.ok(!(await page.isVisible('[data-nn-tool="2"]')));

  // leaving the tab pauses training, coming back resumes it
  if (!(await nn(page)).playing) await page.click('#nn-play');
  await waitFor(page, () => window.__mllab.nn.playing);
  await page.click('#ml-lab-tab-kmeans');
  await waitFor(page, () => !window.__mllab.nn.playing);
  await page.waitForTimeout(200); // let the last in-flight snapshot land
  assert.ok(!(await nn(page)).playing, 'stays paused');
  const pausedAt = (await nn(page)).epoch;
  await page.waitForTimeout(300);
  assert.ok((await nn(page)).epoch - pausedAt <= 1, 'no training while the tab is hidden');
  await page.click('#ml-lab-tab-nn');
  await waitFor(page, (e) => window.__mllab.nn.playing && window.__mllab.nn.epoch > e + 2, pausedAt);

  // test-split slider
  await page.click('[data-nn-ds="moons"]');
  await setRange(page, '#nn-split', 50);
  await waitFor(page, () => window.__mllab.nn.nTest === Math.round(window.__mllab.nn.n * 0.5));
  await setRange(page, '#nn-split', 0);
  await waitFor(page, () => window.__mllab.nn.nTest === 0);
  await page.waitForTimeout(300);
  assert.equal(await page.textContent('#nn-test-acc'), '–', 'no test set, no test accuracy');
  await setRange(page, '#nn-split', 30);
  await page.waitForTimeout(600);
  await shot('nn-final');
});

// =====================================================================================
// 2. Phone viewport: layout and touch
// =====================================================================================
await runToolTest('ml-lab', async ({ page, context, shot }) => {
  const noOverflow = async (label) => {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    assert.ok(o.sw <= o.iw, `${label}: no horizontal overflow (${o.sw} > ${o.iw})`);
  };
  await page.waitForFunction(() => window.__mllab && window.__mllab.cluster.elbow === 10, null, { timeout: 20000 });
  await noOverflow('clustering');
  const st = await canvasStats(page, '#km-canvas');
  const box = await page.locator('#km-canvas').boundingBox();
  assert.ok(box.width >= 300 && box.x >= 0 && box.x + box.width <= 390, 'canvas fits the phone width');
  assert.ok(st.colors > 8, 'clustering canvas drawn on mobile');
  for (const sel of ['#km-step', '#km-play', '#km-reset']) {
    const b = await page.locator(sel).boundingBox();
    assert.ok(b.x >= 0 && b.x + b.width <= 390, `${sel} on screen`);
  }
  assert.ok(!(await page.locator('.ml-lab-stage-foot .ml-lab-hide-xs').isVisible()), 'keyboard hints hidden on phones');

  // real touch events through the DevTools protocol
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const tap = async (sel, rx, ry) => {
    await page.locator(sel).scrollIntoViewIfNeeded();
    const b = await page.locator(sel).boundingBox();
    const x = b.x + b.width * rx, y = b.y + b.height * ry;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(60);
  };
  await setRange(page, '#km-brush', 0);
  const n0 = (await cl(page)).n;
  await tap('#km-canvas', 0.1, 0.9);
  assert.equal((await cl(page)).n, n0 + 1, 'tap adds a point (clustering)');
  await shot('mobile-kmeans');

  await page.click('#ml-lab-tab-nn');
  await waitFor(page, () => window.__mllab.nn.epoch > 3);
  await noOverflow('neural network');
  const nb = await page.locator('#nn-canvas').boundingBox();
  assert.ok(nb.width >= 300 && nb.x + nb.width <= 390, 'NN canvas fits the phone width');
  const m0 = (await nn(page)).n;
  await tap('#nn-canvas', 0.5, 0.95);
  await tap('#nn-canvas', 0.05, 0.5);
  assert.equal((await nn(page)).n, m0 + 2, 'tap adds points (neural network)');
  // tap a hidden neuron to open the inspector, tap elsewhere to close it
  await page.locator('#nn-net').scrollIntoViewIfNeeded();
  const node = await page.locator('#nn-net .mll-node.is-hidden').nth(1).boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: node.x + node.width / 2, y: node.y + node.height / 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForSelector('#nn-pop:not([hidden])');
  const pb = await page.locator('#nn-pop').boundingBox();
  assert.ok(pb.x >= 0 && pb.x + pb.width <= 390, 'inspector stays on screen');
  await shot('mobile-nn-inspector');
  await tap('#nn-epoch', 0.5, 0.5);
  await page.waitForSelector('#nn-pop', { state: 'hidden' });
  await noOverflow('neural network after interaction');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('mobile-nn');
}, { viewport: { width: 390, height: 844 } });

// =====================================================================================
// 3. Dark theme + live theme switch
// =====================================================================================
await runToolTest('ml-lab', async ({ page, shot }) => {
  await page.waitForFunction(() => window.__mllab && window.__mllab.cluster.elbow === 10, null, { timeout: 20000 });
  const lum = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3;
  const dark = await canvasStats(page, '#km-canvas');
  assert.ok(lum(dark.corner) < 80, `canvas uses the dark surface (${dark.corner})`);
  await page.click('#km-play');
  await waitFor(page, () => window.__mllab.cluster.converged);
  await shot('dark-kmeans');
  await page.click('#ml-lab-tab-nn');
  await page.selectOption('#nn-speed', 'fast');
  await waitFor(page, () => window.__mllab.nn.trainAcc > 0.9, null, 30000);
  await page.waitForTimeout(400);
  const nnDark = await canvasStats(page, '#nn-canvas');
  assert.ok(nnDark.colors > 30, 'dark heatmap drawn');
  await page.locator('#nn-net .mll-node.is-hidden').nth(5).hover();
  await page.waitForSelector('#nn-pop:not([hidden])');
  await shot('dark-nn');
  await page.mouse.move(2, 2);
  // switch to light with the header toggle: canvases redraw with the light palette
  await page.click('#theme-toggle');
  await page.waitForTimeout(300);
  await page.click('#ml-lab-tab-kmeans');
  await page.waitForTimeout(200);
  const light = await canvasStats(page, '#km-canvas');
  assert.ok(lum(light.corner) > 180, `canvas redraws for the light theme (${light.corner})`);
  await page.click('#theme-toggle');
}, { colorScheme: 'dark' });
