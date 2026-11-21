// Optimizer Race: pure simulation core (no DOM). Landscapes, optimizers, and the race runner.
// Kept dependency-free so it can be imported by the UI, by tests in the browser, and by Node scripts.

export type Vec2 = [number, number];
export type GradFn = (x: number, y: number) => Vec2;

/* ==========================================================================
   Landscapes
   ========================================================================== */

export type LandscapeId =
  | 'bowl'
  | 'rosenbrock'
  | 'beale'
  | 'himmelblau'
  | 'saddle'
  | 'rastrigin'
  | 'camel'
  | 'noisy';

export type OptimizerId = 'sgd' | 'momentum' | 'nesterov' | 'adagrad' | 'rmsprop' | 'adam' | 'adamw' | 'lion';

export interface Marker {
  x: number;
  y: number;
  kind: 'global' | 'local' | 'saddle' | 'max';
}

export interface Landscape {
  id: LandscapeId;
  name: string;
  /** TeX source of the formula. */
  tex: string;
  f: (x: number, y: number) => number;
  grad: GradFn;
  /** Region that must be visible; the canvas expands it to keep a 1:1 aspect. */
  view: { xmin: number; xmax: number; ymin: number; ymax: number };
  start: Vec2;
  markers: Marker[];
  /** Known global minimum value, or null when unbounded below. */
  fmin: number | null;
  /** Typical gradient magnitude, used to scale the global noise slider. */
  noiseScale: number;
  /** Standard deviation of the landscape's own gradient noise (stochastic objectives). */
  intrinsicNoise: number;
  /** Tuned default learning rates. */
  lr: Record<OptimizerId, number>;
  maxSteps: number;
  blurb: string;
  tips: string[];
}

const PI2 = Math.PI * 2;

