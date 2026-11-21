/// <reference lib="webworker" />
// PDF writing happens here (pdf-lib + fflate) so big documents never freeze the page.
import { PDFDocument, PDFPage, PDFImage, degrees, rgb, StandardFonts, EncryptedPDFError } from 'pdf-lib';
import { zipSync } from 'fflate';

type Source =
  | { kind: 'pdf'; doc: PDFDocument }
  | { kind: 'image'; bytes: Uint8Array; mime: 'png' | 'jpg'; w: number; h: number };

export type PlanPage =
  | { kind: 'pdf'; src: string; index: number; rot: number }
  | { kind: 'image'; src: string; rot: number }
  | { kind: 'blank'; w: number; h: number; rot: number };

export interface BuildOptions {
  imageSize: 'fit' | 'a4' | 'letter';
  marginMm: number;
  title?: string;
  author?: string;
}

const sources = new Map<string, Source>();
const norm = (d: number) => (((Math.round(d / 90) * 90) % 360) + 360) % 360;

class CodedError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function post(msg: unknown, transfer: Transferable[] = []) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

async function addPdf(id: string, bytes: Uint8Array) {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypt/i.test(String((e as Error)?.message))) throw new CodedError('encrypted', 'Encrypted PDF');
    throw new CodedError('corrupt', (e as Error)?.message || 'Could not parse PDF');
  }
  let pages: PDFPage[];
  try {
    pages = doc.getPages();
  } catch (e) {
    throw new CodedError('corrupt', (e as Error)?.message || 'Missing page tree');
  }
  if (!pages.length) throw new CodedError('corrupt', 'The PDF has no pages');
  sources.set(id, { kind: 'pdf', doc });
  return {
    pages: pages.map((p) => {
      let box = { width: 612, height: 792 };
      try { box = p.getCropBox(); } catch { try { box = p.getSize(); } catch { /* default */ } }
      const rot = norm(p.getRotation().angle || 0);
      const w = Math.abs(box.width) || 612;
      const h = Math.abs(box.height) || 792;
      return rot % 180 ? { w: h, h: w, rot } : { w, h, rot };
    }),
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
  };
}

const PAGE = { a4: [595.28, 841.89], letter: [612, 792] } as const;

async function buildDoc(pages: PlanPage[], opts: BuildOptions, progress: (done: number) => void): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  // Copy pages per source in one call so shared fonts/images are only written once.
  const wanted = new Map<string, number[]>();
  for (const p of pages) if (p.kind === 'pdf') (wanted.get(p.src) ?? wanted.set(p.src, []).get(p.src)!).push(p.index);
  const copied = new Map<string, PDFPage[]>();
  for (const [src, idx] of wanted) {
    const s = sources.get(src);
    if (!s || s.kind !== 'pdf') throw new Error('A source file is missing. Please add it again.');
    copied.set(src, await out.copyPages(s.doc, idx));
  }
  const used = new Map<string, number>();
  const images = new Map<string, PDFImage>();
  const margin = (Math.max(0, opts.marginMm || 0) * 72) / 25.4;
  let done = 0;
  for (const p of pages) {
    if (p.kind === 'pdf') {
      const k = used.get(p.src) ?? 0;
      used.set(p.src, k + 1);
      const page = copied.get(p.src)![k];
      out.addPage(page);
      page.setRotation(degrees(norm((page.getRotation().angle || 0) + p.rot)));
    } else if (p.kind === 'image') {
      const s = sources.get(p.src);
      if (!s || s.kind !== 'image') throw new Error('An image is missing. Please add it again.');
      let img = images.get(p.src);
      if (!img) {
        img = s.mime === 'png' ? await out.embedPng(s.bytes) : await out.embedJpg(s.bytes);
        images.set(p.src, img);
      }
      let pw: number, ph: number, dw: number, dh: number;
      if (opts.imageSize === 'fit') {
        dw = s.w * 0.75; // CSS pixels at 96 dpi -> points
        dh = s.h * 0.75;
        pw = dw + 2 * margin;
        ph = dh + 2 * margin;
      } else {
        const [a, b] = PAGE[opts.imageSize];
        const landscape = s.w > s.h;
        pw = landscape ? b : a;
        ph = landscape ? a : b;
        const availW = Math.max(1, pw - 2 * margin);
        const availH = Math.max(1, ph - 2 * margin);
        const scale = Math.min(availW / s.w, availH / s.h);
        dw = s.w * scale;
        dh = s.h * scale;
      }
      const page = out.addPage([pw, ph]);
      page.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      if (p.rot) page.setRotation(degrees(norm(p.rot)));
    } else {
      const page = out.addPage([p.w, p.h]);
      if (p.rot) page.setRotation(degrees(norm(p.rot)));
    }
    done++;
    if (done % 10 === 0) progress(done);
  }
  if (opts.title) out.setTitle(opts.title, { showInWindowTitleBar: true });
  if (opts.author) out.setAuthor(opts.author);
  out.setProducer('PDF Toolkit (Browser Tools, pdf-lib)');
  out.setCreator('PDF Toolkit');
  return out.save({ useObjectStreams: true });
}

