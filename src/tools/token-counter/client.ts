// Main-thread side of the tokenizer workers: lazy creation per encoding, request ids,
// and "latest request wins" per channel so stale results are dropped.
import type { EncodingName } from './core';
import type { WorkerRequest, WorkerResponse } from './worker-core';

type Encoded = Extract<WorkerResponse, { type: 'encoded' }>;
type Decoded = Extract<WorkerResponse, { type: 'decoded' }>;

interface Pending {
  channel: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

function createWorker(name: EncodingName): Worker {
  // Literal URLs so Vite bundles each worker (and its rank file) separately.
  switch (name) {
    case 'o200k_base':
      return new Worker(new URL('./o200k.worker.ts', import.meta.url), { type: 'module', name: 'tok-o200k' });
    case 'cl100k_base':
      return new Worker(new URL('./cl100k.worker.ts', import.meta.url), { type: 'module', name: 'tok-cl100k' });
    case 'p50k_base':
      return new Worker(new URL('./p50k.worker.ts', import.meta.url), { type: 'module', name: 'tok-p50k' });
  }
}

class EncoderHandle {
  readonly name: EncodingName;
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private latest = new Map<string, number>();
  private readyResolvers: (() => void)[] = [];
  ready = false;
  vocab = 0;
  failed: string | null = null;

  constructor(name: EncodingName) {
    this.name = name;
  }

  private ensure() {
    if (this.worker) return this.worker;
    this.failed = null;
    const w = createWorker(this.name);
    w.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
    w.onerror = (e) => {
      e.preventDefault?.();
      this.fail(`The ${this.name} tokenizer failed to load${e.message ? `: ${e.message}` : ''}. Reload the page to retry.`);
    };
    this.worker = w;
    return w;
  }

  private fail(message: string) {
    this.failed = message;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
    notifyStatus();
  }

  private handle(m: WorkerResponse) {
    if (m.type === 'ready') {
      this.ready = true;
      this.vocab = m.vocab;
      this.readyResolvers.splice(0).forEach((r) => r());
      notifyStatus();
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') {
      if (this.latest.get(p.channel) === m.id) p.onProgress?.(m.done, m.total);
      return;
    }
    this.pending.delete(m.id);
    const stale = this.latest.get(p.channel) !== m.id;
    if (m.type === 'cancelled' || stale) return p.resolve(null);
    if (m.type === 'error') return p.reject(new Error(m.message));
    p.resolve(m);
  }

  /** Start loading the worker + rank file without sending work. */
  preload() {
    this.ensure();
  }

  whenReady(): Promise<void> {
    this.ensure();
    if (this.ready) return Promise.resolve();
    return new Promise((r) => this.readyResolvers.push(r));
  }

  private send<T>(req: WorkerRequest, onProgress?: Pending['onProgress']): Promise<T | null> {
    const w = this.ensure();
    this.latest.set(req.channel, req.id);
    return new Promise<T | null>((resolve, reject) => {
      this.pending.set(req.id, { channel: req.channel, resolve, reject, onProgress });
      w.postMessage(req);
    });
  }

  /** Resolves to null when a newer request on the same channel replaced this one. */
  encode(channel: string, text: string, opts: { allowSpecial: boolean; countOnly?: boolean }, onProgress?: Pending['onProgress']) {
    return this.send<Encoded>({ type: 'encode', id: nextId(), channel, text, ...opts }, onProgress);
  }

  decode(channel: string, ids: number[]) {
    return this.send<Decoded>({ type: 'decode', id: nextId(), channel, ids });
  }
}

let idCounter = 0;
const nextId = () => ++idCounter;

const handles = new Map<EncodingName, EncoderHandle>();
export function encoder(name: EncodingName): EncoderHandle {
  let h = handles.get(name);
  if (!h) {
    h = new EncoderHandle(name);
    handles.set(name, h);
  }
  return h;
}

export type { Encoded, Decoded, EncoderHandle };

const statusListeners = new Set<() => void>();
function notifyStatus() {
  statusListeners.forEach((l) => l());
}
/** Called whenever any encoder becomes ready or fails. */
export function onEncoderStatus(cb: () => void) {
  statusListeners.add(cb);
}