export const LANDSCAPES: Landscape[] = [
  {
    id: 'bowl',
    name: 'Elongated bowl',
    tex: 'f(x,y)=0.05\\,x^2+y^2',
    f: (x, y) => 0.05 * x * x + y * y,
    grad: (x, y) => [0.1 * x, 2 * y],
    view: { xmin: -8.5, xmax: 8.5, ymin: -4, ymax: 4 },
    start: [-7.5, 2.5],
    markers: [{ x: 0, y: 0, kind: 'global' }],
    fmin: 0,
    noiseScale: 1,
    intrinsicNoise: 0,
    lr: { sgd: 0.4, momentum: 0.1, nesterov: 0.1, adagrad: 1.5, rmsprop: 0.05, adam: 0.25, adamw: 0.25, lion: 0.04 },
    maxSteps: 400,
    blurb: 'A convex quadratic whose curvature differs 20× between the axes (condition number 20).',
    tips: [
      'Plain SGD must keep its step below 2/L for the steep y-axis, so it zig-zags or crawls along the shallow x-axis.',
      'Momentum and Nesterov build up speed along the flat direction while the y-oscillations cancel out.',
      'Adam, RMSProp and AdaGrad rescale each coordinate by its own gradient history, so the bowl looks round to them: their paths head almost straight for the minimum.',
      'Lion takes fixed-size sign steps, so it moves diagonally at first and then rattles around the minimum with amplitude ≈ η.',
    ],
  },
  {
    id: 'rosenbrock',
    name: 'Rosenbrock',
    tex: 'f(x,y)=(1-x)^2+100\\,(y-x^2)^2',
    f: (x, y) => {
      const a = 1 - x;
      const b = y - x * x;
      return a * a + 100 * b * b;
    },
    grad: (x, y) => {
      const b = y - x * x;
      return [-2 * (1 - x) - 400 * x * b, 200 * b];
    },
    view: { xmin: -2, xmax: 2, ymin: -1, ymax: 3 },
    start: [-1.6, 2.4],
    markers: [{ x: 1, y: 1, kind: 'global' }],
    fmin: 0,
    noiseScale: 20,
    intrinsicNoise: 0,
    lr: { sgd: 0.0012, momentum: 0.0002, nesterov: 0.0002, adagrad: 0.5, rmsprop: 0.003, adam: 0.03, adamw: 0.03, lion: 0.003 },
    maxSteps: 3000,
    blurb: 'A curved, flat-bottomed banana valley. Finding the valley is easy, following it to (1, 1) is hard.',
    tips: [
      'Everyone drops into the valley within a few steps; the race is about travelling along its curved floor.',
      'SGD needs a tiny learning rate to survive the steep walls, so it crawls along the floor.',
      'Momentum overshoots in the Rosenbrock valley: it bounces between the walls but carries speed around the bend.',
      'Adam handles the badly scaled walls by normalising each coordinate, but its effective step stays ≈ η, so it can oscillate near the end.',
      'Try raising SGD’s learning rate a little: just past ≈ 0.002 it diverges on the steep wall.',
    ],
  },
  {
    id: 'beale',
    name: 'Beale',
    tex: 'f=(1.5-x+xy)^2+(2.25-x+xy^2)^2+(2.625-x+xy^3)^2',
    f: (x, y) => {
      const t1 = 1.5 - x + x * y;
      const t2 = 2.25 - x + x * y * y;
      const t3 = 2.625 - x + x * y * y * y;
      return t1 * t1 + t2 * t2 + t3 * t3;
    },
    grad: (x, y) => {
      const y2 = y * y;
      const y3 = y2 * y;
      const t1 = 1.5 - x + x * y;
      const t2 = 2.25 - x + x * y2;
      const t3 = 2.625 - x + x * y3;
      return [
        2 * t1 * (y - 1) + 2 * t2 * (y2 - 1) + 2 * t3 * (y3 - 1),
        2 * t1 * x + 4 * t2 * x * y + 6 * t3 * x * y2,
      ];
    },
    view: { xmin: -4.5, xmax: 4.5, ymin: -4.5, ymax: 4.5 },
    start: [1, 1.6],
    markers: [{ x: 3, y: 0.5, kind: 'global' }],
    fmin: 0,
    noiseScale: 5,
    intrinsicNoise: 0,
    lr: { sgd: 0.002, momentum: 0.0005, nesterov: 0.0005, adagrad: 0.5, rmsprop: 0.01, adam: 0.04, adamw: 0.04, lion: 0.01 },
    maxSteps: 1500,
    blurb: 'Sharp ridges and flat plateaus with a single minimum at (3, 0.5), in a narrow curved channel.',
    tips: [
      'Gradients range over orders of magnitude: steep near the top edge, nearly flat in the channel.',
      'SGD and momentum take tiny steps on the plateau because the gradient there is small.',
      'Adaptive methods (RMSProp, Adam) normalise the step size and cross the plateau quickly.',
      'Increase the learning rate of momentum: it gets catapulted off the ridge. Turn on gradient clipping to tame it.',
    ],
  },
  {
    id: 'himmelblau',
    name: 'Himmelblau',
    tex: 'f(x,y)=(x^2+y-11)^2+(x+y^2-7)^2',
    f: (x, y) => {
      const a = x * x + y - 11;
      const b = x + y * y - 7;
      return a * a + b * b;
    },
    grad: (x, y) => {
      const a = x * x + y - 11;
      const b = x + y * y - 7;
      return [4 * x * a + 2 * b, 2 * a + 4 * y * b];
    },
    view: { xmin: -5.5, xmax: 5.5, ymin: -5.5, ymax: 5.5 },
    start: [0, -1],
    markers: [
      { x: 3, y: 2, kind: 'global' },
      { x: -2.805118, y: 3.131312, kind: 'global' },
      { x: -3.77931, y: -3.283186, kind: 'global' },
      { x: 3.584428, y: -1.848126, kind: 'global' },
      { x: -0.270845, y: -0.923039, kind: 'max' },
    ],
    fmin: 0,
    noiseScale: 10,
    intrinsicNoise: 0,
    lr: { sgd: 0.01, momentum: 0.002, nesterov: 0.002, adagrad: 1, rmsprop: 0.02, adam: 0.08, adamw: 0.08, lion: 0.02 },
    maxSteps: 800,
    blurb: 'Four equally good minima around a local maximum near (−0.27, −0.92). Where you start decides where you end.',
    tips: [
      'Click near the central bump (the hollow marker) and watch optimizers pick different basins.',
      'Sign-based and normalised updates (Lion, Adam) can take a different route than SGD from the same start.',
      'Momentum can carry an optimizer over a ridge into a basin that plain SGD would never reach.',
    ],
  },
  {
    id: 'saddle',
    name: 'Saddle',
    tex: 'f(x,y)=x^2-y^2',
    f: (x, y) => x * x - y * y,
    grad: (x, y) => [2 * x, -2 * y],
    view: { xmin: -2, xmax: 2, ymin: -2, ymax: 2 },
    start: [-1.8, 0.001],
    markers: [{ x: 0, y: 0, kind: 'saddle' }],
    fmin: null,
    noiseScale: 1,
    intrinsicNoise: 0,
    lr: { sgd: 0.01, momentum: 0.01, nesterov: 0.01, adagrad: 0.1, rmsprop: 0.01, adam: 0.01, adamw: 0.01, lion: 0.01 },
    maxSteps: 600,
    blurb: 'A pure saddle at the origin: a minimum along x and a maximum along y. Unbounded below.',
    tips: [
      'Starting almost on the x-axis, the escape direction (y) has a gradient close to zero.',
      'SGD slides to the saddle and lingers there for a long time; the tiny y-component only grows by (1 + 2η) per step.',
      'Adam and RMSProp divide by the gradient’s RMS, which amplifies the tiny y-gradient: they escape quickly.',
      'Add a little gradient noise: it kicks every optimizer off the ridge, which is one reason SGD noise helps in deep learning.',
      'Start exactly at y = 0 and the gradient never points away: SGD converges to the saddle point and stops.',
    ],
  },
  {
    id: 'rastrigin',
    name: 'Rastrigin',
    tex: 'f=20+\\sum_{u\\in\\{x,y\\}}\\left(u^2-10\\cos 2\\pi u\\right)',
    f: (x, y) => 20 + x * x - 10 * Math.cos(PI2 * x) + y * y - 10 * Math.cos(PI2 * y),
    grad: (x, y) => [2 * x + 10 * PI2 * Math.sin(PI2 * x), 2 * y + 10 * PI2 * Math.sin(PI2 * y)],
    view: { xmin: -4.5, xmax: 4.5, ymin: -4.5, ymax: 4.5 },
    start: [3.3, 2.4],
    markers: [{ x: 0, y: 0, kind: 'global' }],
    fmin: 0,
    noiseScale: 20,
    intrinsicNoise: 0,
    lr: { sgd: 0.002, momentum: 0.002, nesterov: 0.002, adagrad: 0.5, rmsprop: 0.01, adam: 0.05, adamw: 0.05, lion: 0.02 },
    maxSteps: 800,
    blurb: 'A bowl covered in an egg-crate of local minima. Gradient methods only see the nearest dimple.',
    tips: [
      'Most optimizers fall into the closest local minimum and stay there: local information cannot see the global picture.',
      'A larger learning rate or heavy momentum can hop over a few bumps before settling.',
      'Turn up gradient noise to see a crude form of annealing: noise lets optimizers jump between dimples.',
    ],
  },
  {
    id: 'camel',
    name: 'Six-hump camel',
    tex: 'f=\\left(4-2.1x^2+\\tfrac{x^4}{3}\\right)x^2+xy+(4y^2-4)\\,y^2',
    f: (x, y) => {
      const x2 = x * x;
      const y2 = y * y;
      return (4 - 2.1 * x2 + (x2 * x2) / 3) * x2 + x * y + (-4 + 4 * y2) * y2;
    },
    grad: (x, y) => {
      const x2 = x * x;
      return [8 * x - 8.4 * x2 * x + 2 * x2 * x2 * x + y, x - 8 * y + 16 * y * y * y];
    },
    view: { xmin: -2.2, xmax: 2.2, ymin: -1.3, ymax: 1.3 },
    start: [-2, -1],
    markers: [
      { x: 0.0898, y: -0.7126, kind: 'global' },
      { x: -0.0898, y: 0.7126, kind: 'global' },
      { x: -1.7036, y: 0.7961, kind: 'local' },
      { x: 1.7036, y: -0.7961, kind: 'local' },
      { x: -1.6071, y: -0.5687, kind: 'local' },
      { x: 1.6071, y: 0.5687, kind: 'local' },
    ],
    fmin: -1.031628453,
    noiseScale: 3,
    intrinsicNoise: 0,
    lr: { sgd: 0.01, momentum: 0.004, nesterov: 0.004, adagrad: 0.3, rmsprop: 0.01, adam: 0.03, adamw: 0.03, lion: 0.008 },
    maxSteps: 800,
    blurb: 'Six minima: two global ones near (±0.09, ∓0.71) and four local "humps" on the flanks.',
    tips: [
      'From the left flank, cautious optimizers settle in the nearest local minimum (f ≈ −0.22).',
      'Momentum-based methods can roll through the shallow local basin into a global one.',
      'Watch the status column: “local min” means the gradient vanished somewhere other than a global minimum.',
    ],
  },
  {
    id: 'noisy',
    name: 'Noisy bowl',
    tex: 'f(x,y)=\\tfrac12 x^2+\\tfrac32 y^2,\\quad \\tilde g=\\nabla f+\\xi,\\ \\xi\\sim\\mathcal N(0,\\sigma^2 I)',
    f: (x, y) => 0.5 * x * x + 1.5 * y * y,
    grad: (x, y) => [x, 3 * y],
    view: { xmin: -3, xmax: 3, ymin: -2, ymax: 2 },
    start: [-2.6, 1.6],
    markers: [{ x: 0, y: 0, kind: 'global' }],
    fmin: 0,
    noiseScale: 1,
    intrinsicNoise: 1.5,
    lr: { sgd: 0.05, momentum: 0.01, nesterov: 0.01, adagrad: 0.5, rmsprop: 0.02, adam: 0.05, adamw: 0.05, lion: 0.01 },
    maxSteps: 600,
    blurb: 'A simple bowl, but every gradient is corrupted by Gaussian noise (σ = 1.5), like a minibatch gradient.',
    tips: [
      'No optimizer settles exactly: each ends up jittering inside a “noise ball” whose size scales with the learning rate.',
      'Momentum averages gradients over ≈ 1/(1−μ) steps, which smooths the path.',
      'Adam’s step is ≈ η·m̂/√v̂: near the minimum the noise dominates v̂, so the step stays roughly η in size.',
      'AdaGrad’s ever-growing denominator acts like a learning-rate decay, so it ends up the calmest here.',
    ],
  },
];

