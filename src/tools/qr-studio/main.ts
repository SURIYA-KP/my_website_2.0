import { copyText, debounce, downloadBlob, downloadText, escapeHtml, initTabs, setupDropzone, toast } from '../../lib/ui';
import { encode, KIND_LABEL, parse, TYPES, typeById, type ContentType, type FieldDef, type Parsed, type Values } from './payload';
import { byteCapacity, createSymbol, styleWarnings, toCanvas, toSvg, type ECL, type Style, type Symbol } from './render';
import {
  cameraErrorMessage, cameraSupported, decodeFrame, decodeImage, getNativeDetector, listCameras, loadImage, openCamera,
  type CameraHandle, type Detection, type Point,
} from './scan';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ICONS: Record<ContentType, string> = {
  url: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/>',
  vcard: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 17a3.5 3.5 0 0 1 7 0M15 9h3M15 13h3"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  sms: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  geo: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  event: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
};

const PRESETS: { name: string; fg: string; bg: string; fg2?: string; eye?: string }[] = [
  { name: 'Classic', fg: '#111111', bg: '#ffffff' },
  { name: 'Indigo', fg: '#3730a3', bg: '#ffffff', eye: '#4f46e5' },
  { name: 'Sunset', fg: '#b91c1c', bg: '#fff7ed', fg2: '#c2410c' },
  { name: 'Ocean', fg: '#0c4a6e', bg: '#f0f9ff', fg2: '#0e7490' },
  { name: 'Forest', fg: '#14532d', bg: '#f7fee7', eye: '#15803d' },
  { name: 'Grape', fg: '#581c87', bg: '#faf5ff', fg2: '#be185d' },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let type: ContentType = 'url';
const values = Object.fromEntries(TYPES.map((t) => [t.id, { ...t.example }])) as Record<ContentType, Values>;
let customPayload: string | null = null;
let payload = '';
let sym: Symbol | null = null;
let userEcl: ECL = 'M';
const style: Style = {
  module: 'square', eye: 'square', fg: '#111111', bg: '#ffffff', transparent: false, gradient: false, fg2: '#4f46e5',
  gradType: 'diagonal', eyeColor: null, margin: 4, ecl: 'M', logo: null, logoArea: 0.12, logoPlate: true,
};

export function init() {
  initTabs(document, (_g, name) => {
    if (name !== 'scan') stopCamera();
  });
  initCreate();
  initScan();
}

// ===========================================================================
// CREATE
// ===========================================================================
function initCreate() {
  const typesEl = $('qrs-types');
  typesEl.innerHTML = TYPES.map(
    (t) => `<button type="button" class="qrs-type" role="radio" data-type="${t.id}" aria-checked="${t.id === type}" tabindex="${t.id === type ? 0 : -1}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[t.id]}</svg>${t.label}</button>`,
  ).join('');
  const typeBtns = Array.from(typesEl.querySelectorAll<HTMLButtonElement>('.qrs-type'));
  const selectType = (id: ContentType, focus = false) => {
    type = id;
    typeBtns.forEach((b) => {
      const on = b.dataset.type === id;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    setCustom(null);
    renderForm();
    update();
  };
  typeBtns.forEach((b, i) => {
    b.addEventListener('click', () => selectType(b.dataset.type as ContentType));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      selectType(typeBtns[(i + d + typeBtns.length) % typeBtns.length].dataset.type as ContentType, true);
    });
  });

  const form = $<HTMLFormElement>('qrs-form');
  form.addEventListener('submit', (e) => e.preventDefault());
  const onForm = (e: Event) => {
    const el = e.target as HTMLInputElement;
    const id = el.dataset.field;
    if (!id) return;
    const v = values[type];
    v[id] = el.type === 'checkbox' ? el.checked : el.value;
    if (type === 'event' && id === 'allday') {
      for (const k of ['start', 'end']) {
        const cur = String(v[k] ?? '');
        v[k] = el.checked ? cur.slice(0, 10) : cur && cur.length === 10 ? `${cur}T09:00` : cur;
      }
      renderForm();
    }
    if (type === 'wifi' && id === 'auth') syncWifiPassword();
    update();
  };
  form.addEventListener('input', onForm);
  form.addEventListener('change', onForm);
  form.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-reveal]');
    if (!btn) return;
    const inp = $<HTMLInputElement>(btn.dataset.reveal!);
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', String(show));
  });

  // Raw payload editing
  const ta = $<HTMLTextAreaElement>('qrs-payload');
  $<HTMLInputElement>('qrs-edit-raw').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    setCustom(on ? payload : null);
    if (on) ta.focus();
    update();
  });
  ta.addEventListener('input', () => {
    if (customPayload === null) return;
    customPayload = ta.value;
    updateDebounced();
  });
  $('qrs-copy-payload').addEventListener('click', () => (payload ? copyText(payload, 'Payload copied') : toast('Nothing to copy yet', 'error')));

  // Style controls
  $('qrs-presets').innerHTML = PRESETS.map(
    (p, i) => `<button type="button" class="qrs-preset" data-preset="${i}"><i style="background:${p.fg2 ? `linear-gradient(135deg, ${p.fg}, ${p.fg2})` : p.fg};box-shadow:inset 0 0 0 3px ${p.bg}"></i>${p.name}</button>`,
  ).join('');
  $('qrs-presets').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-preset]');
    if (!b) return;
    const p = PRESETS[+b.dataset.preset!];
    style.fg = p.fg;
    style.bg = p.bg;
    style.gradient = !!p.fg2;
    if (p.fg2) style.fg2 = p.fg2;
    style.eyeColor = p.eye ?? null;
    style.transparent = false;
    syncStyleInputs();
    update();
  });

  document.querySelectorAll<HTMLElement>('.qrs-style [data-opt]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-val]');
      if (!b) return;
      (style as any)[group.dataset.opt!] = b.dataset.val;
      group.querySelectorAll('[data-val]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      update();
    });
  });

  const bindColor = (id: string, key: 'fg' | 'bg' | 'fg2') => $<HTMLInputElement>(id).addEventListener('input', (e) => {
    style[key] = (e.target as HTMLInputElement).value;
    update();
  });
  bindColor('qrs-fg', 'fg');
  bindColor('qrs-bg', 'bg');
  bindColor('qrs-fg2', 'fg2');
  $<HTMLInputElement>('qrs-eyec').addEventListener('input', (e) => {
    style.eyeColor = (e.target as HTMLInputElement).value;
    update();
  });
  $<HTMLInputElement>('qrs-gradient').addEventListener('change', (e) => {
    style.gradient = (e.target as HTMLInputElement).checked;
    syncStyleInputs();
    update();
  });
  $<HTMLSelectElement>('qrs-gradtype').addEventListener('change', (e) => {
    style.gradType = (e.target as HTMLSelectElement).value as Style['gradType'];
    update();
  });
  $<HTMLInputElement>('qrs-eye-custom').addEventListener('change', (e) => {
    style.eyeColor = (e.target as HTMLInputElement).checked ? $<HTMLInputElement>('qrs-eyec').value : null;
    syncStyleInputs();
    update();
  });
  $<HTMLInputElement>('qrs-transparent').addEventListener('change', (e) => {
    style.transparent = (e.target as HTMLInputElement).checked;
    syncStyleInputs();
    update();
  });
  $<HTMLInputElement>('qrs-margin').addEventListener('input', (e) => {
    style.margin = +(e.target as HTMLInputElement).value;
    update();
  });
  $<HTMLSelectElement>('qrs-ecl').addEventListener('change', (e) => {
    userEcl = (e.target as HTMLSelectElement).value as ECL;
    update();
  });

  // Logo
  const logoFile = $<HTMLInputElement>('qrs-logo-file');
  $('qrs-logo-btn').addEventListener('click', () => logoFile.click());
  logoFile.addEventListener('change', async () => {
    const file = logoFile.files?.[0];
    logoFile.value = '';
    if (file) await setLogo(file);
  });
  $('qrs-logo-remove').addEventListener('click', () => {
    style.logo = null;
    syncLogoUi('');
    update();
    toast('Logo removed');
  });
  $<HTMLInputElement>('qrs-logo-size').addEventListener('input', (e) => {
    style.logoArea = +(e.target as HTMLInputElement).value / 100;
    update();
  });
  $<HTMLInputElement>('qrs-logo-plate').addEventListener('change', (e) => {
    style.logoPlate = (e.target as HTMLInputElement).checked;
    update();
  });

  // Export
  const sizeRange = $<HTMLInputElement>('qrs-size-range');
  const sizeNum = $<HTMLInputElement>('qrs-size');
  sizeRange.addEventListener('input', () => (sizeNum.value = sizeRange.value));
  sizeNum.addEventListener('input', () => {
    const v = +sizeNum.value;
    if (v >= 256 && v <= 2048) sizeRange.value = String(v);
  });
  sizeNum.addEventListener('change', () => {
    sizeNum.value = String(exportSize());
    sizeRange.value = sizeNum.value;
  });
  $('qrs-dl-png').addEventListener('click', downloadPng);
  $('qrs-dl-svg').addEventListener('click', downloadSvg);
  $('qrs-copy-img').addEventListener('click', copyImage);
  $('qrs-print').addEventListener('click', () => {
    if (!sym) return toast('Nothing to print yet', 'error');
    window.print();
  });
  $('qrs-test').addEventListener('click', testScan);

  renderForm();
  syncStyleInputs();
  update();
}

