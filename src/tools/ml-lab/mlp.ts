// A small multilayer perceptron written from scratch: dense layers, softmax cross-entropy,
// backprop, L2 regularisation, SGD / Momentum / Adam. Pure module (no DOM), used by the worker,
// the main-thread fallback, the neuron inspector and the in-browser tests.
import { gaussian, mulberry32, type Rng } from './rng';

export type Activation = 'relu' | 'tanh' | 'sigmoid' | 'gelu';
export type OptimizerKind = 'sgd' | 'momentum' | 'adam';

const GELU_C = Math.sqrt(2 / Math.PI);

/** Activation f(z) and its derivative expressed through z and a = f(z). */
export const ACTIVATIONS: Record<Activation, { f: (z: number) => number; df: (z: number, a: number) => number }> = {
  relu: { f: (z) => (z > 0 ? z : 0), df: (z) => (z > 0 ? 1 : 0) },
  tanh: { f: Math.tanh, df: (_z, a) => 1 - a * a },
  sigmoid: { f: (z) => 1 / (1 + Math.exp(-z)), df: (_z, a) => a * (1 - a) },
  // tanh approximation of GELU (as in BERT / GPT-2)
  gelu: {
    f: (z) => 0.5 * z * (1 + Math.tanh(GELU_C * (z + 0.044715 * z * z * z))),
    df: (z) => {
      const u = GELU_C * (z + 0.044715 * z * z * z);
      const t = Math.tanh(u);
      return 0.5 * (1 + t) + 0.5 * z * (1 - t * t) * GELU_C * (1 + 3 * 0.044715 * z * z);
    },
  },
};

/** Numerically stable softmax (subtracts the max logit). Writes into `out` and returns it. */
export function softmax(z: ArrayLike<number>, out: Float64Array = new Float64Array(z.length)): Float64Array {
  let m = -Infinity;
  for (let i = 0; i < z.length; i++) if (z[i] > m) m = z[i];
  let s = 0;
  for (let i = 0; i < z.length; i++) { out[i] = Math.exp(z[i] - m); s += out[i]; }
  for (let i = 0; i < z.length; i++) out[i] /= s;
  return out;
}

/** Cross-entropy of a probability vector against an integer label: -log p[label]. */
export function crossEntropy(probs: ArrayLike<number>, label: number): number {
  return -Math.log(Math.max(probs[label], 1e-15));
}

/** Weight init: He (fan-in) for ReLU-like activations, Xavier/Glorot otherwise and for the output layer. */
export function initStd(act: Activation, fanIn: number, fanOut: number, isOutput: boolean) {
  return !isOutput && (act === 'relu' || act === 'gelu') ? Math.sqrt(2 / fanIn) : Math.sqrt(2 / (fanIn + fanOut));
}
export const initName = (act: Activation) => (act === 'relu' || act === 'gelu' ? 'He' : 'Xavier');

export class MLP {
  readonly sizes: number[];
  readonly act: Activation;
  readonly L: number;
  W: Float64Array[] = [];
  b: Float64Array[] = [];
  gW: Float64Array[] = [];
  gb: Float64Array[] = [];
  /** pre-activations z[l] and activations a[l] for layer l (a[0] = input, a[L] = softmax probs) */
  z: Float64Array[] = [];
  a: Float64Array[] = [];
  private d: Float64Array[] = [];

  constructor(sizes: number[], act: Activation, rng: Rng | number = 1) {
    if (sizes.length < 2) throw new Error('MLP needs at least an input and an output size');
    this.sizes = sizes.slice();
    this.act = act;
    this.L = sizes.length - 1;
    for (let l = 0; l < this.L; l++) {
      const n = sizes[l] * sizes[l + 1];
      this.W.push(new Float64Array(n));
      this.gW.push(new Float64Array(n));
      this.b.push(new Float64Array(sizes[l + 1]));
      this.gb.push(new Float64Array(sizes[l + 1]));
    }
    for (let l = 0; l <= this.L; l++) {
      this.z.push(new Float64Array(sizes[l]));
      this.a.push(new Float64Array(sizes[l]));
      this.d.push(new Float64Array(sizes[l]));
    }
    this.initWeights(typeof rng === 'number' ? mulberry32(rng) : rng);
  }