export const LANDSCAPE_BY_ID = Object.fromEntries(LANDSCAPES.map((l) => [l.id, l])) as Record<LandscapeId, Landscape>;

/* ==========================================================================
   Optimizers
   ========================================================================== */

export type HyperKey = 'lr' | 'mu' | 'rho' | 'b1' | 'b2' | 'eps' | 'wd';
export type Hyper = Partial<Record<HyperKey, number>> & { lr: number };

export interface ParamSpec {
  key: HyperKey;
  label: string;
  /** TeX symbol for the label. */
  tex: string;
  min: number;
  max: number;
  /** log-scale slider */
  log?: boolean;
}

export interface OptState {
  x: number;
  y: number;
  t: number;
  /** First-moment / velocity slot. */
  m: Vec2;
  /** Second-moment / accumulator slot. */
  v: Vec2;
}

export interface OptimizerDef {
  id: OptimizerId;
  name: string;
  colorVar: string;
  shape: 'circle' | 'square' | 'triangle' | 'diamond' | 'triangle-down' | 'hexagon' | 'star' | 'cross';
  params: ParamSpec[];
  defaults: Omit<Hyper, 'lr'>;
  paper: string;
  summary: string;
  /** Update equations in TeX (one display block). */
  tex: string;
  step: (s: OptState, h: Hyper, grad: GradFn) => void;
}

