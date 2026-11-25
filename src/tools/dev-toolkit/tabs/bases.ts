import { $, $$, kvRow, setStatus } from '../util';

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Parse a signed integer in any base 2–36 into a BigInt. Accepts 0b/0o/0x prefixes, spaces, _ and commas (base 10). */
export function parseBig(raw: string, base: number): bigint {
  let s = raw.trim().replace(/[\s_]/g, '');
  if (base === 10) s = s.replace(/,/g, '');
  let neg = false;
  if (/^[-+]/.test(s)) {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  const pref = s.slice(0, 2).toLowerCase();
  if ((base === 2 && pref === '0b') || (base === 8 && pref === '0o') || (base === 16 && pref === '0x')) s = s.slice(2);
  if (!s) throw new Error('Enter a number');
  s = s.toLowerCase();
  let v = 0n;
  const B = BigInt(base);
  for (let i = 0; i < s.length; i++) {
    const d = DIGITS.indexOf(s[i]);
    if (d < 0 || d >= base) throw new Error(`“${s[i]}” is not a valid base-${base} digit`);
    v = v * B + BigInt(d);
  }
  return neg ? -v : v;
}

export function formatBig(v: bigint, base: number, group = false, upper = true) {
  const neg = v < 0n;
  let s = (neg ? -v : v).toString(base);
  if (base === 16 && upper) s = s.toUpperCase();
  if (group) {
    const size = base === 2 || base === 16 ? 4 : 3;
    const sep = base === 10 ? ',' : ' ';
    if (base === 2) s = s.padStart(Math.ceil(s.length / 4) * 4, '0');
    s = s.replace(new RegExp(`\\B(?=(.{${size}})+$)`, 'g'), sep);
  }
  return (neg ? '-' : '') + s;
}

const SI = [['B', 1], ['kB', 1e3], ['MB', 1e6], ['GB', 1e9], ['TB', 1e12], ['PB', 1e15], ['EB', 1e18]] as const;
const IEC = [['B', 1], ['KiB', 2 ** 10], ['MiB', 2 ** 20], ['GiB', 2 ** 30], ['TiB', 2 ** 40], ['PiB', 2 ** 50], ['EiB', 2 ** 60]] as const;
const num = (v: number) => {
  if (v === 0) return '0';
  if (Math.abs(v) >= 1e21 || Math.abs(v) < 1e-6) return v.toExponential(4);
  return v.toLocaleString('en', { maximumFractionDigits: v < 1 ? 8 : 4 });
};
export function human(bytes: number, table: readonly (readonly [string, number])[]) {
  let i = 0;
  while (i < table.length - 1 && Math.abs(bytes) >= table[i + 1][1]) i++;
  const v = bytes / table[i][1];
  return `${v.toLocaleString('en', { maximumFractionDigits: 2 })} ${table[i][0]}`;
}

export function init() {
  const inputs = $$<HTMLInputElement>('.dt-bases input[data-base]');
  const customBase = $<HTMLSelectElement>('#nb-custom-base');
  const group = $<HTMLInputElement>('#nb-group');
  const status = $('#nb-status');
  const info = $('#nb-info');
  for (let b = 2; b <= 36; b++) customBase.add(new Option(String(b), String(b), b === 36, b === 36));
  const baseOf = (el: HTMLInputElement) => (el.dataset.base === 'custom' ? Number(customBase.value) : Number(el.dataset.base));
  let value: bigint | null = 3735928559n;

  const render = (source?: HTMLInputElement) => {
    for (const el of inputs) {
      el.classList.remove('is-invalid');
      if (el === source || value === null) continue;
      el.value = formatBig(value, baseOf(el), group.checked);
    }
    info.replaceChildren();
    if (value === null) return;
    const abs = value < 0n ? -value : value;
    const bits = abs === 0n ? 1 : abs.toString(2).length;
    const rows: [string, string][] = [['Bit length', `${bits} bit${bits === 1 ? '' : 's'} (${Math.ceil(bits / 8)} byte${Math.ceil(bits / 8) === 1 ? '' : 's'})`]];
    if (value < 0n) {
      const width = [8, 16, 32, 64, 128, 256].find((w) => -value! <= 1n << BigInt(w - 1));
      if (width) {
        const tc = (1n << BigInt(width)) + value;
        rows.push([`Two's complement (${width}-bit)`, `0x${tc.toString(16).toUpperCase().padStart(width / 4, '0')}`]);
      }
    } else {
      const width = [8, 16, 32, 64].find((w) => value! < 1n << BigInt(w));
      if (width && value >= 1n << BigInt(width - 1)) rows.push([`As signed ${width}-bit`, String(value - (1n << BigInt(width)))]);
      if (value <= BigInt(Number.MAX_SAFE_INTEGER)) rows.push(['Safe JS number', 'Yes']);
      else rows.push(['Safe JS number', 'No: larger than 2⁵³ − 1, needs BigInt']);
    }
    info.append(...rows.map(([k, v]) => kvRow(k, v, { copy: /^(Bit length|Safe)/.test(k) ? false : undefined, cls: /^(Bit length|Safe)/.test(k) ? 'is-text' : '' })));
  };

  for (const el of inputs) {
    el.addEventListener('input', () => {
      if (!el.value.trim()) {
        value = null;
        inputs.forEach((o) => o !== el && (o.value = ''));
        info.replaceChildren();
        setStatus(status, null);
        return;
      }
      try {
        value = parseBig(el.value, baseOf(el));
        setStatus(status, null);
        render(el);
      } catch (e: any) {
        el.classList.add('is-invalid');
        setStatus(status, 'error', e.message);
      }
    });
    el.addEventListener('blur', () => value !== null && !el.classList.contains('is-invalid') && (el.value = formatBig(value, baseOf(el), group.checked)));
  }
  customBase.addEventListener('change', () => render());
  group.addEventListener('change', () => render());
  render();

  // ---------------------------------------------------------------- bytes ⇄ units
  const val = $<HTMLInputElement>('#bu-val');
  const unit = $<HTMLSelectElement>('#bu-unit');
  const buStatus = $('#bu-status');
  const buHuman = $('#bu-human');
  const tbody = $('#bu-table tbody');
  const units = () => {
    const raw = val.value.trim().replace(/[,_\s]/g, '');
    buHuman.replaceChildren();
    tbody.replaceChildren();
    if (!raw) return setStatus(buStatus, null);
    const n = Number(raw);
    if (!Number.isFinite(n) || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw)) return setStatus(buStatus, 'error', 'Enter a number, e.g. 1.5 or 2e9.');
    if (n < 0) return setStatus(buStatus, 'error', 'Sizes cannot be negative.');
    setStatus(buStatus, null);
    const bytes = n * Number(unit.value);
    buHuman.append(
      kvRow('Bytes', Number.isInteger(bytes) ? bytes.toLocaleString('en') : num(bytes), { copy: String(bytes) }),
      kvRow('Bits', num(bytes * 8), { copy: String(bytes * 8) }),
      kvRow('Human (SI)', human(bytes, SI), { cls: 'is-text' }),
      kvRow('Human (IEC)', human(bytes, IEC), { cls: 'is-text' }),
    );
    for (let i = 1; i < SI.length; i++) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${SI[i][0]}</td><td>${num(bytes / SI[i][1])}</td><td>${IEC[i][0]}</td><td>${num(bytes / IEC[i][1])}</td>`;
      tbody.append(tr);
    }
  };
  val.addEventListener('input', units);
  unit.addEventListener('change', units);
  units();
}
