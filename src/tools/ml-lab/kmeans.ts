// k-means (Lloyd's algorithm) split into its two phases so the UI can animate them.
// Pure module: no DOM access, safe to import from tests or workers.
import type { P2 } from './datasets';
import { mulberry32, type Rng } from './rng';

export type InitMethod = 'random' | 'kmeans++';

export const dist2 = (a: P2, b: P2) => {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
};

/**
 * Pick k starting centroids from the data.
 *  - random  ("Forgy"): k distinct data points chosen uniformly.
 *  - kmeans++: first centre uniform, each next one sampled with probability proportional to D(x)^2,
 *    the squared distance to the nearest centre chosen so far. Already-chosen points have D = 0,
 *    so they can never be picked twice.
 */
export function initCentroids(points: P2[], k: number, method: InitMethod, rng: Rng): P2[] {
  const n = points.length;
  if (!n) return [];
  k = Math.max(1, Math.min(Math.floor(k), n));
  const copy = (i: number) => ({ x: points[i].x, y: points[i].y });
  if (method === 'random') {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rng() * (n - i));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, k).map(copy);
  }
  const chosen: number[] = [Math.floor(rng() * n)];
  const taken = new Uint8Array(n);
  taken[chosen[0]] = 1;
  const d2 = new Float64Array(n);
  for (let i = 0; i < n; i++) d2[i] = dist2(points[i], points[chosen[0]]);
  while (chosen.length < k) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d2[i];
    let next = -1;
    if (sum > 0) {
      let r = rng() * sum;
      for (let i = 0; i < n; i++) {
        if (d2[i] <= 0) continue;
        r -= d2[i];
        next = i;
        if (r <= 0) break;
      }
    }
    if (next < 0) {
      // every remaining point coincides with a centre: fall back to any unused index
      const free: number[] = [];
      for (let i = 0; i < n; i++) if (!taken[i]) free.push(i);
      next = free[Math.floor(rng() * free.length)];
    }
    chosen.push(next);
    taken[next] = 1;
    const c = points[next];
    for (let i = 0; i < n; i++) {
      const d = dist2(points[i], c);
      if (d < d2[i]) d2[i] = d;
    }
  }
  return chosen.map(copy);
}

export function nearest(p: P2, centroids: P2[]): number {
  let best = 0, bd = Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const d = dist2(p, centroids[c]);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/** Assignment phase: label every point with its nearest centroid. Mutates `labels`. */
export function assign(points: P2[], centroids: P2[], labels: Int32Array) {
  let changed = 0, inertia = 0;
  for (let i = 0; i < points.length; i++) {
    const c = nearest(points[i], centroids);
    if (labels[i] !== c) { changed++; labels[i] = c; }
    inertia += dist2(points[i], centroids[c]);
  }
  return { changed, inertia };
}

/**
 * Update phase: move each centroid to the mean of its points. An empty cluster keeps its
 * previous position (it may win points back after the next assignment).
 */
export function update(points: P2[], labels: Int32Array, prev: P2[]) {
  const k = prev.length;
  const sx = new Float64Array(k), sy = new Float64Array(k), cnt = new Int32Array(k);
  for (let i = 0; i < points.length; i++) {
    const c = labels[i];
    if (c < 0 || c >= k) continue;
    sx[c] += points[i].x; sy[c] += points[i].y; cnt[c]++;
  }
  let shift = 0;
  const empty: number[] = [];
  const centroids = prev.map((p, c) => {
    if (!cnt[c]) { empty.push(c); return { x: p.x, y: p.y }; }
    const q = { x: sx[c] / cnt[c], y: sy[c] / cnt[c] };
    shift = Math.max(shift, Math.sqrt(dist2(p, q)));
    return q;
  });
  return { centroids, shift, empty, counts: cnt };
}

/** Within-cluster sum of squares for the given labels and centroids. */
export function inertia(points: P2[], labels: Int32Array, centroids: P2[]) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const c = labels[i];
    if (c >= 0 && c < centroids.length) s += dist2(points[i], centroids[c]);
  }
  return s;
}

export interface KMeansResult {
  centroids: P2[];
  labels: Int32Array;
  inertia: number;
  iterations: number;
  converged: boolean;
}

export interface KMeansOpts { init?: InitMethod; seed?: number; maxIter?: number; rng?: Rng }