const LR: ParamSpec = { key: 'lr', label: 'Learning rate', tex: '\\eta', min: 1e-5, max: 10, log: true };
const MU: ParamSpec = { key: 'mu', label: 'Momentum', tex: '\\mu', min: 0, max: 0.999 };
const RHO: ParamSpec = { key: 'rho', label: 'Decay', tex: '\\rho', min: 0, max: 0.9999 };
const B1: ParamSpec = { key: 'b1', label: 'Beta 1', tex: '\\beta_1', min: 0, max: 0.999 };
const B2: ParamSpec = { key: 'b2', label: 'Beta 2', tex: '\\beta_2', min: 0, max: 0.99999 };
const EPS: ParamSpec = { key: 'eps', label: 'Epsilon', tex: '\\epsilon', min: 1e-12, max: 1, log: true };
const WD: ParamSpec = { key: 'wd', label: 'Weight decay', tex: '\\lambda', min: 0, max: 1 };

const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export const OPTIMIZERS: OptimizerDef[] = [
  {
    id: 'sgd',
    name: 'SGD',
    colorVar: '--c3',
    shape: 'circle',
    params: [LR],
    defaults: {},
    paper: 'Robbins & Monro, 1951',
    summary: 'Step straight down the (possibly noisy) gradient. The learning rate is bounded by the steepest curvature: η < 2/L.',
    tex: '\\theta_{t} = \\theta_{t-1} - \\eta\\, g_t',
    step(s, h, grad) {
      const [gx, gy] = grad(s.x, s.y);
      s.t++;
      s.x -= h.lr * gx;
      s.y -= h.lr * gy;
    },
  },
  {
    id: 'momentum',
    name: 'Momentum',
    colorVar: '--c4',
    shape: 'square',
    params: [LR, MU],
    defaults: { mu: 0.9 },
    paper: 'Polyak, 1964 (heavy ball)',
    summary: 'Accumulate a velocity: consistent gradient directions add up, oscillating ones cancel. Effective step ≈ η/(1−μ).',
    tex: '\\begin{aligned} v_t &= \\mu\\, v_{t-1} - \\eta\\, g_t \\\\ \\theta_t &= \\theta_{t-1} + v_t \\end{aligned}',
    step(s, h, grad) {
      const mu = h.mu ?? 0.9;
      const [gx, gy] = grad(s.x, s.y);
      s.t++;
      s.m[0] = mu * s.m[0] - h.lr * gx;
      s.m[1] = mu * s.m[1] - h.lr * gy;
      s.x += s.m[0];
      s.y += s.m[1];
    },
  },
  {
    id: 'nesterov',
    name: 'Nesterov',
    colorVar: '--c6',
    shape: 'triangle',
    params: [LR, MU],
    defaults: { mu: 0.9 },
    paper: 'Nesterov, 1983; Sutskever et al., 2013',
    summary: 'Momentum that evaluates the gradient at the look-ahead point θ + μv, so it can brake before overshooting.',
    tex: '\\begin{aligned} v_t &= \\mu\\, v_{t-1} - \\eta\\, \\nabla f(\\theta_{t-1} + \\mu v_{t-1}) \\\\ \\theta_t &= \\theta_{t-1} + v_t \\end{aligned}',
    step(s, h, grad) {
      const mu = h.mu ?? 0.9;
      const [gx, gy] = grad(s.x + mu * s.m[0], s.y + mu * s.m[1]);
      s.t++;
      s.m[0] = mu * s.m[0] - h.lr * gx;
      s.m[1] = mu * s.m[1] - h.lr * gy;
      s.x += s.m[0];
      s.y += s.m[1];
    },
  },
  {
    id: 'adagrad',
    name: 'AdaGrad',
    colorVar: '--c5',
    shape: 'diamond',
    params: [LR, EPS],
    defaults: { eps: 1e-8 },
    paper: 'Duchi, Hazan & Singer, 2011',
    summary: 'Per-coordinate step sizes from the sum of all past squared gradients. The denominator only grows, so steps shrink over time.',
    tex: '\\begin{aligned} G_t &= G_{t-1} + g_t^2 \\\\ \\theta_t &= \\theta_{t-1} - \\frac{\\eta}{\\sqrt{G_t}+\\epsilon}\\, g_t \\end{aligned}',
    step(s, h, grad) {
      const eps = h.eps ?? 1e-8;
      const [gx, gy] = grad(s.x, s.y);
      s.t++;
      s.v[0] += gx * gx;
      s.v[1] += gy * gy;
      s.x -= (h.lr * gx) / (Math.sqrt(s.v[0]) + eps);
      s.y -= (h.lr * gy) / (Math.sqrt(s.v[1]) + eps);
    },
  },
  {
    id: 'rmsprop',
    name: 'RMSProp',
    colorVar: '--c2',
    shape: 'triangle-down',
    params: [LR, RHO, EPS],
    defaults: { rho: 0.9, eps: 1e-8 },
    paper: 'Tieleman & Hinton, 2012 (Coursera lecture 6e)',
    summary: 'AdaGrad with a leaky (exponential moving) average of squared gradients, so the step size can recover.',
    tex: '\\begin{aligned} s_t &= \\rho\\, s_{t-1} + (1-\\rho)\\, g_t^2 \\\\ \\theta_t &= \\theta_{t-1} - \\frac{\\eta}{\\sqrt{s_t}+\\epsilon}\\, g_t \\end{aligned}',
    step(s, h, grad) {
      const rho = h.rho ?? 0.9;
      const eps = h.eps ?? 1e-8;
      const [gx, gy] = grad(s.x, s.y);
      s.t++;
      s.v[0] = rho * s.v[0] + (1 - rho) * gx * gx;
      s.v[1] = rho * s.v[1] + (1 - rho) * gy * gy;
      s.x -= (h.lr * gx) / (Math.sqrt(s.v[0]) + eps);
      s.y -= (h.lr * gy) / (Math.sqrt(s.v[1]) + eps);
    },
  },
  {
    id: 'adam',
    name: 'Adam',
    colorVar: '--c1',
    shape: 'hexagon',
    params: [LR, B1, B2, EPS],
    defaults: { b1: 0.9, b2: 0.999, eps: 1e-8 },
    paper: 'Kingma & Ba, 2015',
    summary: 'Momentum on the gradient plus RMSProp-style scaling, both bias-corrected for the zero initialisation. Steps are ≈ η in size.',
    tex: '\\begin{aligned} m_t &= \\beta_1 m_{t-1} + (1-\\beta_1)\\, g_t \\\\ v_t &= \\beta_2 v_{t-1} + (1-\\beta_2)\\, g_t^2 \\\\ \\hat m_t &= \\frac{m_t}{1-\\beta_1^t},\\quad \\hat v_t = \\frac{v_t}{1-\\beta_2^t} \\\\ \\theta_t &= \\theta_{t-1} - \\eta\\, \\frac{\\hat m_t}{\\sqrt{\\hat v_t}+\\epsilon} \\end{aligned}',
    step(s, h, grad) {
      adamStep(s, h, grad, 0);
    },
  },
  {
    id: 'adamw',
    name: 'AdamW',
    colorVar: '--c8',
    shape: 'star',
    params: [LR, B1, B2, EPS, WD],
    defaults: { b1: 0.9, b2: 0.999, eps: 1e-8, wd: 0.01 },
    paper: 'Loshchilov & Hutter, 2019',
    summary: 'Adam with decoupled weight decay: θ shrinks toward 0 directly instead of adding λθ to the gradient, so decay is not rescaled by √v̂. It pulls the end point slightly toward the origin.',
    tex: '\\begin{aligned} m_t, v_t, \\hat m_t, \\hat v_t &\\ \\text{as in Adam} \\\\ \\theta_t &= \\theta_{t-1} - \\eta \\left( \\frac{\\hat m_t}{\\sqrt{\\hat v_t}+\\epsilon} + \\lambda\\, \\theta_{t-1} \\right) \\end{aligned}',
    step(s, h, grad) {
      adamStep(s, h, grad, h.wd ?? 0.01);
    },
  },
  {
    id: 'lion',
    name: 'Lion',
    colorVar: '--c7',
    shape: 'cross',
    params: [LR, B1, B2, WD],
    defaults: { b1: 0.9, b2: 0.99, wd: 0 },
    paper: 'Chen et al., 2023 (Symbolic Discovery of Optimization Algorithms)',
    summary: 'Uses only the sign of an interpolated momentum, so every coordinate moves exactly ±η per step. Typically needs a 3–10× smaller η than Adam.',
    tex: '\\begin{aligned} c_t &= \\beta_1 m_{t-1} + (1-\\beta_1)\\, g_t \\\\ \\theta_t &= \\theta_{t-1} - \\eta \\left( \\operatorname{sign}(c_t) + \\lambda\\, \\theta_{t-1} \\right) \\\\ m_t &= \\beta_2 m_{t-1} + (1-\\beta_2)\\, g_t \\end{aligned}',
    step(s, h, grad) {
      const b1 = h.b1 ?? 0.9;
      const b2 = h.b2 ?? 0.99;
      const wd = h.wd ?? 0;
      const [gx, gy] = grad(s.x, s.y);
      s.t++;
      const cx = b1 * s.m[0] + (1 - b1) * gx;
      const cy = b1 * s.m[1] + (1 - b1) * gy;
      const x0 = s.x;
      const y0 = s.y;
      s.x = x0 - h.lr * (sign(cx) + wd * x0);
      s.y = y0 - h.lr * (sign(cy) + wd * y0);
      s.m[0] = b2 * s.m[0] + (1 - b2) * gx;
      s.m[1] = b2 * s.m[1] + (1 - b2) * gy;
    },
  },
];