function fieldKind(f: FieldDef) {
  if (type === 'event' && (f.id === 'start' || f.id === 'end') && values.event.allday) return 'date';
  return f.kind ?? 'text';
}

function renderForm() {
  const def = typeById(type);
  const v = values[type];
  const html = def.fields
    .map((f) => {
      const id = `qrs-f-${f.id}`;
      const kind = fieldKind(f);
      const val = v[f.id];
      const cls = f.full || kind === 'checkbox' ? 'field qrs-full' : 'field';
      const hint = f.hint ? `<span class="qrs-hint" id="${id}-hint">${escapeHtml(f.hint)}</span>` : '';
      const desc = f.hint ? ` aria-describedby="${id}-hint"` : '';
      const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
      const ac = ` autocomplete="${f.autocomplete ?? 'off'}"`;
      if (kind === 'checkbox') {
        return `<div class="${cls}"><label class="checkbox"><input type="checkbox" id="${id}" data-field="${f.id}"${val ? ' checked' : ''}${desc} /> ${escapeHtml(f.label)}</label>${hint}</div>`;
      }
      const label = `<label class="label" for="${id}">${escapeHtml(f.label)}</label>`;
      if (kind === 'select') {
        const opts = f.options!.map(([ov, ol]) => `<option value="${ov}"${ov === val ? ' selected' : ''}>${escapeHtml(ol)}</option>`).join('');
        return `<div class="${cls}">${label}<select class="select" id="${id}" data-field="${f.id}"${desc}>${opts}</select>${hint}</div>`;
      }
      if (kind === 'textarea') {
        return `<div class="${cls}">${label}<textarea class="textarea" id="${id}" data-field="${f.id}" rows="3"${ph}${desc}>${escapeHtml(String(val ?? ''))}</textarea>${hint}</div>`;
      }
      const input = `<input class="input" type="${kind}" id="${id}" data-field="${f.id}" value="${escapeHtml(String(val ?? ''))}"${ph}${ac}${desc}${f.step ? ` step="${f.step}"` : ''} spellcheck="false" />`;
      if (kind === 'password') {
        return `<div class="${cls}">${label}<div class="qrs-pw">${input}<button type="button" class="btn" data-reveal="${id}" aria-pressed="false" aria-label="Show password">Show</button></div>${hint}</div>`;
      }
      return `<div class="${cls}">${label}${input}${hint}</div>`;
    })
    .join('');
  $('qrs-form').innerHTML = html;
  if (type === 'wifi') syncWifiPassword();
}

