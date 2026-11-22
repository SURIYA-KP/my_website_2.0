import { downloadBlob, toast, setupDropzone, formatBytes, escapeHtml } from '../../lib/ui';
import {
  type Item, History, newUid, moveTo, moveBy, rotate, remove, duplicate, insertAt, reverse, parseRanges, chunk, type RangeResult,
} from './state';
import { sniff, looksLikePdfName, prepareImage } from './files';
import { registerPdf, requestThumb, cachedThumb, renderPage, pdfjs } from './thumbs';
import { setupDrag } from './drag';
import type { PlanPage, BuildOptions } from './worker';

// ---------------------------------------------------------------- worker client
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; onProgress?: (p: number) => void }>();
worker.onmessage = (e) => {
  const { id, ok, result, error, progress } = e.data;
  const p = pending.get(id);
  if (!p) return;
  if (progress !== undefined) { p.onProgress?.(progress); return; }
  pending.delete(id);
  if (ok) p.resolve(result);
  else p.reject(Object.assign(new Error(error?.message || 'Worker error'), { code: error?.code }));
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message || 'The PDF engine failed to start.'));
  pending.clear();
};
function call<T = any>(type: string, payload: unknown, transfer: Transferable[] = [], onProgress?: (p: number) => void): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, payload }, transfer);
  });
}