function adamStep(s: OptState, h: Hyper, grad: GradFn, wd: number) {
  const b1 = h.b1 ?? 0.9;
  const b2 = h.b2 ?? 0.999;
  const eps = h.eps ?? 1e-8;
  const [gx, gy] = grad(s.x, s.y);
  s.t++;
  s.m[0] = b1 * s.m[0] + (1 - b1) * gx;
  s.m[1] = b1 * s.m[1] + (1 - b1) * gy;
  s.v[0] = b2 * s.v[0] + (1 - b2) * gx * gx;
  s.v[1] = b2 * s.v[1] + (1 - b2) * gy * gy;
  const bc1 = 1 - Math.pow(b1, s.t);
  const bc2 = 1 - Math.pow(b2, s.t);
  const x0 = s.x;
  const y0 = s.y;
  s.x = x0 - h.lr * ((s.m[0] / bc1) / (Math.sqrt(s.v[0] / bc2) + eps) + wd * x0);
  s.y = y0 - h.lr * ((s.m[1] / bc1) / (Math.sqrt(s.v[1] / bc2) + eps) + wd * y0);
}

export const OPTIMIZER_BY_ID = Object.fromEntries(OPTIMIZERS.map((o) => [o.id, o])) as Record<OptimizerId, OptimizerDef>;
export const OPTIMIZER_IDS = OPTIMIZERS.map((o) => o.id);

