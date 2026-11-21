// Message-driven training engine shared by the Web Worker and the main-thread fallback.
// It trains in short time slices and posts snapshots (metrics, weights, prediction grid).
import type { Sample } from './datasets';
import { Trainer, type TrainConfig } from './trainer';

export type Speed = 'slow' | 'normal' | 'fast';

export type EngineMsg =
  | { type: 'init'; cfg: TrainConfig; samples: Sample[] }
  | { type: 'data'; samples: Sample[] }
  | { type: 'config'; cfg: TrainConfig }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'step'; epochs: number }
  | { type: 'reset'; seed: number }
  | { type: 'speed'; speed: Speed };

export interface Snapshot {
  type: 'snap';
  runId: number;
  epoch: number;
  playing: boolean;
  diverged: boolean;
  trainLoss: number;
  trainAcc: number;
  testLoss: number;
  testAcc: number;
  nTrain: number;
  nTest: number;
  sizes: number[];
  W: Float64Array[];
  b: Float64Array[];
  res: number;
  classes: number;
  grid: Float32Array;
}

export interface EngineError { type: 'error'; message: string }

export const GRID_RES = 56;
const RATE: Record<Speed, number> = { slow: 5, normal: 30, fast: Infinity }; // epochs per second
const SLICE_MS = 12;
const SNAP_MS = 45;

export class EngineCore {
  private tr: Trainer | null = null;
  private playing = false;
  private speed: Speed = 'normal';
  private runId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastTick = 0;
  private due = 0;
  private lastSnap = 0;

  constructor(private post: (msg: Snapshot | EngineError, transfer: Transferable[]) => void) {}

  handle(msg: EngineMsg) {
    try {
      switch (msg.type) {
        case 'init':
          this.tr = new Trainer(msg.cfg, msg.samples);
          this.runId++;
          this.snapshot();
          break;
        case 'data':
          if (!this.tr) return;
          this.tr.setData(msg.samples);
          this.snapshot();
          break;
        case 'config':
          if (!this.tr) return;
          if (this.tr.configure(msg.cfg)) this.runId++;
          this.snapshot();
          break;
        case 'reset':
          if (!this.tr) return;
          this.tr.reset(msg.seed);
          this.runId++;
          this.snapshot();
          break;
        case 'step':
          if (!this.tr) return;
          for (let i = 0; i < msg.epochs && !this.tr.diverged; i++) this.tr.trainEpoch();
          this.snapshot();
          break;
        case 'speed':
          this.speed = msg.speed;
          break;
        case 'play':
          if (this.playing) return;
          this.playing = true;
          this.lastTick = performance.now();
          this.due = 1; // first epoch right away
          this.schedule();
          break;
        case 'pause':
          this.playing = false;
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          this.snapshot();
          break;
      }
    } catch (e) {
      this.playing = false;
      this.post({ type: 'error', message: (e as Error).message || String(e) }, []);
    }
  }

  private schedule() {
    this.timer = setTimeout(() => this.tick(), 8);
  }

  private tick() {
    this.timer = null;
    const tr = this.tr;
    if (!this.playing || !tr) return;
    const now = performance.now();
    const rate = RATE[this.speed];
    this.due = Math.min(this.due + ((now - this.lastTick) / 1000) * (Number.isFinite(rate) ? rate : 0), 50);
    this.lastTick = now;
    const t0 = now;
    if (!Number.isFinite(rate)) {
      do tr.trainEpoch(); while (performance.now() - t0 < SLICE_MS && !tr.diverged);
    } else {
      while (this.due >= 1 && performance.now() - t0 < SLICE_MS && !tr.diverged) {
        tr.trainEpoch();
        this.due -= 1;
      }
    }
    if (tr.diverged || tr.nTrain === 0) this.playing = false;
    if (!this.playing || performance.now() - this.lastSnap >= SNAP_MS) this.snapshot();
    if (this.playing) this.schedule();
  }

  private snapshot() {
    const tr = this.tr;
    if (!tr) return;
    this.lastSnap = performance.now();
    const m = tr.evaluate();
    const W = tr.net.W.map((w) => w.slice());
    const b = tr.net.b.map((x) => x.slice());
    const grid = tr.grid(GRID_RES);
    this.post(
      {
        type: 'snap', runId: this.runId, epoch: tr.epoch, playing: this.playing, diverged: tr.diverged,
        ...m, nTrain: tr.nTrain, nTest: tr.nTest, sizes: tr.sizes, W, b, res: GRID_RES, classes: tr.cfg.classes, grid,
      },
      [...W.map((w) => w.buffer), ...b.map((x) => x.buffer), grid.buffer],
    );
  }
}