// ---------------------------------------------------------------- icons
const svg = (d: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  rotl: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  rotr: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  dup: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  del: svg('<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
  zoom: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  left: svg('<path d="m15 18-6-6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
};

// ---------------------------------------------------------------- state
interface Source { id: string; name: string; kind: 'pdf' | 'image'; color: number; pages: number; size: number; url?: string }
const sources = new Map<string, Source>();
let items: Item[] = [];
const sel = new Set<string>();
let anchor: string | null = null;
let focusUid: string | null = null;
const history = new History();
let colorSeq = 0;
let srcSeq = 0;
let busy = false;
let nameTouched = false;
let lastPointer = 'mouse';
let splitMode: 'every' | 'ranges' | 'single' = 'every';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function init() {
  const root = $('pt-root');
  const grid = $('pt-grid');
  const indicator = $('pt-indicator');
  const dz = $('pt-drop');
  const live = $('pt-live');
  const errorsBox = $('pt-errors');
  const dialog = $<HTMLDialogElement>('pt-preview');

  const announce = (msg: string) => { live.textContent = ''; requestAnimationFrame(() => (live.textContent = msg)); };

  // ------------------------------------------------------------ add files
  const openPicker = setupDropzone(dz, (files) => addFiles(files), { multiple: true, accept: '.pdf,application/pdf,image/png,image/jpeg,image/webp,image/gif,image/bmp', pageWide: true });
  $('pt-add').addEventListener('click', () => openPicker());
  $('pt-sample').addEventListener('click', () => loadSamples());

  const errors: { file: string; msg: string }[] = [];
  function showErrors() {
    errorsBox.hidden = !errors.length;
    errorsBox.innerHTML = errors.length
      ? `<div class="row-between"><strong>${errors.length === 1 ? 'A file could not be added' : `${errors.length} files could not be added`}</strong><button class="btn btn-ghost btn-sm" type="button" data-dismiss>Dismiss</button></div>
         <ul>${errors.map((e) => `<li><b>${escapeHtml(e.file)}</b>: ${escapeHtml(e.msg)}</li>`).join('')}</ul>`
      : '';
  }
  errorsBox.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-dismiss]')) { errors.length = 0; showErrors(); }
  });

  function explain(name: string, err: any, kind: string | null): string {
    const code = err?.code;
    if (code === 'encrypted') {
      const fix = 'To use it, open it in a PDF viewer (entering the password if asked), choose Print → Save as PDF to make an unencrypted copy, then add that copy here.';
      return err?.password
        ? `This PDF is password-protected. Its pages are encrypted and this tool cannot decrypt them in the browser, so it was not added. ${fix}`
        : `This PDF is encrypted (it opens without a password but has owner restrictions). Its contents are scrambled, so copied pages would come out garbled; it was not added. ${fix}`;
    }
    if (code === 'corrupt') return 'This PDF appears to be damaged or incomplete and could not be read. Try re-downloading or re-saving it.';
    if (code === 'notpdf') return 'The file is named like a PDF but its contents are not a PDF. It may be damaged or saved in another format.';
    if (code === 'unsupported') return 'Not a PDF or a supported image. Add PDF, JPG, PNG or WebP files.';
    if (code === 'empty') return 'The file is empty.';
    if (kind && kind !== 'pdf') return `The image could not be read (${err?.message || 'unknown error'}).`;
    return err?.message || 'Unknown error.';
  }

  async function addFile(f: File): Promise<Item[]> {
    if (!f.size) throw Object.assign(new Error('empty'), { code: 'empty' });
    const buf = await f.arrayBuffer();
    const kind = sniff(buf, f.name, f.type);
    if (!kind) throw Object.assign(new Error(''), { code: looksLikePdfName(f.name, f.type) ? 'notpdf' : 'unsupported' });
    const id = `s${++srcSeq}`;
    if (kind === 'pdf') {
      const copy = buf.slice(0);
      let info: { pages: { w: number; h: number }[] };
      try {
        info = await call<{ pages: { w: number; h: number }[] }>('addPdf', { id, bytes: copy }, [copy]);
      } catch (err: any) {
        if (err?.code === 'encrypted') err.password = await needsPassword(buf);
        throw err;
      }
      registerPdf(id, buf);
      const src: Source = { id, name: f.name, kind: 'pdf', color: colorSeq++ % 8, pages: info.pages.length, size: f.size };
      sources.set(id, src);
      return info.pages.map((p, i) => ({ uid: newUid(), src: id, page: i, rot: 0, w: p.w, h: p.h }));
    }
    const img = await prepareImage(buf, kind, f.type);
    await call('addImage', { id, bytes: img.bytes, mime: img.mime, w: img.w, h: img.h }, [img.bytes]);
    sources.set(id, { id, name: f.name, kind: 'image', color: colorSeq++ % 8, pages: 1, size: f.size, url: img.url });
    return [{ uid: newUid(), src: id, page: 0, rot: 0, w: img.w, h: img.h }];
  }

  /** Distinguish "needs a password" from "opens, but encrypted with owner restrictions". */
  async function needsPassword(buf: ArrayBuffer): Promise<boolean> {
    try {
      const lib = await pdfjs();
      const doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false, verbosity: 0 }).promise;
      doc.destroy();
      return false;
    } catch (e: any) {
      return e?.name === 'PasswordException';
    }
  }

  async function addFiles(files: File[]) {
    if (!files.length) return;
    const status = $('pt-loading');
    status.hidden = false;
    const added: Item[] = [];
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      status.textContent = files.length > 1 ? `Reading ${f.name} (${i + 1} of ${files.length})…` : `Reading ${f.name}…`;
      await new Promise((r) => setTimeout(r, 0));
      try {
        added.push(...(await addFile(f)));
        ok++;
        if (!nameTouched && ok === 1 && !items.length) {
          ($('pt-filename') as HTMLInputElement).value = f.name.replace(/\.[^.]+$/, '').slice(0, 60) + (files.length > 1 ? '-merged' : '-edited');
        }
      } catch (err: any) {
        errors.push({ file: f.name, msg: explain(f.name, err, null) });
      }
    }
    status.hidden = true;
    showErrors();
    if (added.length) {
      commit([...items, ...added]);
      const msg = `Added ${added.length} page${added.length === 1 ? '' : 's'} from ${ok} file${ok === 1 ? '' : 's'}`;
      toast(msg);
      announce(msg);
    }
    if (errors.length && !added.length) toast(errors.length === 1 ? 'That file could not be added' : 'Those files could not be added', 'error');
  }

  async function loadSamples() {
    const btn = $<HTMLButtonElement>('pt-sample');
    btn.disabled = true;
    try {
      const r = await call<{ a: Uint8Array; b: Uint8Array }>('samples', {});
      const c = document.createElement('canvas');
      c.width = 900; c.height = 600;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 900, 600);
      grad.addColorStop(0, '#0891b2'); grad.addColorStop(1, '#7c3aed');
      g.fillStyle = grad; g.fillRect(0, 0, 900, 600);
      g.fillStyle = 'rgba(255,255,255,.18)';
      for (let i = 0; i < 7; i++) { g.beginPath(); g.arc(120 + i * 120, 420 - (i % 3) * 70, 60 + (i % 2) * 30, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = '#fff'; g.font = 'bold 64px sans-serif'; g.fillText('Photo.png', 60, 140);
      g.font = '28px sans-serif'; g.fillText('Images become PDF pages too', 60, 190);
      const png = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
      await addFiles([
        new File([r.a], 'Quarterly report.pdf', { type: 'application/pdf' }),
        new File([r.b], 'Slides.pdf', { type: 'application/pdf' }),
        new File([png], 'Photo.png', { type: 'image/png' }),
      ]);
    } catch (e: any) {
      toast(`Could not create the sample: ${e?.message || e}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ history
  function commit(next: Item[], msg?: string) {
    history.push(items);
    items = next;
    afterChange();
    if (msg) announce(msg);
  }
  function afterChange() {
    const present = new Set(items.map((i) => i.uid));
    for (const u of [...sel]) if (!present.has(u)) sel.delete(u);
    if (focusUid && !present.has(focusUid)) focusUid = null;
    if (anchor && !present.has(anchor)) anchor = null;
    render();
  }
  function undo() {
    const prev = history.undo(items);
    if (!prev) return;
    items = prev; afterChange(); announce('Undone'); toast('Undone');
  }
  function redo() {
    const next = history.redo(items);
    if (!next) return;
    items = next; afterChange(); announce('Redone'); toast('Redone');
  }

  // ------------------------------------------------------------ operations
  const targets = () => (sel.size ? new Set(sel) : focusUid ? new Set([focusUid]) : new Set<string>());
  const plural = (n: number) => `${n} page${n === 1 ? '' : 's'}`;
  function opRotate(uids: Set<string>, d: number) {
    if (!uids.size) return toast('Select pages first', 'error');
    commit(rotate(items, uids, d), `Rotated ${plural(uids.size)} ${d > 0 ? 'right' : 'left'}`);
  }
  function opDelete(uids: Set<string>) {
    if (!uids.size) return toast('Select pages first', 'error');
    const idx = items.findIndex((i) => uids.has(i.uid));
    commit(remove(items, uids), `Deleted ${plural(uids.size)}`);
    const next = items[Math.min(idx, items.length - 1)];
    focusUid = next?.uid ?? null;
    render();
    if (next) focusTile(next.uid);
    toast(`Deleted ${plural(uids.size)} · Ctrl+Z to undo`);
  }
  function opDuplicate(uids: Set<string>) {
    if (!uids.size) return toast('Select pages first', 'error');
    const r = duplicate(items, uids);
    commit(r.items, `Duplicated ${plural(uids.size)}`);
  }
  function opMove(uids: Set<string>, d: -1 | 1) {
    if (!uids.size) return toast('Select pages first', 'error');
    const next = moveBy(items, uids, d);
    if (next.every((it, i) => it === items[i])) return;
    commit(next, `Moved ${plural(uids.size)} ${d < 0 ? 'earlier' : 'later'}`);
    const f = focusUid && uids.has(focusUid) ? focusUid : [...uids][0];
    focusTile(f);
  }
  function opBlank() {
    let at = items.length;
    let ref: Item | undefined = items[items.length - 1];
    if (sel.size) {
      at = Math.max(...items.map((it, i) => (sel.has(it.uid) ? i : -1))) + 1;
      ref = items[at - 1];
    }
    let w = 595.28, h = 841.89;
    if (ref && ref.src && sources.get(ref.src)?.kind === 'pdf') {
      [w, h] = ref.rot % 180 ? [ref.h, ref.w] : [ref.w, ref.h];
    }
    const blank: Item = { uid: newUid(), src: null, page: 0, rot: 0, w, h };
    commit(insertAt(items, at, [blank]), `Inserted a blank page at position ${at + 1}`);
    sel.clear(); sel.add(blank.uid); anchor = blank.uid; focusUid = blank.uid;
    render();
    scrollToTile(blank.uid);
  }
  function opReverse() {
    if (items.length < 2) return;
    const s = sel.size >= 2 ? sel : new Set<string>();
    commit(reverse(items, s), s.size ? `Reversed ${plural(s.size)}` : 'Reversed page order');
    toast(s.size ? `Reversed ${plural(s.size)}` : 'Reversed page order');
  }
  function selectWhere(pred: (i: number, it: Item) => boolean) {
    sel.clear();
    items.forEach((it, i) => { if (pred(i, it)) sel.add(it.uid); });
    anchor = null;
    render();
    announce(`${sel.size} selected`);
  }

  // ------------------------------------------------------------ toolbar
  const on = (id: string, fn: () => void) => $(id).addEventListener('click', fn);
  on('pt-sel-all', () => selectWhere(() => true));
  on('pt-sel-none', () => selectWhere(() => false));
  on('pt-sel-odd', () => selectWhere((i) => i % 2 === 0));
  on('pt-sel-even', () => selectWhere((i) => i % 2 === 1));
  on('pt-sel-invert', () => { const old = new Set(sel); selectWhere((_, it) => !old.has(it.uid)); });
  on('pt-rotl', () => opRotate(targets(), -90));
  on('pt-rotr', () => opRotate(targets(), 90));
  on('pt-move-l', () => opMove(targets(), -1));
  on('pt-move-r', () => opMove(targets(), 1));
  on('pt-dup', () => opDuplicate(targets()));
  on('pt-del', () => opDelete(targets()));
  on('pt-blank', opBlank);
  on('pt-reverse', opReverse);
  on('pt-undo', undo);
  on('pt-redo', redo);
  on('pt-m-export', () => {
    const panel = $('pt-export');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $<HTMLButtonElement>('pt-merge').focus({ preventScroll: true });
  });
  $('pt-add-more').addEventListener('click', () => openPicker());
  on('pt-clear', () => {
    if (!items.length) return;
    commit([], 'Removed all pages');
    toast('Removed all pages · Ctrl+Z to undo');
  });

  // ------------------------------------------------------------ grid rendering
  const tiles = new Map<string, HTMLElement>();
  const visible = new Set<HTMLElement>();
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const t = en.target as HTMLElement;
      if (en.isIntersecting) { visible.add(t); loadThumb(t); } else visible.delete(t);
    }
  }, { rootMargin: '600px 0px' });

  function loadThumb(tile: HTMLElement) {
    if (tile.dataset.loaded) return;
    const it = items.find((i) => i.uid === tile.dataset.uid);
    if (!it || !it.src) return;
    const src = sources.get(it.src);
    if (!src || src.kind !== 'pdf') return;
    tile.dataset.loaded = 'pending';
    requestThumb(it.src, it.page, () => visible.has(tile) && tile.isConnected)
      .then((url) => { setFaceImage(tile, url); tile.dataset.loaded = 'done'; io.unobserve(tile); })
      .catch((e) => {
        if (e?.message === 'skipped') { delete tile.dataset.loaded; return; }
        tile.dataset.loaded = 'error';
        const face = tile.querySelector('.pt-face')!;
        face.classList.add('pt-face-error');
        face.innerHTML = '<span>No preview</span>';
      });
  }
  function setFaceImage(tile: HTMLElement, url: string) {
    const face = tile.querySelector('.pt-face')!;
    let img = face.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      face.replaceChildren(img);
    }
    img.src = url;
  }

  function makeTile(it: Item): HTMLElement {
    const el = document.createElement('div');
    el.className = 'pt-tile';
    el.dataset.uid = it.uid;
    el.setAttribute('role', 'listitem');
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="pt-thumb">
        <div class="pt-page"><div class="pt-face"><span class="pt-spin" aria-hidden="true"></span></div></div>
        <span class="pt-num" aria-hidden="true"></span>
        <button type="button" class="pt-check" data-act="toggle" tabindex="-1" aria-label="Select page">${I.check}</button>
        <button type="button" class="pt-nudge pt-nudge-l" data-act="left" tabindex="-1" aria-label="Move earlier" title="Move earlier">${I.left}</button>
        <button type="button" class="pt-nudge pt-nudge-r" data-act="right" tabindex="-1" aria-label="Move later" title="Move later">${I.right}</button>
        <div class="pt-acts">
          <button type="button" data-act="rotl" tabindex="-1" aria-label="Rotate left" title="Rotate left">${I.rotl}</button>
          <button type="button" data-act="rotr" tabindex="-1" aria-label="Rotate right" title="Rotate right">${I.rotr}</button>
          <button type="button" data-act="zoom" tabindex="-1" aria-label="Preview" title="Preview (double-click)">${I.zoom}</button>
          <button type="button" data-act="dup" tabindex="-1" aria-label="Duplicate" title="Duplicate">${I.dup}</button>
          <button type="button" data-act="del" tabindex="-1" aria-label="Delete" title="Delete" class="pt-act-del">${I.del}</button>
        </div>
      </div>
      <div class="pt-foot"><span class="pt-dot" aria-hidden="true"></span><span class="pt-name"></span><span class="pt-pg"></span></div>`;
    const face = el.querySelector('.pt-face')!;
    const src = it.src ? sources.get(it.src) : null;
    if (!src) {
      face.classList.add('pt-face-blank');
      face.innerHTML = '<span>Blank</span>';
      el.dataset.loaded = 'done';
    } else if (src.kind === 'image') {
      setFaceImage(el, src.url!);
      el.dataset.loaded = 'done';
    } else {
      const hit = cachedThumb(src.id, it.page);
      if (hit) { setFaceImage(el, hit); el.dataset.loaded = 'done'; }
    }
    const name = src ? src.name : 'Blank page';
    el.querySelector('.pt-name')!.textContent = name;
    (el.querySelector('.pt-name') as HTMLElement).title = name;
    el.querySelector('.pt-pg')!.textContent = src?.kind === 'pdf' ? `p. ${it.page + 1}` : src ? 'image' : '';
    el.style.setProperty('--pt-c', src ? `var(--c${src.color + 1})` : 'var(--text-faint)');
    return el;
  }

  // Box ratio of the thumbnail area (width / height) and how much of it a page may fill.
  const BOX = 0.78, FILL = 0.88;
  function layoutTile(el: HTMLElement, it: Item) {
    const key = `${it.rot}|${it.w}|${it.h}`;
    if (el.dataset.geo === key) return;
    el.dataset.geo = key;
    const turned = it.rot % 180 !== 0;
    const dw = turned ? it.h : it.w, dh = turned ? it.w : it.h;
    const a = dw / dh;
    const page = el.querySelector<HTMLElement>('.pt-page')!;
    const face = el.querySelector<HTMLElement>('.pt-face')!;
    if (a >= BOX) { page.style.width = `${FILL * 100}%`; page.style.height = `${(FILL * BOX * 100) / a}%`; }
    else { page.style.height = `${FILL * 100}%`; page.style.width = `${(FILL * a * 100) / BOX}%`; }
    face.style.width = turned ? `${(dh / dw) * 100}%` : '100%';
    face.style.height = turned ? `${(dw / dh) * 100}%` : '100%';
    face.style.transform = `translate(-50%, -50%) rotate(${it.rot}deg)`;
  }

  function render() {
    const present = new Set(items.map((i) => i.uid));
    for (const [uid, el] of tiles) {
      if (!present.has(uid)) { io.unobserve(el); visible.delete(el); el.remove(); tiles.delete(uid); }
    }
    let prev: Element | null = null;
    const tabUid = focusUid && present.has(focusUid) ? focusUid : items[0]?.uid;
    items.forEach((it, i) => {
      let el = tiles.get(it.uid);
      if (!el) {
        el = makeTile(it);
        tiles.set(it.uid, el);
        if (el.dataset.loaded !== 'done') io.observe(el);
      }
      const expected = prev ? prev.nextElementSibling : grid.firstElementChild;
      if (expected !== el) grid.insertBefore(el, expected);
      prev = el;
      layoutTile(el, it);
      const selected = sel.has(it.uid);
      const num = String(i + 1);
      const state = `${num}|${selected}|${tabUid === it.uid}|${it.rot}`;
      if (el.dataset.state !== state) {
        el.dataset.state = state;
        el.querySelector('.pt-num')!.textContent = num;
        el.classList.toggle('is-selected', selected);
        el.tabIndex = tabUid === it.uid ? 0 : -1;
        const src = it.src ? sources.get(it.src) : null;
        const what = src ? (src.kind === 'pdf' ? `${src.name}, page ${it.page + 1}` : `image ${src.name}`) : 'blank page';
        el.setAttribute('aria-label', `Page ${num} of ${items.length}: ${what}${it.rot ? `, rotated ${it.rot}°` : ''}${selected ? ', selected' : ''}`);
        el.querySelector('.pt-check')!.setAttribute('aria-pressed', String(selected));
      }
    });
    // keep aria labels' "of N" current when count changes
    grid.dataset.count = String(items.length);
    updateChrome();
  }

  function updateChrome() {
    const n = items.length;
    root.classList.toggle('pt-has-pages', n > 0);
    const s = sel.size;
    $('pt-count').textContent = n ? (s ? `${s} of ${plural(n)} selected` : `${plural(n)}`) : 'No pages';
    const t = s > 0 || !!focusUid;
    for (const id of ['pt-rotl', 'pt-rotr', 'pt-move-l', 'pt-move-r', 'pt-dup', 'pt-del']) $<HTMLButtonElement>(id).disabled = !n || !t;
    for (const id of ['pt-sel-all', 'pt-sel-none', 'pt-sel-odd', 'pt-sel-even', 'pt-sel-invert', 'pt-clear', 'pt-blank']) $<HTMLButtonElement>(id).disabled = !n;
    $<HTMLButtonElement>('pt-reverse').disabled = n < 2;
    $<HTMLButtonElement>('pt-reverse').title = s >= 2 ? 'Reverse the order of the selected pages' : 'Reverse the order of all pages';
    $<HTMLButtonElement>('pt-undo').disabled = !history.canUndo;
    $<HTMLButtonElement>('pt-redo').disabled = !history.canRedo;
    // file list: every source that still has pages in the arrangement
    const counts = new Map<string, number>();
    for (const it of items) if (it.src) counts.set(it.src, (counts.get(it.src) ?? 0) + 1);
    const blanks = items.filter((it) => !it.src).length;
    const fileList = $('pt-files');
    const fileHtml = [...counts.keys()].map((id) => {
      const s = sources.get(id)!;
      const c = counts.get(id)!;
      const pages = s.kind === 'image' ? (c === 1 ? 'image' : `image ×${c}`) : c === s.pages ? plural(c) : `${c} of ${plural(s.pages)}`;
      return `<li class="pt-file" style="--pt-c: var(--c${s.color + 1})"><button type="button" class="pt-file-main" data-src="${id}" title="Select all pages from ${escapeHtml(s.name)}"><span class="pt-file-bar" aria-hidden="true"></span><span class="pt-file-text"><span class="pt-file-name">${escapeHtml(s.name)}</span><span class="pt-file-meta">${pages} · ${formatBytes(s.size)}</span></span></button><button type="button" class="btn btn-ghost btn-icon btn-sm pt-file-x" data-remove="${id}" aria-label="Remove ${escapeHtml(s.name)}" title="Remove this file's pages (undo with Ctrl+Z)">${I.x}</button></li>`;
    }).join('') + (blanks ? `<li class="pt-file pt-file-blank" style="--pt-c: var(--text-faint)"><span class="pt-file-main"><span class="pt-file-bar" aria-hidden="true"></span><span class="pt-file-text"><span class="pt-file-name">Blank pages</span><span class="pt-file-meta">${plural(blanks)}</span></span></span></li>` : '');
    if (fileList.dataset.html !== fileHtml) { fileList.innerHTML = fileHtml; fileList.dataset.html = fileHtml; }
    $('pt-files-count').textContent = counts.size ? `${counts.size} file${counts.size === 1 ? '' : 's'}` : '';
    // outputs
    $<HTMLButtonElement>('pt-merge').disabled = busy || !n;
    $('pt-merge-count').textContent = n ? `(${plural(n)})` : '';
    $<HTMLButtonElement>('pt-extract').disabled = busy || !s;
    $('pt-extract-count').textContent = s ? `(${plural(s)})` : '';
    updateSplit();
    const hasImages = items.some((it) => it.src && sources.get(it.src)?.kind === 'image');
    $('pt-img-note').textContent = hasImages ? 'Used for the image pages in your document.' : 'Applies when you add JPG, PNG or WebP images.';
  }

  $('pt-files').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const rm = t.closest<HTMLElement>('[data-remove]');
    if (rm) {
      const id = rm.dataset.remove!;
      const uids = new Set(items.filter((i) => i.src === id).map((i) => i.uid));
      commit(remove(items, uids), `Removed ${sources.get(id)?.name}`);
      toast(`Removed ${sources.get(id)?.name} · Ctrl+Z to undo`);
      return;
    }
    const b = t.closest<HTMLElement>('[data-src]');
    if (b) selectWhere((_, it) => it.src === b.dataset.src);
  });

  function focusTile(uid: string | null | undefined) {
    if (!uid) return;
    focusUid = uid;
    render();
    const el = tiles.get(uid);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function scrollToTile(uid: string) {
    tiles.get(uid)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ------------------------------------------------------------ grid interaction
  grid.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, true);
  grid.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tile = t.closest<HTMLElement>('.pt-tile');
    if (!tile) {
      if (t === grid && sel.size) { sel.clear(); render(); }
      return;
    }
    const uid = tile.dataset.uid!;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    const one = new Set([uid]);
    if (act) {
      focusUid = uid;
      if (act === 'toggle') { sel.has(uid) ? sel.delete(uid) : sel.add(uid); anchor = uid; render(); }
      else if (act === 'rotl') opRotate(one, -90);
      else if (act === 'rotr') opRotate(one, 90);
      else if (act === 'dup') opDuplicate(one);
      else if (act === 'del') opDelete(one);
      else if (act === 'left') opMove(sel.has(uid) ? new Set(sel) : one, -1);
      else if (act === 'right') opMove(sel.has(uid) ? new Set(sel) : one, 1);
      else if (act === 'zoom') openPreview(uid);
      return;
    }
    if (e.shiftKey && anchor) {
      const a = items.findIndex((i) => i.uid === anchor);
      const b = items.findIndex((i) => i.uid === uid);
      if (!(e.ctrlKey || e.metaKey)) sel.clear();
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) sel.add(items[k].uid);
    } else if (e.ctrlKey || e.metaKey || lastPointer === 'touch') {
      sel.has(uid) ? sel.delete(uid) : sel.add(uid);
      anchor = uid;
    } else {
      const only = sel.size === 1 && sel.has(uid);
      sel.clear();
      if (!only) sel.add(uid);
      anchor = uid;
    }
    focusUid = uid;
    render();
    tile.focus({ preventScroll: true });
  });
  grid.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act]')) return;
    const tile = t.closest<HTMLElement>('.pt-tile');
    if (tile) openPreview(tile.dataset.uid!);
  });

  function columns(): number {
    const els = [...grid.children] as HTMLElement[];
    if (els.length < 2) return 1;
    const top = els[0].offsetTop;
    let c = 0;
    while (c < els.length && els[c].offsetTop === top) c++;
    return Math.max(1, c);
  }

  grid.addEventListener('keydown', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.pt-tile');
    if (!tile || e.target !== tile) return;
    const uid = tile.dataset.uid!;
    const idx = items.findIndex((i) => i.uid === uid);
    const mod = e.ctrlKey || e.metaKey;
    let step = 0;
    if (e.key === 'ArrowLeft') step = -1;
    else if (e.key === 'ArrowRight') step = 1;
    else if (e.key === 'ArrowUp') step = -columns();
    else if (e.key === 'ArrowDown') step = columns();
    if (step && e.altKey) {
      e.preventDefault();
      opMove(sel.has(uid) ? new Set(sel) : new Set([uid]), step < 0 ? -1 : 1);
      return;
    }
    if (step || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, idx + step));
      const target = items[to].uid;
      if (e.shiftKey) {
        if (!anchor) anchor = uid;
        const a = items.findIndex((i) => i.uid === anchor);
        sel.clear();
        for (let k = Math.min(a, to); k <= Math.max(a, to); k++) sel.add(items[k].uid);
      }
      focusTile(target);
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      sel.has(uid) ? sel.delete(uid) : sel.add(uid);
      anchor = uid; focusUid = uid; render();
    } else if (e.key === 'Enter') {
      e.preventDefault(); openPreview(uid);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); opDelete(sel.size ? new Set(sel) : new Set([uid]));
    } else if (!mod && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault(); opRotate(sel.size ? new Set(sel) : new Set([uid]), e.shiftKey ? -90 : 90);
    } else if (!mod && e.key === 'd') {
      e.preventDefault(); opDuplicate(sel.size ? new Set(sel) : new Set([uid]));
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault(); selectWhere(() => true);
    } else if (e.key === 'Escape' && sel.size) {
      sel.clear(); render();
    }
  });
  grid.addEventListener('focusin', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.pt-tile');
    if (tile && focusUid !== tile.dataset.uid) { focusUid = tile.dataset.uid!; updateChrome(); }
  });

  document.addEventListener('keydown', (e) => {
    if (dialog.open) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });

  setupDrag({
    grid,
    indicator,
    tileSelector: '.pt-tile',
    dragSet: (uid) => (sel.has(uid) ? items.filter((i) => sel.has(i.uid)).map((i) => i.uid) : [uid]),
    onStart: (uids) => { if (!sel.has(uids[0])) { sel.clear(); sel.add(uids[0]); anchor = uids[0]; render(); } },
    onDrop: (uids, before) => {
      const next = moveTo(items, new Set(uids), before);
      if (next.every((it, i) => it === items[i])) return;
      commit(next, `Moved ${plural(uids.length)} to position ${next.findIndex((i) => i.uid === uids[0]) + 1}`);
    },
  });

  // ------------------------------------------------------------ preview dialog
  let previewUid: string | null = null;
  let previewToken = 0;
  const stage = $('pt-pv-stage');
  async function drawPreview() {
    const idx = items.findIndex((i) => i.uid === previewUid);
    if (idx < 0) { dialog.close(); return; }
    const it = items[idx];
    const src = it.src ? sources.get(it.src) : null;
    $('pt-pv-title').textContent = `Page ${idx + 1} of ${items.length}`;
    $('pt-pv-sub').textContent = src ? (src.kind === 'pdf' ? `${src.name} · page ${it.page + 1}` : src.name) : 'Blank page';
    $('pt-pv-sub').style.setProperty('--pt-c', src ? `var(--c${src.color + 1})` : 'var(--text-faint)');
    $<HTMLButtonElement>('pt-pv-prev').disabled = idx === 0;
    $<HTMLButtonElement>('pt-pv-next').disabled = idx === items.length - 1;
    const token = ++previewToken;
    const W = Math.max(100, stage.clientWidth - 24), H = Math.max(100, stage.clientHeight - 24);
    if (src?.kind === 'pdf') {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      try {
        const canvas = await renderPage(src.id, it.page, W * dpr, H * dpr, it.rot);
        if (token !== previewToken) return;
        canvas.style.width = `${canvas.width / dpr}px`;
        canvas.style.height = `${canvas.height / dpr}px`;
        canvas.className = 'pt-pv-page';
        canvas.setAttribute('aria-label', 'Page preview');
        stage.replaceChildren(canvas);
      } catch {
        if (token === previewToken) stage.innerHTML = '<p class="muted">Preview unavailable for this page.</p>';
      }
    } else {
      const turned = it.rot % 180 !== 0;
      const dw = turned ? it.h : it.w, dh = turned ? it.w : it.h;
      const s = Math.min(W / dw, H / dh);
      const box = document.createElement('div');
      box.className = 'pt-pv-box';
      box.style.width = `${dw * s}px`;
      box.style.height = `${dh * s}px`;
      const face = document.createElement(src ? 'img' : 'div');
      face.className = 'pt-pv-face' + (src ? '' : ' pt-face-blank');
      face.style.width = `${it.w * s}px`;
      face.style.height = `${it.h * s}px`;
      face.style.transform = `translate(-50%, -50%) rotate(${it.rot}deg)`;
      if (src) { (face as HTMLImageElement).src = src.url!; (face as HTMLImageElement).alt = src.name; }
      else face.innerHTML = '<span>Blank page</span>';
      box.appendChild(face);
      stage.replaceChildren(box);
    }
  }
  function openPreview(uid: string) {
    previewUid = uid;
    stage.innerHTML = '';
    if (!dialog.open) dialog.showModal();
    drawPreview(); // header updates synchronously; the page canvas follows when rendered
  }
  function stepPreview(d: number) {
    const idx = items.findIndex((i) => i.uid === previewUid);
    const n = items[idx + d];
    if (n) { previewUid = n.uid; drawPreview(); }
  }
  on('pt-pv-prev', () => stepPreview(-1));
  on('pt-pv-next', () => stepPreview(1));
  on('pt-pv-close', () => dialog.close());
  on('pt-pv-rotl', () => { if (previewUid) { opRotate(new Set([previewUid]), -90); drawPreview(); } });
  on('pt-pv-rotr', () => { if (previewUid) { opRotate(new Set([previewUid]), 90); drawPreview(); } });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepPreview(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepPreview(1); }
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (previewUid) { const u = previewUid; previewUid = null; focusTile(u); }
  });

  // ------------------------------------------------------------ outputs
  const fileBase = () => {
    const v = ($('pt-filename') as HTMLInputElement).value.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-');
    return v || 'document';
  };
  $('pt-filename').addEventListener('input', () => { nameTouched = true; });

  function toPlan(list: Item[]): PlanPage[] {
    return list.map((it) => {
      if (!it.src) return { kind: 'blank', w: it.w, h: it.h, rot: it.rot };
      const s = sources.get(it.src)!;
      return s.kind === 'pdf' ? { kind: 'pdf', src: s.id, index: it.page, rot: it.rot } : { kind: 'image', src: s.id, rot: it.rot };
    });
  }
  function buildOptions(): BuildOptions {
    return {
      imageSize: ($('pt-imgsize') as HTMLSelectElement).value as BuildOptions['imageSize'],
      marginMm: parseFloat(($('pt-margin') as HTMLSelectElement).value) || 0,
      title: ($('pt-title') as HTMLInputElement).value.trim() || undefined,
      author: ($('pt-author') as HTMLInputElement).value.trim() || undefined,
    };
  }

  const progressEl = $('pt-progress');
  const progressBar = progressEl.querySelector<HTMLElement>('span')!;
  async function runJob<T>(label: string, job: (onProgress: (p: number) => void) => Promise<T>): Promise<T | null> {
    busy = true;
    updateChrome();
    $<HTMLButtonElement>('pt-split-go').disabled = true;
    progressEl.hidden = false;
    progressBar.style.width = '4%';
    $('pt-progress-label').textContent = label;
    try {
      return await job((p) => { progressBar.style.width = `${Math.max(4, Math.round(p * 100))}%`; });
    } catch (e: any) {
      toast(`Failed: ${e?.message || e}`, 'error', 4000);
      $('pt-result').innerHTML = `<div class="alert alert-error">Could not create the file: ${escapeHtml(e?.message || String(e))}</div>`;
      return null;
    } finally {
      busy = false;
      progressEl.hidden = true;
      updateChrome();
    }
  }
  function showResult(name: string, detail: string, size: number) {
    $('pt-result').innerHTML = `<div class="pt-result-card"><span class="pt-result-name">${escapeHtml(name)}</span><span class="muted small">${escapeHtml(detail)} · <b data-size="${size}">${formatBytes(size)}</b></span></div>`;
    toast(`Downloaded ${name} (${formatBytes(size)})`);
  }

  async function exportPdf(list: Item[], name: string) {
    const bytes = await runJob(`Building ${name}…`, (p) => call<Uint8Array>('build', { pages: toPlan(list), options: buildOptions() }, [], p));
    if (!bytes) return;
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
    showResult(name, plural(list.length), bytes.byteLength);
  }
  on('pt-merge', () => { if (items.length) exportPdf(items, `${fileBase()}.pdf`); });
  on('pt-extract', () => {
    const list = items.filter((i) => sel.has(i.uid));
    if (list.length) exportPdf(list, `${fileBase()}-selected.pdf`);
  });

  // split
  const splitBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-split]')];
  splitBtns.forEach((b) => b.addEventListener('click', () => {
    splitMode = b.dataset.split as typeof splitMode;
    splitBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('pt-split-every').hidden = splitMode !== 'every';
    $('pt-split-ranges').hidden = splitMode !== 'ranges';
    updateSplit();
  }));
  $('pt-split-n').addEventListener('input', updateSplit);
  $('pt-ranges').addEventListener('input', updateSplit);
  function splitResult(): RangeResult {
    const n = items.length;
    if (!n) return { groups: [], labels: [], error: 'Add pages first.' };
    if (splitMode === 'single') return chunk(1, n);
    if (splitMode === 'every') return chunk(parseInt(($('pt-split-n') as HTMLInputElement).value, 10), n);
    return parseRanges(($('pt-ranges') as HTMLInputElement).value, n);
  }
  function updateSplit() {
    const r = splitResult();
    const out = $('pt-split-preview');
    const btn = $<HTMLButtonElement>('pt-split-go');
    if (r.error) {
      out.className = 'pt-split-preview is-error small';
      out.textContent = items.length ? r.error : 'Add pages to split them.';
      btn.disabled = true;
      $('pt-ranges').setAttribute('aria-invalid', String(splitMode === 'ranges' && !!items.length));
      return;
    }
    $('pt-ranges').setAttribute('aria-invalid', 'false');
    const shown = r.labels.slice(0, 8).join(' · ') + (r.labels.length > 8 ? ` · … (${r.labels.length - 8} more)` : '');
    out.className = 'pt-split-preview small';
    out.textContent = `→ ${r.groups.length} PDF${r.groups.length === 1 ? '' : 's'} in a ZIP: ${shown}`;
    btn.disabled = busy;
  }
  on('pt-split-go', async () => {
    const r = splitResult();
    if (r.error) return toast(r.error, 'error');
    const base = fileBase();
    const pad = String(r.groups.length).length;
    const groups = r.groups.map((g, k) => ({
      name: `${base}-${String(k + 1).padStart(Math.max(2, pad), '0')}-p${r.labels[k]}.pdf`,
      pages: toPlan(g.map((n) => items[n - 1])),
    }));
    const zip = await runJob(`Splitting into ${groups.length} files…`, (p) => call<Uint8Array>('split', { groups, options: buildOptions() }, [], p));
    if (!zip) return;
    const name = `${base}-split.zip`;
    downloadBlob(new Blob([zip], { type: 'application/zip' }), name);
    showResult(name, `${groups.length} PDF${groups.length === 1 ? '' : 's'}`, zip.byteLength);
  });

  render();
}
