/// <reference lib="webworker" />
// Decodes and re-encodes images off the main thread with OffscreenCanvas.
import { detectFormats, offscreenEnv, processBitmap, type JobOptions } from './pipeline';
import type { OutFormat } from './types';

let supported: OutFormat[] = ['jpeg', 'png'];
const post = (msg: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') throw new Error('no OffscreenCanvas');
      const c = new OffscreenCanvas(1, 1);
      if (!c.getContext('2d') || typeof c.convertToBlob !== 'function') throw new Error('no 2d context');
      supported = await detectFormats(offscreenEnv);
      post({ type: 'ready', supported });
    } catch (err) {
      post({ type: 'ready', error: String((err as Error)?.message || err) });
    }
    return;
  }
  if (m.type !== 'process') return;
  const { jobId } = m;
  let bmp: ImageBitmap | undefined = m.bitmap;
  if (!bmp) {
    try {
      bmp = await createImageBitmap(m.blob as Blob, { imageOrientation: 'from-image' });
    } catch {
      post({ type: 'decode-failed', jobId });
      return;
    }
  }
  try {
    const opts: JobOptions = { ...(m.opts as Omit<JobOptions, 'supported'>), supported };
    const result = await processBitmap(offscreenEnv, bmp, opts, (text) => post({ type: 'progress', jobId, text }));
    post({ type: 'done', jobId, result });
  } catch (err) {
    post({ type: 'error', jobId, message: String((err as Error)?.message || err) });
  } finally {
    bmp.close();
  }
};