export function createState(x: number, y: number): OptState {
  return { x, y, t: 0, m: [0, 0], v: [0, 0] };
}

/** One optimizer update in place. Pure apart from mutating `s`. */
export function stepOptimizer(id: OptimizerId, s: OptState, h: Hyper, grad: GradFn) {
  OPTIMIZER_BY_ID[id].step(s, h, grad);
}

export function defaultHyper(id: OptimizerId, landscape: Landscape): Hyper {
  return { lr: landscape.lr[id], ...OPTIMIZER_BY_ID[id].defaults };
}

/* ==========================================================================
   Noise and gradient pipeline
   ========================================================================== */

/** Small seeded PRNG (mulberry32) with a Box–Muller normal sampler. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  let spare: number | null = null;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = uniform();
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(PI2 * v);
    return r * Math.cos(PI2 * v);
  };
  return { uniform, normal };
}

export interface GradOptions {
  /** Global noise level, relative to the landscape's noiseScale. */
  noise: number;
  /** Clip the gradient's L2 norm to this value; 0 disables clipping. */
  clip: number;
}

/** Build the gradient oracle an optimizer sees: true gradient + noise, then norm clipping. */
export function makeGradFn(l: Landscape, opts: GradOptions, rng: ReturnType<typeof makeRng>): GradFn {
  const sigma = Math.hypot(l.intrinsicNoise, opts.noise * l.noiseScale);
  return (x, y) => {
    let [gx, gy] = l.grad(x, y);
    if (sigma > 0) {
      gx += sigma * rng.normal();
      gy += sigma * rng.normal();
    }
    if (opts.clip > 0) {
      const n = Math.hypot(gx, gy);
      if (n > opts.clip) {
        gx *= opts.clip / n;
        gy *= opts.clip / n;
      }
    }
    return [gx, gy];
  };
}