function syncWifiPassword() {
  const pw = document.getElementById('qrs-f-password') as HTMLInputElement | null;
  if (!pw) return;
  const open = values.wifi.auth === 'nopass';
  pw.disabled = open;
  pw.placeholder = open ? 'Not needed for open networks' : 'Password';
}

function setCustom(v: string | null) {
  customPayload = v;
  const on = v !== null;
  $<HTMLInputElement>('qrs-edit-raw').checked = on;
  const ta = $<HTMLTextAreaElement>('qrs-payload');
  ta.readOnly = !on;
  $('qrs-form').classList.toggle('is-locked', on);
  $('qrs-form').toggleAttribute('inert', on);
  $('qrs-payload-hint').textContent = on
    ? 'Editing raw text: the form above is paused. Untick “Edit raw text” to go back to the form.'
    : 'This exact text is stored in the code. Turn on “Edit raw text” to fine-tune it by hand.';
}

function syncStyleInputs() {
  $<HTMLInputElement>('qrs-fg').value = style.fg;
  $<HTMLInputElement>('qrs-bg').value = style.bg;
  $<HTMLInputElement>('qrs-fg2').value = style.fg2;
  $<HTMLInputElement>('qrs-gradient').checked = style.gradient;
  $('qrs-fg2-wrap').hidden = !style.gradient;
  $('qrs-gradtype').hidden = !style.gradient;
  $<HTMLInputElement>('qrs-eye-custom').checked = !!style.eyeColor;
  $('qrs-eye-wrap').hidden = !style.eyeColor;
  if (style.eyeColor) $<HTMLInputElement>('qrs-eyec').value = style.eyeColor;
  $<HTMLInputElement>('qrs-transparent').checked = style.transparent;
  $('qrs-bg-wrap').style.opacity = style.transparent ? '0.4' : '';
  $<HTMLInputElement>('qrs-bg').disabled = style.transparent;
}

