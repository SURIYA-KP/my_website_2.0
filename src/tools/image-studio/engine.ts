// Job runner: a small pool of Web Workers using OffscreenCanvas, or the main thread as a fallback.
import { detectFormats, domEnv, processBitmap, type JobResult } from './pipeline';
import type { Edit, OutFormat, Settings } from './types';

export class Cancelled extends Error {
  constructor() { super('cancelled'); }
}

export interface JobInput {
  key: number;
  file: File;
  srcType: string;
  isSvg: boolean;
  settings: Settings;
  edit: Edit | null;
  onProgress?: (text: string) => void;
}

interface Pending {
  job: JobInput;
  resolve: (r: JobResult) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: Worker | null; // null = main thread
  busy: boolean;
  current?: Pending & { jobId: number };
}

/* ---------- Decoding on the main thread ---------- */

const UNIT: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, em: 16, ex: 8, rem: 16 };
function svgLength(v: string | null): number | null {
  if (!v) return null;
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v);
  if (!m || m[2] === '%') return null;
  const u = UNIT[m[2].toLowerCase()];
  return u ? parseFloat(m[1]) * u : null;
}

export interface SvgInfo { width: number; height: number; doc: Document }

export function parseSvg(text: string): SvgInfo {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.nodeName.toLowerCase() !== 'svg') throw new Error('This SVG file is not valid XML.');
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  let w = svgLength(root.getAttribute('width'));
  let h = svgLength(root.getAttribute('height'));
  if (w && !h) h = hasVb ? (w * vb[3]) / vb[2] : 150;
  if (h && !w) w = hasVb ? (h * vb[2]) / vb[3] : 300;
  if (!w || !h) [w, h] = hasVb ? [vb[2], vb[3]] : [300, 150];
  if (!hasVb) root.setAttribute('viewBox', `0 0 ${w} ${h}`);
  return { width: w, height: h, doc };
}

const MAX_SIDE = 16384;
const MAX_AREA = 80e6;

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw new Error('The browser could not decode this image.');
  }
  return img;
}