/* ==========================================================================
   Race runner
   ========================================================================== */

export type Status = 'ready' | 'running' | 'converged' | 'local-min' | 'saddle' | 'stationary' | 'diverged' | 'escaped' | 'max-steps';

export const STATUS_LABEL: Record<Status, string> = {
  ready: 'ready',
  running: 'running',
  converged: 'converged',
  'local-min': 'local min',
  saddle: 'at saddle',
  stationary: 'stationary',
  diverged: 'diverged',
  escaped: 'escaped ↓',
  'max-steps': 'max steps',
};

export function isFinished(s: Status) {
  return s !== 'ready' && s !== 'running';
}

export interface Runner {
  id: OptimizerId;
  hyper: Hyper;
  state: OptState;
  grad: GradFn;
  status: Status;
  xs: number[];
  ys: number[];
  losses: number[];
  /** Step at which the status was decided. */
  doneAt: number;
}

export interface RaceConfig {
  landscape: Landscape;
  start: Vec2;
  optimizers: { id: OptimizerId; hyper: Hyper }[];
  noise: number;
  clip: number;
  maxSteps: number;
  /** Converged once the true gradient norm drops below this. */
  tol: number;
  seed: number;
}

/** Classify a stationary point with a finite-difference Hessian of the analytic gradient. */
export function classifyStationary(l: Landscape, x: number, y: number): 'converged' | 'local-min' | 'saddle' | 'stationary' {
  const span = Math.max(l.view.xmax - l.view.xmin, l.view.ymax - l.view.ymin);
  for (const m of l.markers) {
    if (m.kind === 'global' && Math.hypot(x - m.x, y - m.y) < span * 0.02) return 'converged';
  }
  if (l.fmin !== null && Math.abs(l.f(x, y) - l.fmin) < 1e-4) return 'converged';
  const h = 1e-5;
  const [gxp, gyp] = l.grad(x + h, y);
  const [gxm, gym] = l.grad(x - h, y);
  const [gxu, gyu] = l.grad(x, y + h);
  const [gxd, gyd] = l.grad(x, y - h);
  const hxx = (gxp - gxm) / (2 * h);
  const hyy = (gyu - gyd) / (2 * h);
  const hxy = (gyp - gym + (gxu - gxd)) / (4 * h);
  const det = hxx * hyy - hxy * hxy;
  const tr = hxx + hyy;
  if (det > 1e-9 && tr > 0) return 'local-min';
  if (det < -1e-9) return 'saddle';
  return 'stationary';
}

export class Race {
  cfg: RaceConfig;
  runners: Runner[] = [];
  step = 0;
  bounds = { xmin: 0, xmax: 0, ymin: 0, ymax: 0 };
  f0 = 0;

