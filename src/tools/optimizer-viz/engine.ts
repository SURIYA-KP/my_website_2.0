// Optimizer Race: pure simulation core (no DOM). Landscapes, optimizers, the race runner,
// presets and the share-hash codec. Dependency-free so the UI, browser tests (window.__optviz)
// and Node scripts can all import it.

export type Vec2 = [number, number];
export type GradFn = (x: number, y: number) => Vec2;

/* ==========================================================================
   Landscapes
   ========================================================================== */

export type LandscapeId = 'bowl' | 'rosenbrock' | 'beale' | 'himmelblau' | 'saddle' | 'rastrigin' | 'camel' | 'noisy';
export type OptimizerId = 'sgd' | 'momentum' | 'nesterov' | 'adagrad' | 'rmsprop' | 'adam' | 'adamw' | 'lion';

export interface Marker {
  x: number;
  y: number;
  kind: 'global' | 'local' | 'saddle' | 'max';
}

export interface Tip {
  text: string;
  /** Optimizers this tip is about (shown first when one of them is selected). */
  ids?: OptimizerId[];
}

export interface View {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

export interface Landscape {
  id: LandscapeId;
  name: string;
  /** TeX source of the formula. */
  tex: string;
  f: (x: number, y: number) => number;
  grad: GradFn;
  /** Region that must be visible; the canvas expands it to its own aspect. */
  view: View;
  start: Vec2;
  markers: Marker[];
  /** Known global minimum value. */
  fmin: number;
  /** Typical gradient magnitude: scales the global noise slider and the convergence tests. */
  gscale: number;
  /** Standard deviation of the landscape's own gradient noise (stochastic objectives). */
  intrinsicNoise: number;
  /** Tuned default learning rates. */
  lr: Record<OptimizerId, number>;
  maxSteps: number;
  /** Default animation speed (optimizer steps per frame). */
  speed: number;
  blurb: string;
  tips: Tip[];
}

const PI2 = Math.PI * 2;
export const DEFAULT_KAPPA = 20;

/** Ill-conditioned quadratic f = x²/κ + y², Hessian diag(2/κ, 2), condition number κ. */
export function makeBowl(kappa = DEFAULT_KAPPA): Landscape {
  const k = Math.min(1000, Math.max(1, kappa));
  const a = 1 / k;
  return {
    id: 'bowl',
    name: 'Elongated bowl',
    tex: `f(x,y)=\\tfrac{1}{${+k.toFixed(2)}}\\,x^2+y^2\\qquad \\kappa=${+k.toFixed(2)}`,
    f: (x, y) => a * x * x + y * y,
    grad: (x, y) => [2 * a * x, 2 * y],
    view: { xmin: -8.5, xmax: 8.5, ymin: -4, ymax: 4 },
    start: [-7.5, 2.5],
    markers: [{ x: 0, y: 0, kind: 'global' }],
    fmin: 0,
    gscale: 1,
    intrinsicNoise: 0,
    lr: { sgd: 0.4, momentum: 0.1, nesterov: 0.1, adagrad: 1.5, rmsprop: 0.05, adam: 0.25, adamw: 0.25, lion: 0.04 },
    maxSteps: 800,
    speed: 2,
    blurb: `A convex quadratic whose curvature differs ${+k.toFixed(1)}× between the axes (condition number κ = ${+k.toFixed(1)}). Drag the κ slider to make it more or less elongated.`,
    tips: [
      { text: 'Gradient descent must keep η below 2/L = 1 for the steep y-axis, so along the shallow x-axis it only shrinks the error by (1 − 2η/κ) per step: it crawls.', ids: ['sgd'] },
      { text: 'Momentum and Nesterov build up speed along the flat x-direction while the y-oscillations cancel. Their rate depends on √κ instead of κ.', ids: ['momentum', 'nesterov'] },
      { text: 'Adam, RMSProp and AdaGrad rescale each coordinate by its own gradient history, so the bowl looks round to them: their paths head diagonally at first, then straight for the minimum.', ids: ['adam', 'adamw', 'rmsprop', 'adagrad'] },
      { text: 'Lion moves every coordinate by exactly ±η, so it travels at 45° and then rattles around the minimum with an amplitude of about η.', ids: ['lion'] },
      { text: 'Raise κ to 100: SGD runs out of steps while momentum still finishes. Set κ = 1 and every method looks good.' },
    ],
  };
}

export const LANDSCAPES: Landscape[] = [
  makeBowl(),
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
    gscale: 20,
    intrinsicNoise: 0,
    lr: { sgd: 0.0015, momentum: 0.0007, nesterov: 0.0007, adagrad: 0.5, rmsprop: 0.01, adam: 0.05, adamw: 0.05, lion: 0.002 },
    maxSteps: 4000,
    speed: 10,
    blurb: 'A curved, flat-bottomed banana valley. Finding the valley is easy; following its floor to (1, 1) is hard.',
    tips: [
      { text: 'Everyone drops into the valley within a few steps; the race is about travelling along its curved floor.' },
      { text: 'SGD needs a tiny learning rate to survive the steep walls (curvature up to ~2000), so it crawls along the floor. Just past η ≈ 0.002 it diverges on the wall.', ids: ['sgd'] },
      { text: 'Momentum bounces between the walls, but the velocity it carries around the bend more than makes up for it.', ids: ['momentum', 'nesterov'] },
      { text: 'Adaptive methods normalise the badly scaled walls away. Adam’s step stays ≈ η, so it can zig-zag a little near the end.', ids: ['adam', 'adamw', 'rmsprop'] },
      { text: 'AdaGrad’s accumulated denominator keeps growing on the steep walls, so it slows down as it follows the valley.', ids: ['adagrad'] },
      { text: 'Lion’s fixed-size sign steps keep it moving on the flat floor, but it ends in a small jitter of size ≈ η around (1, 1).', ids: ['lion'] },
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
      return [2 * t1 * (y - 1) + 2 * t2 * (y2 - 1) + 2 * t3 * (y3 - 1), 2 * t1 * x + 4 * t2 * x * y + 6 * t3 * x * y2];
    },
    view: { xmin: -4.5, xmax: 4.5, ymin: -4.5, ymax: 4.5 },
    start: [1, 1.6],
    markers: [{ x: 3, y: 0.5, kind: 'global' }],
    fmin: 0,
    gscale: 5,
    intrinsicNoise: 0,
    lr: { sgd: 0.01, momentum: 0.002, nesterov: 0.002, adagrad: 1, rmsprop: 0.01, adam: 0.08, adamw: 0.08, lion: 0.01 },
    maxSteps: 1500,
    speed: 5,
    blurb: 'Sharp ridges and flat plateaus with a single minimum at (3, 0.5), at the end of a narrow curved channel.',
    tips: [
      { text: 'Gradients range over orders of magnitude: steep near the top edge, nearly flat in the channel.' },
      { text: 'SGD and momentum take tiny steps on the plateau because the gradient there is small.', ids: ['sgd', 'momentum', 'nesterov'] },
      { text: 'Adaptive methods normalise the step size and cross the plateau quickly.', ids: ['adam', 'adamw', 'rmsprop', 'adagrad'] },
      { text: 'Raise momentum’s learning rate: it gets catapulted off the ridge. Turn on gradient clipping to tame it.', ids: ['momentum'] },
      { text: 'Lion ignores gradient magnitudes entirely, so the plateau does not slow it down at all.', ids: ['lion'] },
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
    start: [-0.3, -0.6],
    markers: [
      { x: 3, y: 2, kind: 'global' },
      { x: -2.805118, y: 3.131312, kind: 'global' },
      { x: -3.77931, y: -3.283186, kind: 'global' },
      { x: 3.584428, y: -1.848126, kind: 'global' },
      { x: -0.270845, y: -0.923039, kind: 'max' },
    ],
    fmin: 0,
    gscale: 10,
    intrinsicNoise: 0,
    lr: { sgd: 0.01, momentum: 0.002, nesterov: 0.002, adagrad: 1, rmsprop: 0.02, adam: 0.08, adamw: 0.08, lion: 0.02 },
    maxSteps: 800,
    speed: 2,
    blurb: 'Four equally good minima around a local maximum near (−0.27, −0.92). Where you start, and how you move, decides where you end.',
    tips: [
      { text: 'Click near the central bump (the hollow marker) and watch the optimizers pick different basins.' },
      { text: 'Sign-based and normalised updates take a different route than the raw gradient from the same start.', ids: ['lion', 'adam', 'adamw', 'rmsprop', 'adagrad'] },
      { text: 'Momentum can carry an optimizer over a ridge into a basin that plain SGD would never reach.', ids: ['momentum', 'nesterov', 'sgd'] },
    ],
  },
  {
    id: 'saddle',
    name: 'Saddle',
    tex: 'f(x,y)=x^2-y^2+\\tfrac12\\,y^4',
    f: (x, y) => x * x - y * y + 0.5 * y * y * y * y,
    grad: (x, y) => [2 * x, -2 * y + 2 * y * y * y],
    view: { xmin: -2, xmax: 2, ymin: -1.8, ymax: 1.8 },
    start: [-1.8, 0.001],
    markers: [
      { x: 0, y: 0, kind: 'saddle' },
      { x: 0, y: 1, kind: 'global' },
      { x: 0, y: -1, kind: 'global' },
    ],
    fmin: -0.5,
    gscale: 1,
    intrinsicNoise: 0,
    lr: { sgd: 0.01, momentum: 0.01, nesterov: 0.01, adagrad: 0.1, rmsprop: 0.01, adam: 0.01, adamw: 0.01, lion: 0.01 },
    maxSteps: 1200,
    speed: 3,
    blurb: 'A saddle point at the origin (a minimum along x, a maximum along y) with two valleys at (0, ±1) to escape into.',
    tips: [
      { text: 'Starting almost on the x-axis, the escape direction (y) has a gradient close to zero.' },
      { text: 'SGD slides into the saddle and lingers: the tiny y-offset only grows by a factor (1 + 2η) per step.', ids: ['sgd'] },
      { text: 'Adam and RMSProp divide by the gradient’s RMS, which blows the tiny y-gradient up to a full-size step: they escape quickly.', ids: ['adam', 'adamw', 'rmsprop', 'adagrad'] },
      { text: 'Momentum accumulates the small escape gradient and accelerates out, but more slowly than the adaptive methods.', ids: ['momentum', 'nesterov'] },
      { text: 'Lion uses only the sign, so the y-gradient of 10⁻³ moves it as fast as any other: it heads straight down the diagonal.', ids: ['lion'] },
      { text: 'Add a little gradient noise: it kicks every optimizer off the ridge. That is one reason SGD noise helps in deep learning.' },
      { text: 'Start exactly at y = 0 and the gradient never points away: plain SGD converges to the saddle and stops.' },
    ],
  },
  {
    id: 'rastrigin',
    name: 'Rastrigin',
    tex: 'f=20+\\textstyle\\sum_{u\\in\\{x,y\\}}\\left(u^2-10\\cos 2\\pi u\\right)',
    f: (x, y) => 20 + x * x - 10 * Math.cos(PI2 * x) + y * y - 10 * Math.cos(PI2 * y),
    grad: (x, y) => [2 * x + 10 * PI2 * Math.sin(PI2 * x), 2 * y + 10 * PI2 * Math.sin(PI2 * y)],
    view: { xmin: -5.12, xmax: 5.12, ymin: -5.12, ymax: 5.12 },
    start: [4.45, 4.4],
    markers: [{ x: 0, y: 0, kind: 'global' }],
    fmin: 0,
    gscale: 20,
    intrinsicNoise: 0,
    lr: { sgd: 0.002, momentum: 0.002, nesterov: 0.002, adagrad: 0.5, rmsprop: 0.01, adam: 0.05, adamw: 0.05, lion: 0.02 },
    maxSteps: 800,
    speed: 2,
    blurb: 'A bowl covered in an egg-crate of local minima. A gradient only sees the nearest dimple.',
    tips: [
      { text: 'Most optimizers fall into the closest local minimum and stay there: local information cannot see the global picture.' },
      { text: 'SGD with a small η is the most “honest” local method: it rolls into the very first dimple.', ids: ['sgd'] },
      { text: 'Heavy momentum or a larger η can hop over a few bumps before settling.', ids: ['momentum', 'nesterov'] },
      { text: 'Adam’s normalised steps of ≈ η let it skate across bumps whose gradient flips sign every half period.', ids: ['adam', 'adamw', 'rmsprop'] },
      { text: 'Turn up gradient noise for a crude form of annealing: noise lets optimizers jump between dimples.' },
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
      { x: 0.0898420, y: -0.7126564, kind: 'global' },
      { x: -0.0898420, y: 0.7126564, kind: 'global' },
      { x: -1.7036071, y: 0.7960836, kind: 'local' },
      { x: 1.7036071, y: -0.7960836, kind: 'local' },
      { x: -1.6071046, y: -0.5686514, kind: 'local' },
      { x: 1.6071046, y: 0.5686514, kind: 'local' },
    ],
    fmin: -1.031628453,
    gscale: 3,
    intrinsicNoise: 0,
    lr: { sgd: 0.01, momentum: 0.004, nesterov: 0.004, adagrad: 0.3, rmsprop: 0.01, adam: 0.03, adamw: 0.03, lion: 0.008 },
    maxSteps: 800,
    speed: 2,
    blurb: 'Six minima: two global ones near (±0.09, ∓0.71) and four local “humps” on the flanks.',
    tips: [
      { text: 'From the left flank, cautious optimizers settle in the nearest local minimum (f ≈ −0.22).', ids: ['sgd', 'adagrad'] },
      { text: 'Momentum-based methods can roll through a shallow local basin into a global one.', ids: ['momentum', 'nesterov', 'adam', 'adamw'] },
      { text: 'Watch the status column: “local min” means the gradient vanished somewhere other than a global minimum.' },
    ],
  },
  {
    id: 'noisy',
    name: 'Noisy bowl',
    tex: 'f=\\tfrac12 x^2+\\tfrac32 y^2,\\quad \\tilde g=\\nabla f+\\xi,\\ \\xi\\sim\\mathcal N(0,\\sigma^2 I)',
    f: (x, y) => 0.5 * x * x + 1.5 * y * y,
    grad: (x, y) => [x, 3 * y],
    view: { xmin: -3, xmax: 3, ymin: -2, ymax: 2 },
    start: [-2.6, 1.6],
    markers: [{ x: 0, y: 0, kind: 'global' }],
    fmin: 0,
    gscale: 1,
    intrinsicNoise: 1.5,
    lr: { sgd: 0.05, momentum: 0.01, nesterov: 0.01, adagrad: 0.5, rmsprop: 0.02, adam: 0.05, adamw: 0.05, lion: 0.01 },
    maxSteps: 600,
    speed: 1,
    blurb: 'A simple bowl, but every gradient is corrupted by Gaussian noise (σ = 1.5), like a minibatch gradient.',
    tips: [
      { text: 'No optimizer settles exactly: each ends up jittering inside a “noise ball” whose size scales with the learning rate.' },
      { text: 'Momentum averages gradients over ≈ 1/(1 − μ) steps, which smooths the path.', ids: ['momentum', 'nesterov'] },
      { text: 'Adam’s step is ≈ η·m̂/√v̂: near the minimum the noise dominates v̂, so its steps stay roughly η in size.', ids: ['adam', 'adamw', 'rmsprop'] },
      { text: 'AdaGrad’s ever-growing denominator acts like a learning-rate decay, so it ends up the calmest here.', ids: ['adagrad'] },
      { text: 'SGD’s noise ball has radius ∝ √η: halve the learning rate and watch it shrink (and the descent slow down).', ids: ['sgd'] },
      { text: 'Lion’s sign of a noisy momentum is still ±η per step, so it jitters with amplitude η no matter how small the noise is.', ids: ['lion'] },
    ],
  },
];

export const LANDSCAPE_IDS = LANDSCAPES.map((l) => l.id);

/** Look up a landscape; the bowl is rebuilt for the requested condition number. */
export function getLandscape(id: LandscapeId, kappa = DEFAULT_KAPPA): Landscape {
  if (id === 'bowl') return makeBowl(kappa);
  return LANDSCAPES.find((l) => l.id === id) ?? LANDSCAPES[0];
}

/* ==========================================================================
   Optimizers
   ========================================================================== */

export type HyperKey = 'lr' | 'mu' | 'rho' | 'b1' | 'b2' | 'eps' | 'wd';
export type Hyper = Partial<Record<HyperKey, number>> & { lr: number };

export interface ParamSpec {
  key: HyperKey;
  label: string;
  /** Plain-text symbol for compact labels. */
  sym: string;
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

const LR: ParamSpec = { key: 'lr', label: 'Learning rate', sym: 'η', min: 1e-5, max: 10, log: true };
const MU: ParamSpec = { key: 'mu', label: 'Momentum', sym: 'μ', min: 0, max: 0.999 };
const RHO: ParamSpec = { key: 'rho', label: 'Decay', sym: 'ρ', min: 0, max: 0.9999 };
const B1: ParamSpec = { key: 'b1', label: 'Beta 1', sym: 'β₁', min: 0, max: 0.999 };
const B2: ParamSpec = { key: 'b2', label: 'Beta 2', sym: 'β₂', min: 0, max: 0.99999 };
const EPS: ParamSpec = { key: 'eps', label: 'Epsilon', sym: 'ε', min: 1e-12, max: 1, log: true };
const WD: ParamSpec = { key: 'wd', label: 'Weight decay', sym: 'λ', min: 0, max: 0.5 };

const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Adam / AdamW (Kingma & Ba 2015, Alg. 1; Loshchilov & Hutter 2019, Alg. 2 with η_t = 1, α = lr). */
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
  // Decoupled weight decay: λθ is added to the update, never to the gradient (so it skips m and v).
  s.x = x0 - h.lr * (s.m[0] / bc1 / (Math.sqrt(s.v[0] / bc2) + eps) + wd * x0);
  s.y = y0 - h.lr * (s.m[1] / bc1 / (Math.sqrt(s.v[1] / bc2) + eps) + wd * y0);
}

export const OPTIMIZERS: OptimizerDef[] = [
  {
    id: 'sgd',
    name: 'SGD',
    colorVar: '--c3',
    shape: 'circle',
    params: [LR],
    defaults: {},
    paper: 'Robbins & Monro, 1951',
    summary: 'Step straight down the (possibly noisy) gradient. On a quadratic the learning rate must stay below 2/L, where L is the steepest curvature, and progress along the flattest direction is then slow.',
    tex: '\\theta_{t} = \\theta_{t-1} - \\eta\\, g_t,\\qquad g_t=\\nabla f(\\theta_{t-1})',
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
    summary: 'Accumulate a velocity: consistent gradient directions add up, oscillating ones cancel. In a long straight valley the effective step grows to ≈ η/(1 − μ).',
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
    summary: 'Momentum that evaluates the gradient at the look-ahead point θ + μv, so it starts braking before it overshoots.',
    tex: '\\begin{aligned} v_t &= \\mu\\, v_{t-1} - \\eta\\, \\nabla f(\\theta_{t-1} + \\mu\\, v_{t-1}) \\\\ \\theta_t &= \\theta_{t-1} + v_t \\end{aligned}',
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
    summary: 'Per-coordinate step sizes from the running sum of all past squared gradients. The denominator only grows, so the steps shrink over time: a built-in learning-rate decay.',
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
    paper: 'Tieleman & Hinton, 2012 (lecture 6e)',
    summary: 'AdaGrad with a leaky (exponential moving) average of squared gradients, so the step size can recover after a steep stretch.',
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
    summary: 'Momentum on the gradient plus RMSProp-style scaling, both bias-corrected for their zero initialisation. Each coordinate moves by roughly η per step, whatever the gradient’s scale; the very first step is exactly η·sign(g).',
    tex: '\\begin{aligned} m_t &= \\beta_1 m_{t-1} + (1-\\beta_1)\\, g_t \\\\ v_t &= \\beta_2 v_{t-1} + (1-\\beta_2)\\, g_t^2 \\\\ \\hat m_t &= \\frac{m_t}{1-\\beta_1^{\\,t}},\\quad \\hat v_t = \\frac{v_t}{1-\\beta_2^{\\,t}} \\\\ \\theta_t &= \\theta_{t-1} - \\eta\\, \\frac{\\hat m_t}{\\sqrt{\\hat v_t}+\\epsilon} \\end{aligned}',
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
    summary: 'Adam with decoupled weight decay: θ shrinks toward 0 directly instead of adding λθ to the gradient, so the decay is not rescaled by √v̂. Away from the origin it pulls the end point slightly toward (0, 0).',
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
    paper: 'Chen et al., 2023',
    summary: 'Discovered by program search. It takes the sign of an interpolation between the momentum and the fresh gradient (β₁), and tracks the momentum with a slower β₂. Every coordinate moves exactly ±η, so it needs a 3–10× smaller η than Adam.',
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
  /** Global noise level, relative to the landscape's gscale. */
  noise: number;
  /** Clip the gradient's L2 norm to this value; 0 disables clipping. */
  clip: number;
}

export function noiseSigma(l: Landscape, noise: number) {
  return Math.hypot(l.intrinsicNoise, noise * l.gscale);
}

/** The gradient oracle an optimizer sees: true gradient + Gaussian noise, then L2-norm clipping. */
export function makeGradFn(l: Landscape, opts: GradOptions, rng: ReturnType<typeof makeRng>): GradFn {
  const sigma = noiseSigma(l, opts.noise);
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

export type Status = 'ready' | 'running' | 'converged' | 'local-min' | 'saddle' | 'stationary' | 'diverged' | 'max-steps';

export const STATUS_LABEL: Record<Status, string> = {
  ready: 'ready',
  running: 'running',
  converged: 'converged',
  'local-min': 'local min',
  saddle: 'stuck at saddle',
  stationary: 'stalled',
  diverged: 'diverged',
  'max-steps': 'out of steps',
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
  /** Where the race ended for this runner (the window centroid for oscillating finishers). */
  end: Vec2 | null;
  /** How it stopped: tolerance test on |∇f| and |Δθ|, or a settled oscillation. */
  how: 'tol' | 'settled' | null;
}

export interface RaceConfig {
  landscape: Landscape;
  start: Vec2;
  optimizers: { id: OptimizerId; hyper: Hyper }[];
  noise: number;
  clip: number;
  maxSteps: number;
  seed: number;
}

/** Convergence thresholds, scaled to the landscape. */
export function tolerances(l: Landscape) {
  const span = Math.max(l.view.xmax - l.view.xmin, l.view.ymax - l.view.ymin);
  return {
    span,
    /** |∇f| below this … */
    grad: 1e-3 * l.gscale,
    /** … and |Δθ| below this counts as converged. */
    step: 1e-5 * span,
    /** Settled oscillation: the last `window` iterates fit in a box this small … */
    window: 40,
    box: 0.012 * span,
    /** … around a centroid whose gradient is below this. */
    centroidGrad: 0.01 * l.gscale,
    /** A window that fits in this box has stopped moving, whatever the gradient says. */
    frozen: 2e-4 * span,
    /** A settled run must sit this close to a stationary point. */
    near: 0.02 * span,
    /** Leaving the view by this much (in each direction) counts as diverged. */
    pad: 1.5 * span,
  };
}

function hessian(l: Landscape, x: number, y: number) {
  const h = 1e-5 * Math.max(1, Math.hypot(x, y));
  const [gxp, gyp] = l.grad(x + h, y);
  const [gxm, gym] = l.grad(x - h, y);
  const [gxu, gyu] = l.grad(x, y + h);
  const [gxd, gyd] = l.grad(x, y - h);
  return { hxx: (gxp - gxm) / (2 * h), hyy: (gyu - gyd) / (2 * h), hxy: (gyp - gym + (gxu - gxd)) / (4 * h) };
}

/**
 * Newton-polish a point to the stationary point it is sitting next to (an oscillating or
 * weight-decayed optimizer stops near one, not on it). Returns null if Newton does not converge close by.
 */
export function polishStationary(l: Landscape, x: number, y: number, maxDist: number): Vec2 | null {
  let px = x, py = y;
  for (let i = 0; i < 30; i++) {
    const [gx, gy] = l.grad(px, py);
    if (Math.hypot(gx, gy) < 1e-9 * l.gscale) return Math.hypot(px - x, py - y) <= maxDist ? [px, py] : null;
    const { hxx, hyy, hxy } = hessian(l, px, py);
    const det = hxx * hyy - hxy * hxy;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
    px -= (hyy * gx - hxy * gy) / det;
    py -= (hxx * gy - hxy * gx) / det;
    if (!Number.isFinite(px) || !Number.isFinite(py) || Math.hypot(px - x, py - y) > maxDist) return null;
  }
  return null;
}

/** Classify where a run stopped: a global minimum, a local minimum, a saddle, or a flat spot. */
export function classifyPoint(l: Landscape, x: number, y: number): 'converged' | 'local-min' | 'saddle' | 'stationary' {
  const span = Math.max(l.view.xmax - l.view.xmin, l.view.ymax - l.view.ymin);
  const p = polishStationary(l, x, y, 0.08 * span) ?? [x, y];
  for (const m of l.markers) {
    if (m.kind === 'global' && Math.hypot(p[0] - m.x, p[1] - m.y) < span * 0.01) return 'converged';
  }
  if (Math.abs(l.f(p[0], p[1]) - l.fmin) < 1e-6 * Math.max(1, Math.abs(l.fmin))) return 'converged';
  const { hxx, hyy, hxy } = hessian(l, p[0], p[1]);
  const det = hxx * hyy - hxy * hxy;
  const scale = Math.max(1e-12, hxx * hxx + hyy * hyy);
  if (det > 1e-6 * scale && hxx + hyy > 0) return 'local-min';
  if (det < -1e-6 * scale) return 'saddle';
  return 'stationary';
}

export class Race {
  cfg: RaceConfig;
  runners: Runner[] = [];
  step = 0;
  bounds: View = { xmin: 0, xmax: 0, ymin: 0, ymax: 0 };
  f0 = 0;
  /** Optimizers that reached a global minimum, in finishing order. */
  podium: OptimizerId[] = [];
  readonly tol: ReturnType<typeof tolerances>;

  constructor(cfg: RaceConfig) {
    this.cfg = cfg;
    this.tol = tolerances(cfg.landscape);
    this.reset();
  }

  reset() {
    const { landscape: l, start, optimizers, noise, clip, seed } = this.cfg;
    const pad = this.tol.pad;
    this.bounds = { xmin: l.view.xmin - pad, xmax: l.view.xmax + pad, ymin: l.view.ymin - pad, ymax: l.view.ymax + pad };
    this.step = 0;
    this.podium = [];
    this.f0 = l.f(start[0], start[1]);
    this.runners = optimizers.map(({ id, hyper }) => ({
      id,
      hyper: { ...hyper },
      state: createState(start[0], start[1]),
      // Every optimizer sees an identical noise stream, so the comparison is fair and reproducible.
      grad: makeGradFn(l, { noise, clip }, makeRng(seed)),
      status: 'ready' as Status,
      xs: [start[0]],
      ys: [start[1]],
      losses: [this.f0],
      doneAt: 0,
      end: null,
      how: null,
    }));
  }

  get finished() {
    return this.runners.every((r) => isFinished(r.status)) || this.step >= this.cfg.maxSteps;
  }

  get stochastic() {
    return noiseSigma(this.cfg.landscape, this.cfg.noise) > 0;
  }

  private finish(r: Runner, status: Status, how: Runner['how'] = null, end: Vec2 | null = null) {
    r.status = status;
    r.doneAt = r.state.t;
    r.how = how;
    r.end = end ?? [r.state.x, r.state.y];
    if (status === 'converged') this.podium.push(r.id);
  }

  /** Tolerance test on the true gradient and the last step, then the settled-oscillation test. */
  private checkStop(r: Runner, dx: number, dy: number) {
    const l = this.cfg.landscape;
    const T = this.tol;
    const { x, y } = r.state;
    const [gx, gy] = l.grad(x, y);
    if (!this.stochastic && Math.hypot(gx, gy) < T.grad && Math.hypot(dx, dy) < T.step) {
      this.finish(r, classifyPoint(l, x, y), 'tol');
      return;
    }
    // Sign-based and adaptive methods (and noisy runs) never shrink their steps to zero: they end in a
    // small limit cycle. Detect that every few steps: tight bounding box + near-zero gradient at its centre.
    const n = r.xs.length;
    const W = T.window;
    if (n > W && r.state.t % 5 === 0) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      let ax = 0, ay = 0, bx = 0, by = 0;
      for (let i = n - W; i < n; i++) {
        const px = r.xs[i], py = r.ys[i];
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        if (i < n - W / 2) { ax += px; ay += py; } else { bx += px; by += py; }
      }
      const box = Math.hypot(x1 - x0, y1 - y0);
      // A slow crawl also fits in a small box, but its two half-window centroids drift apart.
      const drift = Math.hypot(bx - ax, by - ay) / (W / 2);
      const cx = (ax + bx) / W, cy = (ay + by) / W;
      let stop = false;
      if (box < T.frozen && !this.stochastic) {
        // Not moving any more, even if |∇f| is not tiny (e.g. AdamW's decay-shifted fixed point) …
        stop = true;
      } else if (box < T.box && drift < Math.max(0.05 * box, 1e-3 * T.step)) {
        // … or circling a point whose gradient is ~0 (Lion's ±η limit cycle, Adam's jitter).
        const [hx, hy] = l.grad(cx, cy);
        stop = Math.hypot(hx, hy) < T.centroidGrad;
      }
      // Only stop next to an actual stationary point: a very slow crawl is still a crawl.
      if (stop && polishStationary(l, cx, cy, Math.max(4 * box, T.near))) {
        this.finish(r, classifyPoint(l, cx, cy), 'settled', [cx, cy]);
      }
    }
  }

  /** Advance every active runner by up to `n` steps. Returns the number of steps taken. */
  advance(n = 1) {
    const l = this.cfg.landscape;
    const b = this.bounds;
    let taken = 0;
    for (let k = 0; k < n; k++) {
      if (this.finished) break;
      this.step++;
      taken++;
      for (const r of this.runners) {
        if (isFinished(r.status)) continue;
        r.status = 'running';
        const px = r.state.x, py = r.state.y;
        stepOptimizer(r.id, r.state, r.hyper, r.grad);
        const { x, y } = r.state;
        const f = l.f(x, y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(f)) {
          r.state.x = px;
          r.state.y = py;
          this.finish(r, 'diverged');
          continue;
        }
        r.xs.push(x);
        r.ys.push(y);
        r.losses.push(f);
        if (x < b.xmin || x > b.xmax || y < b.ymin || y > b.ymax) {
          this.finish(r, 'diverged');
          continue;
        }
        this.checkStop(r, x - px, y - py);
        if (!isFinished(r.status) && this.step >= this.cfg.maxSteps) this.finish(r, 'max-steps');
      }
    }
    return taken;
  }

  /** Steps to run with no visible change (e.g. for tests and the "finish" button). */
  runToEnd(limit = 1e6) {
    let total = 0;
    while (!this.finished && total < limit) total += this.advance(1000);
    return total;
  }
}

/* ==========================================================================
   Helpers shared by the UI
   ========================================================================== */

/** Expand a view window to the given aspect (width / height) around its centre. */
export function fitView(v: View, aspect: number): View {
  const cx = (v.xmin + v.xmax) / 2;
  const cy = (v.ymin + v.ymax) / 2;
  let w = v.xmax - v.xmin;
  let h = v.ymax - v.ymin;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  return { xmin: cx - w / 2, xmax: cx + w / 2, ymin: cy - h / 2, ymax: cy + h / 2 };
}

/* ==========================================================================
   Presets ("lessons")
   ========================================================================== */

export interface Preset {
  id: string;
  name: string;
  short: string;
  description: string;
  landscape: LandscapeId;
  kappa?: number;
  start: Vec2;
  /** Enabled optimizers and their hyperparameter overrides (on top of the landscape defaults). */
  optimizers: Partial<Record<OptimizerId, Partial<Hyper>>>;
  noise: number;
  clip: number;
  maxSteps: number;
  speed: number;
  select: OptimizerId;
}

export const PRESETS: Preset[] = [
  {
    id: 'momentum',
    name: 'Why momentum helps',
    short: 'Ill-conditioned bowl',
    description:
      'All three use the same η = 0.1 on a bowl with condition number 50. SGD shrinks the x-error by only 1 − 2η/κ = 0.4 % per step, so it crawls. Momentum keeps adding up the small but consistent x-gradient, and Nesterov’s look-ahead brakes earlier, so it overshoots less.',
    landscape: 'bowl',
    kappa: 50,
    start: [-7.5, 2.5],
    optimizers: { sgd: { lr: 0.1 }, momentum: { lr: 0.1, mu: 0.9 }, nesterov: { lr: 0.1, mu: 0.9 } },
    noise: 0,
    clip: 0,
    maxSteps: 1500,
    speed: 5,
    select: 'momentum',
  },
  {
    id: 'saddle',
    name: 'Escaping a saddle point',
    short: 'Tiny escape gradient',
    description:
      'Start a hair (y = 0.001) above the ridge. With η = 0.01 everywhere, SGD slides into the saddle and lingers, because the escape gradient is tiny. Adam and RMSProp rescale it to a full-size step and leave long before; momentum accelerates its way out in between.',
    landscape: 'saddle',
    start: [-1.8, 0.001],
    optimizers: { sgd: { lr: 0.01 }, momentum: { lr: 0.01, mu: 0.9 }, rmsprop: { lr: 0.01 }, adam: { lr: 0.01 } },
    noise: 0,
    clip: 0,
    maxSteps: 1500,
    speed: 3,
    select: 'adam',
  },
  {
    id: 'lr-high',
    name: 'Learning rate too high',
    short: 'Past the 2/L limit',
    description:
      'On this bowl the steepest curvature is L = 2, so gradient descent is stable only while η < 2/L = 1, and heavy-ball momentum while η < 2(1 + μ)/L. SGD at η = 1.05 and momentum at η = 2 grow geometrically and diverge. Adam and Lion take steps of at most ≈ η, so the same over-large η makes them bounce but not explode.',
    landscape: 'bowl',
    kappa: 20,
    start: [-7.3, 2.7],
    optimizers: { sgd: { lr: 1.05 }, momentum: { lr: 2, mu: 0.9 }, adam: { lr: 1 }, lion: { lr: 0.3 } },
    noise: 0,
    clip: 0,
    maxSteps: 400,
    speed: 1,
    select: 'sgd',
  },
  {
    id: 'rosenbrock',
    name: 'Adaptive methods on Rosenbrock',
    short: 'Following a curved valley',
    description:
      'The valley floor is almost flat while its walls are hundreds of times steeper. SGD’s η is capped by the walls, so it crawls along the floor and runs out of steps. Adam’s per-coordinate scaling evens out the curvature and wins comfortably; RMSProp gets there too but zig-zags on the way, and AdaGrad’s ever-growing denominator makes it stall. Carefully tuned heavy-ball momentum is a strong runner-up: adaptivity is not the only fix.',
    landscape: 'rosenbrock',
    start: [-1.6, 2.4],
    optimizers: { sgd: {}, momentum: {}, adagrad: {}, rmsprop: {}, adam: {}, lion: {} },
    noise: 0,
    clip: 0,
    maxSteps: 4000,
    speed: 10,
    select: 'adam',
  },
  {
    id: 'rastrigin',
    name: 'Many local minima',
    short: 'Rastrigin egg-crate',
    description:
      'Start in the far corner. A gradient only describes the nearest dimple: SGD drops into the first one (f ≈ 32), and even Adam with a big η only gets one cell further. AdaGrad’s large early steps carry it a few cells in, while heavy momentum (μ = 0.95) rolls over ridge after ridge to a dimple right next to the global minimum. None of them finds (0, 0): try other start points or add gradient noise.',
    landscape: 'rastrigin',
    start: [4.45, 4.4],
    optimizers: { sgd: {}, momentum: { lr: 0.003, mu: 0.95 }, adagrad: { lr: 2 }, adam: { lr: 0.8 } },
    noise: 0,
    clip: 0,
    maxSteps: 800,
    speed: 2,
    select: 'momentum',
  },
];

/* ==========================================================================
   Share-hash codec: #l=bowl&k=20&s=-7.5,2.5&n=0&c=0&m=400&v=4&sel=adam&o=sgd:0.4;adam:0.25,0.9,0.999,1e-8
   ========================================================================== */

export interface ShareState {
  landscape: LandscapeId;
  kappa: number;
  start: Vec2;
  enabled: OptimizerId[];
  hyper: Record<OptimizerId, Hyper>;
  noise: number;
  clip: number;
  maxSteps: number;
  speed: number;
  selected: OptimizerId;
}

const num = (v: number) => String(+v.toPrecision(6));

export function encodeHash(s: ShareState): string {
  const o = s.enabled
    .map((id) => `${id}:${OPTIMIZER_BY_ID[id].params.map((p) => num(s.hyper[id][p.key] ?? 0)).join(',')}`)
    .join(';');
  const parts = [
    `l=${s.landscape}`,
    ...(s.landscape === 'bowl' ? [`k=${num(s.kappa)}`] : []),
    `s=${num(s.start[0])},${num(s.start[1])}`,
    `o=${o || '-'}`,
    `n=${num(s.noise)}`,
    `c=${num(s.clip)}`,
    `m=${s.maxSteps}`,
    `v=${s.speed}`,
    `sel=${s.selected}`,
  ];
  return parts.join('&');
}

/** Parse a share hash. Unknown or malformed fields are dropped; the caller fills in defaults. */
export function decodeHash(hash: string): Partial<ShareState> {
  const out: Partial<ShareState> = {};
  const q = new Map<string, string>();
  for (const kv of hash.replace(/^#/, '').split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) q.set(kv.slice(0, i), decodeURIComponent(kv.slice(i + 1)));
  }
  const finite = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : undefined);
  const l = q.get('l') as LandscapeId | undefined;
  if (l && LANDSCAPE_IDS.includes(l)) out.landscape = l;
  const k = finite(q.get('k'));
  if (k !== undefined) out.kappa = Math.min(1000, Math.max(1, k));
  const s = q.get('s')?.split(',').map(Number);
  if (s && s.length === 2 && s.every(Number.isFinite)) out.start = [s[0], s[1]];
  const o = q.get('o');
  if (o !== undefined) {
    out.enabled = [];
    out.hyper = {} as Record<OptimizerId, Hyper>;
    for (const part of o.split(';')) {
      const [id, vals] = part.split(':') as [OptimizerId, string | undefined];
      const def = OPTIMIZER_BY_ID[id];
      if (!def || out.enabled.includes(id)) continue;
      const nums = (vals ?? '').split(',').map(Number);
      const h: Partial<Hyper> = {};
      def.params.forEach((p, i) => {
        const v = nums[i];
        if (Number.isFinite(v)) h[p.key] = Math.min(p.max, Math.max(p.key === 'lr' ? 0 : p.min, v));
      });
      out.enabled.push(id);
      if (h.lr !== undefined) out.hyper[id] = h as Hyper;
    }
  }
  const n = finite(q.get('n'));
  if (n !== undefined) out.noise = Math.min(2, Math.max(0, n));
  const c = finite(q.get('c'));
  if (c !== undefined) out.clip = Math.max(0, c);
  const m = finite(q.get('m'));
  if (m !== undefined) out.maxSteps = Math.round(Math.min(20000, Math.max(10, m)));
  const v = finite(q.get('v'));
  if (v !== undefined) out.speed = Math.round(Math.min(200, Math.max(1, v)));
  const sel = q.get('sel') as OptimizerId | undefined;
  if (sel && OPTIMIZER_BY_ID[sel]) out.selected = sel;
  return out;
}
