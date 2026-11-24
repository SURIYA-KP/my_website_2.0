// Image Studio page controller: file intake, the results list, settings, downloads and dialogs.
import { debounce, downloadBlob, escapeHtml, formatBytes, setupDropzone, toast } from '../../lib/ui';
import { CompareViewer } from './compare';
import { CropEditor } from './crop';
import { Cancelled, Engine, decodeOnMain } from './engine';
import { formatCoord, metaSummary, parseMeta, type ImageMeta } from './exif';
import { applyEdit, domEnv, renderRegion, type JobResult } from './pipeline';
import { createSettingsForm, type SettingsForm } from './settings-form';
import {
  DEFAULT_SETTINGS, EXT, LABEL, buildFilenames, cloneSettings, editedSize, sourceLabel,
  type Edit, type Settings,
} from './types';

// ---------------------------------------------------------------- icons
const svg = (d: string, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  compare: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 2v20"/>'),
  crop: svg('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  download: svg('<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  pin: svg('<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>', 12),
  warn: svg('<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>', 17),
};

// ---------------------------------------------------------------- types
type Status = 'reading' | 'queued' | 'working' | 'done' | 'error';
interface Item {
  id: number;
  file: File;
  name: string;
  mime: string;
  isSvg: boolean;
  meta: ImageMeta | null;
  override: Settings | null;
  edit: Edit | null;
  version: number;
  status: Status;
  progress: string;
  error?: string;
  result?: JobResult;
  url?: string;
  srcUrl?: string;
  el: HTMLLIElement;
  parts: { thumb: HTMLButtonElement; info: HTMLElement; save: HTMLElement; extra: HTMLElement; acts: HTMLElement };
}

// ---------------------------------------------------------------- file sniffing
type Sniff = { mime: string; svg: boolean } | { error: string };
const ascii = (b: Uint8Array, s: number, n: number) => String.fromCharCode(...b.subarray(s, s + n));
export function sniff(b: Uint8Array, file: File): Sniff {
  if (!b.length) return { error: 'The file is empty.' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', svg: false };
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { mime: 'image/png', svg: false };
  if (ascii(b, 0, 4) === 'GIF8') return { mime: 'image/gif', svg: false };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { mime: 'image/webp', svg: false };
  if (b[0] === 0x42 && b[1] === 0x4d && b.length > 26) return { mime: 'image/bmp', svg: false };
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', svg: false };
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return { mime: 'image/heic', svg: false };
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { mime: 'image/x-icon', svg: false };
  if (ascii(b, 0, 5) === '%PDF-') return { error: 'This is a PDF document, not an image. Use the PDF Toolkit for PDFs.' };
  if (ascii(b, 0, 2) === 'PK') return { error: 'This is a ZIP archive, not an image. Unzip it and add the images inside.' };
  const head = new TextDecoder().decode(b.subarray(0, 4096)).replace(/^﻿/, '');
  if (/<svg[\s>]/i.test(head) && /^\s*</.test(head)) return { mime: 'image/svg+xml', svg: true };
  const sample = b.subarray(0, 512);
  let printable = 0;
  for (const c of sample) if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc0) printable++;
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1] || '').toLowerCase();
  const named = /^(jpe?g|png|gif|webp|bmp|avif|svg|ico)$/.test(ext) ? ` despite its .${ext} name` : '';
  if (printable / sample.length > 0.95) return { error: `This is a text file${named}, not an image.` };
  return { error: `This file is not an image${named} (unrecognized format). Supported: JPEG, PNG, WebP, GIF, BMP, AVIF and SVG.` };
}

// ---------------------------------------------------------------- state
const items: Item[] = [];
let global: Settings = cloneSettings(DEFAULT_SETTINGS);
let seq = 0;
let pasteSeq = 0;
const engine = new Engine();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const pct = (from: number, to: number) => (from > 0 ? ((to - from) / from) * 100 : 0);
const fmtPct = (p: number) => `${p <= 0 ? '−' : '+'}${Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.round(Math.abs(p))}%`;
const effective = (it: Item) => it.override ?? global;
/** Metadata worth flagging: EXIF, XMP or text. A color profile alone is harmless (browsers' encoders add one). */
const privacyMeta = (m: ImageMeta | null | undefined) => !!m && (m.hasExif || m.hasXmp || m.hasComment || m.hasText);