  constructor(cfg: RaceConfig) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    const { landscape: l, start, optimizers, noise, clip, seed } = this.cfg;
    const w = l.view.xmax - l.view.xmin;
    const h = l.view.ymax - l.view.ymin;
    const pad = 1.5 * Math.max(w, h);
    this.bounds = { xmin: l.view.xmin - pad, xmax: l.view.xmax + pad, ymin: l.view.ymin - pad, ymax: l.view.ymax + pad };
    this.step = 0;
    this.f0 = l.f(start[0], start[1]);
    this.runners = optimizers.map(({ id, hyper }) => {
      // Every optimizer gets an identical noise stream, so the comparison is fair and reproducible.
      const rng = makeRng(seed);
      return {
        id,
        hyper: { ...hyper },
        state: createState(start[0], start[1]),
        grad: makeGradFn(l, { noise, clip }, rng),
        status: 'ready' as Status,
        xs: [start[0]],
        ys: [start[1]],
        losses: [this.f0],
        doneAt: 0,
      };
    });
    // Starting exactly on a stationary point.
    for (const r of this.runners) this.checkConverged(r);
  }

  get finished() {
    return this.runners.every((r) => isFinished(r.status));
  }

  private checkConverged(r: Runner) {
    const l = this.cfg.landscape;
    const [gx, gy] = l.grad(r.state.x, r.state.y);
    if (Math.hypot(gx, gy) < this.cfg.tol && l.intrinsicNoise === 0 && this.cfg.noise === 0) {
      r.status = classifyStationary(l, r.state.x, r.state.y);
      r.doneAt = r.state.t;
      return true;
    }
    return false;
  }

  /** Advance every active runner by `n` steps. Returns the number of steps taken. */
  advance(n = 1) {
    const l = this.cfg.landscape;
    const b = this.bounds;
    let taken = 0;
    for (let k = 0; k < n; k++) {
      if (this.step >= this.cfg.maxSteps || this.finished) break;
      this.step++;
      taken++;
      for (const r of this.runners) {
        if (isFinished(r.status)) continue;
        r.status = 'running';
        stepOptimizer(r.id, r.state, r.hyper, r.grad);
        const { x, y } = r.state;
        const f = l.f(x, y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(f)) {
          r.status = 'diverged';
          r.doneAt = r.state.t;
          continue;
        }
        r.xs.push(x);
        r.ys.push(y);
        r.losses.push(f);
        if (x < b.xmin || x > b.xmax || y < b.ymin || y > b.ymax) {
          r.status = 'diverged';
          r.doneAt = r.state.t;
          continue;
        }
        // Unbounded-below landscapes: leaving the window downhill counts as escaping.
        if (l.fmin === null && f < this.f0 && (x < l.view.xmin || x > l.view.xmax || y < l.view.ymin || y > l.view.ymax)) {
          r.status = 'escaped';
          r.doneAt = r.state.t;
          continue;
        }
        if (this.checkConverged(r)) continue;
        if (this.step >= this.cfg.maxSteps) {
          r.status = 'max-steps';
          r.doneAt = r.state.t;
        }
      }
    }
    return taken;
  }
}

/* ==========================================================================
   Helpers shared by the UI
   ========================================================================== */

/** Expand a view window to the given aspect (width / height) around its centre. */
export function fitView(v: Landscape['view'], aspect: number) {
  const cx = (v.xmin + v.xmax) / 2;
  const cy = (v.ymin + v.ymax) / 2;
  let w = v.xmax - v.xmin;
  let h = v.ymax - v.ymin;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  return { xmin: cx - w / 2, xmax: cx + w / 2, ymin: cy - h / 2, ymax: cy + h / 2 };
}

/* ==========================================================================
   Presets
   ========================================================================== */

export interface Preset {
  id: string;
  name: string;
  description: string;
  landscape: LandscapeId;
  start: Vec2;
  /** Enabled optimizers and their hyperparameter overrides (on top of the landscape defaults). */
  optimizers: Partial<Record<OptimizerId, Partial<Hyper>>>;
  noise: number;
  clip: number;
  maxSteps: number;
}

export const PRESETS: Preset[] = [
  {
    id: 'momentum',
    name: 'Why momentum helps',
    description:
      'Same learning rate (η = 0.1) for all three. SGD crawls along the shallow x-direction of the elongated bowl, while momentum accumulates speed there and its y-oscillations cancel out. Nesterov’s look-ahead brakes earlier and overshoots less.',
    landscape: 'bowl',
    start: [-7.5, 2.5],
    optimizers: { sgd: { lr: 0.1 }, momentum: { lr: 0.1, mu: 0.9 }, nesterov: { lr: 0.1, mu: 0.9 } },
    noise: 0,
    clip: 0,
    maxSteps: 400,
  },
  {
    id: 'saddle',
    name: 'Saddle point escape',
    description:
      'Start a hair above the ridge of x² − y². With η = 0.01 everywhere, SGD slides into the saddle and lingers, because the escape gradient is tiny. Adam and RMSProp normalise it to a step of ≈ η and leave long before; momentum accelerates its way out.',
    landscape: 'saddle',
    start: [-1.8, 0.001],
    optimizers: { sgd: { lr: 0.01 }, momentum: { lr: 0.01, mu: 0.9 }, rmsprop: { lr: 0.01 }, adam: { lr: 0.01 } },
    noise: 0,
    clip: 0,
    maxSteps: 600,
  },
  {
    id: 'lr-high',
    name: 'Learning rate too high',
    description:
      'On a quadratic, SGD is stable only while η·L < 2 (here L = 2, so η < 1), and heavy-ball momentum while η·L < 2(1 + μ). Push past it and the iterates grow geometrically: diverged. Adam and Lion take steps of at most ≈ η, so the same over-large η makes them bounce but not explode.',
    landscape: 'bowl',
    start: [-7.3, 2.7],
    optimizers: { sgd: { lr: 1.05 }, momentum: { lr: 2, mu: 0.9 }, adam: { lr: 1 }, lion: { lr: 0.3 } },
    noise: 0,
    clip: 0,
    maxSteps: 400,
  },
];
