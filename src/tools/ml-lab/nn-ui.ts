// Neural-network tab: data editing, training controls, live decision boundary, curves,
// network diagram and the hidden-neuron inspector. Training runs in a Web Worker.
import { debounce, toast } from '../../lib/ui';
import { drawLineChart } from './charts';
import { fitCanvas, type RGB, type Theme } from './colors';
import { makeClassData, splitTrainTest, type ClassDataset, type LabeledPoint, type Sample } from './datasets';
import { EngineCore, type EngineError, type EngineMsg, type Snapshot, type Speed } from './engine-core';
import { featurize, FEATURES, initName, MLP, type Activation, type FeatureKey, type OptimizerKind } from './mlp';
import { createNetworkView, type NeuronRef } from './network';
import { randomSeed } from './rng';
import type { TrainConfig } from './trainer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MAX_POINTS = 1500;
const CLASS_NAMES = ['A', 'B', 'C'];
const FEATURE_LABEL = Object.fromEntries(FEATURES.map((f) => [f.key, f.label])) as Record<FeatureKey, string>;
const FEATURE_ORDER = FEATURES.map((f) => f.key);

type Kind = ClassDataset | 'custom';
type Tool = 0 | 1 | 2 | 'erase';

interface Preset {
  id: string; title: string; sub: string;
  data: { kind: ClassDataset; classes: number; n: number; noise: number; split: number; seed: number };
  cfg: Partial<TrainConfig>;
  text: string;
  fix?: { label: string; cfg: Partial<TrainConfig>; text: string };
}

const PRESETS: Preset[] = [
  {
    id: 'xor', title: 'XOR needs a hidden layer', sub: 'No hidden layer: a single straight line',
    data: { kind: 'xor', classes: 2, n: 300, noise: 0.05, split: 0.3, seed: 3 },
    cfg: { features: ['x', 'y'], hidden: [], activation: 'tanh', optimizer: 'adam', lr: 0.03, batchSize: 16, l2: 0 },
    text: 'With no hidden layer the network is logistic regression: its boundary is one straight line, and no single line separates XOR’s diagonal quadrants. Accuracy stalls near chance however long you train.',
    fix: { label: 'Add a hidden layer of 4', cfg: { hidden: [4] }, text: 'Four tanh units each learn their own line; the output layer combines them into a bent boundary. Hover a hidden neuron below to see the line it learned. (Ticking the xy feature also works: XOR is linear in xy.)' },
  },
  {
    id: 'spiral', title: 'Spiral needs depth or features', sub: 'One tiny layer can’t follow the arms',
    data: { kind: 'spiral', classes: 2, n: 400, noise: 0.1, split: 0.3, seed: 3 },
    cfg: { features: ['x', 'y'], hidden: [4], activation: 'tanh', optimizer: 'adam', lr: 0.03, batchSize: 16, l2: 0 },
    text: 'Two interleaved spirals need a boundary that winds around the origin. Four hidden units can only make a few bends, so the network settles for a blurry compromise around 60%.',
    fix: { label: 'Go deeper: 3 × 12 ReLU', cfg: { hidden: [12, 12, 12], activation: 'relu' }, text: 'Each extra layer composes the previous layer’s folds, so the number of linear pieces grows quickly with depth. Watch the boundary unwind the spiral. Alternatively keep it small and add the sin πx / sin πy features.' },
  },
  {
    id: 'overfit', title: 'Overfitting: small data, big net', sub: '30 noisy points, 3 × 16 neurons',
    data: { kind: 'moons', classes: 2, n: 60, noise: 0.45, split: 0.5, seed: 3 },
    cfg: { features: ['x', 'y'], hidden: [16, 16, 16], activation: 'relu', optimizer: 'adam', lr: 0.03, batchSize: 4, l2: 0 },
    text: 'The network has ~600 parameters for 30 training points, so it memorises the noise: training loss goes to zero while test loss turns around and climbs. The boundary grows islands around single points.',
    fix: { label: 'Add L2 penalty 0.01', cfg: { l2: 0.01 }, text: 'L2 regularisation adds λ/2·Σw² to the loss, pulling weights toward zero. Smaller weights mean a smoother function: the islands disappear and the test loss stays low.' },
  },
  {
    id: 'lr', title: 'Learning rate too high', sub: 'SGD with lr = 10 overshoots',
    data: { kind: 'circles', classes: 2, n: 300, noise: 0.1, split: 0.3, seed: 3 },
    cfg: { features: ['x', 'y'], hidden: [8], activation: 'tanh', optimizer: 'sgd', lr: 10, batchSize: 16, l2: 0 },
    text: 'Each step jumps so far along the gradient that it overshoots the valley and lands higher up the other side. The tanh units saturate, the loss jumps around at a high level and the accuracy flips between guesses.',
    fix: { label: 'Use lr = 0.3', cfg: { lr: 0.3 }, text: 'A 30× smaller step follows the slope instead of leaping over it. Same model, same data: the loss now falls smoothly and the ring is found in a few dozen epochs.' },
  },
  {
    id: 'features', title: 'The right features make it linear', sub: 'x² and y² with no hidden layer',
    data: { kind: 'circles', classes: 2, n: 300, noise: 0.1, split: 0.3, seed: 3 },
    cfg: { features: ['x2', 'y2'], hidden: [], activation: 'tanh', optimizer: 'adam', lr: 0.03, batchSize: 16, l2: 0 },
    text: 'In (x², y²) space the inner disc and the outer ring are separated by the straight line x² + y² = r². So a purely linear model solves circles instantly. Feature engineering does by hand what hidden layers learn.',
    fix: { label: 'Take them away (x, y only)', cfg: { features: ['x', 'y'] }, text: 'With only x and y and still no hidden layer, the model is back to drawing one straight line through the rings. Add a hidden layer to get the circle back.' },
  },
  {
    id: 'vanish', title: 'Deep sigmoid nets stall', sub: '4 sigmoid layers + plain SGD',
    data: { kind: 'circles', classes: 2, n: 300, noise: 0.1, split: 0.3, seed: 3 },
    cfg: { features: ['x', 'y'], hidden: [8, 8, 8, 8], activation: 'sigmoid', optimizer: 'sgd', lr: 0.1, batchSize: 16, l2: 0 },
    text: 'The sigmoid’s slope is at most 0.25, and backprop multiplies one such factor per layer, so the gradient reaching the first layers is tiny. The loss sits flat near ln 2 ≈ 0.69: the vanishing gradient problem.',
    fix: { label: 'Switch to ReLU', cfg: { activation: 'relu' }, text: 'ReLU has slope 1 wherever it is active, so gradients pass through the layers undiminished (and He initialisation keeps the signal scale steady). Same depth, same optimizer: it learns in seconds.' },
  },
];

