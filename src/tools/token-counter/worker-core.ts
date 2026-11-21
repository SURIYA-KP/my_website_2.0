// Shared tokenizer worker logic. Each encoding gets its own tiny worker entry file that
// statically imports its rank table, so a rank file is only downloaded when that encoding
// is first used (and workers stay single-file bundles).
import { Tiktoken } from 'js-tiktoken/lite';
import type { TiktokenBPE } from 'js-tiktoken/lite';
import { encodeInChunks, textStats } from './core';

export type WorkerRequest =
  | { type: 'encode'; id: number; channel: string; text: string; allowSpecial: boolean; countOnly?: boolean }
  | { type: 'decode'; id: number; channel: string; ids: number[] };

export type WorkerResponse =
  | { type: 'ready'; encoding: string; vocab: number; ms: number }
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string }
  | {
      type: 'encoded';
      id: number;
      ids: Uint32Array;
      lens: Uint16Array | null;
      stats: ReturnType<typeof textStats> | null;
      ms: number;
    }
  | { type: 'decoded'; id: number; ids: Uint32Array; lens: Uint16Array; bytes: Uint8Array; text: string };

const SLICE_MS = 24;

export function startWorker(encoding: string, ranks: TiktokenBPE) {
  const post = (msg: WorkerResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  const t0 = performance.now();
  const enc = new Tiktoken(ranks);
  // Internal maps of js-tiktoken: rank -> bytes, special rank -> bytes.
  const textMap = (enc as any).textMap as Map<number, Uint8Array>;
  const special = (enc as any).inverseSpecialTokens as Record<number, Uint8Array>;
  const tokenBytes = (id: number) => textMap.get(id) ?? special[id];
  const vocab = textMap.size + Object.keys(ranks.special_tokens).length;
  post({ type: 'ready', encoding, vocab, ms: Math.round(performance.now() - t0) });

  const latest = new Map<string, number>();
  const superseded = (m: { id: number; channel: string }) => latest.get(m.channel) !== m.id;
  const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

  async function encodeJob(m: Extract<WorkerRequest, { type: 'encode' }>) {
    const start = performance.now();
    const stats = m.countOnly ? null : textStats(m.text);
    const ids: number[] = [];
    let slice = performance.now();
    for (const part of encodeInChunks(enc, ranks.pat_str, ranks.special_tokens, m.text, m.allowSpecial)) {
      for (let i = 0; i < part.ids.length; i++) ids.push(part.ids[i]);
      if (performance.now() - slice > SLICE_MS) {
        post({ type: 'progress', id: m.id, done: part.end, total: m.text.length });
        await yieldNow();
        if (superseded(m)) return post({ type: 'cancelled', id: m.id });
        slice = performance.now();
      }
    }
    if (superseded(m)) return post({ type: 'cancelled', id: m.id });
    const out = Uint32Array.from(ids);
    let lens: Uint16Array | null = null;
    if (!m.countOnly) {
      lens = new Uint16Array(out.length);
      for (let i = 0; i < out.length; i++) lens[i] = tokenBytes(out[i])?.length ?? 0;
    }
    post(
      { type: 'encoded', id: m.id, ids: out, lens, stats, ms: Math.round(performance.now() - start) },
      lens ? [out.buffer, lens.buffer] : [out.buffer],
    );
  }

  function decodeJob(m: Extract<WorkerRequest, { type: 'decode' }>) {
    const unknown = m.ids.filter((id) => !tokenBytes(id));
    if (unknown.length) {
      const list = [...new Set(unknown)].slice(0, 5).join(', ');
      return post({
        type: 'error',
        id: m.id,
        message: `Unknown token id${unknown.length > 1 ? 's' : ''} for ${encoding}: ${list}${unknown.length > 5 ? ', …' : ''}. Valid ids are 0 to ${vocab - 1}.`,
      });
    }
    const lens = new Uint16Array(m.ids.length);
    let total = 0;
    m.ids.forEach((id, i) => {
      lens[i] = tokenBytes(id).length;
      total += lens[i];
    });
    const bytes = new Uint8Array(total);
    let off = 0;
    m.ids.forEach((id) => {
      const b = tokenBytes(id);
      bytes.set(b, off);
      off += b.length;
    });
    const text = new TextDecoder('utf-8').decode(bytes);
    const ids = Uint32Array.from(m.ids);
    post({ type: 'decoded', id: m.id, ids, lens, bytes, text }, [ids.buffer, lens.buffer, bytes.buffer]);
  }

  self.onmessage = (e: MessageEvent<WorkerRequest>) => {
    const m = e.data;
    latest.set(m.channel, m.id);
    try {
      if (m.type === 'encode') {
        encodeJob(m).catch((err) => post({ type: 'error', id: m.id, message: String(err?.message || err) }));
      } else if (m.type === 'decode') {
        decodeJob(m);
      }
    } catch (err: any) {
      post({ type: 'error', id: m.id, message: String(err?.message || err) });
    }
  };
}
