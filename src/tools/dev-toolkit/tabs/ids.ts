import { downloadText, toast } from '../../../lib/ui';
import { $, randomBytes, randomInt, bytesToHex, segmented, kvRow, setStatus, relativeTime } from '../util';

// ---------------------------------------------------------------- generators
const hyphenate = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

export function uuidv4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return hyphenate(bytesToHex(b));
}

// UUID v7 (RFC 9562 §5.7): 48-bit Unix ms, version, then 74 random bits.
// Monotonic (RFC 9562 §6.2, method 2): within the same millisecond the 74-bit random field is
// incremented by a random amount, so IDs generated in one session always sort in creation order.
const R74 = (1n << 74n) - 1n;
let v7LastMs = -1;
let v7LastRand = 0n;
const randBig = (bytes: number) => BigInt(`0x${bytesToHex(randomBytes(bytes))}`);
export function uuidv7(nowMs = Date.now()) {
  let ms = nowMs;
  let rand: bigint;
  if (ms <= v7LastMs) {
    ms = v7LastMs;
    rand = v7LastRand + 1n + (randBig(4) & 0xffffffn);
    if (rand > R74) {
      ms++;
      rand = randBig(10) & (R74 >> 1n); // fresh value in the lower half leaves room to keep counting
    }
  } else rand = randBig(10) & R74;
  v7LastMs = ms;
  v7LastRand = rand;
  const randA = (rand >> 62n) & 0xfffn;
  const randB = rand & ((1n << 62n) - 1n);
  const hex =
    ms.toString(16).padStart(12, '0') +
    (0x7000n | randA).toString(16).padStart(4, '0') +
    ((0x2n << 62n) | randB).toString(16).padStart(16, '0');
  return hyphenate(hex);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let ulidLastMs = -1;
let ulidLastRand = 0n;
export function ulid(nowMs = Date.now()) {
  let ms = nowMs;
  let rand: bigint;
  if (ms <= ulidLastMs) {
    ms = ulidLastMs;
    rand = ulidLastRand + 1n;
    if (rand >= 1n << 80n) {
      ms++;
      rand = randBig(10) >> 1n;
    }
  } else rand = randBig(10);
  ulidLastMs = ms;
  ulidLastRand = rand;
  let out = '';
  let t = BigInt(ms);
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[Number(t & 31n)] + out;
    t >>= 5n;
  }
  let r = '';
  for (let i = 0; i < 16; i++) {
    r = CROCKFORD[Number(rand & 31n)] + r;
    rand >>= 5n;
  }
  return out + r;
}

const ALPHABETS: Record<string, string> = {
  url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  hex: '0123456789abcdef',
  num: '0123456789',
  nolook: '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz',
};
export function nanoid(size: number, alphabet: string) {
  let s = '';
  for (let i = 0; i < size; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

// ---------------------------------------------------------------- inspector
const GREGORIAN_OFFSET = 122192928000000000n; // 100-ns intervals between 1582-10-15 and 1970-01-01
function inspect(raw: string): { rows: [string, string][]; error?: string } {
  const s = raw.trim().replace(/^urn:uuid:/i, '').replace(/^\{|\}$/g, '');
  if (!s) return { rows: [] };
  if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(s)) {
    const up = s.toUpperCase();
    let ms = 0;
    for (const c of up.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(c);
    const d = new Date(ms);
    return {
      rows: [
        ['Type', 'ULID'],
        ['Timestamp', `${d.toISOString()} (${relativeTime(ms)})`],
        ['Unix ms', String(ms)],
        ['Randomness', up.slice(10)],
      ],
    };
  }
  const hex = s.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex) || (s.includes('-') && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)))
    return { rows: [], error: 'Not a UUID (32 hex digits, usually as 8-4-4-4-12) or a ULID (26 Crockford Base32 characters).' };
  const canonical = hyphenate(hex);
  if (/^0+$/.test(hex)) return { rows: [['Canonical', canonical], ['Type', 'Nil UUID (all zeros)']] };
  if (/^f+$/.test(hex)) return { rows: [['Canonical', canonical], ['Type', 'Max UUID (all ones)']] };
  const version = parseInt(hex[12], 16);
  const vb = parseInt(hex[16], 16);
  const variant = vb < 8 ? 'NCS (reserved, legacy)' : vb < 12 ? 'RFC 9562 / RFC 4122 (10xx)' : vb < 14 ? 'Microsoft (reserved, legacy GUID)' : 'Reserved for future use';
  const isRfc = vb >= 8 && vb < 12;
  const names: Record<number, string> = {
    1: 'time-based (Gregorian, MAC)',
    2: 'DCE security',
    3: 'name-based (MD5)',
    4: 'random',
    5: 'name-based (SHA-1)',
    6: 'reordered time-based',
    7: 'Unix-time-ordered',
    8: 'custom / vendor-specific',
  };
  const rows: [string, string][] = [
    ['Canonical', canonical],
    ['Version', isRfc && names[version] ? `${version} · ${names[version]}` : `${version} (unknown)`],
    ['Variant', variant],
  ];
  const fmt = (ms: number) => `${new Date(ms).toISOString()} (${relativeTime(ms)})`;
  if (isRfc && version === 7) {
    const ms = parseInt(hex.slice(0, 12), 16);
    rows.push(['Timestamp', fmt(ms)], ['Unix ms', String(ms)], ['Random bits', `${hex.slice(13, 16)} ${hex.slice(17)}`]);
  } else if (isRfc && (version === 1 || version === 6)) {
    const t =
      version === 1
        ? (BigInt(`0x${hex.slice(13, 16)}`) << 48n) | (BigInt(`0x${hex.slice(8, 12)}`) << 32n) | BigInt(`0x${hex.slice(0, 8)}`)
        : (BigInt(`0x${hex.slice(0, 12)}`) << 12n) | BigInt(`0x${hex.slice(13, 16)}`);
    const ms = Number((t - GREGORIAN_OFFSET) / 10000n);
    rows.push(['Timestamp', fmt(ms)], ['Clock sequence', String(parseInt(hex.slice(16, 20), 16) & 0x3fff)], ['Node', hex.slice(20).match(/../g)!.join(':')]);
  } else if (isRfc && version === 4) {
    rows.push(['Random bits', '122 (about 5.3 × 10³⁶ possible values)']);
  }
  return { rows };
}

