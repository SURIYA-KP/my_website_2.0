import { copyText, escapeHtml } from '../../../lib/ui';
import { $, randomInt, segmented, formatDuration } from '../util';
import { WORDS } from '../wordlist';

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
};
const AMBIGUOUS = new Set([...'Il1|O0o`\'"']);

export interface PwOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: string | false;
  noAmbiguous: boolean;
}
function groups(o: PwOptions) {
  const g: string[] = [];
  const clean = (s: string) => Array.from(new Set(s)).filter((c) => !(o.noAmbiguous && AMBIGUOUS.has(c))).join('');
  if (o.lower) g.push(clean(SETS.lower));
  if (o.upper) g.push(clean(SETS.upper));
  if (o.digits) g.push(clean(SETS.digits));
  if (o.symbols) g.push(clean(o.symbols.replace(/[\sA-Za-z0-9]/g, '')));
  return g.filter(Boolean);
}
export function poolOf(o: PwOptions) {
  return Array.from(new Set(groups(o).join(''))).join('');
}

/**
 * Random password using unbiased sampling. Includes at least one character from each chosen set:
 * candidates missing a set are rejected and redrawn, so every compliant password is equally likely.
 */
export function makePassword(o: PwOptions) {
  const gs = groups(o);
  const pool = poolOf(o);
  if (!pool) throw new Error('Choose at least one character set.');
  const need = o.length >= gs.length ? gs : [];
  for (let tries = 0; ; tries++) {
    let s = '';
    for (let i = 0; i < o.length; i++) s += pool[randomInt(pool.length)];
    if (need.every((g) => [...s].some((c) => g.includes(c)))) return s;
    if (tries > 10000) return s; // practically unreachable
  }
}
export function passwordEntropy(o: PwOptions) {
  const n = poolOf(o).length;
  return n > 1 ? o.length * Math.log2(n) : 0;
}

export interface PpOptions {
  words: number;
  sep: string;
  cap: boolean;
  num: boolean;
}
export function makePassphrase(o: PpOptions) {
  const w = Array.from({ length: o.words }, () => {
    const word = WORDS[randomInt(WORDS.length)];
    return o.cap ? word[0].toUpperCase() + word.slice(1) : word;
  });
  if (o.num) {
    const i = randomInt(w.length);
    w[i] += String(randomInt(10));
  }
  return w.join(o.sep);
}
export function passphraseEntropy(o: PpOptions) {
  return o.words * Math.log2(WORDS.length) + (o.num ? Math.log2(10 * o.words) : 0);
}

function crackText(sec: number) {
  const d = formatDuration(sec);
  return d.startsWith('longer') ? `would take ${escapeHtml(d)} to crack` : `about ${escapeHtml(d)} to crack`;
}

const LEVELS: [number, string, string][] = [
  [36, 'Very weak', '--danger'],
  [60, 'Weak', '--danger'],
  [80, 'Reasonable', '--warning'],
  [100, 'Strong', '--success'],
  [Infinity, 'Very strong', '--success'],
];

export function init() {
  const out = $('#pw-out');
  const fillEl = $('#pw-meter-fill');
  const meter = $('#pw-meter');
  const strength = $('#pw-strength');
  const list = $('#pw-list');
  const listText = $('#pw-list-text');
  const count = $<HTMLSelectElement>('#pw-count');
  const len = $<HTMLInputElement>('#pw-len');
  const lenNum = $<HTMLInputElement>('#pw-len-num');
  const ppWords = $<HTMLInputElement>('#pp-words');
  const ppWordsNum = $<HTMLInputElement>('#pp-words-num');
  const sym = $<HTMLInputElement>('#pw-symset');
  const symBox = $<HTMLInputElement>('#pw-symbols');
  const ppInfo = $('#pp-info');
  const chk = (id: string) => $<HTMLInputElement>(`#${id}`).checked;

  const pwOpts = (): PwOptions => ({
    length: Number(len.value),
    lower: chk('pw-lower'),
    upper: chk('pw-upper'),
    digits: chk('pw-digits'),
    symbols: symBox.checked ? sym.value : false,
    noAmbiguous: chk('pw-ambig'),
  });
  const ppOpts = (): PpOptions => ({ words: Number(ppWords.value), sep: $<HTMLSelectElement>('#pp-sep').value, cap: chk('pp-cap'), num: chk('pp-num') });

  const generate = () => {
    const isPw = mode.get() === 'password';
    let make: () => string;
    let bits: number;
    if (isPw) {
      const o = pwOpts();
      if (!poolOf(o)) {
        out.textContent = '';
        list.replaceChildren();
        listText.textContent = '';
        strength.innerHTML = '<span class="badge badge-danger">Choose at least one character set</span>';
        fillEl.style.width = '0';
        return;
      }
      make = () => makePassword(o);
      bits = passwordEntropy(o);
    } else {
      const o = ppOpts();
      make = () => makePassphrase(o);
      bits = passphraseEntropy(o);
      ppInfo.textContent = `${WORDS.length.toLocaleString('en')}-word list · ${Math.log2(WORDS.length).toFixed(0)} bits per word${o.num ? ' · the digit adds a little more' : ''}.`;
    }
    const n = Number(count.value);
    const all = Array.from({ length: n + 1 }, make);
    out.textContent = all[0];
    list.innerHTML = all
      .slice(1)
      .map((p, i) => `<li><code>${escapeHtml(p)}</code><button class="btn btn-sm btn-ghost" type="button" data-i="${i + 1}" aria-label="Copy item ${i + 1}">Copy</button></li>`)
      .join('');
    listText.textContent = all.slice(1).join('\n');
    (list as any)._items = all;

    const [, label, color] = LEVELS.find(([max]) => bits < max)!;
    const pct = Math.min(100, (bits / 128) * 100);
    fillEl.style.width = `${Math.max(4, pct)}%`;
    fillEl.style.background = `var(${color})`;
    meter.setAttribute('aria-valuenow', String(Math.round(bits)));
    meter.setAttribute('aria-valuetext', `${label}, ${Math.round(bits)} bits`);
    // Offline attack at 100 billion guesses per second; on average half the space is searched.
    const crack = Math.pow(2, bits - 1) / 1e11;
    strength.innerHTML = `<strong style="color:var(${color})">${label}</strong> · <span class="mono">${bits.toFixed(1)}</span> bits of entropy · ${crackText(crack)} at 100 billion guesses per second`;
  };

  const mode = segmented($('#pw-mode'), (m) => {
    $('#pw-opts-password').hidden = m !== 'password';
    $('#pw-opts-passphrase').hidden = m !== 'passphrase';
    generate();
  });
  const link = (range: HTMLInputElement, num: HTMLInputElement) => {
    range.addEventListener('input', () => {
      num.value = range.value;
      generate();
    });
    num.addEventListener('input', () => {
      const v = Math.max(Number(range.min), Math.min(Number(range.max), Math.round(Number(num.value))));
      if (!Number.isFinite(v) || num.value === '') return;
      range.value = String(v);
      generate();
    });
    num.addEventListener('change', () => (num.value = range.value));
  };
  link(len, lenNum);
  link(ppWords, ppWordsNum);
  for (const id of ['pw-lower', 'pw-upper', 'pw-digits', 'pw-symbols', 'pw-ambig', 'pp-sep', 'pp-cap', 'pp-num', 'pw-count']) $(`#${id}`).addEventListener('change', generate);
  sym.addEventListener('input', generate);
  $('#pw-regen').addEventListener('click', generate);
  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (b) copyText((list as any)._items[Number(b.dataset.i)], 'Copied');
  });
  generate();
}
