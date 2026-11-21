// Training loop around the MLP: data featurisation, mini-batches, metrics, prediction grid.
// Pure module (no DOM), runs inside the Web Worker or on the main thread as a fallback.
import type { Sample } from './datasets';
import { featurize, MLP, Optimizer, type Activation, type FeatureKey, type OptimizerKind } from './mlp';
import { mulberry32, shuffleInPlace, type Rng } from './rng';

export interface TrainConfig {
  features: FeatureKey[];
  hidden: number[];
  activation: Activation;
  optimizer: OptimizerKind;
  lr: number;
  batchSize: number; // 0 = full batch
  l2: number;
  classes: number;
  seed: number;
}

export interface Metrics { trainLoss: number; trainAcc: number; testLoss: number; testAcc: number }

export class Trainer {
  cfg: TrainConfig;
  net!: MLP;
  opt!: Optimizer;
  epoch = 0;
  diverged = false;
  private rng: Rng;
  private Xtr = new Float64Array(0);
  private ytr = new Int32Array(0);
  private Xte = new Float64Array(0);
  private yte = new Int32Array(0);
  private order = new Int32Array(0);
  private samples: Sample[] = [];
  lastBatchLoss = NaN;

  constructor(cfg: TrainConfig, samples: Sample[]) {
    this.cfg = { ...cfg, features: [...cfg.features], hidden: [...cfg.hidden] };
    this.rng = mulberry32(cfg.seed ^ 0x5bd1e995);
    this.build();
    this.setData(samples);
  }

  get sizes() {
    return [this.cfg.features.length, ...this.cfg.hidden, this.cfg.classes];
  }
  get nTrain() { return this.ytr.length; }
  get nTest() { return this.yte.length; }

  private build() {
    if (!this.cfg.features.length) throw new Error('Select at least one input feature');
    this.net = new MLP(this.sizes, this.cfg.activation, mulberry32(this.cfg.seed));
    this.opt = new Optimizer(this.cfg.optimizer, this.net.params());
    this.epoch = 0;
    this.diverged = false;
  }

  setData(samples: Sample[]) {
    this.samples = samples;
    const keys = this.cfg.features, d = keys.length;
    const tr = samples.filter((s) => !s.test && s.label < this.cfg.classes);
    const te = samples.filter((s) => s.test && s.label < this.cfg.classes);
    this.Xtr = new Float64Array(tr.length * d);
    this.ytr = new Int32Array(tr.length);
    tr.forEach((s, i) => { featurize(s.x, s.y, keys, this.Xtr, i * d); this.ytr[i] = s.label; });
    this.Xte = new Float64Array(te.length * d);
    this.yte = new Int32Array(te.length);
    te.forEach((s, i) => { featurize(s.x, s.y, keys, this.Xte, i * d); this.yte[i] = s.label; });
    this.order = Int32Array.from({ length: tr.length }, (_, i) => i);
  }

  /** Apply a new config. Architecture/feature/class/seed changes rebuild the network. Returns true if rebuilt. */
  configure(cfg: TrainConfig): boolean {
    const old = this.cfg;
    const rebuild = old.features.join() !== cfg.features.join() || old.hidden.join() !== cfg.hidden.join() ||
      old.activation !== cfg.activation || old.classes !== cfg.classes || old.seed !== cfg.seed;
    const optChanged = old.optimizer !== cfg.optimizer;
    this.cfg = { ...cfg, features: [...cfg.features], hidden: [...cfg.hidden] };
    if (rebuild) {
      this.build();
      this.setData(this.samples);
    } else if (optChanged) {
      this.opt = new Optimizer(cfg.optimizer, this.net.params());
    }
    return rebuild;
  }

  /** Re-initialise weights and optimiser state with a fresh seed. */
  reset(seed: number) {
    this.cfg.seed = seed;
    this.build();
  }

  /** One pass over the shuffled training set in mini-batches. */
  trainEpoch() {
    const n = this.nTrain;
    if (!n || this.diverged) return;
    shuffleInPlace(this.order, this.rng);
    const bs = this.cfg.batchSize > 0 ? Math.min(this.cfg.batchSize, n) : n;
    const params = this.net.params(), grads = this.net.grads();
    for (let start = 0; start < n; start += bs) {
      const count = Math.min(bs, n - start);
      const loss = this.net.lossAndGrad(this.Xtr, this.ytr, this.order.subarray(start, start + count), count, this.cfg.l2);
      if (!Number.isFinite(loss)) { this.diverged = true; break; }
      this.lastBatchLoss = loss;
      this.opt.step(params, grads, this.cfg.lr);
    }
    if (!this.diverged && !this.net.W.every((w) => Number.isFinite(w[0]))) this.diverged = true;
    this.epoch++;
  }

  evaluate(): Metrics {
    const tr = this.net.evaluate(this.Xtr, this.ytr, this.nTrain);
    const te = this.net.evaluate(this.Xte, this.yte, this.nTest);
    return { trainLoss: tr.loss, trainAcc: tr.acc, testLoss: te.loss, testAcc: te.acc };
  }

  /**
   * Class probabilities on a res x res grid over [-1, 1]^2, sampled at cell centres, row 0 at the
   * top (y = +1). Layout: out[(row * res + col) * C + c].
   */
  grid(res: number, out?: Float32Array): Float32Array {
    const C = this.cfg.classes, keys = this.cfg.features;
    const buf = out && out.length === res * res * C ? out : new Float32Array(res * res * C);
    const f = new Float64Array(keys.length);
    for (let r = 0; r < res; r++) {
      const y = 1 - ((r + 0.5) * 2) / res;
      for (let c = 0; c < res; c++) {
        const x = -1 + ((c + 0.5) * 2) / res;
        featurize(x, y, keys, f);
        const p = this.net.forward(f);
        const o = (r * res + c) * C;
        for (let k = 0; k < C; k++) buf[o + k] = p[k];
      }
    }
    return buf;
  }
}