/** Full Lloyd iteration until no label changes (or maxIter). */
export function runKMeans(points: P2[], k: number, o: KMeansOpts = {}): KMeansResult {
  const rng = o.rng ?? mulberry32(o.seed ?? 1);
  const maxIter = o.maxIter ?? 300;
  let centroids = initCentroids(points, k, o.init ?? 'kmeans++', rng);
  const labels = new Int32Array(points.length).fill(-1);
  let it = 0, converged = false, wcss = 0;
  while (it < maxIter) {
    const a = assign(points, centroids, labels);
    wcss = a.inertia;
    if (a.changed === 0) { converged = true; break; }
    it++;
    centroids = update(points, labels, centroids).centroids;
  }
  if (!converged) wcss = inertia(points, labels, centroids);
  return { centroids, labels, inertia: wcss, iterations: it, converged };
}

/** Best (lowest inertia) of several independent restarts. */
export function bestOfRestarts(points: P2[], k: number, restarts: number, seed: number, init: InitMethod = 'kmeans++') {
  let best: KMeansResult | null = null;
  for (let r = 0; r < Math.max(1, restarts); r++) {
    const res = runKMeans(points, k, { init, seed: seed * 7919 + r * 104729 + k });
    if (!best || res.inertia < best.inertia) best = res;
  }
  return best!;
}

/**
 * Mean silhouette coefficient s = (b - a) / max(a, b), computed on a random sample of at most
 * `maxSample` points (both the scored points and the reference set), like sklearn's sample_size.
 * Returns NaN when fewer than two clusters are populated.
 */
export function silhouette(points: P2[], labels: Int32Array, k: number, maxSample = 500, seed = 1): number {
  const n = points.length;
  let idx = Array.from({ length: n }, (_, i) => i).filter((i) => labels[i] >= 0);
  if (idx.length > maxSample) {
    const rng = mulberry32(seed);
    for (let i = 0; i < maxSample; i++) {
      const j = i + Math.floor(rng() * (idx.length - i));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    idx = idx.slice(0, maxSample);
  }
  const cnt = new Int32Array(k);
  for (const i of idx) cnt[labels[i]]++;
  let populated = 0;
  for (let c = 0; c < k; c++) if (cnt[c]) populated++;
  if (populated < 2) return NaN;
  const sums = new Float64Array(k);
  let total = 0;
  for (const i of idx) {
    sums.fill(0);
    const p = points[i];
    for (const j of idx) {
      if (i === j) continue;
      sums[labels[j]] += Math.sqrt(dist2(p, points[j]));
    }
    const own = labels[i];
    if (cnt[own] <= 1) continue; // s = 0 for singletons
    const a = sums[own] / (cnt[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && cnt[c]) b = Math.min(b, sums[c] / cnt[c]);
    const m = Math.max(a, b);
    total += m > 0 ? (b - a) / m : 0;
  }
  return total / idx.length;
}

export interface ElbowPoint { k: number; inertia: number; silhouette: number }

/** Generator so the UI can compute one k per animation frame without blocking. */
export function* elbowSteps(points: P2[], kMax = 10, restarts = 4, seed = 1): Generator<ElbowPoint> {
  const top = Math.min(kMax, points.length);
  for (let k = 1; k <= top; k++) {
    const res = bestOfRestarts(points, k, restarts, seed);
    const sil = k >= 2 ? silhouette(points, res.labels, k, 500, seed + k) : NaN;
    yield { k, inertia: res.inertia, silhouette: sil };
  }
}

export function elbow(points: P2[], kMax = 10, restarts = 4, seed = 1): ElbowPoint[] {
  return [...elbowSteps(points, kMax, restarts, seed)];
}

/** Suggested k: the highest mean silhouette (k >= 2). */
export function suggestK(res: ElbowPoint[]): number | null {
  let best: ElbowPoint | null = null;
  for (const r of res) if (r.k >= 2 && Number.isFinite(r.silhouette) && (!best || r.silhouette > best.silhouette)) best = r;
  return best ? best.k : null;
}

/** "Kneedle"-style elbow: the k farthest below the chord from the first to the last inertia. */
export function kneeK(res: ElbowPoint[]): number | null {
  if (res.length < 3) return null;
  const first = res[0], last = res[res.length - 1];
  const span = first.inertia - last.inertia;
  if (!(span > 0)) return null;
  let best = -Infinity, bk: number | null = null;
  for (const r of res) {
    const x = (r.k - first.k) / (last.k - first.k);
    const y = (r.inertia - last.inertia) / span;
    const d = 1 - x - y;
    if (d > best) { best = d; bk = r.k; }
  }
  return bk;
}