function settingsSummary(s: Settings): string {
  const parts = [s.format === 'keep' ? 'Keep format' : LABEL[s.format]];
  if (s.format !== 'png') parts.push(`quality ${s.quality}`);
  const r = s.resize;
  if (r.mode === 'fit') parts.push(`max ${r.width || 'any'}×${r.height || 'any'}`);
  else if (r.mode === 'percent') parts.push(`${r.percent}%`);
  else if (r.mode === 'exact') parts.push(`${r.width || 'auto'}×${r.height || 'auto'}`);
  if (s.target.enabled) parts.push(`≤ ${s.target.kb >= 1024 && s.target.kb % 1024 === 0 ? `${s.target.kb / 1024} MB` : `${s.target.kb} KB`}`);
  return parts.join(' · ');
}

/** Download names for every finished item, de-duplicated in list order. */
function outputNames(): Map<Item, string> {
  const done = items.filter((it) => it.status === 'done' && it.result);
  const names = buildFilenames(done.map((it) => ({ name: it.name, ext: EXT[it.result!.format] })));
  return new Map(done.map((it, i) => [it, names[i]]));
}

export function init() {
  const root = $('is-root');
  const list = $<HTMLUListElement>('is-list');
  const live = $('is-live');
  const announce = (msg: string) => { live.textContent = ''; requestAnimationFrame(() => (live.textContent = msg)); };
  const viewer = new CompareViewer($<HTMLDialogElement>('is-cmp'));
  const cropper = new CropEditor($<HTMLDialogElement>('is-crop'));
  const ready = engine.init();

  // ------------------------------------------------------------ settings
  let form: SettingsForm | null = null;
  let itemForm: SettingsForm | null = null;
  let itemDraft: Settings | null = null;
  let itemTarget: Item | null = null;
  const settingsPanel = $<HTMLDetailsElement>('is-settings-panel');
  if (window.matchMedia('(max-width: 900px)').matches) settingsPanel.open = false;
  const reprocessAll = debounce(() => items.forEach((it) => { if (!it.override && it.status !== 'error' && it.status !== 'reading') processItem(it); }), 300);

  ready.then(() => {
    $('is-settings').replaceChildren();
    form = createSettingsForm($('is-settings'), {
      id: 'is-g', supported: engine.supported, initial: global,
      onChange: (s) => { global = s; $('is-settings-sum').textContent = settingsSummary(s); reprocessAll(); },
    });
    $('is-settings-sum').textContent = settingsSummary(global);
    itemForm = createSettingsForm($('is-item-form'), {
      id: 'is-o', supported: engine.supported, initial: global,
      onChange: (s) => { itemDraft = s; },
    });
    const n = engine.mode === 'worker' ? 'in background workers (OffscreenCanvas), so the page stays responsive' : 'on the main thread (this browser has no OffscreenCanvas workers)';
    const avif = engine.supported.includes('avif') ? ' AVIF output is available.' : ' AVIF output is not offered: this browser cannot encode it.';
    $('is-engine').textContent = `Images are processed ${n}.${avif}`;
  });

  // ------------------------------------------------------------ intake
  const dz = $('is-drop');
  const openPicker = setupDropzone(dz, (files) => addFiles(files), { multiple: true, accept: 'image/*,.svg,.avif,.bmp,.ico', pageWide: true });
  $('is-add').addEventListener('click', () => openPicker());
  $('is-sample').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('is-sample');
    btn.disabled = true;
    try {
      const { makeExamples } = await import('./examples');
      addFiles(await makeExamples());
    } catch (e) {
      toast(`Could not create the samples: ${(e as Error).message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  document.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    let files = Array.from(dt.files ?? []);
    if (!files.length) for (const it of Array.from(dt.items ?? [])) if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    files = files.filter((f) => f.type.startsWith('image/') || /\.svg$/i.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    addFiles(files.map((f) => {
      if (f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f;
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      return new File([f], `pasted-image-${++pasteSeq}.${ext}`, { type: f.type, lastModified: Date.now() });
    }));
    toast(files.length === 1 ? 'Pasted image added' : `${files.length} pasted images added`);
  });

  function addFiles(files: File[]) {
    if (!files.length) return;
    const added = files.map((f) => createItem(f));
    root.classList.add('is-has-items');
    refresh();
    announce(`Added ${added.length} image${added.length === 1 ? '' : 's'}`);
    added.forEach((it) => analyze(it));
  }

  function createItem(file: File): Item {
    const el = document.createElement('li');
    el.className = 'is-item';
    el.innerHTML = `
      <button type="button" class="is-thumb" aria-label="Compare before and after: ${escapeHtml(file.name)}"></button>
      <div class="is-info"></div>
      <div class="is-save"></div>
      <div class="is-acts">
        <button type="button" class="btn btn-icon btn-ghost" data-act="compare" aria-label="Compare before and after" title="Compare before / after">${I.compare}</button>
        <button type="button" class="btn btn-icon btn-ghost" data-act="crop" aria-label="Crop, rotate or flip" title="Crop, rotate, flip">${I.crop}</button>
        <button type="button" class="btn btn-icon btn-ghost" data-act="settings" aria-label="Settings for this image" title="Settings for this image only">${I.sliders}</button>
        <button type="button" class="btn btn-icon btn-ghost is-act-dl" data-act="download" aria-label="Download" title="Download">${I.download}</button>
        <button type="button" class="btn btn-icon btn-ghost is-act-del" data-act="remove" aria-label="Remove" title="Remove">${I.x}</button>
      </div>
      <div class="is-extra"></div>`;
    const q = (s: string) => el.querySelector<HTMLElement>(s)!;
    const it: Item = {
      id: ++seq, file, name: file.name || 'image', mime: file.type, isSvg: false, meta: null, override: null, edit: null,
      version: 0, status: 'reading', progress: 'Reading', el,
      parts: { thumb: q('.is-thumb') as HTMLButtonElement, info: q('.is-info'), save: q('.is-save'), extra: q('.is-extra'), acts: q('.is-acts') },
    };
    el.dataset.id = String(it.id);
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act], .is-thumb');
      if (!b || (b as HTMLButtonElement).disabled) return;
      const act = b.classList.contains('is-thumb') ? 'compare' : b.dataset.act;
      if (act === 'compare') openCompare(it);
      else if (act === 'crop') openCrop(it);
      else if (act === 'settings') openItemSettings(it);
      else if (act === 'download') downloadOne(it);
      else if (act === 'remove') removeItem(it);
    });
    items.push(it);
    list.appendChild(el);
    render(it);
    return it;
  }

  async function analyze(it: Item) {
    try {
      const buf = await it.file.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096));
      const kind = sniff(head, it.file);
      if ('error' in kind) throw new Error(kind.error);
      it.mime = kind.mime;
      it.isSvg = kind.svg;
      if (!kind.svg) it.meta = parseMeta(buf);
      it.srcUrl = URL.createObjectURL(it.file);
      await ready;
      if (!items.includes(it)) return;
      processItem(it);
    } catch (e) {
      it.status = 'error';
      it.error = (e as Error).message || 'Could not read this file.';
      render(it);
      refresh();
    }
  }

  // ------------------------------------------------------------ processing
  async function processItem(it: Item) {
    const v = ++it.version;
    it.status = 'queued';
    it.progress = 'Waiting';
    render(it);
    refresh();
    try {
      const result = await engine.run({
        key: it.id, file: it.file, srcType: it.mime, isSvg: it.isSvg, settings: effective(it), edit: it.edit,
        onProgress: (t) => {
          if (it.version !== v) return;
          it.status = 'working';
          it.progress = t;
          renderStatus(it);
        },
      });
      if (it.version !== v || !items.includes(it)) return;
      const old = it.url;
      it.result = result;
      it.url = URL.createObjectURL(result.blob);
      if (old) setTimeout(() => URL.revokeObjectURL(old), 4000);
      it.status = 'done';
      it.error = undefined;
    } catch (e) {
      if (e instanceof Cancelled || it.version !== v) return;
      it.status = 'error';
      it.error = heicHint(it) || (e as Error).message || 'Processing failed.';
    }
    render(it);
    refresh();
    if (!engine.busy && items.every((x) => x.status === 'done' || x.status === 'error')) announce('All images processed');
  }

  function heicHint(it: Item) {
    return it.mime === 'image/heic'
      ? 'HEIC photos cannot be decoded by this browser. Export the photo as JPEG first (on iPhone: Settings → Camera → Formats → Most Compatible).'
      : '';
  }

  // ------------------------------------------------------------ rendering
  function renderStatus(it: Item) {
    const st = it.parts.info.querySelector<HTMLElement>('.is-status');
    if (!st) return;
    if (it.status === 'queued' || it.status === 'working' || it.status === 'reading') {
      st.innerHTML = `<span class="is-bar" role="progressbar" aria-label="Processing ${escapeHtml(it.name)}"></span><span>${escapeHtml(it.progress)}…</span>`;
    }
    it.el.dataset.status = it.status;
  }

  function render(it: Item) {
    const { el, parts } = it;
    const r = it.status === 'done' ? it.result : undefined;
    const srcLbl = it.isSvg ? 'SVG' : sourceLabel(it.mime);
    el.dataset.status = it.status;
    el.dataset.srcSize = String(it.file.size);
    el.classList.toggle('is-error', it.status === 'error');
    if (r) {
      Object.assign(el.dataset, { outW: r.width, outH: r.height, outSize: r.blob.size, outFormat: r.format, srcW: r.srcW, srcH: r.srcH });
    } else {
      ['outW', 'outH', 'outSize', 'outFormat'].forEach((k) => delete el.dataset[k]);
    }

    // Thumbnail
    const url = it.url ?? it.srcUrl;
    if (it.status === 'error' || !url) {
      parts.thumb.innerHTML = `<span class="is-thumb-ph">${it.status === 'error' ? '!' : escapeHtml(srcLbl)}</span>`;
    } else {
      const cur = parts.thumb.querySelector('img');
      if (cur?.getAttribute('src') !== url) {
        // Swap only once the new picture is decoded, so the thumbnail never flashes blank while re-processing.
        const img = document.createElement('img');
        img.alt = '';
        img.src = url;
        const swap = () => { if ((it.url ?? it.srcUrl) === url && it.status !== 'error') parts.thumb.replaceChildren(img); };
        if (!cur) swap();
        else img.decode().then(swap, swap);
      }
    }
    parts.thumb.disabled = !r;

    // Info
    const chips: string[] = [];
    const m = it.meta;
    if (m?.hasGps) chips.push(`<span class="is-chip is-chip-gps" title="This file records where it was taken">${I.pin}Contains GPS location</span>`);
    else if (privacyMeta(m)) chips.push(`<span class="is-chip is-chip-meta" title="Metadata in the original file">Metadata: ${escapeHtml(metaSummary(m!).join(', '))}</span>`);
    if (it.override) chips.push('<span class="is-chip is-chip-accent">Custom settings</span>');
    if (it.edit) {
      const e = it.edit;
      const what = [e.crop ? 'cropped' : '', e.rotate ? `rotated ${e.rotate}°` : '', e.flipH || e.flipV ? 'flipped' : ''].filter(Boolean).join(', ');
      chips.push(`<span class="is-chip is-chip-accent">${escapeHtml(what.charAt(0).toUpperCase() + what.slice(1))}</span>`);
    }
    const srcDims = r ? `${r.srcW} × ${r.srcH} · ` : '';
    const before = `<span>${srcDims}${srcLbl} · ${formatBytes(it.file.size)}</span>`;
    const after = r ? `<span class="is-out"><span class="is-arrow" aria-hidden="true">→ </span><b>${r.width} × ${r.height}</b> · ${LABEL[r.format]} · <b>${formatBytes(r.blob.size)}</b></span>` : '';
    let status = '';
    if (it.status === 'error') status = `<span class="is-status-err" role="alert">${escapeHtml(it.error || 'Error')}</span>`;
    else if (r) {
      const bits: string[] = [];
      if (r.quality !== null) bits.push(`quality ${Math.round(r.quality * 100)}`);
      else bits.push('lossless');
      if (r.targetMet === true) bits.push(`fits the ${formatBytes(effective(it).target.kb * 1024, 0)} target (${r.passes} passes${r.scale < 0.999 ? `, scaled to ${Math.round(r.scale * 100)}%` : ''})`);
      status = `<span>${escapeHtml(bits.join(' · '))}</span>`;
    }
    parts.info.innerHTML = `
      <div class="is-name-row"><span class="is-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>${chips.join('')}</div>
      <div class="is-dims">${before}${after}</div>
      <div class="is-status">${status}</div>`;
    renderStatus(it);

    // Savings
    parts.save.classList.remove('is-worse');
    if (r) {
      const p = pct(it.file.size, r.blob.size);
      const worse = r.blob.size > it.file.size;
      parts.save.classList.toggle('is-worse', worse);
      parts.save.innerHTML = `<span class="is-save-pct">${fmtPct(p)}</span><span class="is-save-lbl">${worse ? 'larger' : 'smaller'}</span>`;
    } else parts.save.innerHTML = '';

    // Actions
    const can = !!r;
    parts.acts.querySelectorAll<HTMLButtonElement>('[data-act="compare"], [data-act="download"]').forEach((b) => (b.disabled = !can));
    parts.acts.querySelectorAll<HTMLButtonElement>('[data-act="crop"], [data-act="settings"]').forEach((b) => (b.disabled = it.status === 'error' || it.status === 'reading'));

    // Extra: suggestions, notes, metadata
    const extra: string[] = [];
    if (r && r.blob.size > it.file.size) extra.push(`<div class="is-suggest"><b>The output is bigger than the original.</b> ${escapeHtml(suggestion(it, r))}</div>`);
    if (r && r.targetMet === false) extra.push(`<div class="is-suggest"><b>Could not reach ${formatBytes(effective(it).target.kb * 1024, 0)}.</b> This is the smallest result found (${formatBytes(r.blob.size)}). Try a lower target-friendly format such as WebP or JPEG, or a smaller resize.</div>`);
    if (r?.flattened) extra.push(`<div class="is-note">Transparent areas were filled with <span class="mono">${escapeHtml(effective(it).background)}</span> because JPEG has no transparency.</div>`);
    if (m && privacyMeta(m)) extra.push(metaDetails(it, m));
    parts.extra.innerHTML = extra.join('');
  }

  function suggestion(it: Item, r: JobResult): string {
    const s = effective(it);
    const srcLossy = /jpeg|webp|avif/.test(it.mime);
    if (it.isSvg) return 'SVG is compact vector art, so any raster copy is bigger. Keep the SVG where it is supported, or lower the SVG rasterization scale.';
    if (r.format === 'png' && srcLossy) return 'PNG is lossless, so photos grow. Choose JPEG or WebP instead.';
    if (r.format === 'png') return 'Try WebP, which keeps transparency and is usually much smaller, or resize the image.';
    if (s.resize.mode !== 'none' && r.width * r.height > r.srcW * r.srcH) return 'The image is being enlarged. Keep the original size or scale it down.';
    if (s.quality >= 90) return 'Lower the quality: 75–85 usually looks the same and is far smaller.';
    return 'The original is already well compressed. Keep the original file, or try WebP, a lower quality or a smaller size.';
  }

  function metaDetails(it: Item, m: ImageMeta): string {
    const rows: [string, string][] = [];
    if (m.hasGps) {
      const g = m.gps || {};
      const where = g.lat !== undefined && g.lon !== undefined ? `${formatCoord(g.lat, 'N', 'S')}, ${formatCoord(g.lon, 'E', 'W')}` : 'present';
      rows.push(['GPS location', where + (g.alt !== undefined ? ` · ${Math.round(g.alt)} m` : '')]);
    }
    if (m.make || m.model) rows.push(['Camera', [m.make, m.model].filter(Boolean).join(' ')]);
    if (m.lens) rows.push(['Lens', m.lens]);
    if (m.serial) rows.push(['Serial number', m.serial]);
    if (m.dateTime) rows.push(['Date taken', m.dateTime.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')]);
    const shot = [m.exposure, m.fNumber, m.iso ? `ISO ${m.iso}` : '', m.focalLength].filter(Boolean).join(' · ');
    if (shot) rows.push(['Exposure', shot]);
    if (m.software) rows.push(['Software', m.software]);
    if (m.artist) rows.push(['Artist', m.artist]);
    if (m.copyright) rows.push(['Copyright', m.copyright]);
    if (m.orientation && m.orientation > 1) rows.push(['Orientation', `EXIF orientation ${m.orientation}: applied to the pixels, so the output looks the same everywhere`]);
    const other = [m.hasXmp ? 'XMP' : '', m.hasIcc ? 'color profile (converted to sRGB)' : '', m.hasComment || m.hasText ? 'text comments' : ''].filter(Boolean);
    if (other.length) rows.push(['Other', other.join(', ')]);
    rows.push(['In the output', '<span class="is-gone">All removed</span> (re-encoding writes only pixels)']);
    const summary = metaSummary(m).join(', ');
    return `<details class="is-meta"><summary>Metadata in the original: ${escapeHtml(summary)}</summary><dl>${rows
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${k === 'In the output' ? v : escapeHtml(v)}</dd>`)
      .join('')}</dl></details>`;
  }

  /** Toolbar, totals, GPS alert and empty state. */
  function refresh() {
    const total = items.length;
    const done = items.filter((it) => it.status === 'done' && it.result);
    const errors = items.filter((it) => it.status === 'error').length;
    const working = items.filter((it) => it.status === 'queued' || it.status === 'working' || it.status === 'reading').length;
    root.classList.toggle('is-has-items', total > 0);
    $('is-count').textContent = !total ? 'No images' : `${total} image${total === 1 ? '' : 's'}${errors ? ` · ${errors} failed` : ''}`;
    const busy = $('is-busy');
    busy.hidden = !working;
    busy.textContent = working ? `Processing ${working}` : '';
    const zip = $<HTMLButtonElement>('is-zip');
    zip.disabled = !done.length || working > 0;
    $('is-zip-label').textContent = working ? 'Processing…' : `Download all (ZIP)`;

    const totals = $('is-totals');
    if (done.length) {
      const a = done.reduce((s, it) => s + it.file.size, 0);
      const b = done.reduce((s, it) => s + it.result!.blob.size, 0);
      const worse = b > a;
      const p = pct(a, b);
      totals.innerHTML = `<span><b>${done.length}</b> converted</span><span>Original <b>${formatBytes(a)}</b> → <b>${formatBytes(b)}</b></span>
        <span class="is-tot-big${worse ? ' is-worse' : ''}" id="is-saved" data-saved="${a - b}">${worse ? `${formatBytes(b - a)} larger (${fmtPct(p)})` : `Saved ${formatBytes(a - b)} (${fmtPct(p)})`}</span>`;
    } else totals.innerHTML = '';

    const gps = items.filter((it) => it.meta?.hasGps).length;
    const meta = items.filter((it) => privacyMeta(it.meta)).length;
    const alert = $('is-gps-alert');
    alert.hidden = !gps;
    if (gps) {
      alert.innerHTML = `${I.warn}<span><strong>${gps === 1 ? '1 image contains' : `${gps} images contain`} GPS location data</strong>: anyone who gets the original file can see where it was taken. ${meta > gps ? `${meta} images carry metadata in total. ` : ''}The converted files have it all removed (location, camera, date), because re-encoding writes only the pixels.</span>`;
    }
  }

  // ------------------------------------------------------------ actions
  function removeItem(it: Item) {
    const i = items.indexOf(it);
    if (i < 0) return;
    items.splice(i, 1);
    engine.cancel(it.id);
    it.version++;
    if (it.url) URL.revokeObjectURL(it.url);
    if (it.srcUrl) URL.revokeObjectURL(it.srcUrl);
    const next = items[i] ?? items[i - 1];
    it.el.remove();
    refresh();
    announce(`Removed ${it.name}`);
    next?.el.querySelector<HTMLButtonElement>('[data-act="remove"]')?.focus();
  }
  $('is-clear').addEventListener('click', () => {
    [...items].forEach((it) => removeItem(it));
    announce('All images removed');
    $('is-sample').focus();
  });

  function downloadOne(it: Item) {
    if (!it.result) return;
    const name = outputNames().get(it) ?? it.name;
    downloadBlob(it.result.blob, name);
    toast(`Downloaded ${name}`);
  }

  $('is-zip').addEventListener('click', async () => {
    const names = outputNames();
    if (!names.size) return;
    const btn = $<HTMLButtonElement>('is-zip');
    btn.disabled = true;
    try {
      const { zipSync } = await import('fflate');
      const files: Record<string, [Uint8Array, { level: 0 }]> = {};
      for (const [it, name] of names) files[name] = [new Uint8Array(await it.result!.blob.arrayBuffer()), { level: 0 }];
      const zip = zipSync(files);
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), 'images.zip');
      toast(`Downloaded images.zip (${names.size} file${names.size === 1 ? '' : 's'}, ${formatBytes(zip.length)})`);
    } catch (e) {
      toast(`Could not build the ZIP: ${(e as Error).message}`, 'error');
    } finally {
      refresh();
    }
  });

  async function openCompare(it: Item) {
    const r = it.result;
    if (!r || !it.url) return;
    try {
      const bmp = await decodeOnMain(it.file, it.isSvg, effective(it).svgScale);
      try {
        const region = applyEdit(domEnv, bmp, it.edit);
        // Render the original at the output's size so both layers line up pixel for pixel.
        const cap = Math.min(1, Math.sqrt(30e6 / (r.width * r.height)));
        const before = renderRegion(domEnv, region, Math.max(1, Math.round(r.width * cap)), Math.max(1, Math.round(r.height * cap)), null) as HTMLCanvasElement;
        viewer.open({
          title: it.name, before, afterUrl: it.url, width: r.width, height: r.height,
          beforeLabel: `Original · ${formatBytes(it.file.size)}`,
          afterLabel: `${LABEL[r.format]} · ${formatBytes(r.blob.size)}`,
        });
      } finally {
        bmp.close();
      }
    } catch (e) {
      toast(`Could not open the comparison: ${(e as Error).message}`, 'error');
    }
  }

  async function openCrop(it: Item) {
    let bmp: ImageBitmap;
    try {
      bmp = await decodeOnMain(it.file, it.isSvg, effective(it).svgScale);
    } catch (e) {
      toast((e as Error).message, 'error');
      return;
    }
    try {
      const res = await cropper.open(bmp, it.edit, it.name);
      if (res === undefined) return;
      it.edit = res;
      processItem(it);
      toast(res ? 'Edit applied' : 'Edit removed');
    } finally {
      bmp.close();
    }
  }

  // Per-image settings dialog
  const itemDlg = $<HTMLDialogElement>('is-item-dlg');
  function openItemSettings(it: Item) {
    if (!itemForm) return;
    itemTarget = it;
    itemDraft = cloneSettings(effective(it));
    itemForm.set(itemDraft);
    const r = it.result;
    if (r) {
      const s = editedSize(r.srcW, r.srcH, it.edit);
      itemForm.setAspect(s.width / s.height);
    } else itemForm.setAspect(null);
    $('is-item-sub').textContent = `${it.name}${it.override ? ' · custom' : ' · using the global settings'}`;
    itemDlg.showModal();
  }
  itemDlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => itemDlg.close()));
  itemDlg.addEventListener('click', (e) => { if (e.target === itemDlg) itemDlg.close(); });
  $('is-item-apply').addEventListener('click', () => {
    const it = itemTarget;
    itemDlg.close();
    if (!it || !itemDraft || !items.includes(it)) return;
    it.override = cloneSettings(itemDraft);
    processItem(it);
    toast(`Custom settings applied to ${it.name}`);
  });
  $('is-item-reset').addEventListener('click', () => {
    const it = itemTarget;
    itemDlg.close();
    if (!it || !items.includes(it)) return;
    const had = !!it.override;
    it.override = null;
    if (had) processItem(it);
    toast(`${it.name} now uses the global settings`);
  });

  refresh();
}
