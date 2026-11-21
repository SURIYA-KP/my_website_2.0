// Incremental hash implementations (MD5, SHA-1, SHA-256, SHA-384, SHA-512) and HMAC.
// WebCrypto has no MD5 and no streaming digest, so these let us hash huge files chunk by chunk.
// Self-contained (no imports) so it can run in a worker or in Node for verification.

export type HashAlgo = 'MD5' | 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
export const HASH_ALGOS: HashAlgo[] = ['MD5', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];
export const BLOCK_SIZE: Record<HashAlgo, number> = { MD5: 64, 'SHA-1': 64, 'SHA-256': 64, 'SHA-384': 128, 'SHA-512': 128 };

export interface Hasher {
  update(data: Uint8Array): Hasher;
  digest(): Uint8Array;
}

// ---------- Constants derived exactly with BigInt integer roots ----------
function iroot(n: bigint, k: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length) / k + 1n);
  for (;;) {
    const y = ((k - 1n) * x + n / x ** (k - 1n)) / k;
    if (y >= x) return x;
    x = y;
  }
}
const PRIMES: number[] = [];
for (let n = 2; PRIMES.length < 80; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const MASK64 = (1n << 64n) - 1n;
/** First 64 bits of the fractional part of the k-th root of p, split into [hi, lo] int32. */
function frac64(p: number, k: bigint): [number, number] {
  const v = iroot(BigInt(p) << (64n * k), k) & MASK64;
  return [Number(v >> 32n) | 0, Number(v & 0xffffffffn) | 0];
}
const K512 = new Int32Array(160);
PRIMES.forEach((p, i) => {
  const [h, l] = frac64(p, 3n);
  K512[2 * i] = h;
  K512[2 * i + 1] = l;
});
const K256 = new Int32Array(64);
for (let i = 0; i < 64; i++) K256[i] = K512[2 * i];
const IV512 = new Int32Array(16);
const IV384 = new Int32Array(16);
const IV256 = new Int32Array(8);
for (let i = 0; i < 8; i++) {
  const [h, l] = frac64(PRIMES[i], 2n);
  IV512[2 * i] = h;
  IV512[2 * i + 1] = l;
  IV256[i] = h;
  const [h2, l2] = frac64(PRIMES[i + 8], 2n);
  IV384[2 * i] = h2;
  IV384[2 * i + 1] = l2;
}

const be32 = (b: Uint8Array, o: number) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const le32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

abstract class BlockHasher implements Hasher {
  private buf: Uint8Array;
  private bufLen = 0;
  private total = 0;
  private done = false;
  constructor(private blockSize: number, private littleEndian: boolean) {
    this.buf = new Uint8Array(blockSize);
  }
  protected abstract block(b: Uint8Array, o: number): void;
  protected abstract output(): Uint8Array;
  update(data: Uint8Array) {
    if (this.done) throw new Error('Hasher already finalized');
    const bs = this.blockSize;
    const n = data.length;
    let i = 0;
    this.total += n;
    if (this.bufLen) {
      const take = Math.min(n, bs - this.bufLen);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen === bs) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    for (; i + bs <= n; i += bs) this.block(data, i);
    if (i < n) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = n - i;
    }
    return this;
  }
  digest() {
    const bs = this.blockSize;
    const lenBytes = bs === 128 ? 16 : 8;
    const bits = this.total * 8;
    const zeros = (((bs - lenBytes - 1 - this.bufLen) % bs) + bs) % bs;
    const p = new Uint8Array(1 + zeros + lenBytes);
    p[0] = 0x80;
    const dv = new DataView(p.buffer);
    const hi = Math.floor(bits / 4294967296) >>> 0;
    const lo = bits >>> 0;
    const end = p.length;
    if (this.littleEndian) {
      dv.setUint32(end - 8, lo, true);
      dv.setUint32(end - 4, hi, true);
    } else {
      dv.setUint32(end - 8, hi);
      dv.setUint32(end - 4, lo);
    }
    this.update(p);
    this.done = true;
    return this.output();
  }
}

