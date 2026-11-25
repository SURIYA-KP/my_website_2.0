import { copyText, escapeHtml, toast } from '../../../lib/ui';
import { $, kvRow, setStatus, relativeTime } from '../util';

// ---------------------------------------------------------------- time-zone math (Intl only)
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(zone: string) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(zone, f);
  }
  return f;
}
interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number; wd: string }
export function wallTime(ms: number, zone: string): Wall {
  const p: Record<string, string> = {};
  for (const x of partsFmt(zone).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, ms: ((ms % 1000) + 1000) % 1000, wd: p.weekday };
}
/** Offset of `zone` from UTC at instant `ms`, in minutes (e.g. -300 for New York in winter). */
export function offsetMinutes(ms: number, zone: string) {
  const w = wallTime(ms, zone);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - (ms - w.ms)) / 60000);
}
/** Interpret a wall-clock time in `zone` and return the instant (ms since epoch). */
export function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, s: number, msPart: number, zone: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, msPart);
  const o1 = offsetMinutes(guess, zone);
  let t = guess - o1 * 60000;
  const o2 = offsetMinutes(t, zone);
  if (o2 !== o1) t = guess - o2 * 60000;
  return t;
}
const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
function offsetStr(min: number, colon = true) {
  const sign = min < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(Math.abs(min) / 60))}${colon ? ':' : ''}${pad(Math.abs(min) % 60)}`;
}
export function isoUtc(ms: number) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}
export function isoInZone(ms: number, zone: string) {
  const w = wallTime(ms, zone);
  const off = offsetMinutes(ms, zone);
  const frac = w.ms ? `.${pad(w.ms, 3)}` : '';
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${frac}${off === 0 && zone === 'UTC' ? 'Z' : offsetStr(off)}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function rfc2822(ms: number, zone: string) {
  const w = wallTime(ms, zone);
  return `${w.wd}, ${pad(w.d)} ${MONTHS[w.mo - 1]} ${w.y} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)} ${offsetStr(offsetMinutes(ms, zone), false)}`;
}
function isoWeek(y: number, mo: number, d: number) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return { week: Math.ceil(((+date - yearStart) / 86400000 + 1) / 7), year: date.getUTCFullYear() };
}
function zoneAbbr(ms: number, zone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}
function validZone(z: string) {
  if (!z) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- input parsing
const UNIT_MS: Record<string, number> = { s: 1000, ms: 1, us: 0.001, ns: 0.000001 };
const UNIT_NAME: Record<string, string> = { s: 'seconds', ms: 'milliseconds', us: 'microseconds', ns: 'nanoseconds' };
export function detectUnit(digits: number) {
  return digits <= 11 ? 's' : digits <= 14 ? 'ms' : digits <= 17 ? 'us' : 'ns';
}
interface Parsed { ms: number; note: string }
export function parseInput(raw: string, unitSel: string, zone: string): Parsed {
  const s = raw.trim();
  if (/^now$/i.test(s)) return { ms: Date.now(), note: 'Now' };
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) {
    const intDigits = s.replace(/^[-+]/, '').split('.')[0].replace(/^0+(?=\d)/, '').length;
    const unit = unitSel === 'auto' ? detectUnit(intDigits) : unitSel;
    let ms: number;
    if (unit === 's' || unit === 'ms') ms = Number(s) * UNIT_MS[unit];
    else {
      // Use BigInt for the integer part so 19-digit nanosecond values keep their precision.
      const [i] = s.split('.');
      ms = Number(BigInt(i) / BigInt(unit === 'us' ? 1000 : 1000000));
    }
    const how = unitSel === 'auto' ? `Detected Unix ${UNIT_NAME[unit]} (${intDigits} digit${intDigits === 1 ? '' : 's'})` : `Unix ${UNIT_NAME[unit]}`;
    return { ms, note: how };
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?$/);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '0'] = m;
    const ms = wallToInstant(+y, +mo, +d, +h, +mi, +sec, Math.floor(Number(`0.${frac}`) * 1000), zone);
    return { ms, note: `No offset given, so it is read as wall-clock time in ${zone}` };
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error('Could not read that. Try 1700000000, 1700000000000, 2023-11-14T22:13:20Z, or Tue, 14 Nov 2023 22:13:20 +0000.');
  return { ms: t, note: /^\d{4}-/.test(s) ? 'Parsed as ISO 8601' : /^[A-Z][a-z]{2}, /.test(s) ? 'Parsed as RFC 2822' : 'Parsed as a date string' };
}

// ---------------------------------------------------------------- UI
export function init() {
  const nowS = $('#time-now-s');
  const nowMs = $('#time-now-ms');
  const nowIso = $('#time-now-iso');
  const inp = $<HTMLInputElement>('#time-in');
  const unit = $<HTMLSelectElement>('#time-unit');
  const zoneIn = $<HTMLInputElement>('#time-zone');
  const detect = $('#time-detect');
  const status = $('#time-status');
  const out = $('#time-out');
  const zonesEl = $('#time-zones');
  const addIn = $<HTMLInputElement>('#time-add-zone');
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // Searchable list of every IANA zone the browser knows.
  const all: string[] = ((Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined) ?? [];
  const zones = Array.from(new Set(['UTC', local, ...all])).sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
  $('#dt-tz-list').innerHTML = zones.map((z) => `<option value="${escapeHtml(z)}"></option>`).join('');
  zoneIn.value = local;
  let zone = local;
  let instant: number | null = null;

  const compare: string[] = Array.from(new Set([local, 'UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Asia/Tokyo']));

  const renderZones = () => {
    const ms = instant ?? Date.now();
    zonesEl.replaceChildren();
    for (const z of compare) {
      const w = wallTime(ms, z);
      const off = offsetMinutes(ms, z);
      const row = document.createElement('div');
      row.className = 'dt-zone';
      row.dataset.zone = z;
      const abbr = zoneAbbr(ms, z).replace(/^(GMT|UTC)([+-].*)?$/, '');
      const city = z === 'UTC' ? 'UTC' : z.split('/').pop()!.replace(/_/g, ' ');
      row.innerHTML = `<div><div class="dt-zone-name">${escapeHtml(city)}${z === local ? ' <span class="badge">local</span>' : ''}</div>
        <div class="dt-zone-sub">${escapeHtml(z === 'UTC' ? 'Coordinated Universal Time' : z)} · <span>UTC${offsetStr(off)}${abbr ? ` · ${escapeHtml(abbr)}` : ''}</span></div></div>
        <div><div class="dt-zone-time">${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}</div><div class="dt-zone-date">${w.wd}, ${w.d} ${MONTHS[w.mo - 1]} ${w.y}</div></div>
        <button class="btn btn-icon btn-ghost btn-sm" type="button" data-remove aria-label="Remove ${escapeHtml(z)}" title="Remove">✕</button>`;
      zonesEl.append(row);
    }
  };

  const convert = () => {
    const raw = inp.value;
    out.replaceChildren();
    detect.textContent = '';
    setStatus(status, null);
    if (!raw.trim()) {
      instant = null;
      setStatus(status, 'info', 'Enter a timestamp or a date, or press “Use now”.');
      renderZones();
      return;
    }
    let p: Parsed;
    try {
      p = parseInput(raw, unit.value, zone);
    } catch (e: any) {
      instant = null;
      setStatus(status, 'error', e.message);
      renderZones();
      return;
    }
    if (!Number.isFinite(p.ms) || Math.abs(p.ms) > 8.64e15) {
      instant = null;
      setStatus(status, 'error', 'That is outside the range JavaScript dates support (±275,000 years).');
      renderZones();
      return;
    }
    instant = p.ms;
    detect.textContent = p.note;
    const ms = p.ms;
    const w = wallTime(ms, zone);
    const wk = isoWeek(w.y, w.mo, w.d);
    const doy = Math.round((Date.UTC(w.y, w.mo - 1, w.d) - Date.UTC(w.y, 0, 1)) / 86400000) + 1;
    const secs = ms / 1000;
    const rows: [string, string][] = [
      ['Unix seconds', Number.isInteger(secs) ? String(secs) : secs.toFixed(3)],
      ['Unix milliseconds', String(Math.round(ms))],
      ['ISO 8601 (UTC)', isoUtc(ms)],
      ...(zone === 'UTC' ? [] : ([[`ISO 8601 (${zone})`, isoInZone(ms, zone)]] as [string, string][])),
      [`RFC 2822 (${zone})`, rfc2822(ms, zone)],
      [`Local time (${zone})`, new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }).format(ms)],
      ['Relative', relativeTime(ms)],
      ['Calendar', `Day ${doy} of ${w.y} · ISO week ${wk.week} of ${wk.year}`],
    ];
    for (const [k, v] of rows) {
      const r = kvRow(k, v, { cls: /^(Local|Relative|Calendar)/.test(k) ? 'is-text' : '' });
      r.dataset.key = k.split(' (')[0];
      out.append(r);
    }
    renderZones();
  };

  inp.addEventListener('input', convert);
  unit.addEventListener('change', convert);
  const applyZone = () => {
    const z = validZone(zoneIn.value.trim());
    if (!z) {
      if (zoneIn.value.trim()) setStatus(status, 'error', `“${zoneIn.value.trim()}” is not a time zone this browser knows. Pick one from the list, e.g. Europe/Paris.`);
      return;
    }
    zone = z;
    convert();
  };
  zoneIn.addEventListener('input', applyZone);
  zoneIn.addEventListener('change', () => {
    if (!validZone(zoneIn.value.trim())) zoneIn.value = zone;
    applyZone();
  });
  zoneIn.addEventListener('focus', () => zoneIn.select());
  $('#time-use-now').addEventListener('click', () => {
    inp.value = String(Math.floor(Date.now() / 1000));
    unit.value = 'auto';
    convert();
  });

  const addZone = () => {
    const z = validZone(addIn.value.trim());
    if (!z) return toast(addIn.value.trim() ? 'Unknown time zone' : 'Type a zone name first', 'error');
    if (!compare.includes(z)) compare.push(z);
    addIn.value = '';
    renderZones();
  };
  $('#time-add-zone-btn').addEventListener('click', addZone);
  addIn.addEventListener('keydown', (e) => e.key === 'Enter' && addZone());
  addIn.addEventListener('change', () => validZone(addIn.value.trim()) && addZone());
  zonesEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-remove]');
    if (!b) return;
    const z = b.closest<HTMLElement>('.dt-zone')!.dataset.zone!;
    compare.splice(compare.indexOf(z), 1);
    renderZones();
  });

  // Live clock
  const tick = () => {
    const ms = Date.now();
    nowS.textContent = String(Math.floor(ms / 1000));
    nowMs.textContent = String(ms);
    nowIso.textContent = new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  };
  for (const el of [nowS, nowMs, nowIso]) el.addEventListener('click', () => copyText(el.textContent!, 'Copied'));
  let timer: ReturnType<typeof setInterval> | undefined;
  api.show = () => {
    tick();
    clearInterval(timer);
    timer = setInterval(() => {
      if (!document.hidden) tick();
    }, 250);
  };
  api.hide = () => clearInterval(timer);
  tick();
  convert();
}

const api: { show?: () => void; hide?: () => void } = {};
export const show = () => api.show?.();
export const hide = () => api.hide?.();