/** Rasterize an SVG file at `scale` × its intrinsic size. */
export async function rasterizeSvg(file: Blob, scale: number): Promise<ImageBitmap> {
  const info = parseSvg(await file.text());
  let s = Math.max(0.05, scale);
  s = Math.min(s, MAX_SIDE / info.width, MAX_SIDE / info.height, Math.sqrt(MAX_AREA / (info.width * info.height)));
  const W = Math.max(1, Math.round(info.width * s));
  const H = Math.max(1, Math.round(info.height * s));
  const root = info.doc.documentElement;
  root.setAttribute('width', String(W));
  root.setAttribute('height', String(H));
  const blob = new Blob([new XMLSerializer().serializeToString(info.doc)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d')!.drawImage(img, 0, 0, W, H);
    return await createImageBitmap(c);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode any supported file to an oriented ImageBitmap on the main thread. */
export async function decodeOnMain(file: File, isSvg: boolean, svgScale: number): Promise<ImageBitmap> {
  if (isSvg) return rasterizeSvg(file, svgScale);
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Some browsers decode a few formats only through <img> (which also honors EXIF orientation).
    const url = URL.createObjectURL(file);
    try {
      return await createImageBitmap(await loadImage(url));
    } catch {
      throw new Error('This file could not be decoded by your browser. Is it a valid image?');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/* ---------- Engine ---------- */

export class Engine {
  mode: 'worker' | 'main' = 'main';
  supported: OutFormat[] = ['jpeg', 'png'];
  private slots: Slot[] = [];
  private queue: Pending[] = [];
  private nextId = 1;

  async init(): Promise<void> {
    const size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    try {
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('unsupported');
      const first = await this.spawn();
      this.supported = first.supported;
      this.slots.push({ worker: first.worker, busy: false });
      for (let i = 1; i < size; i++) {
        this.spawn().then(
          (w) => { this.slots.push({ worker: w.worker, busy: false }); this.pump(); },
          () => {},
        );
      }
      this.mode = 'worker';
    } catch {
      this.mode = 'main';
      this.supported = await detectFormats(domEnv);
      this.slots = [{ worker: null, busy: false }];
    }
  }

  private spawn(): Promise<{ worker: Worker; supported: OutFormat[] }> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module' });
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timeout')); }, 5000);
      worker.onmessage = (e) => {
        if (e.data?.type !== 'ready') return;
        clearTimeout(timer);
        if (e.data.error) { worker.terminate(); reject(new Error(e.data.error)); return; }
        worker.onmessage = (ev) => this.onWorkerMessage(worker, ev.data);
        worker.onerror = (ev) => { ev.preventDefault(); this.onWorkerCrash(worker); };
        resolve({ worker, supported: e.data.supported });
      };
      worker.onerror = (ev) => { ev.preventDefault(); clearTimeout(timer); worker.terminate(); reject(new Error('worker failed')); };
      worker.postMessage({ type: 'init' });
    });
  }

  /** Queue a job. A queued (not yet started) job with the same key is cancelled. */
  run(job: JobInput): Promise<JobResult> {
    this.cancel(job.key);
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  cancel(key?: number) {
    this.queue = this.queue.filter((p) => {
      if (key === undefined || p.job.key === key) { p.reject(new Cancelled()); return false; }
      return true;
    });
  }

  get busy() {
    return this.queue.length > 0 || this.slots.some((s) => s.busy);
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy || !this.queue.length) continue;
      const p = this.queue.shift()!;
      slot.busy = true;
      const jobId = this.nextId++;
      slot.current = { ...p, jobId };
      if (slot.worker) this.startOnWorker(slot, p, jobId);
      else this.startOnMain(slot, p);
    }
  }

  private finish(slot: Slot) {
    slot.busy = false;
    slot.current = undefined;
    this.pump();
  }

  private opts(job: JobInput) {
    return { settings: job.settings, edit: job.edit, srcType: job.srcType, srcBytes: job.file.size };
  }

  private async startOnWorker(slot: Slot, p: Pending, jobId: number, forceBitmap = false) {
    const { job } = p;
    try {
      if (job.isSvg || forceBitmap) {
        job.onProgress?.('Decoding');
        const bitmap = await decodeOnMain(job.file, job.isSvg, job.settings.svgScale);
        slot.worker!.postMessage({ type: 'process', jobId, bitmap, opts: this.opts(job) }, [bitmap]);
      } else {
        slot.worker!.postMessage({ type: 'process', jobId, blob: job.file, opts: this.opts(job) });
      }
    } catch (e) {
      p.reject(e);
      this.finish(slot);
    }
  }

  private onWorkerMessage(worker: Worker, m: any) {
    const slot = this.slots.find((s) => s.worker === worker);
    const cur = slot?.current;
    if (!slot || !cur || cur.jobId !== m.jobId) return;
    if (m.type === 'progress') cur.job.onProgress?.(m.text);
    else if (m.type === 'decode-failed') this.startOnWorker(slot, cur, cur.jobId, true);
    else if (m.type === 'done') { cur.resolve(m.result); this.finish(slot); }
    else if (m.type === 'error') { cur.reject(new Error(m.message)); this.finish(slot); }
  }

  private onWorkerCrash(worker: Worker) {
    const slot = this.slots.find((s) => s.worker === worker);
    if (!slot) return;
    slot.current?.reject(new Error('The image worker crashed (the image may be too large for available memory).'));
    worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
    this.spawn().then(
      (w) => { this.slots.push({ worker: w.worker, busy: false }); this.pump(); },
      () => {
        if (!this.slots.length) { this.mode = 'main'; this.slots.push({ worker: null, busy: false }); this.pump(); }
      },
    );
  }

  private async startOnMain(slot: Slot, p: Pending) {
    const { job } = p;
    try {
      job.onProgress?.('Decoding');
      await new Promise((r) => setTimeout(r, 0));
      const bmp = await decodeOnMain(job.file, job.isSvg, job.settings.svgScale);
      try {
        const result = await processBitmap(domEnv, bmp, { ...this.opts(job), supported: this.supported }, async (t) => {
          job.onProgress?.(t);
        });
        p.resolve(result);
      } finally {
        bmp.close();
      }
    } catch (e) {
      p.reject(e);
    }
    // Yield so the UI can paint between images.
    setTimeout(() => this.finish(slot), 0);
  }
}
