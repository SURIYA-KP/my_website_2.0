// Pure helpers for the token counter. No DOM, no workers: usable in the browser,
// in the tokenizer workers and directly from Node tests (type-strippable TS only).

export type EncodingName = 'o200k_base' | 'cl100k_base' | 'p50k_base';

export const ENCODINGS: { name: EncodingName; label: string; short: string; models: string; size: string }[] = [
  { name: 'o200k_base', label: 'o200k_base', short: 'o200k', models: 'GPT-4o · GPT-4.1 · o-series', size: '2.3 MB' },
  { name: 'cl100k_base', label: 'cl100k_base', short: 'cl100k', models: 'GPT-4 · GPT-3.5 · embeddings', size: '1.1 MB' },
  { name: 'p50k_base', label: 'p50k_base', short: 'p50k', models: 'Codex · text-davinci', size: '0.5 MB' },
];

export function isEncodingName(s: string): s is EncodingName {
  return ENCODINGS.some((e) => e.name === s);
}

/** Minimal surface of js-tiktoken's Tiktoken that we rely on. */
export interface EncoderLike {
  encode(text: string, allowedSpecial?: string[] | 'all', disallowedSpecial?: string[] | 'all'): number[];
}

function escapeRegex(s: string) {
  return s.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Encode `text` in pieces so a worker can yield between them (progress + cancellation).
 * Produces exactly the same ids as `enc.encode(text, allowSpecial ? 'all' : [], [])`:
 * the text is first split on special tokens (only when allowed, like tiktoken does), then
 * each ordinary segment is cut only at boundaries of the encoding's own pre-tokenizer regex,
 * so no BPE piece ever spans two chunks.
 */
export function* encodeInChunks(
  enc: EncoderLike,
  patStr: string,
  specialTokens: Record<string, number>,
  text: string,
  allowSpecial: boolean,
  chunkChars = 32768,
): Generator<{ ids: number[]; end: number }> {
  const parts: { start: number; end: number; special?: number }[] = [];
  const specials = Object.keys(specialTokens);
  if (allowSpecial && specials.length) {
    const re = new RegExp(specials.map(escapeRegex).join('|'), 'g');
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index! > last) parts.push({ start: last, end: m.index! });
      parts.push({ start: m.index!, end: m.index! + m[0].length, special: specialTokens[m[0]] });
      last = m.index! + m[0].length;
    }
    if (last < text.length) parts.push({ start: last, end: text.length });
  } else if (text.length) {
    parts.push({ start: 0, end: text.length });
  }

  for (const p of parts) {
    if (p.special !== undefined) {
      yield { ids: [p.special], end: p.end };
      continue;
    }
    if (p.end - p.start <= chunkChars) {
      yield { ids: enc.encode(text.slice(p.start, p.end), [], []), end: p.end };
      continue;
    }
    const seg = text.slice(p.start, p.end);
    const re = new RegExp(patStr, 'gu');
    let chunkStart = 0;
    for (const m of seg.matchAll(re)) {
      const mEnd = m.index! + m[0].length;
      if (mEnd - chunkStart >= chunkChars) {
        yield { ids: enc.encode(seg.slice(chunkStart, mEnd), [], []), end: p.start + mEnd };
        chunkStart = mEnd;
      }
    }
    if (chunkStart < seg.length) yield { ids: enc.encode(seg.slice(chunkStart), [], []), end: p.end };
  }
}

export interface TextStats {
  chars: number; // Unicode code points
  words: number;
  lines: number;
  bytes: number; // UTF-8
}

export function textStats(text: string): TextStats {
  let chars = 0;
  let bytes = 0;
  let lines = text.length ? 1 : 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        chars++;
        bytes += 4;
        i++;
        continue;
      }
    }
    chars++;
    if (c === 10) lines++;
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  let words = 0;
  const re = /\S+/g;
  while (re.exec(text)) words++;
  return { chars, words, lines, bytes };
}

export type Utf8Segment = { text: string } | { bytes: number[] };

const td = /* @__PURE__ */ new TextDecoder('utf-8');

/**
 * Split one token's raw bytes into decodable text and stray bytes. Byte-level BPE tokens
 * can start or end in the middle of a multi-byte UTF-8 character (common for emoji and CJK);
 * those leftover bytes are returned separately so the UI can show a byte placeholder
 * instead of a misleading U+FFFD.
 */