const DEFAULT_LESSON = {
  title: 'Watch a network learn',
  text: 'Pick a lesson above, or change anything on the left: data, input features, depth, activation or optimizer. Training continues live while you edit, and the background shows the class the network would predict, paler where it is unsure.',
};

export function initNN(theme: () => Theme) {
  const canvas = $<HTMLCanvasElement>('nn-canvas');
  const wrap = $('nn-wrap');
  const els = {
    n: $<HTMLInputElement>('nn-n'), nOut: $('nn-n-out'),
    noise: $<HTMLInputElement>('nn-noise'), noiseOut: $('nn-noise-out'),
    split: $<HTMLInputElement>('nn-split'), splitOut: $('nn-split-out'),
    act: $<HTMLSelectElement>('nn-act'), opt: $<HTMLSelectElement>('nn-opt'), lr: $<HTMLSelectElement>('nn-lr'),
    batch: $<HTMLSelectElement>('nn-batch'), l2: $<HTMLSelectElement>('nn-l2'), speed: $<HTMLSelectElement>('nn-speed'),
    init: $('nn-init'), layersOut: $('nn-layers-out'), layerList: $('nn-layer-list'),
    layersMinus: $<HTMLButtonElement>('nn-layers-minus'), layersPlus: $<HTMLButtonElement>('nn-layers-plus'),
    play: $<HTMLButtonElement>('nn-play'), step: $<HTMLButtonElement>('nn-step'), reset: $<HTMLButtonElement>('nn-reset'),
    epoch: $('nn-epoch'), trainLoss: $('nn-train-loss'), testLoss: $('nn-test-loss'), trainAcc: $('nn-train-acc'), testAcc: $('nn-test-acc'),
    lossChart: $<HTMLCanvasElement>('nn-loss-chart'), accChart: $<HTMLCanvasElement>('nn-acc-chart'), alert: $('nn-alert'),
    empty: $('nn-empty'), params: $('nn-params'), net: $('nn-net'),
    pop: $('nn-pop'), popCanvas: $<HTMLCanvasElement>('nn-pop-canvas'), popTitle: $('nn-pop-title'), popSub: $('nn-pop-sub'),
    presets: $('nn-presets'), lessonTitle: $('nn-lesson-title'), lessonText: $('nn-lesson-text'), lessonFix: $<HTMLButtonElement>('nn-lesson-fix'),
    cls2: $<HTMLButtonElement>('nn-cls-2'), cls3: $<HTMLButtonElement>('nn-cls-3'),
  };

  // ------------------------------------------------------------------ state
  let samples: Sample[] = [];
  let kind: Kind = 'spiral';
  let dataSeed = 1;
  let classes = 2;
  let tool: Tool = 0;
  const cfg: TrainConfig = {
    features: ['x', 'y'], hidden: [10, 10, 10], activation: 'tanh', optimizer: 'adam',
    lr: 0.01, batchSize: 16, l2: 0, classes: 2, seed: 1,
  };
  let runId = -1;
  let gen = 0;
  let snap: Snapshot | null = null;
  let playing = false;
  let wantPlaying = false; // the user's intent; in-flight snapshots must not flip a fresh pause back
  let started = false;
  let diverged = false;
  let preset: Preset | null = null;
  interface Hist { e: number; tl: number; vl: number; ta: number; va: number }
  let hist: Hist[] = [];
  let shownGrid: Float32Array | null = null;
  let targetGrid: Float32Array | null = null;
  let gridC = 2, gridRes = 0;
  let active: NeuronRef | null = null;
  let resumeOnShow = false;

  // ------------------------------------------------------------------ engine (worker with main-thread fallback)
  let post: (m: EngineMsg) => void;
  let fallbackCore: EngineCore | null = null;
  const useFallback = (why: string) => {
    if (fallbackCore) return;
    console.warn(`ML Lab: training on the main thread (${why})`);
    fallbackCore = new EngineCore((m) => onEngine(m));
    post = (m) => fallbackCore!.handle(m);
    post({ type: 'init', cfg: { ...cfg }, samples, gen });
    post({ type: 'speed', speed: els.speed.value as Speed });
    if (playing) post({ type: 'play' });
  };
  try {
    const worker = new Worker(new URL('./nn.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<Snapshot | EngineError>) => onEngine(e.data);
    worker.onerror = (e) => { e.preventDefault(); worker.terminate(); useFallback('worker failed to load'); };
    post = (m) => worker.postMessage(m);
  } catch {
    post = () => {};
    useFallback('workers unavailable');
  }

  function onEngine(m: Snapshot | EngineError) {
    if (m.type === 'error') {
      toast(m.message, 'error');
      playing = false;
      syncTransport();
      return;
    }
    onSnap(m);
  }

  // ------------------------------------------------------------------ geometry
  let size = 400;
  const toPx = (x: number, y: number) => [((x + 1) / 2) * size, ((1 - y) / 2) * size] as const;
  const toWorld = (px: number, py: number) => ({ x: (px / size) * 2 - 1, y: 1 - (py / size) * 2 });

  // ------------------------------------------------------------------ net diagram
  const netView = createNetworkView(els.net, theme, (ref, ev) => setActive(ref, ev));
  let builtKey = '';
  function ensureDiagram(sizes: number[]) {
    const key = `${sizes.join(',')}|${cfg.features.join(',')}`;
    if (key === builtKey) return;
    builtKey = key;
    netView.build(sizes, cfg.features.map((f) => FEATURE_LABEL[f]), CLASS_NAMES.slice(0, sizes[sizes.length - 1]));
    let p = 0;
    for (let l = 0; l < sizes.length - 1; l++) p += sizes[l] * sizes[l + 1] + sizes[l + 1];
    els.params.textContent = `${sizes.join(' → ')} · ${p.toLocaleString()} parameters`;
    setActive(null);
  }

  // ------------------------------------------------------------------ snapshots
  let netDirty = false;
  function onSnap(s: Snapshot) {
    if (s.gen < gen) return; // stale: sent before the latest init / config / reset was processed
    if (s.runId !== runId) {
      runId = s.runId;
      hist = [];
    }
    snap = s;
    playing = s.playing && wantPlaying;
    diverged = s.diverged;
    const push = (h: Hist) => {
      const last = hist[hist.length - 1];
      if (last && last.e === h.e) hist[hist.length - 1] = h;
      else if (!last || h.e > last.e) hist.push(h);
    };
    for (let i = 0; i + 4 < s.hist.length; i += 5) push({ e: s.hist[i], tl: s.hist[i + 1], vl: s.hist[i + 2], ta: s.hist[i + 3], va: s.hist[i + 4] });
    push({ e: s.epoch, tl: s.trainLoss, vl: s.testLoss, ta: s.trainAcc, va: s.testAcc });
    while (hist.length > 700) hist = hist.filter((_, i) => i % 2 === 0 || i === hist.length - 1);
    if (!shownGrid || s.grid.length !== shownGrid.length) shownGrid = s.grid.slice();
    targetGrid = s.grid;
    gridC = s.classes;
    gridRes = s.res;
    ensureDiagram(s.sizes);
    netDirty = true;
    chartsDirty = true;
    syncMetrics();
    syncTransport();
    requestRender();
  }

  // ------------------------------------------------------------------ rendering
  let raf = 0;
  let chartsDirty = true;
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d')!;
  let img: ImageData | null = null;
  const requestRender = () => { if (!raf) raf = requestAnimationFrame(render); };

  function render() {
    raf = 0;
    const th = theme();
    size = Math.max(200, Math.floor(wrap.clientWidth));
    const { ctx } = fitCanvas(canvas, size, size);
    ctx.fillStyle = th.elev;
    ctx.fillRect(0, 0, size, size);

    // ease the displayed probabilities toward the latest snapshot: smooth 60 fps morphing
    let moving = false;
    if (shownGrid && targetGrid && shownGrid.length === targetGrid.length) {
      for (let i = 0; i < shownGrid.length; i++) {
        const d = targetGrid[i] - shownGrid[i];
        if (d > 0.002 || d < -0.002) { shownGrid[i] += d * 0.28; moving = true; } else shownGrid[i] = targetGrid[i];
      }
    }
    if (shownGrid && gridRes && samples.length) drawHeatmap(ctx, th);
    drawAxes(ctx, th);
    if (shownGrid && gridRes && samples.length) drawBoundary(ctx, th);
    drawPoints(ctx, th);
    if (hover && tool === 'erase') {
      const [hx, hy] = toPx(hover.x, hover.y);
      ctx.beginPath();
      ctx.arc(hx, hy, (ERASE_R / 2) * size, 0, Math.PI * 2);
      ctx.strokeStyle = th.danger;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (netDirty && snap) { netDirty = false; netView.update(snap.W, snap.b); if (active) drawNeuronMap(); }
    if (chartsDirty) { chartsDirty = false; drawCharts(); }
    if (moving) requestRender();
  }

  function drawHeatmap(ctx: CanvasRenderingContext2D, th: Theme) {
    const res = gridRes, C = gridC, g = shownGrid!;
    if (off.width !== res) { off.width = off.height = res; img = null; }
    if (!img) img = offCtx.createImageData(res, res);
    const bg = th.rgb.elev;
    const cols: RGB[] = th.rgb.classes;
    const maxA = th.dark ? 0.5 : 0.55;
    const d = img.data;
    for (let i = 0; i < res * res; i++) {
      let r = 0, gg = 0, b = 0, pmax = 0;
      for (let c = 0; c < C; c++) {
        const p = g[i * C + c];
        r += p * cols[c][0]; gg += p * cols[c][1]; b += p * cols[c][2];
        if (p > pmax) pmax = p;
      }
      const conf = Math.max(0, (pmax - 1 / C) / (1 - 1 / C));
      const a = maxA * (0.12 + 0.88 * Math.pow(conf, 0.75));
      d[i * 4] = bg[0] + (r - bg[0]) * a;
      d[i * 4 + 1] = bg[1] + (gg - bg[1]) * a;
      d[i * 4 + 2] = bg[2] + (b - bg[2]) * a;
      d[i * 4 + 3] = 255;
    }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, 0, 0, res, res, 0, 0, size, size);
  }

  function drawAxes(ctx: CanvasRenderingContext2D, th: Theme) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = th.text;
    for (let i = 1; i < 8; i++) {
      const p = Math.round((i / 8) * size) + 0.5;
      ctx.globalAlpha = i === 4 ? 0.22 : 0.07;
      ctx.beginPath();
      ctx.moveTo(p, 0); ctx.lineTo(p, size);
      ctx.moveTo(0, p); ctx.lineTo(size, p);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Decision boundary: zero contour of p_c − max_{j≠c} p_j for each class (marching squares). */
  function drawBoundary(ctx: CanvasRenderingContext2D, th: Theme) {
    const res = gridRes, C = gridC, g = shownGrid!;
    const f = new Float32Array(res * res);
    const cell = size / res;
    ctx.beginPath();
    for (let c = 0; c < (C === 2 ? 1 : C); c++) {
      for (let i = 0; i < res * res; i++) {
        let other = 0;
        for (let j = 0; j < C; j++) if (j !== c && g[i * C + j] > other) other = g[i * C + j];
        f[i] = g[i * C + c] - other;
      }
      for (let r = 0; r < res - 1; r++) {
        for (let q = 0; q < res - 1; q++) {
          const a = f[r * res + q], b = f[r * res + q + 1], cc = f[(r + 1) * res + q + 1], d = f[(r + 1) * res + q];
          const sa = a > 0, sb = b > 0, sc = cc > 0, sd = d > 0;
          if (sa === sb && sb === sc && sc === sd) continue;
          const x0 = (q + 0.5) * cell, y0 = (r + 0.5) * cell;
          const pts: [number, number][] = [];
          if (sa !== sb) pts.push([x0 + (a / (a - b)) * cell, y0]);                 // top
          if (sb !== sc) pts.push([x0 + cell, y0 + (b / (b - cc)) * cell]);         // right
          if (sd !== sc) pts.push([x0 + (d / (d - cc)) * cell, y0 + cell]);         // bottom
          if (sa !== sd) pts.push([x0, y0 + (a / (a - d)) * cell]);                 // left
          if (pts.length === 2) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); }
          else if (pts.length === 4) {
            const centre = (a + b + cc + d) / 4 > 0;
            const [t, ri, bo, le] = pts;
            if (centre === sa) { ctx.moveTo(t[0], t[1]); ctx.lineTo(ri[0], ri[1]); ctx.moveTo(bo[0], bo[1]); ctx.lineTo(le[0], le[1]); }
            else { ctx.moveTo(t[0], t[1]); ctx.lineTo(le[0], le[1]); ctx.moveTo(ri[0], ri[1]); ctx.lineTo(bo[0], bo[1]); }
          }
        }
      }
    }
    ctx.strokeStyle = th.text;
    ctx.globalAlpha = th.dark ? 0.55 : 0.45;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawPoints(ctx: CanvasRenderingContext2D, th: Theme) {
    const r = size < 420 ? 3.4 : 4.2;
    for (let c = 0; c < classes; c++) {
      // train: filled discs with a halo
      ctx.beginPath();
      for (const s of samples) {
        if (s.label !== c || s.test) continue;
        const [x, y] = toPx(s.x, s.y);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = th.classes[c];
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = th.elev;
      ctx.stroke();
      // test: hollow rings
      ctx.beginPath();
      for (const s of samples) {
        if (s.label !== c || !s.test) continue;
        const [x, y] = toPx(s.x, s.y);
        ctx.moveTo(x + r - 0.5, y);
        ctx.arc(x, y, r - 0.5, 0, Math.PI * 2);
      }
      ctx.fillStyle = th.elev;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = th.classes[c];
      ctx.stroke();
    }
  }

  function drawCharts() {
    const th = theme();
    const test = samples.some((s) => s.test);
    drawLineChart(els.lossChart, [
      { pts: hist.map((h) => [h.e, h.tl]), color: th.accent, label: 'train loss', width: 2 },
      ...(test ? [{ pts: hist.map((h) => [h.e, h.vl] as [number, number]), color: th.muted, dash: [4, 3], label: 'test loss' }] : []),
    ], th, { yMin: 0, empty: 'Press Play to train' });
    drawLineChart(els.accChart, [
      { pts: hist.map((h) => [h.e, h.ta]), color: th.accent, label: 'train accuracy', width: 2 },
      ...(test ? [{ pts: hist.map((h) => [h.e, h.va] as [number, number]), color: th.muted, dash: [4, 3], label: 'test accuracy' }] : []),
    ], th, { yMin: 0, yMax: 1, yFmt: (v) => `${Math.round(v * 100)}%`, empty: 'Press Play to train' });
  }

  // ------------------------------------------------------------------ neuron inspector
  const popRes = 44;
  const popOff = document.createElement('canvas');
  popOff.width = popOff.height = popRes;
  let inspector: MLP | null = null;

  function setActive(ref: NeuronRef | null, _ev?: PointerEvent) {
    active = ref;
    netView.setActive(ref);
    if (!ref || !snap) { els.pop.hidden = true; return; }
    els.pop.hidden = false;
    els.popTitle.textContent = `Hidden ${ref.layer} · neuron ${ref.index + 1}`;
    drawNeuronMap();
    // position next to the neuron, inside the network card (the diagram itself may scroll sideways)
    const card = els.pop.offsetParent as HTMLElement | null;
    const node = els.net.querySelectorAll<SVGGElement>('.mll-node')[nodeOffset(ref)];
    const nr = node?.getBoundingClientRect();
    if (!nr || !card) return;
    const cr = card.getBoundingClientRect();
    const pw = els.pop.offsetWidth || 152, ph = els.pop.offsetHeight || 190;
    let x = nr.right - cr.left + 12;
    if (x + pw > cr.width - 6) x = nr.left - cr.left - pw - 12;
    x = Math.max(6, Math.min(cr.width - pw - 6, x));
    const y = Math.max(6, Math.min(cr.height - ph - 6, nr.top - cr.top + nr.height / 2 - ph / 2));
    els.pop.style.left = `${x}px`;
    els.pop.style.top = `${y}px`;
  }
  function nodeOffset(ref: NeuronRef) {
    const sizes = snap!.sizes;
    let o = 0;
    for (let l = 0; l < ref.layer; l++) o += sizes[l];
    return o + ref.index;
  }

  /** Evaluate one hidden unit's activation over the input square and paint it into the popover. */
  function drawNeuronMap() {
    if (!active || !snap) return;
    const s = snap;
    if (!inspector || inspector.sizes.join() !== s.sizes.join() || inspector.act !== cfg.activation) {
      inspector = new MLP(s.sizes, cfg.activation, 1);
    }
    if (active.layer >= s.sizes.length - 1 || active.index >= s.sizes[active.layer]) { setActive(null); return; }
    for (let l = 0; l < inspector.L; l++) { inspector.W[l].set(s.W[l]); inspector.b[l].set(s.b[l]); }
    const keys = cfg.features;
    if (keys.length !== s.sizes[0]) return;
    const fbuf = new Float64Array(keys.length);
    const vals = new Float64Array(popRes * popRes);
    let lo = Infinity, hi = -Infinity, maxAbs = 1e-9;
    for (let r = 0; r < popRes; r++) {
      const y = 1 - ((r + 0.5) * 2) / popRes;
      for (let c = 0; c < popRes; c++) {
        const x = -1 + ((c + 0.5) * 2) / popRes;
        featurize(x, y, keys, fbuf);
        inspector.forward(fbuf);
        const v = inspector.a[active.layer][active.index];
        vals[r * popRes + c] = v;
        if (v < lo) lo = v; if (v > hi) hi = v;
        if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
      }
    }
    const th = theme();
    const bg = th.rgb.elev, pos = th.rgb.pos, neg = th.rgb.neg;
    const pctx = popOff.getContext('2d')!;
    const im = pctx.createImageData(popRes, popRes);
    for (let i = 0; i < vals.length; i++) {
      const t = vals[i] / maxAbs;
      const col = t >= 0 ? pos : neg;
      const a = Math.min(1, Math.abs(t)) * 0.9;
      im.data[i * 4] = bg[0] + (col[0] - bg[0]) * a;
      im.data[i * 4 + 1] = bg[1] + (col[1] - bg[1]) * a;
      im.data[i * 4 + 2] = bg[2] + (col[2] - bg[2]) * a;
      im.data[i * 4 + 3] = 255;
    }
    pctx.putImageData(im, 0, 0);
    const { ctx, w, h } = fitCanvas(els.popCanvas, 134, 134);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(popOff, 0, 0, w, h);
    // faint data overlay for orientation
    ctx.globalAlpha = 0.55;
    for (const smp of samples) {
      ctx.fillStyle = th.classes[smp.label] ?? th.faint;
      ctx.fillRect(((smp.x + 1) / 2) * w - 0.75, ((1 - smp.y) / 2) * h - 0.75, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
    const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
    els.popSub.textContent = `${actName(cfg.activation)} output, range ${fmt(lo)} to ${fmt(hi)}`;
  }
  const actName = (a: Activation) => ({ relu: 'ReLU', tanh: 'tanh', sigmoid: 'sigmoid', gelu: 'GELU' })[a];

  document.addEventListener('pointerdown', (e) => {
    if (!active) return;
    if ((e.target as Element)?.closest?.('.mll-node.is-hidden')) return;
    setActive(null);
  });

  // ------------------------------------------------------------------ UI sync
  const fmtLoss = (v: number) => (Number.isFinite(v) ? (v >= 100 ? v.toFixed(0) : v.toFixed(3)) : '–');
  const fmtAcc = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '–');
  function syncMetrics() {
    const s = snap;
    els.epoch.textContent = s ? s.epoch.toLocaleString() : '0';
    els.trainLoss.textContent = s && s.nTrain ? fmtLoss(s.trainLoss) : '–';
    els.trainAcc.textContent = s && s.nTrain ? fmtAcc(s.trainAcc) : '–';
    els.testLoss.textContent = s && s.nTest ? fmtLoss(s.testLoss) : '–';
    els.testAcc.textContent = s && s.nTest ? fmtAcc(s.testAcc) : '–';
    if (diverged) {
      els.alert.hidden = false;
      els.alert.textContent = 'Training diverged: the loss became infinite or NaN. Lower the learning rate, then press Reset.';
    } else els.alert.hidden = true;
  }

  function setPlayIcon(on: boolean) {
    els.play.setAttribute('aria-pressed', String(on));
    els.play.querySelector<HTMLElement>('.ml-lab-ico-play')!.hidden = on;
    els.play.querySelector<HTMLElement>('.ml-lab-ico-pause')!.hidden = !on;
    els.play.querySelector<HTMLElement>('.ml-lab-play-text')!.textContent = on ? 'Pause' : 'Play';
  }
  function syncTransport() {
    setPlayIcon(playing);
    const nTrain = samples.filter((s) => !s.test).length;
    els.play.disabled = nTrain === 0 && !playing;
    els.step.disabled = nTrain === 0 || diverged;
    els.empty.hidden = samples.length > 0;
  }

  function syncArch() {
    const L = cfg.hidden.length;
    els.layersOut.textContent = String(L);
    els.layersMinus.disabled = L === 0;
    els.layersPlus.disabled = L >= 4;
    els.layerList.innerHTML = '';
    cfg.hidden.forEach((n, l) => {
      const row = document.createElement('div');
      row.className = 'ml-lab-layer';
      row.innerHTML = `<span>Layer ${l + 1}</span><div class="ml-lab-stepper" role="group" aria-label="Neurons in layer ${l + 1}">
        <button type="button" class="btn btn-sm btn-icon" data-d="-1" aria-label="Fewer neurons in layer ${l + 1}" ${n <= 1 ? 'disabled' : ''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>
        <output class="mono" aria-live="polite">${n}</output>
        <button type="button" class="btn btn-sm btn-icon" data-d="1" aria-label="More neurons in layer ${l + 1}" ${n >= 16 ? 'disabled' : ''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>`;
      row.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
        cfg.hidden[l] = Math.max(1, Math.min(16, cfg.hidden[l] + Number(b.dataset.d)));
        syncArch();
        row.parentElement?.children[l]?.querySelector<HTMLButtonElement>(`button[data-d="${b.dataset.d}"]`)?.focus();
        configChanged();
      }));
      els.layerList.appendChild(row);
    });
    els.init.textContent = `${initName(cfg.activation)} init`;
  }

  function syncControls() {
    els.act.value = cfg.activation;
    els.opt.value = cfg.optimizer;
    els.lr.value = String(cfg.lr);
    els.batch.value = String(cfg.batchSize);
    els.l2.value = String(cfg.l2);
    document.querySelectorAll<HTMLInputElement>('[data-nn-feat]').forEach((cb) => { cb.checked = cfg.features.includes(cb.dataset.nnFeat as FeatureKey); });
    els.cls2.setAttribute('aria-pressed', String(classes === 2));
    els.cls3.setAttribute('aria-pressed', String(classes === 3));
    document.querySelector<HTMLElement>('[data-nn-tool="2"]')!.hidden = classes < 3;
    if (classes < 3 && tool === 2) setTool(0);
    document.querySelectorAll<HTMLButtonElement>('[data-nn-ds]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nnDs === kind)));
    syncArch();
  }

  function syncLesson() {
    els.presets.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset?.id)));
  }
  function showLesson(title: string, text: string, fix?: Preset['fix']) {
    els.lessonTitle.textContent = title;
    els.lessonText.textContent = text;
    els.lessonFix.hidden = !fix;
    els.lessonFix.textContent = fix?.label ?? '';
  }

  // ------------------------------------------------------------------ engine plumbing
  const sendData = debounce(() => post({ type: 'data', samples }), 30);
  function dataChanged() {
    syncTransport();
    sendData();
    chartsDirty = true;
    requestRender();
  }
  function configChanged() {
    cfg.classes = classes;
    post({ type: 'config', cfg: { ...cfg, hidden: [...cfg.hidden], features: [...cfg.features] }, gen: ++gen });
    diverged = false;
  }
  function restartEngine() {
    cfg.classes = classes;
    diverged = false;
    snap = null;
    post({ type: 'init', cfg: { ...cfg, hidden: [...cfg.hidden], features: [...cfg.features] }, samples, gen: ++gen });
    post({ type: 'speed', speed: els.speed.value as Speed });
  }
  function play() {
    if (playing) { post({ type: 'pause' }); playing = wantPlaying = false; syncTransport(); return; }
    if (!samples.some((s) => !s.test)) { toast('Add some training points first', 'error'); return; }
    if (diverged) { post({ type: 'reset', seed: randomSeed(), gen: ++gen }); diverged = false; }
    post({ type: 'play' });
    playing = wantPlaying = true;
    started = true;
    syncTransport();
  }

  // ------------------------------------------------------------------ data
  function generate(newSeed = false) {
    if (newSeed) dataSeed = randomSeed() % 100000;
    if (kind === 'custom') kind = 'spiral';
    const pts = makeClassData(kind, { n: Number(els.n.value), noise: Number(els.noise.value) / 100, classes, seed: dataSeed });
    samples = splitTrainTest(pts, Number(els.split.value) / 100, dataSeed);
    syncControls();
    dataChanged();
  }
  function resplit() {
    samples = splitTrainTest(samples as LabeledPoint[], Number(els.split.value) / 100, dataSeed);
    dataChanged();
  }

  // painting
  const ERASE_R = 0.09;
  let painting = false;
  let lastPaint: { x: number; y: number } | null = null;
  let hover: { x: number; y: number } | null = null;
  function eventWorld(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return toWorld(((e.clientX - rect.left) / rect.width) * size, ((e.clientY - rect.top) / rect.height) * size);
  }
  function applyTool(p: { x: number; y: number }) {
    if (p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1) return;
    if (tool === 'erase') {
      const before = samples.length;
      samples = samples.filter((s) => (s.x - p.x) ** 2 + (s.y - p.y) ** 2 > ERASE_R * ERASE_R);
      if (samples.length !== before) { markCustom(); dataChanged(); }
      return;
    }
    if (samples.length >= MAX_POINTS) { toast(`Point limit reached (${MAX_POINTS})`, 'error'); painting = false; return; }
    samples.push({ x: p.x, y: p.y, label: tool, test: false });
    markCustom();
    dataChanged();
  }
  function markCustom() {
    if (kind !== 'custom') { kind = 'custom'; syncControls(); }
    if (preset) { preset = null; syncLesson(); }
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    painting = true;
    const p = eventWorld(e);
    lastPaint = p;
    applyTool(p);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = eventWorld(e);
    hover = e.pointerType === 'mouse' ? p : null;
    if (painting && lastPaint && Math.hypot(p.x - lastPaint.x, p.y - lastPaint.y) >= (tool === 'erase' ? 0.03 : 0.07)) {
      lastPaint = p;
      applyTool(p);
    }
    if (tool === 'erase') requestRender();
  });
  const endPaint = () => { painting = false; lastPaint = null; };
  canvas.addEventListener('pointerup', endPaint);
  canvas.addEventListener('pointercancel', endPaint);
  canvas.addEventListener('pointerleave', () => { hover = null; requestRender(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function setTool(t: Tool) {
    tool = t;
    document.querySelectorAll<HTMLButtonElement>('[data-nn-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nnTool === String(t))));
    canvas.dataset.tool = t === 'erase' ? 'erase' : 'paint';
    requestRender();
  }

  // ------------------------------------------------------------------ presets
  function applyPreset(p: Preset) {
    preset = p;
    kind = p.data.kind;
    classes = p.data.classes;
    dataSeed = p.data.seed;
    els.n.value = String(p.data.n);
    els.noise.value = String(Math.round(p.data.noise * 100));
    els.split.value = String(Math.round(p.data.split * 100));
    syncOutputs();
    Object.assign(cfg, { seed: 1 }, p.cfg, { hidden: [...(p.cfg.hidden ?? cfg.hidden)], features: [...(p.cfg.features ?? cfg.features)] });
    const pts = makeClassData(p.data.kind, { n: p.data.n, noise: p.data.noise, classes, seed: p.data.seed });
    samples = splitTrainTest(pts, p.data.split, p.data.seed);
    syncControls();
    syncTransport();
    restartEngine();
    showLesson(p.title, p.text, p.fix);
    syncLesson();
    playing = false;
    play();
  }
  function applyFix() {
    const p = preset;
    if (!p?.fix) return;
    Object.assign(cfg, p.fix.cfg);
    if (p.fix.cfg.hidden) cfg.hidden = [...p.fix.cfg.hidden];
    if (p.fix.cfg.features) cfg.features = [...p.fix.cfg.features];
    cfg.seed = 1;
    syncControls();
    restartEngine();
    showLesson(p.title, p.fix.text);
    playing = false;
    play();
  }
  PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ml-lab-preset';
    b.dataset.preset = p.id;
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<b></b><small></small>`;
    b.querySelector('b')!.textContent = p.title;
    b.querySelector('small')!.textContent = p.sub;
    b.addEventListener('click', () => applyPreset(p));
    els.presets.appendChild(b);
  });
  els.lessonFix.addEventListener('click', applyFix);

  // A manual change keeps training but ends the guided lesson.
  function leaveLesson() {
    if (!preset) return;
    preset = null;
    syncLesson();
    showLesson(DEFAULT_LESSON.title, DEFAULT_LESSON.text);
  }

  // ------------------------------------------------------------------ controls
  const syncOutputs = () => {
    els.nOut.textContent = els.n.value;
    els.noiseOut.textContent = `${els.noise.value}%`;
    els.splitOut.textContent = `${els.split.value}%`;
  };
  document.querySelectorAll<HTMLButtonElement>('[data-nn-ds]').forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.nnDs as ClassDataset;
    leaveLesson();
    generate(false);
  }));
  const regen = debounce(() => { if (kind !== 'custom') generate(false); }, 60);
  els.n.addEventListener('input', () => { syncOutputs(); leaveLesson(); regen(); });
  els.noise.addEventListener('input', () => { syncOutputs(); leaveLesson(); regen(); });
  els.split.addEventListener('input', () => { syncOutputs(); leaveLesson(); resplit(); });
  $('nn-regen').addEventListener('click', () => { leaveLesson(); generate(true); });
  $('nn-clear').addEventListener('click', () => {
    samples = [];
    kind = 'custom';
    leaveLesson();
    syncControls();
    dataChanged();
    toast('Cleared: click the canvas to add points');
  });
  const setClasses = (c: number) => {
    if (c === classes) return;
    classes = c;
    leaveLesson();
    if (kind === 'custom') samples = samples.filter((s) => s.label < c);
    else {
      const pts = makeClassData(kind, { n: Number(els.n.value), noise: Number(els.noise.value) / 100, classes, seed: dataSeed });
      samples = splitTrainTest(pts, Number(els.split.value) / 100, dataSeed);
    }
    syncControls();
    syncTransport();
    restartEngine();
    if (playing) post({ type: 'play' });
  };
  els.cls2.addEventListener('click', () => setClasses(2));
  els.cls3.addEventListener('click', () => setClasses(3));
  document.querySelectorAll<HTMLButtonElement>('[data-nn-tool]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.nnTool!;
    setTool(v === 'erase' ? 'erase' : (Number(v) as Tool));
  }));
  document.querySelectorAll<HTMLInputElement>('[data-nn-feat]').forEach((cb) => cb.addEventListener('change', () => {
    const on = new Set(cfg.features);
    if (cb.checked) on.add(cb.dataset.nnFeat as FeatureKey);
    else on.delete(cb.dataset.nnFeat as FeatureKey);
    if (!on.size) { cb.checked = true; toast('Keep at least one input feature', 'error'); return; }
    cfg.features = FEATURE_ORDER.filter((k) => on.has(k));
    leaveLesson();
    configChanged();
  }));
  els.layersMinus.addEventListener('click', () => { if (cfg.hidden.length) { cfg.hidden.pop(); syncArch(); leaveLesson(); configChanged(); } });
  els.layersPlus.addEventListener('click', () => {
    if (cfg.hidden.length >= 4) return;
    cfg.hidden.push(cfg.hidden[cfg.hidden.length - 1] ?? 4);
    syncArch(); leaveLesson(); configChanged();
  });
  els.act.addEventListener('change', () => { cfg.activation = els.act.value as Activation; syncArch(); leaveLesson(); configChanged(); });
  els.opt.addEventListener('change', () => { cfg.optimizer = els.opt.value as OptimizerKind; leaveLesson(); configChanged(); });
  els.lr.addEventListener('change', () => { cfg.lr = Number(els.lr.value); leaveLesson(); configChanged(); });
  els.batch.addEventListener('change', () => { cfg.batchSize = Number(els.batch.value); leaveLesson(); configChanged(); });
  els.l2.addEventListener('change', () => { cfg.l2 = Number(els.l2.value); leaveLesson(); configChanged(); });
  els.speed.addEventListener('change', () => post({ type: 'speed', speed: els.speed.value as Speed }));
  els.play.addEventListener('click', play);
  els.step.addEventListener('click', () => {
    if (playing) { post({ type: 'pause' }); playing = wantPlaying = false; }
    post({ type: 'step', epochs: 1 });
    started = true;
    syncTransport();
  });
  els.reset.addEventListener('click', () => {
    cfg.seed = randomSeed();
    diverged = false;
    post({ type: 'reset', seed: cfg.seed, gen: ++gen });
    if (playing) post({ type: 'play' });
  });

  new ResizeObserver(() => { chartsDirty = true; requestRender(); }).observe(wrap);
  new ResizeObserver(() => { chartsDirty = true; requestRender(); }).observe(els.lossChart);

  // keyboard: Space = play/pause, N = step, R = reset (only while this tab is visible)
  document.addEventListener('keydown', (e) => {
    const panel = document.querySelector<HTMLElement>('[data-tabpanel="mllab:nn"]');
    if (!panel || panel.hidden) return;
    const t = e.target as HTMLElement;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && tag !== 'BUTTON' && !t?.closest?.('[role="button"]')) { e.preventDefault(); play(); }
    else if (e.key === 'n') { e.preventDefault(); els.step.click(); }
    else if (e.key === 'r') els.reset.click();
  });

  // ------------------------------------------------------------------ initial state
  syncOutputs();
  setTool(0);
  generate(false);
  showLesson(DEFAULT_LESSON.title, DEFAULT_LESSON.text);
  restartEngine();

  return {
    /** Called when the tab becomes visible: start training the first time so the page is alive. */
    shown() {
      requestRender();
      if (!started && samples.length) play();
      else if (resumeOnShow && !playing) play();
      resumeOnShow = false;
    },
    /** Called when another tab is selected: don't burn CPU on a hidden chart. */
    hidden() {
      resumeOnShow = playing;
      if (playing) { post({ type: 'pause' }); playing = wantPlaying = false; syncTransport(); }
    },
    redraw() {
      chartsDirty = true;
      netView.restyle(theme());
      if (active) drawNeuronMap();
      requestRender();
    },
    get state() {
      return {
        epoch: snap?.epoch ?? 0, playing, trainAcc: snap?.trainAcc ?? NaN, testAcc: snap?.testAcc ?? NaN,
        trainLoss: snap?.trainLoss ?? NaN, n: samples.length, nTest: samples.filter((s) => s.test).length,
        sizes: snap?.sizes ?? [], netVersion: netView.version, preset: preset?.id ?? null, classes, features: [...cfg.features],
        hidden: [...cfg.hidden], worker: !fallbackCore, diverged,
      };
    },
  };
}
