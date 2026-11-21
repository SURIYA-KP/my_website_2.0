// Synthetic 2-D datasets. Everything lives in the square [-1, 1] x [-1, 1]. Pure, no DOM.
import { gaussian, mulberry32, shuffleInPlace, type Rng } from './rng';

export interface P2 { x: number; y: number }
export interface LabeledPoint extends P2 { label: number }
export interface Sample extends LabeledPoint { test: boolean }

const clamp = (v: number, lo = -1, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

/** Uniformly rescale points (in place) so their bounding box fits inside [-m, m]^2, centred. */
export function fitToBox<T extends P2>(pts: T[], m = 0.9, alsoTransform: P2[] = []): T[] {
  if (!pts.length) return pts;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const half = Math.max(x1 - x0, y1 - y0) / 2 || 1;
  const s = m / half;
  for (const p of [...pts, ...alsoTransform]) {
    p.x = (p.x - cx) * s;
    p.y = (p.y - cy) * s;
  }
  return pts;
}

function blobCenters(count: number, rng: Rng, spread = 0.68): P2[] {
  const centers: P2[] = [];
  let minD = count <= 4 ? 0.62 : count <= 6 ? 0.5 : 0.42;
  let tries = 0;
  while (centers.length < count) {
    const c = { x: (rng() * 2 - 1) * spread, y: (rng() * 2 - 1) * spread };
    if (centers.every((o) => Math.hypot(o.x - c.x, o.y - c.y) >= minD)) centers.push(c);
    if (++tries % 400 === 0) minD *= 0.9; // relax when crowded
  }
  return centers;
}

// ---------------------------------------------------------------- clustering

export type ClusterDataset = 'blobs' | 'uniform' | 'moons' | 'rings' | 'aniso';
export interface ClusterOpts { n: number; noise: number; centers: number; seed: number }
export interface ClusterData { points: P2[]; trueCenters: P2[] | null }

export function makeClusterData(kind: ClusterDataset, o: ClusterOpts): ClusterData {
  const rng = mulberry32(o.seed);
  const n = Math.max(0, Math.round(o.n));
  const noise = Math.max(0, Math.min(1, o.noise));
  const pts: P2[] = [];
  let centers: P2[] | null = null;
  switch (kind) {
    case 'blobs':
    case 'aniso': {
      centers = blobCenters(Math.max(1, o.centers), rng);
      const sd = 0.035 + 0.16 * noise;
      for (let i = 0; i < n; i++) {
        const c = centers[i % centers.length];
        pts.push({ x: c.x + gaussian(rng) * sd, y: c.y + gaussian(rng) * sd });
      }
      if (kind === 'aniso') {
        // The classic sklearn shear: round blobs become stretched, tilted ellipses.
        const M = [0.6, -0.64, -0.41, 0.85];
        for (const p of [...pts, ...centers]) {
          const x = p.x, y = p.y;
          p.x = M[0] * x + M[2] * y;
          p.y = M[1] * x + M[3] * y;
        }
        fitToBox(pts, 0.9, centers);
      }
      break;
    }
    case 'uniform':
      for (let i = 0; i < n; i++) pts.push({ x: rng() * 1.8 - 0.9, y: rng() * 1.8 - 0.9 });
      break;
    case 'moons': {
      const sd = 0.03 + 0.17 * noise;
      for (let i = 0; i < n; i++) {
        const t = rng() * Math.PI;
        const up = i % 2 === 0;
        pts.push(up
          ? { x: Math.cos(t) + gaussian(rng) * sd, y: Math.sin(t) + gaussian(rng) * sd }
          : { x: 1 - Math.cos(t) + gaussian(rng) * sd, y: 0.5 - Math.sin(t) + gaussian(rng) * sd });
      }
      fitToBox(pts, 0.9);
      break;
    }
    case 'rings': {
      const sd = 0.012 + 0.09 * noise;
      for (let i = 0; i < n; i++) {
        const outer = i % 3 !== 0; // 2/3 of the points on the longer ring
        const r = (outer ? 0.8 : 0.32) + gaussian(rng) * sd;
        const t = rng() * Math.PI * 2;
        pts.push({ x: r * Math.cos(t), y: r * Math.sin(t) });
      }
      break;
    }
  }
  for (const p of pts) { p.x = clamp(p.x); p.y = clamp(p.y); }
  return { points: pts, trueCenters: centers };
}

// ------------------------------------------------------------ classification

export type ClassDataset = 'blobs' | 'xor' | 'circles' | 'spiral' | 'moons';
export interface ClassOpts { n: number; noise: number; classes: number; seed: number }

export function makeClassData(kind: ClassDataset, o: ClassOpts): LabeledPoint[] {
  const rng = mulberry32(o.seed);
  const n = Math.max(0, Math.round(o.n));
  const C = Math.max(2, Math.min(3, Math.round(o.classes)));
  const noise = Math.max(0, Math.min(1, o.noise));
  const pts: LabeledPoint[] = [];
  switch (kind) {
    case 'blobs': {
      const sd = 0.1 + 0.28 * noise;
      for (let i = 0; i < n; i++) {
        const c = i % C;
        const ang = (2 * Math.PI * c) / C + Math.PI / 4;
        pts.push({ x: 0.48 * Math.cos(ang) + gaussian(rng) * sd, y: 0.48 * Math.sin(ang) + gaussian(rng) * sd, label: c });
      }
      break;
    }
    case 'xor': {
      const sd = 0.22 * noise;
      for (let i = 0; i < n; i++) {
        let x = rng() * 1.8 - 0.9, y = rng() * 1.8 - 0.9;
        // keep a small margin around the axes so the clean version is cleanly separable
        x += x > 0 ? 0.04 : -0.04;
        y += y > 0 ? 0.04 : -0.04;
        let label: number;
        if (C === 2) label = x * y > 0 ? 0 : 1;
        else {
          // 3 classes: a six-sector pinwheel, the natural generalisation of XOR's quadrants
          const a = (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
          label = Math.floor(a / (Math.PI / 3)) % 3;
        }
        pts.push({ x: x + gaussian(rng) * sd, y: y + gaussian(rng) * sd, label });
      }
      break;
    }
    case 'circles': {
      const sd = 0.012 + 0.11 * noise;
      const bands = C === 2 ? [[0, 0.38], [0.6, 0.9]] : [[0, 0.26], [0.42, 0.6], [0.76, 0.94]];
      for (let i = 0; i < n; i++) {
        const c = i % C;
        const [r0, r1] = bands[c];
        // area-uniform radius within the band
        const r = Math.sqrt(r0 * r0 + rng() * (r1 * r1 - r0 * r0)) + gaussian(rng) * sd;
        const t = rng() * Math.PI * 2;
        pts.push({ x: r * Math.cos(t), y: r * Math.sin(t), label: c });
      }
      break;
    }
    case 'spiral': {
      const sd = 0.015 + 0.09 * noise;
      for (let i = 0; i < n; i++) {
        const c = i % C;
        const s = rng();
        const r = 0.06 + 0.84 * s;
        const t = 1.6 * Math.PI * s * 1.5 + (2 * Math.PI * c) / C;
        pts.push({ x: r * Math.cos(t) + gaussian(rng) * sd, y: r * Math.sin(t) + gaussian(rng) * sd, label: c });
      }
      break;
    }
    case 'moons': {
      const sd = 0.03 + 0.2 * noise;
      for (let i = 0; i < n; i++) {
        const c = i % C;
        const t = rng() * Math.PI;
        const x = c + Math.cos(t);
        const y = c % 2 === 0 ? Math.sin(t) : 0.5 - Math.sin(t);
        pts.push({ x: x + gaussian(rng) * sd, y: y + gaussian(rng) * sd, label: c });
      }
      fitToBox(pts, 0.88);
      break;
    }
  }
  for (const p of pts) { p.x = clamp(p.x); p.y = clamp(p.y); }
  return pts;
}

/** Mark a random `testFrac` share of points as held-out test points (deterministic per seed). */
export function splitTrainTest(pts: LabeledPoint[], testFrac: number, seed: number): Sample[] {
  const idx = Array.from({ length: pts.length }, (_, i) => i);
  shuffleInPlace(idx, mulberry32(seed ^ 0x9e3779b9));
  const nTest = Math.round(pts.length * Math.max(0, Math.min(0.9, testFrac)));
  const isTest = new Uint8Array(pts.length);
  for (let i = 0; i < nTest; i++) isTest[idx[i]] = 1;
  return pts.map((p, i) => ({ x: p.x, y: p.y, label: p.label, test: !!isTest[i] }));
}