export function splitUtf8(bytes: Uint8Array): Utf8Segment[] {
  const out: Utf8Segment[] = [];
  const pushText = (s: string) => {
    const last = out[out.length - 1];
    if (last && 'text' in last) last.text += s;
    else out.push({ text: s });
  };
  const pushByte = (b: number) => {
    const last = out[out.length - 1];
    if (last && 'bytes' in last) last.bytes.push(b);
    else out.push({ bytes: [b] });
  };
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    const need = b < 0x80 ? 1 : b >> 5 === 6 ? 2 : b >> 4 === 14 ? 3 : b >> 3 === 30 ? 4 : 0;
    if (need === 1) {
      // Fast path for ASCII runs
      let j = i;
      while (j < n && bytes[j] < 0x80) j++;
      pushText(String.fromCharCode(...bytes.subarray(i, j)));
      i = j;
      continue;
    }
    let ok = need > 0 && i + need <= n;
    for (let k = 1; ok && k < need; k++) if ((bytes[i + k] & 0xc0) !== 0x80) ok = false;
    if (ok) {
      pushText(td.decode(bytes.subarray(i, i + need)));
      i += need;
    } else {
      pushByte(b);
      i++;
    }
  }
  return out;
}

export function hexByte(b: number) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Parse a list of token ids such as "[9906, 1917]", "9906 1917" or one id per line.
 * Throws an Error with a user-facing message on invalid input.
 */
export function parseTokenIds(input: string): number[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const body = trimmed.replace(/^\[/, '').replace(/\]$/, '');
  const parts = body.split(/[\s,;]+/).filter(Boolean);
  const ids: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) {
      const shown = p.length > 24 ? `${p.slice(0, 24)}…` : p;
      throw new Error(`"${shown}" is not a token id. Use whole numbers separated by commas or spaces.`);
    }
    const n = Number(p);
    if (!Number.isSafeInteger(n)) throw new Error(`${p} is too large to be a token id.`);
    ids.push(n);
  }
  return ids;
}

/** Rough multipliers relative to the o200k_base count. Heuristics, not tokenizers. */
export const APPROX_MODELS = [
  {
    key: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    factor: 1.2,
    spread: 0.2,
    note: 'Anthropic does not publish an offline tokenizer. Claude counts are often somewhat higher than o200k for the same text.',
  },
  {
    key: 'gemini',
    name: 'Gemini',
    vendor: 'Google',
    factor: 1.05,
    spread: 0.2,
    note: 'Uses its own SentencePiece-style vocabulary. Often in the same ballpark as o200k for English; code and other languages vary more.',
  },
  {
    key: 'llama',
    name: 'Llama 3.x',
    vendor: 'Meta',
    factor: 1.05,
    spread: 0.15,
    note: 'Llama 3 uses a large BPE vocabulary similar in spirit to tiktoken, so counts are usually close. Older Llama 2 models use far more tokens.',
  },
] as const;

export interface Approx {
  mid: number;
  low: number;
  high: number;
  plusMinus: number;
}

export function approximate(o200kCount: number, factor: number, spread: number): Approx {
  const mid = Math.round(o200kCount * factor);
  const plusMinus = Math.round(mid * spread);
  return { mid, low: Math.max(0, mid - plusMinus), high: mid + plusMinus, plusMinus };
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  inputPricePerM: number;
  outputPricePerM: number;
  requests: number;
}

export function estimateCost(c: CostInput) {
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const req = Math.max(1, Math.floor(safe(c.requests)) || 1);
  const input = (safe(c.inputTokens) * safe(c.inputPricePerM)) / 1_000_000;
  const output = (safe(c.outputTokens) * safe(c.outputPricePerM)) / 1_000_000;
  const perRequest = input + output;
  return { input, output, perRequest, total: perRequest * req, requests: req };
}

export function formatUSD(n: number) {
  if (!Number.isFinite(n)) return '–';
  if (n === 0) return '$0.00';
  const abs = Math.abs(n);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

export function formatInt(n: number) {
  return Math.round(n).toLocaleString('en-US');
}

/** "8K", "128K", "1M", "1.05M" — short label for a context size. */
export function formatContext(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '–';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) {
    // 8192 -> 8K, 32768 -> 32K, 128000 -> 128K
    const k = n % 1024 === 0 ? n / 1024 : n / 1000;
    return `${+k.toFixed(1)}K`;
  }
  return String(n);
}