async function setLogo(file: File) {
  if (!file.type.startsWith('image/')) {
    toast('Please choose an image file for the logo', 'error');
    return;
  }
  try {
    const img = await loadImage(file);
    // Downscale big logos so exported SVGs stay small.
    const max = 512;
    const w0 = img.naturalWidth || 256, h0 = img.naturalHeight || 256;
    const k = Math.min(1, max / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * k));
    c.height = Math.max(1, Math.round(h0 * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    const src = c.toDataURL('image/png');
    const small = new Image();
    small.src = src;
    await small.decode();
    style.logo = { src, img: small, w: c.width, h: c.height };
    syncLogoUi(file.name);
    update();
    toast('Logo added · error correction set to H');
  } catch (e) {
    toast((e as Error).message || 'Could not load that image', 'error');
  }
}

function syncLogoUi(name: string) {
  const has = !!style.logo;
  const thumb = $<HTMLImageElement>('qrs-logo-thumb');
  thumb.hidden = !has;
  if (style.logo) thumb.src = style.logo.src;
  $('qrs-logo-name').textContent = has ? name : 'PNG, JPG or SVG. Stays on your device.';
  $('qrs-logo-btn-text').textContent = has ? 'Replace…' : 'Add image…';
  $('qrs-logo-remove').hidden = !has;
  $('qrs-logo-opts').hidden = !has;
}

const MODE_NAMES: Record<string, string> = { Numeric: 'numeric', Alphanumeric: 'alphanumeric', Byte: 'byte', Kanji: 'kanji' };

function update() {
  // Payload
  const ta = $<HTMLTextAreaElement>('qrs-payload');
  const errEl = $('qrs-form-error');
  let formError = '';
  if (customPayload !== null) {
    payload = customPayload;
  } else {
    const enc = encode(type, values[type]);
    payload = enc.payload;
    formError = enc.error ?? '';
    if (ta.value !== payload) ta.value = payload;
  }
  errEl.hidden = !formError;
  errEl.textContent = formError;

  // Style-derived values
  style.ecl = style.logo ? 'H' : userEcl;
  const eclSel = $<HTMLSelectElement>('qrs-ecl');
  eclSel.value = style.ecl;
  eclSel.disabled = !!style.logo;
  $('qrs-ecl-note').hidden = !style.logo;
  $('qrs-margin-val').textContent = `${style.margin} module${style.margin === 1 ? '' : 's'}`;
  $('qrs-logo-size-val').textContent = `${Math.round(style.logoArea * 100)}% of area`;
  $('qrs-test-result').textContent = '';

  const svgHost = $('qrs-svg');
  const empty = $('qrs-empty');
  const exportBtns = ['qrs-dl-png', 'qrs-dl-svg', 'qrs-copy-img', 'qrs-print', 'qrs-test'].map((id) => $<HTMLButtonElement>(id));
  const setEmpty = (msg: string) => {
    sym = null;
    svgHost.innerHTML = '';
    svgHost.hidden = true;
    empty.hidden = false;
    $('qrs-empty-text').textContent = msg;
    $('qrs-badges').innerHTML = '';
    $('qrs-cap-value').textContent = '';
    $('qrs-bar-fill').style.width = '0';
    $('qrs-warnings').innerHTML = '';
    $('qrs-print-caption').textContent = '';
    exportBtns.forEach((b) => (b.disabled = true));
  };

  if (!payload) return setEmpty(formError || 'Fill in the form to see your code.');
  try {
    sym = createSymbol(payload, style.ecl);
  } catch (e) {
    const big = /too big/i.test((e as Error).message);
    const max = byteCapacity(40, style.ecl);
    return setEmpty(big ? `Too much data for one QR code (max ≈ ${max.toLocaleString()} bytes at level ${style.ecl}). Shorten the content or lower the error correction.` : (e as Error).message);
  }

  svgHost.hidden = false;
  empty.hidden = true;
  svgHost.innerHTML = toSvg(sym, style, 340, `QR code: ${payload.slice(0, 80)}`);
  exportBtns.forEach((b) => (b.disabled = false));

  const bytes = new TextEncoder().encode(payload).length;
  const modes = sym.modes.map((m) => MODE_NAMES[m] ?? m).join(' + ');
  $('qrs-badges').innerHTML =
    `<span class="badge badge-accent" id="qrs-version" title="QR version">Version ${sym.version}</span>` +
    `<span class="badge" title="Modules per side">${sym.size}×${sym.size}</span>` +
    `<span class="badge" title="Error correction level">ECL ${sym.ecl}</span>`;
  const pct = Math.min(100, Math.round((sym.usedBits / sym.capacityBits) * 100));
  $('qrs-cap-label').textContent = `${bytes.toLocaleString()} byte${bytes === 1 ? '' : 's'} · ${modes} mode · mask ${sym.mask}`;
  $('qrs-cap-value').textContent = `${pct}% of v${sym.version}`;
  $('qrs-cap-value').title = `${sym.usedBits} of ${sym.capacityBits} data bits used. Up to ~${byteCapacity(sym.version, sym.ecl)} bytes fit in version ${sym.version}; ${byteCapacity(40, sym.ecl).toLocaleString()} bytes at most (version 40).`;
  const bar = $('qrs-bar');
  bar.setAttribute('aria-valuenow', String(pct));
  bar.classList.toggle('is-high', sym.version >= 15);
  $('qrs-bar-fill').style.width = `${pct}%`;

  const warns = styleWarnings(style);
  if (sym.version >= 15) warns.push({ level: 'warning', text: `Dense code (version ${sym.version}). Print it at least ${Math.ceil(sym.size * 0.06 + 0.5)} cm wide, or shorten the content.` });
  if (style.module === 'dots' && sym.ecl === 'L') warns.push({ level: 'warning', text: 'Dots with level L leave little room for error. Consider M or higher.' });
  $('qrs-warnings').innerHTML = warns
    .map((w) => `<li class="alert alert-${w.level === 'error' ? 'error' : 'warning'}"><span aria-hidden="true">${w.level === 'error' ? '✕' : '!'}</span><span>${escapeHtml(w.text)}</span></li>`)
    .join('');
  $('qrs-print-caption').textContent = payload.length > 300 ? payload.slice(0, 300) + '…' : payload;
}
const updateDebounced = debounce(update, 120);

function exportSize() {
  const v = Math.round(+$<HTMLInputElement>('qrs-size').value);
  return Number.isFinite(v) ? Math.min(2048, Math.max(256, v)) : 1024;
}

function fileBase() {
  return `qr-${customPayload !== null ? 'custom' : type}`;
}

function pngBlob(px = exportSize()): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!sym) return reject(new Error('Nothing to export yet'));
    toCanvas(sym, style, px).toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