function wordsOut(words: ArrayLike<number>, count: number, little: boolean) {
  const out = new Uint8Array(count * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < count; i++) dv.setUint32(i * 4, words[i] >>> 0, little);
  return out;
}

// ---------- MD5 ----------
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

class MD5 extends BlockHasher {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
  private m = new Int32Array(16);
  constructor() {
    super(64, true);
  }
  protected block(b: Uint8Array, o: number) {
    const m = this.m;
    for (let i = 0; i < 16; i++) m[i] = le32(b, o + i * 4);
    const h0 = this.h;
    let a = h0[0], bb = h0[1], c = h0[2], d = h0[3];
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) {
        f = (bb & c) | (~bb & d);
        g = i;
      } else if (i < 32) {
        f = (d & bb) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = bb ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (bb | ~d);
        g = (7 * i) & 15;
      }
      f = (f + a + MD5_K[i] + m[g]) | 0;
      a = d;
      d = c;
      c = bb;
      bb = (bb + rotl(f, MD5_S[(i >> 4) * 4 + (i & 3)])) | 0;
    }
    const h = this.h;
    h[0] += a;
    h[1] += bb;
    h[2] += c;
    h[3] += d;
  }
  protected output() {
    return wordsOut(this.h, 4, true);
  }
}

// ---------- SHA-1 ----------
class SHA1 extends BlockHasher {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0]);
  private w = new Int32Array(80);
  constructor() {
    super(64, false);
  }
  protected block(b: Uint8Array, o: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = be32(b, o + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    const h0 = this.h;
    let a = h0[0], bb = h0[1], c = h0[2], d = h0[3], e = h0[4];
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) {
        f = (bb & c) | (~bb & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = bb ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (bb & c) | (bb & d) | (c & d);
        k = 0x8f1bbcdc | 0;
      } else {
        f = bb ^ c ^ d;
        k = 0xca62c1d6 | 0;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(bb, 30);
      bb = a;
      a = t;
    }
    const h = this.h;
    h[0] += a;
    h[1] += bb;
    h[2] += c;
    h[3] += d;
    h[4] += e;
  }
  protected output() {
    return wordsOut(this.h, 5, false);
  }
}

