// Payload encoders (form values -> QR text) and a parser (QR text -> structured result).
// Pure functions, no DOM.

export type ContentType = 'url' | 'text' | 'wifi' | 'vcard' | 'email' | 'sms' | 'phone' | 'geo' | 'event';
export type Values = Record<string, string | boolean>;

export interface FieldDef {
  id: string;
  label: string;
  kind?: 'text' | 'textarea' | 'select' | 'checkbox' | 'password' | 'email' | 'tel' | 'url' | 'number' | 'datetime-local' | 'date';
  placeholder?: string;
  options?: [string, string][];
  full?: boolean;
  hint?: string;
  autocomplete?: string;
  step?: string;
}

export interface TypeDef {
  id: ContentType;
  label: string;
  fields: FieldDef[];
  example: Values;
}

export const TYPES: TypeDef[] = [
  {
    id: 'url',
    label: 'URL',
    fields: [{ id: 'url', label: 'Website address', kind: 'url', placeholder: 'https://example.com', full: true, hint: 'https:// is added if you leave out the scheme.' }],
    example: { url: 'https://example.com/welcome' },
  },
  {
    id: 'text',
    label: 'Text',
    fields: [{ id: 'text', label: 'Text', kind: 'textarea', placeholder: 'Anything you like…', full: true }],
    example: { text: 'Hello from QR Studio! Everything here is generated in your browser.' },
  },
  {
    id: 'wifi',
    label: 'Wi-Fi',
    fields: [
      { id: 'ssid', label: 'Network name (SSID)', placeholder: 'My Network', full: true, autocomplete: 'off' },
      { id: 'password', label: 'Password', kind: 'password', placeholder: 'Password', autocomplete: 'off' },
      { id: 'auth', label: 'Security', kind: 'select', options: [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP'], ['nopass', 'None (open network)']] },
      { id: 'hidden', label: 'Hidden network', kind: 'checkbox' },
    ],
    example: { ssid: 'Café Guest', password: 'sun;shine,42', auth: 'WPA', hidden: false },
  },
  {
    id: 'vcard',
    label: 'Contact',
    fields: [
      { id: 'first', label: 'First name', autocomplete: 'off' },
      { id: 'last', label: 'Last name', autocomplete: 'off' },
      { id: 'phone', label: 'Phone', kind: 'tel', placeholder: '+1 555 0100' },
      { id: 'email', label: 'Email', kind: 'email', placeholder: 'name@example.com' },
      { id: 'org', label: 'Organization' },
      { id: 'title', label: 'Job title' },
      { id: 'url', label: 'Website', kind: 'url', full: true },
      { id: 'street', label: 'Street', full: true },
      { id: 'city', label: 'City' },
      { id: 'region', label: 'State / region' },
      { id: 'zip', label: 'Postal code' },
      { id: 'country', label: 'Country' },
    ],
    example: {
      first: 'Ada', last: 'Lovelace', phone: '+44 20 7946 0958', email: 'ada@example.com', org: 'Analytical Engines, Ltd.',
      title: 'Chief Programmer', url: 'https://example.com/ada', street: '12 St James\'s Square', city: 'London', region: '', zip: 'SW1Y 4JH', country: 'United Kingdom',
    },
  },
  {
    id: 'email',
    label: 'Email',
    fields: [
      { id: 'to', label: 'To', kind: 'email', placeholder: 'someone@example.com', full: true },
      { id: 'subject', label: 'Subject', full: true },
      { id: 'body', label: 'Message', kind: 'textarea', full: true },
    ],
    example: { to: 'hello@example.com', subject: 'Question about your service', body: 'Hi there,\n\nI scanned your QR code and…' },
  },
  {
    id: 'sms',
    label: 'SMS',
    fields: [
      { id: 'number', label: 'Phone number', kind: 'tel', placeholder: '+1 555 0100', full: true },
      { id: 'message', label: 'Message', kind: 'textarea', full: true },
    ],
    example: { number: '+15550100', message: 'JOIN' },
  },
  {
    id: 'phone',
    label: 'Phone',
    fields: [{ id: 'number', label: 'Phone number', kind: 'tel', placeholder: '+1 555 0100', full: true }],
    example: { number: '+1 555 0100' },
  },
  {
    id: 'geo',
    label: 'Location',
    fields: [
      { id: 'lat', label: 'Latitude', kind: 'number', placeholder: '48.8584', step: 'any', hint: '−90 to 90' },
      { id: 'lng', label: 'Longitude', kind: 'number', placeholder: '2.2945', step: 'any', hint: '−180 to 180' },
      { id: 'label', label: 'Label (optional)', full: true, placeholder: 'Eiffel Tower' },
    ],
    example: { lat: '48.8584', lng: '2.2945', label: 'Eiffel Tower' },
  },
  {
    id: 'event',
    label: 'Event',
    fields: [
      { id: 'summary', label: 'Title', full: true },
      { id: 'allday', label: 'All-day event', kind: 'checkbox', full: true },
      { id: 'start', label: 'Starts', kind: 'datetime-local' },
      { id: 'end', label: 'Ends', kind: 'datetime-local' },
      { id: 'location', label: 'Location', full: true },
      { id: 'description', label: 'Description', kind: 'textarea', full: true },
      { id: 'utc', label: 'Convert times to UTC (adds Z)', kind: 'checkbox', full: true, hint: 'Off: “floating” local time, read in the scanner’s time zone.' },
    ],
    example: { summary: 'Team offsite', allday: false, start: '2026-12-04T09:30', end: '2026-12-04T17:00', location: 'Room 4, Main St 1', description: 'Bring a laptop; lunch provided.', utc: false },
  },
];

export const typeById = (id: string) => TYPES.find((t) => t.id === id) ?? TYPES[0];

const s = (v: unknown) => (typeof v === 'string' ? v : '').trim();
const raw = (v: unknown) => (typeof v === 'string' ? v : '');

/** Escape per the ZXing WIFI: spec: backslash, semicolon, comma, colon and double quote. */
export function escapeWifi(v: string) {
  return v.replace(/([\\;,:"])/g, '\\$1');
}

/** Escape a vCard 3.0 / iCalendar TEXT value. */
export function escapeText(v: string) {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}

/** "2026-12-04T09:30" -> "20261204T093000" (floating) or UTC "...Z". */
export function icsDate(local: string, utc: boolean, allDay: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(local);
  if (!m) return '';
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  if (allDay) return `${y}${mo}${d}`;
  if (!utc) return `${y}${mo}${d}T${h}${mi}${se}`;
  const dt = new Date(+y, +mo - 1, +d, +h, +mi, +se);
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`;
}

export interface Encoded {
  payload: string;
  error?: string;
}

export function encode(type: ContentType, v: Values): Encoded {
  switch (type) {
    case 'url': {
      let u = s(v.url);
      if (!u) return { payload: '', error: 'Enter a web address.' };
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
      return { payload: u };
    }
    case 'text': {
      const t = raw(v.text);
      return t ? { payload: t } : { payload: '', error: 'Type some text to encode.' };
    }
    case 'wifi': {
      const ssid = raw(v.ssid);
      if (!ssid) return { payload: '', error: 'Enter the network name (SSID).' };
      const auth = s(v.auth) || 'WPA';
      let p = `WIFI:T:${auth};S:${escapeWifi(ssid)};`;
      if (auth !== 'nopass') p += `P:${escapeWifi(raw(v.password))};`;
      if (v.hidden) p += 'H:true;';
      return { payload: p + ';' };
    }
    case 'vcard': {
      const first = s(v.first), last = s(v.last);
      const fn = [first, last].filter(Boolean).join(' ') || s(v.org);
      if (!fn && !s(v.phone) && !s(v.email)) return { payload: '', error: 'Add at least a name, phone or email.' };
      const L = ['BEGIN:VCARD', 'VERSION:3.0', `N:${escapeText(last)};${escapeText(first)};;;`, `FN:${escapeText(fn)}`];
      if (s(v.org)) L.push(`ORG:${escapeText(s(v.org))}`);
      if (s(v.title)) L.push(`TITLE:${escapeText(s(v.title))}`);
      if (s(v.phone)) L.push(`TEL;TYPE=CELL:${s(v.phone)}`);
      if (s(v.email)) L.push(`EMAIL;TYPE=INTERNET:${s(v.email)}`);
      if (s(v.url)) L.push(`URL:${s(v.url)}`);
      const adr = [v.street, v.city, v.region, v.zip, v.country].map((x) => escapeText(s(x)));
      if (adr.some(Boolean)) L.push(`ADR;TYPE=WORK:;;${adr.join(';')}`);
      L.push('END:VCARD');
      return { payload: L.join('\r\n') };
    }
    case 'email': {
      const to = s(v.to);
      if (!to) return { payload: '', error: 'Enter a recipient address.' };
      const q: string[] = [];
      if (s(v.subject)) q.push('subject=' + encodeURIComponent(s(v.subject)));
      if (raw(v.body).trim()) q.push('body=' + encodeURIComponent(raw(v.body).replace(/\r?\n/g, '\r\n')));
      return { payload: `mailto:${to.split(/[,;\s]+/).filter(Boolean).map(encodeURI).join(',')}${q.length ? '?' + q.join('&') : ''}` };
    }
    case 'sms': {
      const n = s(v.number).replace(/[^\d+*#]/g, '');
      if (!n) return { payload: '', error: 'Enter a phone number.' };
      return { payload: `SMSTO:${n}:${raw(v.message)}` };
    }
    case 'phone': {
      const n = s(v.number).replace(/[^\d+*#]/g, '');
      if (!n) return { payload: '', error: 'Enter a phone number.' };
      return { payload: `tel:${n}` };
    }
    case 'geo': {
      const lat = parseFloat(s(v.lat)), lng = parseFloat(s(v.lng));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { payload: '', error: 'Enter latitude and longitude as numbers.' };
      if (Math.abs(lat) > 90) return { payload: '', error: 'Latitude must be between −90 and 90.' };
      if (Math.abs(lng) > 180) return { payload: '', error: 'Longitude must be between −180 and 180.' };
      const label = s(v.label);
      // "?q=lat,lng(Label)" drops a labelled pin in Android and most map apps; plain geo: readers ignore it.
      return { payload: `geo:${lat},${lng}${label ? `?q=${lat},${lng}(${encodeURIComponent(label)})` : ''}` };
    }
    case 'event': {
      const summary = s(v.summary);
      if (!summary) return { payload: '', error: 'Give the event a title.' };
      const allDay = !!v.allday, utc = !!v.utc && !allDay;
      const start = icsDate(s(v.start), utc, allDay);
      if (!start) return { payload: '', error: 'Pick a start date and time.' };
      let end = icsDate(s(v.end), utc, allDay);
      if (end && s(v.end) < s(v.start)) return { payload: '', error: 'The event ends before it starts.' };
      if (allDay && end) {
        // DTEND is exclusive for all-day events: add one day.
        const d = new Date(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8) + 1);
        end = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
      }
      const dp = allDay ? ';VALUE=DATE' : '';
      const L = ['BEGIN:VEVENT', `SUMMARY:${escapeText(summary)}`, `DTSTART${dp}:${start}`];
      if (end) L.push(`DTEND${dp}:${end}`);
      if (s(v.location)) L.push(`LOCATION:${escapeText(s(v.location))}`);
      if (raw(v.description).trim()) L.push(`DESCRIPTION:${escapeText(raw(v.description).trim())}`);
      L.push('END:VEVENT');
      return { payload: L.join('\r\n') };
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing scanned text
// ---------------------------------------------------------------------------

export type Parsed =
  | { kind: 'url'; url: string; scheme: string; host: string; safe: boolean; warnings: string[] }
  | { kind: 'wifi'; ssid: string; password: string; auth: string; hidden: boolean }
  | { kind: 'vcard'; fields: [string, string][]; name: string }
  | { kind: 'email'; to: string; subject: string; body: string }
  | { kind: 'sms'; number: string; message: string }
  | { kind: 'phone'; number: string }
  | { kind: 'geo'; lat: string; lng: string; label: string }
  | { kind: 'event'; fields: [string, string][]; summary: string }
  | { kind: 'text'; text: string };

/** Split "K:v;K2:v2;" respecting backslash escapes, then unescape. */
function splitEscaped(str: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length) {
      cur += c + str[++i];
    } else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
const unescapeWifi = (v: string) => v.replace(/\\(.)/g, '$1');
export function unescapeText(v: string) {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function parseWifi(text: string) {
  const body = text.replace(/^WIFI:/i, '');
  const r = { ssid: '', password: '', auth: 'nopass', hidden: false };
  for (const part of splitEscaped(body, ';')) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const k = part.slice(0, i).toUpperCase();
    const val = unescapeWifi(part.slice(i + 1));
    if (k === 'S') r.ssid = val;
    else if (k === 'P') r.password = val;
    else if (k === 'T') r.auth = val || 'nopass';
    else if (k === 'H') r.hidden = /^true$/i.test(val);
  }
  return r;
}

/** Parse "BEGIN:X ... END:X" content lines into [name(+params), value] pairs (unfolded). */
function contentLines(text: string): { name: string; params: string; value: string }[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  return unfolded
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf(':');
      if (i < 0) return null;
      const head = line.slice(0, i);
      const [name, ...params] = head.split(';');
      return { name: name.toUpperCase(), params: params.join(';'), value: line.slice(i + 1) };
    })
    .filter((x): x is { name: string; params: string; value: string } => !!x && !['BEGIN', 'END', 'VERSION'].includes(x.name));
}

export function parseVcard(text: string) {
  const fields: [string, string][] = [];
  let name = '';
  const labels: Record<string, string> = { FN: 'Name', ORG: 'Organization', TITLE: 'Title', TEL: 'Phone', EMAIL: 'Email', URL: 'Website', ADR: 'Address', NOTE: 'Note', BDAY: 'Birthday' };
  for (const { name: k, value } of contentLines(text)) {
    if (k === 'N') {
      if (!name) {
        const [last = '', first = ''] = splitEscaped(value, ';').map(unescapeText);
        name = [first, last].filter(Boolean).join(' ');
      }
      continue;
    }
    if (!labels[k]) continue;
    let v: string;
    if (k === 'ADR') v = splitEscaped(value, ';').map(unescapeText).map((x) => x.trim()).filter(Boolean).join(', ');
    else if (k === 'ORG') v = splitEscaped(value, ';').map(unescapeText).filter(Boolean).join(', ');
    else v = unescapeText(value);
    if (k === 'FN') name = v;
    if (v) fields.push([labels[k], v]);
  }
  if (name && !fields.some(([l]) => l === 'Name')) fields.unshift(['Name', name]);
  return { fields, name };
}

export function parseEvent(text: string) {
  const fields: [string, string][] = [];
  let summary = '';
  const labels: Record<string, string> = { SUMMARY: 'Title', DTSTART: 'Starts', DTEND: 'Ends', LOCATION: 'Location', DESCRIPTION: 'Description' };
  for (const { name, value } of contentLines(text)) {
    if (!labels[name]) continue;
    let v = unescapeText(value);
    if (name === 'DTSTART' || name === 'DTEND') v = prettyIcsDate(value);
    if (name === 'SUMMARY') summary = v;
    fields.push([labels[name], v]);
  }
  return { fields, summary };
}

function prettyIcsDate(v: string) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim());
  if (!m) return v;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h) return `${y}-${mo}-${d} (all day)`;
  if (z) {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    return `${dt.toLocaleString()} (from UTC)`;
  }
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

const SAFE_SCHEMES = ['http:', 'https:'];

/** The host as a person reads it in the raw text: everything between "//" and the first / ? or #. */
export function visibleHost(text: string) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(text);
  return m ? m[1] : '';
}

/**
 * Spot links whose visible address is not where they really go: "user@host" tricks,
 * look-alike (punycode) characters, backslashes and odd host notations.
 */
export function urlWarnings(text: string, u: URL): string[] {
  const out: string[] = [];
  const shown = visibleHost(text);
  const real = u.host;
  if (/\\/.test(text.split(/[?#]/)[0])) {
    out.push(`The address contains a backslash, which browsers treat as “/”. This link really goes to ${real}.`);
  } else if (shown.includes('@')) {
    const decoy = shown.slice(0, shown.lastIndexOf('@'));
    out.push(`The address starts with “${decoy}@”, which is not the destination. This link really goes to ${real}.`);
  } else if (/(^|\.)xn--/i.test(u.hostname)) {
    out.push(/xn--/i.test(shown)
      ? `The host ${real} is an internationalized name that may imitate a familiar site once displayed.`
      : `The host “${shown}” uses look-alike (non-Latin) characters. Its real address is ${real}.`);
  } else if (shown && shown.toLowerCase().replace(/\.$/, '') !== real && shown.toLowerCase().replace(/\.$/, '').replace(/:(80|443)$/, '') !== real) {
    out.push(`The address is written as “${shown}” but really goes to ${real}.`);
  }
  return out;
}

export function parse(text: string): Parsed {
  const t = text.trim();
  if (/^WIFI:/i.test(t)) return { kind: 'wifi', ...parseWifi(t) };
  if (/^BEGIN:VCARD/i.test(t)) return { kind: 'vcard', ...parseVcard(t) };
  if (/^BEGIN:(VEVENT|VCALENDAR)/i.test(t)) return { kind: 'event', ...parseEvent(t) };
  if (/^mailto:/i.test(t)) {
    const [addr, query = ''] = t.slice(7).split('?');
    const q = new URLSearchParams(query.replace(/\+/g, '%2B'));
    return { kind: 'email', to: safeDecode(addr), subject: q.get('subject') ?? '', body: q.get('body') ?? '' };
  }
  if (/^MATMSG:/i.test(t)) {
    const r = { to: '', subject: '', body: '' };
    for (const part of splitEscaped(t.slice(7), ';')) {
      const i = part.indexOf(':');
      const k = part.slice(0, i).toUpperCase(), v = unescapeWifi(part.slice(i + 1));
      if (k === 'TO') r.to = v; else if (k === 'SUB') r.subject = v; else if (k === 'BODY') r.body = v;
    }
    return { kind: 'email', ...r };
  }
  let m = /^SMSTO:([^:]*):?([\s\S]*)$/i.exec(t);
  if (m) return { kind: 'sms', number: m[1], message: m[2] };
  m = /^sms:([^?]*)(?:\?body=([\s\S]*))?$/i.exec(t);
  if (m) return { kind: 'sms', number: m[1], message: safeDecode(m[2] ?? '') };
  m = /^tel:([\s\S]+)$/i.exec(t);
  if (m) return { kind: 'phone', number: m[1] };
  m = /^geo:(-?[\d.]+),(-?[\d.]+)[^?]*(?:\?q=([\s\S]*))?$/i.exec(t);
  if (m) {
    const q = safeDecode(m[3] ?? '');
    const pin = /^\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\(([\s\S]*)\)\s*$/.exec(q);
    return { kind: 'geo', lat: m[1], lng: m[2], label: pin ? pin[1] : q };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t) || /^www\.\S+\.\S+$/i.test(t)) {
    const href = /^www\./i.test(t) ? 'https://' + t : t;
    try {
      const u = new URL(href);
      return { kind: 'url', url: href, scheme: u.protocol, host: u.host, safe: SAFE_SCHEMES.includes(u.protocol), warnings: urlWarnings(href, u) };
    } catch {
      /* fall through */
    }
  }
  return { kind: 'text', text };
}

function safeDecode(v: string) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export const KIND_LABEL: Record<Parsed['kind'], string> = {
  url: 'Link', wifi: 'Wi-Fi', vcard: 'Contact', email: 'Email', sms: 'SMS', phone: 'Phone', geo: 'Location', event: 'Event', text: 'Text',
};