// ---------------------------------------------------------------- UI
const DESCRIPTIONS: Record<string, string> = {
  v4: 'Random UUID (version 4): 122 random bits. The everyday choice when order does not matter.',
  v7: 'Time-ordered UUID (version 7, RFC 9562): a 48-bit millisecond timestamp then random bits. Sorts by creation time, which keeps database indexes compact. Monotonic within the same millisecond.',
  ulid: 'ULID: 48-bit timestamp + 80 random bits in 26 Crockford Base32 characters. Sortable, case-insensitive, no hyphens. Monotonic within the same millisecond.',
  nanoid: 'Nano ID-style: random characters from an alphabet you choose, picked with unbiased sampling. The default 21 URL-safe characters carry 126 bits.',
};

export function init() {
  const out = $<HTMLTextAreaElement>('#uuid-out');
  const count = $<HTMLInputElement>('#uuid-count');
  const upper = $<HTMLInputElement>('#uuid-upper');
  const nohyph = $<HTMLInputElement>('#uuid-nohyph');
  const desc = $('#uuid-desc');
  const nanoOpts = $('#uuid-nano-opts');
  const nanoSize = $<HTMLInputElement>('#uuid-nano-size');
  const nanoAlpha = $<HTMLSelectElement>('#uuid-nano-alpha');
  const inspIn = $<HTMLInputElement>('#uuid-inspect');
  const inspOut = $('#uuid-inspect-out');
  const inspStatus = $('#uuid-inspect-status');

  const runInspect = () => {
    const r = inspect(inspIn.value);
    inspOut.replaceChildren(...r.rows.map(([k, v]) => kvRow(k, v)));
    setStatus(inspStatus, r.error ? 'error' : null, r.error);
  };

  const generate = () => {
    const t = type.get();
    const n = Math.max(1, Math.min(1000, Math.floor(Number(count.value) || 1)));
    if (String(n) !== count.value) count.value = String(n);
    const ids: string[] = [];
    if (t === 'nanoid') {
      const size = Math.max(2, Math.min(256, Math.floor(Number(nanoSize.value) || 21)));
      const alpha = ALPHABETS[nanoAlpha.value];
      for (let i = 0; i < n; i++) ids.push(nanoid(size, alpha));
    } else {
      for (let i = 0; i < n; i++) {
        let id = t === 'v4' ? uuidv4() : t === 'v7' ? uuidv7() : ulid();
        if (t !== 'ulid') {
          if (nohyph.checked) id = id.replace(/-/g, '');
          if (upper.checked) id = id.toUpperCase();
        }
        ids.push(id);
      }
    }
    out.value = ids.join('\n');
    out.rows = Math.min(12, Math.max(4, n));
    if (t !== 'nanoid') {
      inspIn.value = ids[0];
      runInspect();
    }
  };
  const type = segmented($('#uuid-type'), (t) => {
    desc.textContent = DESCRIPTIONS[t];
    nanoOpts.hidden = t !== 'nanoid';
    $('#uuid-upper-wrap').hidden = $('#uuid-nohyph-wrap').hidden = t === 'ulid' || t === 'nanoid';
    generate();
  });
  desc.textContent = DESCRIPTIONS.v4;
  $('#uuid-gen').addEventListener('click', generate);
  [count, nanoSize].forEach((el) => el.addEventListener('change', generate));
  [upper, nohyph, nanoAlpha].forEach((el) => el.addEventListener('change', generate));
  count.addEventListener('keydown', (e) => e.key === 'Enter' && generate());
  $('#uuid-dl').addEventListener('click', () => {
    if (!out.value) return toast('Nothing to download yet', 'error');
    downloadText(out.value + '\n', `${type.get()}-ids.txt`);
    toast('Download started');
  });
  // Clicking a line in the output inspects that ID.
  out.addEventListener('click', () => {
    const before = out.value.slice(0, out.selectionStart).split('\n').length - 1;
    const line = out.value.split('\n')[before];
    if (line && type.get() !== 'nanoid') {
      inspIn.value = line;
      runInspect();
    }
  });
  inspIn.addEventListener('input', runInspect);
  generate();
}