async function makeSamples() {
  const palette = [rgb(0.31, 0.27, 0.9), rgb(0.03, 0.57, 0.7), rgb(0.85, 0.47, 0.02), rgb(0.86, 0.15, 0.47), rgb(0.09, 0.64, 0.29)];
  const make = async (title: string, n: number, size: [number, number], color: number) => {
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.setTitle(title);
    for (let i = 1; i <= n; i++) {
      const page = doc.addPage(size);
      const [w, h] = size;
      const c = palette[(color + i - 1) % palette.length];
      page.drawRectangle({ x: 0, y: h - 70, width: w, height: 70, color: c });
      page.drawText(title, { x: 32, y: h - 46, size: 22, font: bold, color: rgb(1, 1, 1) });
      page.drawText(`Page ${i} of ${n}`, { x: 32, y: h - 120, size: 16, font, color: rgb(0.2, 0.2, 0.2) });
      page.drawText(String(i), { x: w / 2 - 40, y: h / 2 - 60, size: 160, font: bold, color: c, opacity: 0.85 });
      for (let l = 0; l < 6; l++) {
        page.drawRectangle({ x: 32, y: 150 - l * 18, width: (w - 64) * (0.55 + ((l * 37 + i * 13) % 40) / 100), height: 8, color: rgb(0.85, 0.85, 0.85) });
      }
    }
    return doc.save();
  };
  return {
    a: await make('Quarterly report', 5, [595.28, 841.89], 0),
    b: await make('Slides', 3, [792, 612], 2),
  };
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'addPdf') {
      post({ id, ok: true, result: await addPdf(payload.id, new Uint8Array(payload.bytes)) });
    } else if (type === 'addImage') {
      sources.set(payload.id, { kind: 'image', bytes: new Uint8Array(payload.bytes), mime: payload.mime, w: payload.w, h: payload.h });
      post({ id, ok: true, result: true });
    } else if (type === 'drop') {
      for (const s of payload.ids as string[]) sources.delete(s);
      post({ id, ok: true, result: true });
    } else if (type === 'build') {
      const total = payload.pages.length;
      const bytes = await buildDoc(payload.pages, payload.options, (d) => post({ id, progress: d / total }));
      post({ id, ok: true, result: bytes }, [bytes.buffer]);
    } else if (type === 'split') {
      const groups: { name: string; pages: PlanPage[] }[] = payload.groups;
      const total = groups.reduce((n, g) => n + g.pages.length, 0);
      let base = 0;
      const files: Record<string, Uint8Array> = {};
      for (const g of groups) {
        files[g.name] = await buildDoc(g.pages, payload.options, (d) => post({ id, progress: (base + d) / total }));
        base += g.pages.length;
        post({ id, progress: base / total });
      }
      const zip = zipSync(files, { level: 0 }); // PDFs are already compressed
      post({ id, ok: true, result: zip }, [zip.buffer]);
    } else if (type === 'samples') {
      const r = await makeSamples();
      post({ id, ok: true, result: r }, [r.a.buffer, r.b.buffer]);
    } else {
      throw new Error(`Unknown message ${type}`);
    }
  } catch (err) {
    const er = err as CodedError;
    post({ id, ok: false, error: { code: er?.code || 'error', message: er?.message || String(err) } });
  }
};