  initWeights(rng: Rng) {
    for (let l = 0; l < this.L; l++) {
      const std = initStd(this.act, this.sizes[l], this.sizes[l + 1], l === this.L - 1);
      const W = this.W[l];
      for (let i = 0; i < W.length; i++) W[i] = gaussian(rng) * std;
      this.b[l].fill(0);
    }
  }

  get numParams() {
    let n = 0;
    for (let l = 0; l < this.L; l++) n += this.W[l].length + this.b[l].length;
    return n;
  }

  params() { return [...this.W, ...this.b]; }
  grads() { return [...this.gW, ...this.gb]; }

  /** Forward pass for one input row (read from x starting at `off`). Returns the internal probs buffer. */
  forward(x: ArrayLike<number>, off = 0): Float64Array {
    const { sizes, L } = this;
    const f = ACTIVATIONS[this.act].f;
    const a0 = this.a[0];
    for (let i = 0; i < sizes[0]; i++) a0[i] = x[off + i];
    for (let l = 0; l < L; l++) {
      const nIn = sizes[l], nOut = sizes[l + 1];
      const W = this.W[l], b = this.b[l], aIn = this.a[l], zO = this.z[l + 1], aO = this.a[l + 1];
      for (let o = 0; o < nOut; o++) {
        let s = b[o];
        const row = o * nIn;
        for (let i = 0; i < nIn; i++) s += W[row + i] * aIn[i];
        zO[o] = s;
        if (l < L - 1) aO[o] = f(s);
      }
      if (l === L - 1) softmax(zO, aO);
    }
    return this.a[L];
  }

  /** Backprop for the sample last passed to forward(); accumulates into gW / gb. */
  private backward(label: number) {
    const { sizes, L } = this;
    const df = ACTIVATIONS[this.act].df;
    const dL = this.d[L], p = this.a[L];
    // d(CE o softmax)/dz = p - onehot(label)
    for (let o = 0; o < sizes[L]; o++) dL[o] = p[o] - (o === label ? 1 : 0);
    for (let l = L - 1; l >= 0; l--) {
      const nIn = sizes[l], nOut = sizes[l + 1];
      const W = this.W[l], gW = this.gW[l], gb = this.gb[l], dO = this.d[l + 1], aIn = this.a[l];
      for (let o = 0; o < nOut; o++) {
        const g = dO[o];
        if (g === 0) continue;
        gb[o] += g;
        const row = o * nIn;
        for (let i = 0; i < nIn; i++) gW[row + i] += g * aIn[i];
      }
      if (l > 0) {
        const dI = this.d[l], zI = this.z[l];
        for (let i = 0; i < nIn; i++) {
          let s = 0;
          for (let o = 0; o < nOut; o++) s += W[o * nIn + i] * dO[o];
          dI[i] = s * df(zI[i], aIn[i]);
        }
      }
    }
  }

  private l2Penalty(l2: number) {
    if (!l2) return 0;
    let s = 0;
    for (const W of this.W) for (let i = 0; i < W.length; i++) s += W[i] * W[i];
    return 0.5 * l2 * s;
  }

  /**
   * Mean cross-entropy over the rows idx[0..count) (or rows 0..count when idx is null) of the
   * row-major feature matrix X, plus (l2 / 2) * sum(W^2). Fills gW / gb with the exact gradient.
   */
  lossAndGrad(X: Float64Array, y: ArrayLike<number>, idx: ArrayLike<number> | null, count: number, l2 = 0): number {
    for (const g of this.gW) g.fill(0);
    for (const g of this.gb) g.fill(0);
    if (count <= 0) return 0;
    const d = this.sizes[0];
    let loss = 0;
    for (let t = 0; t < count; t++) {
      const r = idx ? idx[t] : t;
      const p = this.forward(X, r * d);
      loss += crossEntropy(p, y[r]);
      this.backward(y[r]);
    }
    const inv = 1 / count;
    for (let l = 0; l < this.L; l++) {
      const gW = this.gW[l], W = this.W[l], gb = this.gb[l];
      for (let i = 0; i < gW.length; i++) gW[i] = gW[i] * inv + l2 * W[i];
      for (let i = 0; i < gb.length; i++) gb[i] *= inv;
    }
    return loss * inv + this.l2Penalty(l2);
  }