async function downloadPng() {
  try {
    const px = exportSize();
    downloadBlob(await pngBlob(px), `${fileBase()}-${px}.png`);
    toast(`PNG downloaded (${px}×${px})`);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function downloadSvg() {
  if (!sym) return toast('Nothing to export yet', 'error');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n${toSvg(sym, style, exportSize(), 'QR code')}\n`;
  downloadText(svg, `${fileBase()}.svg`, 'image/svg+xml');
  toast('SVG downloaded');
}

async function copyImage() {
  if (!sym) return toast('Nothing to copy yet', 'error');
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('unsupported');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
    toast('Image copied to clipboard');
  } catch {
    toast('This browser does not allow copying images. Download the PNG instead.', 'error', 3500);
  }
}

async function testScan() {
  if (!sym) return;
  const out = $('qrs-test-result');
  out.innerHTML = '<span class="muted">Decoding…</span>';
  const canvas = toCanvas(sym, { ...style, transparent: false, bg: style.transparent ? '#ffffff' : style.bg }, 600);
  const det = await decodeImage(canvas, canvas.width, canvas.height);
  if (det && det.text === payload) {
    out.innerHTML = '<span class="badge badge-success">✓ Scans correctly</span> <span class="faint">Decoded content matches the payload.</span>';
  } else if (det) {
    out.innerHTML = '<span class="badge badge-warning">Mismatch</span> <span class="faint">Decoded text differs from the payload.</span>';
  } else {
    out.innerHTML = '<span class="badge badge-danger">✕ Could not decode</span> <span class="faint">Increase contrast, use a smaller logo or a higher error-correction level.</span>';
  }
}

// ===========================================================================
// SCAN
// ===========================================================================
interface HistoryItem {
  id: number;
  text: string;
  parsed: Parsed;
  source: string;
  time: Date;
}
const history: HistoryItem[] = [];
let historySeq = 0;
let currentId = -1;

let cam: CameraHandle | null = null;
let raf = 0;
let busy = false;
let lastTick = 0;
let lastHit = 0;
let lastCamText = '';
let lastCamTime = 0;
let torchOn = false;

function initScan() {
  setupDropzone($('qrs-drop'), (files) => scanBlob(files[0], 'Image file'), { accept: 'image/*' });

  document.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgItem = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!imgItem) return;
    const file = imgItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    showTab('scan');
    scanBlob(file, 'Pasted image');
  });

  $('qrs-scan-sample').addEventListener('click', async () => {
    if (!sym) return showImgMsg('The Create tab has no code yet. Fill in its form first.', 'warning');
    const blob = await pngBlob(600);
    scanBlob(blob, 'Code from Create');
  });

  getNativeDetector().then((d) => {
    $('qrs-engine').textContent = d ? 'Decoder: built-in BarcodeDetector (jsQR fallback)' : 'Decoder: jsQR';
  });

  $('qrs-cam-start').addEventListener('click', startCamera);
  $('qrs-cam-stop').addEventListener('click', () => {
    stopCamera();
    showCamMsg('', 'info');
  });
  $<HTMLSelectElement>('qrs-cam-select').addEventListener('change', () => {
    if (cam) startCamera();
  });
  $('qrs-cam-torch').addEventListener('click', async () => {
    if (!cam) return;
    const ok = await cam.setTorch(!torchOn);
    if (!ok) return toast('Torch could not be switched', 'error');
    torchOn = !torchOn;
    $('qrs-cam-torch').setAttribute('aria-pressed', String(torchOn));
    $('qrs-cam-torch').textContent = torchOn ? 'Torch on' : 'Torch';
  });
  $('qrs-history-clear').addEventListener('click', () => {
    history.length = 0;
    renderHistory();
    toast('Scan history cleared');
  });
  $('qrs-history').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-hid]');
    if (!b) return;
    const item = history.find((h) => h.id === +b.dataset.hid!);
    if (item) showResult(item);
  });
  $('qrs-result').addEventListener('click', onResultAction);
  window.addEventListener('pagehide', stopCamera);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && cam) {
      stopCamera();
      showCamMsg('Camera stopped because the page was hidden. Press Start camera to resume.', 'info');
    }
  });
  renderHistory();
}

function showTab(name: string) {
  const tab = document.querySelector<HTMLButtonElement>(`[data-tabs="qrs"] [data-tab="${name}"]`);
  if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
}

function showImgMsg(text: string, kind: 'error' | 'warning' | 'success' | 'info') {
  const el = $('qrs-img-msg');
  el.hidden = !text;
  el.className = `alert alert-${kind}`;
  el.textContent = text;
}

async function scanBlob(blob: Blob, source: string) {
  if (!blob.type.startsWith('image/') && blob.type) {
    showImgMsg(`“${(blob as File).name ?? 'This file'}” is not an image. Choose a PNG, JPG, GIF, WebP or similar.`, 'error');
    return;
  }
  showImgMsg('Scanning…', 'info');
  let img: HTMLImageElement;
  try {
    img = await loadImage(blob);
  } catch (e) {
    showImgMsg((e as Error).message, 'error');
    return;
  }
  const w = img.naturalWidth, h = img.naturalHeight;
  let det: Detection | null = null;
  try {
    det = await decodeImage(img, w, h);
  } catch (e) {
    showImgMsg(`Decoding failed: ${(e as Error).message}`, 'error');
  }
  drawImagePreview(img, det?.corners ?? null);
  URL.revokeObjectURL(img.src);
  if (!det) {
    showImgMsg('No QR code found in this image. Try a sharper, well-lit photo where the whole code (with its white border) is visible.', 'warning');
    return;
  }
  showImgMsg(`QR code found (${det.engine}).`, 'success');
  addScan(det.text, source);
}

function drawImagePreview(img: HTMLImageElement, corners: Point[] | null) {
  const wrap = $('qrs-img-preview');
  const c = $<HTMLCanvasElement>('qrs-img-canvas');
  const k = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (corners) outline(ctx, corners.map((p) => ({ x: p.x * k, y: p.y * k })), Math.max(3, c.width / 150));
  wrap.hidden = false;
}

function outline(ctx: CanvasRenderingContext2D, pts: Point[], lw: number) {
  if (pts.length < 3) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw * 2.2;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#22c55e';
  ctx.fillStyle = 'rgba(34,197,94,0.15)';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function addScan(text: string, source: string) {
  const item: HistoryItem = { id: ++historySeq, text, parsed: parse(text), source, time: new Date() };
  history.unshift(item);
  if (history.length > 50) history.pop();
  showResult(item);
}

function renderHistory() {
  const list = $('qrs-history');
  list.innerHTML = history
    .map((h) => {
      const label = KIND_LABEL[h.parsed.kind];
      const preview = h.text.replace(/\s+/g, ' ').slice(0, 120);
      return `<li><button type="button" data-hid="${h.id}" aria-current="${h.id === currentId}"><span class="badge">${label}</span><span class="qrs-h-text" title="${escapeHtml(preview)}">${escapeHtml(preview)}</span><span class="qrs-h-time">${h.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></button></li>`;
    })
    .join('');
  $('qrs-history-empty').hidden = history.length > 0;
  $<HTMLButtonElement>('qrs-history-clear').disabled = history.length === 0;
}

const kv = (rows: [string, string][]) =>
  `<table class="qrs-kv"><tbody>${rows.filter(([, v]) => v !== '').map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody></table>`;
const btn = (action: string, label: string, primary = false, extra = '') =>
  `<button type="button" class="btn btn-sm${primary ? ' btn-primary' : ''}" data-action="${action}"${extra}>${label}</button>`;

let shown: HistoryItem | null = null;

function showResult(item: HistoryItem) {
  shown = item;
  currentId = item.id;
  const p = item.parsed;
  let body = '';
  switch (p.kind) {
    case 'url':
      body = `<div class="qrs-result-main mono" id="qrs-result-url">${escapeHtml(p.url)}</div>
        <div class="qrs-result-sub">Goes to <strong>${escapeHtml(p.host)}</strong>${p.safe ? '' : ` · unusual scheme “${escapeHtml(p.scheme)}”`}. Check the address before opening.</div>
        <div class="qrs-result-actions">${p.safe ? btn('open', 'Open link', true) : ''}${btn('copy-raw', 'Copy link')}</div>`;
      break;
    case 'wifi':
      body = `<div class="qrs-result-main">${escapeHtml(p.ssid || '(no name)')}</div>
        ${kv([['Network', p.ssid], ['Security', p.auth === 'nopass' ? 'Open (no password)' : p.auth], ['Password', p.auth === 'nopass' ? '' : p.password], ['Hidden', p.hidden ? 'Yes' : 'No']])}
        <div class="qrs-result-actions">${p.password ? btn('copy-password', 'Copy password', true) : ''}${btn('copy-ssid', 'Copy network name')}</div>
        <p class="small faint">Browsers cannot join Wi-Fi networks. Copy the password, then pick the network in your device settings.</p>`;
      break;
    case 'vcard':
      body = `<div class="qrs-result-main">${escapeHtml(p.name || 'Contact card')}</div>${kv(p.fields)}
        <div class="qrs-result-actions">${btn('save-vcf', 'Save contact (.vcf)', true)}${btn('copy-raw', 'Copy vCard')}</div>`;
      break;
    case 'event':
      body = `<div class="qrs-result-main">${escapeHtml(p.summary || 'Calendar event')}</div>${kv(p.fields)}
        <div class="qrs-result-actions">${btn('save-ics', 'Add to calendar (.ics)', true)}${btn('copy-raw', 'Copy')}</div>`;
      break;
    case 'email':
      body = `<div class="qrs-result-main">${escapeHtml(p.to)}</div>${kv([['To', p.to], ['Subject', p.subject], ['Message', p.body]])}
        <div class="qrs-result-actions">${btn('open', 'Compose email', true)}${btn('copy-text', 'Copy address', false, ` data-text="${escapeHtml(p.to)}"`)}</div>`;
      break;
    case 'sms':
      body = `<div class="qrs-result-main">${escapeHtml(p.number)}</div>${kv([['To', p.number], ['Message', p.message]])}
        <div class="qrs-result-actions">${btn('open', 'Open in messages', true)}${btn('copy-text', 'Copy number', false, ` data-text="${escapeHtml(p.number)}"`)}${p.message ? btn('copy-text', 'Copy message', false, ` data-text="${escapeHtml(p.message)}"`) : ''}</div>`;
      break;
    case 'phone':
      body = `<div class="qrs-result-main">${escapeHtml(p.number)}</div>
        <div class="qrs-result-actions">${btn('open', 'Call', true)}${btn('copy-text', 'Copy number', false, ` data-text="${escapeHtml(p.number)}"`)}</div>`;
      break;
    case 'geo':
      body = `<div class="qrs-result-main">${escapeHtml(p.label || `${p.lat}, ${p.lng}`)}</div>${kv([['Latitude', p.lat], ['Longitude', p.lng], ['Label', p.label]])}
        <div class="qrs-result-actions">${btn('open', 'Open in maps app', true)}${btn('copy-text', 'Copy coordinates', false, ` data-text="${p.lat}, ${p.lng}"`)}</div>`;
      break;
    case 'text':
      body = `<pre class="qrs-text-block" id="qrs-result-text">${escapeHtml(p.text)}</pre><div class="qrs-result-actions">${btn('copy-raw', 'Copy text', true)}</div>`;
      break;
  }
  const raw = p.kind === 'text' ? '' : `<details class="qrs-raw"><summary>Raw text · ${item.text.length} characters</summary><pre>${escapeHtml(item.text)}</pre></details>`;
  $('qrs-result').innerHTML = `${body}${raw}<p class="small faint" style="margin:10px 0 0">${escapeHtml(item.source)} · ${item.time.toLocaleTimeString()}</p>`;
  $('qrs-result-kind').innerHTML = `<span class="badge badge-accent" id="qrs-result-badge">${KIND_LABEL[p.kind]}</span>`;
  renderHistory();
}

function openHref(p: Parsed): string | null {
  switch (p.kind) {
    case 'url': return p.safe ? p.url : null;
    case 'email': return `mailto:${encodeURI(p.to)}?subject=${encodeURIComponent(p.subject)}&body=${encodeURIComponent(p.body)}`;
    case 'sms': return `sms:${p.number.replace(/[^\d+*#]/g, '')}${p.message ? `?body=${encodeURIComponent(p.message)}` : ''}`;
    case 'phone': return `tel:${p.number.replace(/[^\d+*#]/g, '')}`;
    case 'geo': return `geo:${p.lat},${p.lng}${p.label ? `?q=${encodeURIComponent(p.label)}` : ''}`;
    default: return null;
  }
}

function onResultAction(e: Event) {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  if (!b || !shown) return;
  const p = shown.parsed;
  switch (b.dataset.action) {
    case 'open': {
      const href = openHref(p);
      if (!href) return;
      if (p.kind === 'url') window.open(href, '_blank', 'noopener,noreferrer');
      else window.location.href = href;
      break;
    }
    case 'copy-raw': copyText(shown.text); break;
    case 'copy-text': copyText(b.dataset.text ?? ''); break;
    case 'copy-password': if (p.kind === 'wifi') copyText(p.password, 'Password copied'); break;
    case 'copy-ssid': if (p.kind === 'wifi') copyText(p.ssid, 'Network name copied'); break;
    case 'save-vcf': {
      const name = (p.kind === 'vcard' && p.name) || 'contact';
      downloadText(shown.text.replace(/\r?\n/g, '\r\n') + '\r\n', `${name.replace(/[^\w.-]+/g, '_')}.vcf`, 'text/vcard');
      toast('Contact file downloaded');
      break;
    }
    case 'save-ics': {
      let t = shown.text.trim();
      if (!/^BEGIN:VCALENDAR/i.test(t)) t = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//QR Studio//EN\r\n${t}\r\nEND:VCALENDAR`;
      downloadText(t.replace(/\r?\n/g, '\r\n') + '\r\n', 'event.ics', 'text/calendar');
      toast('Calendar file downloaded');
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
function showCamMsg(text: string, kind: 'error' | 'warning' | 'info' | 'success') {
  const el = $('qrs-cam-msg');
  el.hidden = !text;
  el.className = `alert alert-${kind}`;
  el.textContent = text;
}

function setCamState(state: 'Off' | 'Starting…' | 'Scanning' | 'Error') {
  const b = $('qrs-cam-state');
  b.textContent = state;
  b.className = `badge${state === 'Scanning' ? ' badge-success' : state === 'Error' ? ' badge-danger' : ''}`;
}

async function refreshCameraList() {
  const sel = $<HTMLSelectElement>('qrs-cam-select');
  const cams = await listCameras();
  const current = cam?.track.getSettings().deviceId ?? sel.value;
  sel.innerHTML = '<option value="">Default camera</option>' +
    cams.filter((c) => c.deviceId).map((c, i) => `<option value="${escapeHtml(c.deviceId)}">${escapeHtml(c.label || `Camera ${i + 1}`)}</option>`).join('');
  if (current && cams.some((c) => c.deviceId === current)) sel.value = current;
}

async function startCamera() {
  const startBtn = $<HTMLButtonElement>('qrs-cam-start');
  if (!cameraSupported()) {
    setCamState('Error');
    showCamMsg(window.isSecureContext
      ? 'This browser does not support camera access. Scan from an image file or paste a screenshot instead.'
      : 'Camera access needs a secure (HTTPS) page. Scan from an image file or paste a screenshot instead.', 'error');
    return;
  }
  const deviceId = $<HTMLSelectElement>('qrs-cam-select').value || undefined;
  stopCamera();
  startBtn.disabled = true;
  setCamState('Starting…');
  showCamMsg('Starting camera… your browser may ask for permission.', 'info');
  try {
    cam = await openCamera(deviceId);
  } catch (e) {
    cam = null;
    startBtn.disabled = false;
    setCamState('Error');
    showCamMsg(cameraErrorMessage(e), 'error');
    return;
  }
  const video = $<HTMLVideoElement>('qrs-video');
  video.srcObject = cam.stream;
  try {
    await video.play();
  } catch {
    /* autoplay of a muted stream normally succeeds; frames still arrive */
  }
  $('qrs-video-wrap').classList.add('is-on');
  startBtn.disabled = false;
  startBtn.textContent = 'Restart';
  $<HTMLButtonElement>('qrs-cam-stop').disabled = false;
  torchOn = false;
  const torch = $('qrs-cam-torch');
  torch.hidden = !cam.torch;
  torch.textContent = 'Torch';
  torch.setAttribute('aria-pressed', 'false');
  setCamState('Scanning');
  showCamMsg('Point the camera at a QR code. Detected codes are outlined and added below.', 'info');
  refreshCameraList();
  cam.track.addEventListener('ended', () => {
    stopCamera();
    showCamMsg('The camera was disconnected.', 'warning');
  });
  const native = await getNativeDetector();
  const work = document.createElement('canvas');
  const overlay = $<HTMLCanvasElement>('qrs-overlay');
  const tick = (t: number) => {
    if (!cam) return;
    raf = requestAnimationFrame(tick);
    if (busy || t - lastTick < 100) return;
    busy = true;
    lastTick = t;
    decodeFrame(video, work, native)
      .then((det) => {
        if (!cam) return;
        drawOverlay(overlay, video, det, t);
        if (det) onCameraDetect(det.text);
      })
      .catch(() => {})
      .finally(() => (busy = false));
  };
  raf = requestAnimationFrame(tick);
}

function drawOverlay(overlay: HTMLCanvasElement, video: HTMLVideoElement, det: Detection | null, t: number) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (overlay.width !== vw) overlay.width = vw;
  if (overlay.height !== vh) overlay.height = vh;
  const ctx = overlay.getContext('2d')!;
  if (det) {
    lastHit = t;
    ctx.clearRect(0, 0, vw, vh);
    outline(ctx, det.corners, Math.max(3, vw / 160));
    $('qrs-video-wrap').classList.add('is-hit');
  } else if (t - lastHit > 600) {
    ctx.clearRect(0, 0, vw, vh);
    $('qrs-video-wrap').classList.remove('is-hit');
  }
}

function onCameraDetect(text: string) {
  const now = performance.now();
  if (text === lastCamText && now - lastCamTime < 4000) {
    lastCamTime = now;
    return;
  }
  lastCamText = text;
  lastCamTime = now;
  addScan(text, 'Camera');
  toast('QR code detected');
  navigator.vibrate?.(40);
}

function stopCamera() {
  cancelAnimationFrame(raf);
  raf = 0;
  busy = false;
  if (cam) {
    cam.stop();
    cam = null;
  }
  const video = document.getElementById('qrs-video') as HTMLVideoElement | null;
  if (!video) return;
  video.srcObject = null;
  const overlay = $<HTMLCanvasElement>('qrs-overlay');
  overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
  $('qrs-video-wrap').classList.remove('is-on', 'is-hit');
  $<HTMLButtonElement>('qrs-cam-stop').disabled = true;
  $<HTMLButtonElement>('qrs-cam-start').textContent = 'Start camera';
  $('qrs-cam-torch').hidden = true;
  if ($('qrs-cam-state').textContent !== 'Error') setCamState('Off');
}