// ---------- SHA-256 ----------
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
class SHA256 extends BlockHasher {
  private h = new Int32Array(IV256);
  private w = new Int32Array(64);
  constructor() {
    super(64, false);
  }
  protected block(b: Uint8Array, o: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = be32(b, o + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h0 = this.h;
    let a = h0[0], bb = h0[1], c = h0[2], d = h0[3], e = h0[4], f = h0[5], g = h0[6], hh = h0[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    const h = this.h;
    h[0] += a;
    h[1] += bb;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  protected output() {
    return wordsOut(this.h, 8, false);
  }
}

// ---------- SHA-512 / SHA-384 (64-bit words as hi/lo int32 pairs) ----------
const TWO32 = 4294967296;
// rotate-right of the 64-bit value (h,l) by n (n != 32), returning the high / low halves
const rH = (h: number, l: number, n: number) => (n < 32 ? (h >>> n) | (l << (32 - n)) : (l >>> (n - 32)) | (h << (64 - n)));
const rL = (h: number, l: number, n: number) => (n < 32 ? (l >>> n) | (h << (32 - n)) : (h >>> (n - 32)) | (l << (64 - n)));

class SHA512 extends BlockHasher {
  private h: Int32Array;
  private w = new Int32Array(160);
  constructor(private outBytes: 64 | 48 = 64) {
    super(128, false);
    this.h = new Int32Array(outBytes === 64 ? IV512 : IV384);
  }
  protected block(b: Uint8Array, o: number) {
    const w = this.w;
    for (let i = 0; i < 32; i++) w[i] = be32(b, o + i * 4);
    for (let t = 16; t < 80; t++) {
      let xh = w[2 * (t - 15)];
      let xl = w[2 * (t - 15) + 1];
      const s0h = rH(xh, xl, 1) ^ rH(xh, xl, 8) ^ (xh >>> 7);
      const s0l = rL(xh, xl, 1) ^ rL(xh, xl, 8) ^ ((xl >>> 7) | (xh << 25));
      xh = w[2 * (t - 2)];
      xl = w[2 * (t - 2) + 1];
      const s1h = rH(xh, xl, 19) ^ rH(xh, xl, 61) ^ (xh >>> 6);
      const s1l = rL(xh, xl, 19) ^ rL(xh, xl, 61) ^ ((xl >>> 6) | (xh << 26));
      const l = (s1l >>> 0) + (w[2 * (t - 7) + 1] >>> 0) + (s0l >>> 0) + (w[2 * (t - 16) + 1] >>> 0);
      w[2 * t] = s1h + w[2 * (t - 7)] + s0h + w[2 * (t - 16)] + ((l / TWO32) | 0);
      w[2 * t + 1] = l;
    }
    const H = this.h;
    let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
    let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (let t = 0; t < 80; t++) {
      const S1h = rH(eh, el, 14) ^ rH(eh, el, 18) ^ rH(eh, el, 41);
      const S1l = rL(eh, el, 14) ^ rL(eh, el, 18) ^ rL(eh, el, 41);
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);
      const t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512[2 * t + 1] >>> 0) + (w[2 * t + 1] >>> 0);
      const t1h = (hh + S1h + chh + K512[2 * t] + w[2 * t] + ((t1l / TWO32) | 0)) | 0;
      const S0h = rH(ah, al, 28) ^ rH(ah, al, 34) ^ rH(ah, al, 39);
      const S0l = rL(ah, al, 28) ^ rL(ah, al, 34) ^ rL(ah, al, 39);
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (S0l >>> 0) + (mjl >>> 0);
      const t2h = S0h + mjh + ((t2l / TWO32) | 0);
      hh = gh; hl = gl;
      gh = fh; gl = fl;
      fh = eh; fl = el;
      const el2 = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + ((el2 / TWO32) | 0)) | 0;
      el = el2 | 0;
      dh = ch; dl = cl;
      ch = bh; cl = bl;
      bh = ah; bl = al;
      const t1lw = t1l >>> 0;
      const al2 = t1lw + (t2l >>> 0);
      ah = (t1h + t2h + ((al2 / TWO32) | 0)) | 0;
      al = al2 | 0;
    }
    const add = (i: number, xh: number, xl: number) => {
      const l = (H[i + 1] >>> 0) + (xl >>> 0);
      H[i] = H[i] + xh + ((l / TWO32) | 0);
      H[i + 1] = l;
    };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl);
    add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  protected output() {
    return wordsOut(this.h, this.outBytes / 4, false);
  }
}

export function createHash(algo: HashAlgo): Hasher {
  switch (algo) {
    case 'MD5': return new MD5();
    case 'SHA-1': return new SHA1();
    case 'SHA-256': return new SHA256();
    case 'SHA-384': return new SHA512(48);
    case 'SHA-512': return new SHA512(64);
  }
  throw new Error(`Unknown hash ${algo}`);
}

export function createHmac(algo: HashAlgo, key: Uint8Array): Hasher {
  const bs = BLOCK_SIZE[algo];
  if (key.length > bs) key = createHash(algo).update(key).digest();
  const k = new Uint8Array(bs);
  k.set(key);
  const inner = createHash(algo).update(k.map((x) => x ^ 0x36));
  const opad = k.map((x) => x ^ 0x5c);
  return {
    update(d: Uint8Array) {
      inner.update(d);
      return this;
    },
    digest() {
      return createHash(algo).update(opad).update(inner.digest()).digest();
    },
  };
}

export function hashBytes(algo: HashAlgo, data: Uint8Array) {
  return createHash(algo).update(data).digest();
}