  /** Same objective as lossAndGrad without touching gradients. */
  loss(X: Float64Array, y: ArrayLike<number>, idx: ArrayLike<number> | null, count: number, l2 = 0): number {
    if (count <= 0) return 0;
    const d = this.sizes[0];
    let loss = 0;
    for (let t = 0; t < count; t++) {
      const r = idx ? idx[t] : t;
      loss += crossEntropy(this.forward(X, r * d), y[r]);
    }
    return loss / count + this.l2Penalty(l2);
  }

  /** Mean data loss (no L2) and accuracy over all `count` rows. */
  evaluate(X: Float64Array, y: ArrayLike<number>, count: number) {
    if (count <= 0) return { loss: NaN, acc: NaN };
    const d = this.sizes[0];
    let loss = 0, correct = 0;
    for (let r = 0; r < count; r++) {
      const p = this.forward(X, r * d);
      loss += crossEntropy(p, y[r]);
      let best = 0;
      for (let c = 1; c < p.length; c++) if (p[c] > p[best]) best = c;
      if (best === y[r]) correct++;
    }
    return { loss: loss / count, acc: correct / count };
  }
}

export class Optimizer {
  kind: OptimizerKind;
  private m: Float64Array[];
  private v: Float64Array[];
  private t = 0;
  momentum = 0.9;
  beta1 = 0.9;
  beta2 = 0.999;
  eps = 1e-8;

  constructor(kind: OptimizerKind, params: Float64Array[]) {
    this.kind = kind;
    this.m = params.map((p) => new Float64Array(p.length));
    this.v = params.map((p) => new Float64Array(p.length));
  }

  step(params: Float64Array[], grads: Float64Array[], lr: number) {
    this.t++;
    if (this.kind === 'sgd') {
      for (let k = 0; k < params.length; k++) {
        const p = params[k], g = grads[k];
        for (let i = 0; i < p.length; i++) p[i] -= lr * g[i];
      }
    } else if (this.kind === 'momentum') {
      const mu = this.momentum;
      for (let k = 0; k < params.length; k++) {
        const p = params[k], g = grads[k], v = this.m[k];
        for (let i = 0; i < p.length; i++) { v[i] = mu * v[i] - lr * g[i]; p[i] += v[i]; }
      }
    } else {
      const { beta1: b1, beta2: b2, eps } = this;
      const c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
      for (let k = 0; k < params.length; k++) {
        const p = params[k], g = grads[k], m = this.m[k], v = this.v[k];
        for (let i = 0; i < p.length; i++) {
          m[i] = b1 * m[i] + (1 - b1) * g[i];
          v[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
          p[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + eps);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ features

export type FeatureKey = 'x' | 'y' | 'x2' | 'y2' | 'xy' | 'sinx' | 'siny';
export const FEATURES: { key: FeatureKey; label: string; fn: (x: number, y: number) => number }[] = [
  { key: 'x', label: 'x', fn: (x) => x },
  { key: 'y', label: 'y', fn: (_x, y) => y },
  { key: 'x2', label: 'x²', fn: (x) => x * x },
  { key: 'y2', label: 'y²', fn: (_x, y) => y * y },
  { key: 'xy', label: 'xy', fn: (x, y) => x * y },
  { key: 'sinx', label: 'sin πx', fn: (x) => Math.sin(Math.PI * x) },
  { key: 'siny', label: 'sin πy', fn: (_x, y) => Math.sin(Math.PI * y) },
];
const FEATURE_FN = Object.fromEntries(FEATURES.map((f) => [f.key, f.fn])) as Record<FeatureKey, (x: number, y: number) => number>;

/** Write the selected feature values for (x, y) into out[off..]. */
export function featurize(x: number, y: number, keys: FeatureKey[], out: Float64Array, off = 0) {
  for (let i = 0; i < keys.length; i++) out[off + i] = FEATURE_FN[keys[i]](x, y);
  return out;
}
