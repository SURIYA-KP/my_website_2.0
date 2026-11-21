// Thumbnail and preview rendering with pdf.js (loaded lazily, worker served from our own origin).
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfJs = typeof import('pdfjs-dist');
let libP: Promise<PdfJs> | null = null;
export function pdfjs(): Promise<PdfJs> {
  if (!libP) {
    libP = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = workerUrl;
      return m;
    });
  }
  return libP;
}

const docs = new Map<string, Promise<PDFDocumentProxy>>();

/** Register PDF bytes for a source (they are only parsed by pdf.js when first needed). */
const pendingBytes = new Map<string, ArrayBuffer>();
export function registerPdf(id: string, bytes: ArrayBuffer) {
  pendingBytes.set(id, bytes);
}

export function openDoc(id: string): Promise<PDFDocumentProxy> {
  let p = docs.get(id);
  if (!p) {
    const bytes = pendingBytes.get(id);
    if (!bytes) return Promise.reject(new Error('missing source'));
    pendingBytes.delete(id);
    p = pdfjs().then((lib) => lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise);
    docs.set(id, p);
  }
  return p;
}

export async function closeAll() {
  pendingBytes.clear();
  const all = [...docs.values()];
  docs.clear();
  for (const p of all) p.then((d) => d.destroy()).catch(() => {});
}

/** Render a page into a canvas. `rotation` is the extra rotation on top of the page's own. */
export async function renderPage(id: string, index: number, targetW: number, targetH: number, rotation = 0, canvas = document.createElement('canvas')) {
  const doc = await openDoc(id);
  const page = await doc.getPage(index + 1);
  const rot = (((page.rotate + rotation) % 360) + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation: rot });
  const scale = Math.min(targetW / base.width, targetH / base.height);
  const viewport = page.getViewport({ scale, rotation: rot });
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
  page.cleanup();
  return canvas;
}

// ---- Thumbnail queue: few renders at a time, skip tiles that scrolled away ----
const thumbCache = new Map<string, string>(); // "src:page" -> object URL
const inflight = new Map<string, Promise<string>>();
interface Job { key: string; src: string; page: number; wanted: () => boolean; resolve: (u: string) => void; reject: (e: unknown) => void }
const queue: Job[] = [];
let running = 0;
const MAX = 3;

export function cachedThumb(src: string, page: number) {
  return thumbCache.get(`${src}:${page}`);
}

export function requestThumb(src: string, page: number, wanted: () => boolean): Promise<string> {
  const key = `${src}:${page}`;
  const hit = thumbCache.get(key);
  if (hit) return Promise.resolve(hit);
  const fly = inflight.get(key);
  if (fly) return fly;
  const p = new Promise<string>((resolve, reject) => {
    queue.push({ key, src, page, wanted, resolve, reject });
  });
  inflight.set(key, p);
  p.catch(() => {}).finally(() => inflight.delete(key));
  pump();
  return p;
}

function pump() {
  while (running < MAX && queue.length) {
    const job = queue.shift()!;
    if (!job.wanted()) {
      job.reject(new Error('skipped'));
      continue;
    }
    running++;
    const px = Math.min(2, window.devicePixelRatio || 1);
    renderPage(job.src, job.page, 180 * px, 220 * px)
      .then((canvas) => new Promise<string>((res, rej) => canvas.toBlob((b) => {
        canvas.width = canvas.height = 0;
        b ? res(URL.createObjectURL(b)) : rej(new Error('toBlob failed'));
      }, 'image/png')))
      .then((url) => { thumbCache.set(job.key, url); job.resolve(url); }, job.reject)
      .finally(() => { running--; pump(); });
  }
}

export function clearThumbs() {
  for (const u of thumbCache.values()) URL.revokeObjectURL(u);
  thumbCache.clear();
  queue.length = 0;
}
