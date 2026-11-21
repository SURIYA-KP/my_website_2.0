import { copyText, escapeHtml, toast } from '../../lib/ui';

export const enc = new TextEncoder();
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
};
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

// ---------- Base64 ----------
export function bytesToBase64(bytes: Uint8Array, urlSafe = false, pad = true) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  let s = btoa(bin);
  if (urlSafe) s = s.replace(/\+/g, '-').replace(/\//g, '_');
  if (!pad) s = s.replace(/=+$/, '');
  return s;
}

/** Decode standard or URL-safe Base64 (padding optional, whitespace ignored). Throws a readable Error. */
export function base64ToBytes(input: string): Uint8Array {
  let s = input.replace(/\s+/g, '');
  if (!s) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) {
    const bad = s.match(/[^A-Za-z0-9+/_=-]/);
    throw new Error(bad ? `Invalid Base64 character “${bad[0]}”` : 'Padding “=” may only appear at the end');
  }
  s = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length % 4 === 1) throw new Error('Invalid Base64 length (one character too many or too few)');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: Uint8Array, upper = false) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return upper ? s.toUpperCase() : s;
}

export function hexToBytes(hex: string) {
  const s = hex.replace(/^0x/i, '').replace(/[\s:]/g, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('Invalid hex string');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true });
export function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** True when text looks like human-readable text (no odd control characters). */
export function isPrintable(text: string) {
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F�]/.test(text);
}

// ---------- Random ----------
/** Unbiased random integer in [0, n) using rejection sampling over 32-bit values. */
export function randomInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new Error('randomInt: bad range');
  const limit = Math.floor(2 ** 32 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function randomBytes(n: number) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// ---------- DOM helpers ----------
export function copyButton(getText: () => string, label = 'Copy', what = 'Copied') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-sm dt-copy';
  b.textContent = label;
  b.addEventListener('click', () => {
    const t = getText();
    if (!t) return toast('Nothing to copy yet', 'error');
    copyText(t, what);
  });
  return b;
}

/** Build a "label | value | copy" row. Value can be plain text or pre-escaped HTML. */
export function kvRow(label: string, value: string, opts: { html?: boolean; copy?: string | false; title?: string; cls?: string } = {}) {
  const row = document.createElement('div');
  row.className = `dt-kv-row${opts.cls ? ' ' + opts.cls : ''}`;
  const k = document.createElement('div');
  k.className = 'dt-kv-key';
  k.textContent = label;
  if (opts.title) k.title = opts.title;
  const v = document.createElement('div');
  v.className = 'dt-kv-val';
  if (opts.html) v.innerHTML = value;
  else v.textContent = value;
  row.append(k, v);
  const copyVal = opts.copy === undefined ? (opts.html ? v.textContent ?? '' : value) : opts.copy;
  if (copyVal !== false) row.append(copyButton(() => copyVal, 'Copy', `${label} copied`));
  else row.append(document.createElement('span'));
  return row;
}

export function setStatus(el: HTMLElement, kind: 'error' | 'warning' | 'success' | 'info' | null, msg = '') {
  el.className = kind ? `alert alert-${kind}` : '';
  el.textContent = msg;
  el.hidden = !kind || !msg;
}

/** Wire a segmented button group (.btn-group with [data-value]) and return a getter. */
export function segmented(group: HTMLElement, onChange: (v: string) => void) {
  const buttons = $$<HTMLButtonElement>('[data-value]', group);
  const set = (v: string, fire = true) => {
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
    if (fire) onChange(v);
  };
  buttons.forEach((b) => b.addEventListener('click', () => set(b.dataset.value!)));
  return {
    get: () => buttons.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.value ?? buttons[0].dataset.value!,
    set,
  };
}

/** Syntax-highlight a JSON value as HTML (keys, strings, numbers, booleans, null). */
export function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? 'undefined';
  const re = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let out = '';
  let last = 0;
  for (const m of json.matchAll(re)) {
    out += escapeHtml(json.slice(last, m.index));
    let cls = 'num';
    if (m[1]) cls = m[2] ? 'key' : 'str';
    else if (m[3]) cls = 'bool';
    else if (m[0] === 'null') cls = 'null';
    if (m[1] && m[2]) out += `<span class="dt-j-key">${escapeHtml(m[1])}</span>${escapeHtml(m[2])}`;
    else out += `<span class="dt-j-${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index! + m[0].length;
  }
  return out + escapeHtml(json.slice(last));
}

// ---------- Time ----------
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function relativeTime(ms: number, now = Date.now()) {
  const diff = (ms - now) / 1000;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [u, s] of units) if (abs >= s || u === 'second') return rtf.format(Math.round(diff / s), u);
  return '';
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return '∞';
  if (seconds < 1) return 'less than a second';
  const units: [string, number][] = [
    ['billion years', 31536000e9],
    ['million years', 31536000e6],
    ['thousand years', 31536000e3],
    ['years', 31536000],
    ['days', 86400],
    ['hours', 3600],
    ['minutes', 60],
    ['seconds', 1],
  ];
  if (seconds > 31536000e12) return 'longer than the age of the universe';
  for (const [u, s] of units) {
    if (seconds >= s) {
      const v = seconds / s;
      return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString('en')} ${u}`;
    }
  }
  return `${seconds.toFixed(0)} seconds`;
}
