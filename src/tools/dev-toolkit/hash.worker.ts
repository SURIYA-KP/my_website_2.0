// Hashes a File in chunks so any size works without freezing the page or loading it all into memory.
import { createHash, createHmac, type HashAlgo, type Hasher } from './hashes';

const CHUNK = 4 * 1024 * 1024;

self.onmessage = async (e: MessageEvent<{ id: number; file: File; algos: HashAlgo[]; key: Uint8Array | null }>) => {
  const { id, file, algos, key } = e.data;
  try {
    const hashers: [HashAlgo, Hasher][] = algos.map((a) => [a, key ? createHmac(a, key) : createHash(a)]);
    let last = 0;
    for (let off = 0; off < file.size; off += CHUNK) {
      const buf = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
      for (const [, h] of hashers) h.update(buf);
      const now = performance.now();
      if (now - last > 80) {
        last = now;
        (self as any).postMessage({ id, progress: Math.min(off + CHUNK, file.size) / file.size });
      }
    }
    const results: Record<string, Uint8Array> = {};
    for (const [a, h] of hashers) results[a] = h.digest();
    (self as any).postMessage({ id, results });
  } catch (err: any) {
    (self as any).postMessage({ id, error: err?.message || String(err) });
  }
};
