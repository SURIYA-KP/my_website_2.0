// Settings form used both for the global panel and the per-image override dialog.
import { type FormatChoice, type OutFormat, type Settings, LABEL, cloneSettings } from './types';

export interface SettingsForm {
  get(): Settings;
  set(s: Settings): void;
  setAspect(aspect: number | null): void;
}

const h = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
};

export function createSettingsForm(
  root: HTMLElement,
  opts: { id: string; supported: OutFormat[]; initial: Settings; onChange: (s: Settings) => void; aspect?: number | null },
): SettingsForm {
  const p = opts.id;
  let aspect = opts.aspect ?? null;
  const formats: FormatChoice[] = ['keep', ...(['jpeg', 'png', 'webp', 'avif'] as OutFormat[]).filter((f) => opts.supported.includes(f))];
  root.classList.add('is-form');
  root.append(h(`
    <div class="field">
      <span class="label" id="${p}-fmt-l">Output format</span>
      <div class="btn-group is-fmt" role="group" aria-labelledby="${p}-fmt-l">
        ${formats.map((f) => `<button type="button" class="btn btn-sm" data-fmt="${f}" aria-pressed="false">${f === 'keep' ? 'Keep' : LABEL[f as OutFormat]}</button>`).join('')}
      </div>
      <p class="small muted is-hint" data-r="fmt-hint"></p>
    </div>
    <div class="field">
      <div class="row-between"><label class="label" for="${p}-q" data-r="q-label">Quality</label><span class="small mono" data-r="q-val"></span></div>
      <input type="range" id="${p}-q" min="1" max="100" step="1" data-r="q" />
      <p class="small muted is-hint" data-r="q-hint" hidden></p>
    </div>
    <div class="field">
      <label class="label" for="${p}-rmode">Resize</label>
      <select class="select" id="${p}-rmode" data-r="rmode">
        <option value="none">Keep original size</option>
        <option value="fit">Fit within max width &amp; height</option>
        <option value="percent">Scale by percentage</option>
        <option value="exact">Exact size</option>
      </select>
      <div class="is-two" data-r="fit">
        <div class="field"><label class="label" for="${p}-fw">Max width (px)</label><input class="input" type="number" min="1" inputmode="numeric" id="${p}-fw" placeholder="any" data-r="fw" /></div>
        <div class="field"><label class="label" for="${p}-fh">Max height (px)</label><input class="input" type="number" min="1" inputmode="numeric" id="${p}-fh" placeholder="any" data-r="fh" /></div>
        <p class="small muted is-hint is-span2">Images are only ever scaled down, never enlarged.</p>
      </div>
      <div class="field" data-r="pct">
        <div class="row-between"><label class="label" for="${p}-pct">Percentage</label><span class="small mono" data-r="pct-val"></span></div>
        <input type="range" id="${p}-pct" min="5" max="200" step="1" data-r="pct-in" />
      </div>
      <div class="is-two" data-r="exact">
        <div class="field"><label class="label" for="${p}-ew">Width (px)</label><input class="input" type="number" min="1" inputmode="numeric" id="${p}-ew" data-r="ew" /></div>
        <div class="field"><label class="label" for="${p}-eh">Height (px)</label><input class="input" type="number" min="1" inputmode="numeric" id="${p}-eh" data-r="eh" /></div>
        <label class="checkbox is-span2"><input type="checkbox" data-r="lock" /> Lock aspect ratio</label>
        <p class="small muted is-hint is-span2" data-r="exact-hint"></p>
      </div>
    </div>
    <div class="field">
      <label class="checkbox"><input type="checkbox" id="${p}-ten" data-r="ten" /> Target file size</label>
      <div class="row is-target-row" data-r="target">
        <span class="small muted">at most</span>
        <input class="input" type="number" min="1" step="any" aria-label="Target size" data-r="tval" />
        <select class="select" aria-label="Target size unit" data-r="tunit"><option value="1">KB</option><option value="1024">MB</option></select>
      </div>
      <p class="small muted is-hint" data-r="t-hint" hidden>Finds the highest quality that fits, and shrinks the dimensions only if it has to.</p>
    </div>
    <details class="is-more" data-r="more">
    <summary>Transparency &amp; SVG</summary>
    <div class="is-more-body">
    <div class="field">
      <label class="label" for="${p}-bg">Background for transparency</label>
      <div class="row is-bg-row">
        <input type="color" id="${p}-bg" data-r="bg" />
        <input class="input mono" maxlength="7" aria-label="Background hex color" data-r="bghex" />
        <button type="button" class="is-swatch" data-bg="#ffffff" style="background:#ffffff" aria-label="White"></button>
        <button type="button" class="is-swatch" data-bg="#000000" style="background:#000000" aria-label="Black"></button>
      </div>
      <p class="small muted is-hint">Used when transparent images become JPEG (no alpha channel).</p>
    </div>
    <div class="field">
      <label class="label" for="${p}-svg">SVG rasterization scale</label>
      <select class="select" id="${p}-svg" data-r="svg">
        ${[0.5, 1, 2, 3, 4, 8].map((s) => `<option value="${s}">${s}× intrinsic size</option>`).join('')}
      </select>
      <p class="small muted is-hint">SVG is vector art; pick how many pixels to render it at.</p>
    </div>
    </div>
    </details>
  `));

  const $ = <T extends HTMLElement>(r: string) => root.querySelector<T>(`[data-r="${r}"]`)!;
  const fmtBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-fmt]'));
  const q = $<HTMLInputElement>('q');
  const rmode = $<HTMLSelectElement>('rmode');
  const fw = $<HTMLInputElement>('fw'), fh = $<HTMLInputElement>('fh');
  const pct = $<HTMLInputElement>('pct-in');
  const ew = $<HTMLInputElement>('ew'), eh = $<HTMLInputElement>('eh'), lock = $<HTMLInputElement>('lock');
  const ten = $<HTMLInputElement>('ten'), tval = $<HTMLInputElement>('tval'), tunit = $<HTMLSelectElement>('tunit');
  const bg = $<HTMLInputElement>('bg'), bghex = $<HTMLInputElement>('bghex');
  const svg = $<HTMLSelectElement>('svg');

  let s = cloneSettings(opts.initial);
  const int = (el: HTMLInputElement) => Math.max(0, Math.round(Number(el.value) || 0));

  const sync = () => {
    fmtBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fmt === s.format)));
    const png = s.format === 'png';
    const keep = s.format === 'keep';
    $('fmt-hint').textContent = keep
      ? 'JPEG, PNG and WebP keep their format; GIF, BMP and SVG become PNG.'
      : s.format === 'jpeg' ? 'Smallest for photos. No transparency.'
      : png ? 'Lossless, keeps transparency. Large for photos.'
      : s.format === 'webp' ? 'Great all-rounder: small files, keeps transparency.'
      : 'Very small files; slower to encode.';
    q.value = String(s.quality);
    $('q-val').textContent = png ? 'n/a' : `${s.quality}`;
    $('q-label').textContent = s.target.enabled ? 'Max quality' : 'Quality';
    q.disabled = png;
    const qh = $('q-hint');
    qh.hidden = !(png || keep);
    qh.textContent = png ? 'PNG is lossless, so quality does not apply. Resize or use a target size to make it smaller.' : 'Applies to JPEG and WebP outputs; PNG stays lossless.';
    rmode.value = s.resize.mode;
    $('fit').hidden = s.resize.mode !== 'fit';
    $('pct').hidden = s.resize.mode !== 'percent';
    $('exact').hidden = s.resize.mode !== 'exact';
    if (document.activeElement !== fw) fw.value = s.resize.width ? String(s.resize.width) : '';
    if (document.activeElement !== fh) fh.value = s.resize.height ? String(s.resize.height) : '';
    pct.value = String(s.resize.percent);
    $('pct-val').textContent = `${s.resize.percent}%`;
    if (document.activeElement !== ew) ew.value = s.resize.width ? String(s.resize.width) : '';
    if (document.activeElement !== eh) eh.value = s.resize.height ? String(s.resize.height) : '';
    lock.checked = s.resize.lock;
    ew.placeholder = s.resize.lock ? 'auto' : '';
    eh.placeholder = s.resize.lock ? 'auto' : '';
    $('exact-hint').textContent = s.resize.lock
      ? 'Enter one side; the other follows the image’s aspect ratio.'
      : 'Both sides are forced; the image may be stretched.';
    ten.checked = s.target.enabled;
    $('target').hidden = !s.target.enabled;
    $('t-hint').hidden = !s.target.enabled;
    if (document.activeElement !== tval) {
      const mb = s.target.kb >= 1024 && s.target.kb % 1024 === 0;
      tunit.value = mb ? '1024' : '1';
      tval.value = String(mb ? s.target.kb / 1024 : s.target.kb);
    }
    bg.value = s.background;
    if (document.activeElement !== bghex) bghex.value = s.background;
    svg.value = String(s.svgScale);
  };

  const emit = () => { sync(); opts.onChange(cloneSettings(s)); };

  fmtBtns.forEach((b) => b.addEventListener('click', () => { s.format = b.dataset.fmt as FormatChoice; emit(); }));
  q.addEventListener('input', () => { s.quality = int(q) || 1; emit(); });
  rmode.addEventListener('change', () => {
    s.resize.mode = rmode.value as Settings['resize']['mode'];
    if (s.resize.mode === 'exact' && s.resize.lock && s.resize.width && s.resize.height) s.resize.height = 0;
    emit();
  });
  fw.addEventListener('input', () => { s.resize.width = int(fw); emit(); });
  fh.addEventListener('input', () => { s.resize.height = int(fh); emit(); });
  pct.addEventListener('input', () => { s.resize.percent = int(pct) || 100; emit(); });
  ew.addEventListener('input', () => {
    s.resize.width = int(ew);
    if (s.resize.lock) { s.resize.height = aspect && s.resize.width ? Math.max(1, Math.round(s.resize.width / aspect)) : 0; eh.value = s.resize.height ? String(s.resize.height) : ''; }
    emit();
  });
  eh.addEventListener('input', () => {
    s.resize.height = int(eh);
    if (s.resize.lock) {
      // Height drives the size when locked: clear width (or derive it when the aspect is known).
      s.resize.width = 0;
      ew.value = aspect && s.resize.height ? String(Math.max(1, Math.round(s.resize.height * aspect))) : '';
    }
    emit();
  });
  lock.addEventListener('change', () => {
    s.resize.lock = lock.checked;
    if (lock.checked && s.resize.width && s.resize.height) s.resize.height = aspect ? Math.round(s.resize.width / aspect) : 0;
    emit();
  });
  ten.addEventListener('change', () => { s.target.enabled = ten.checked; emit(); });
  const readTarget = () => {
    const v = Number(tval.value);
    if (v > 0) { s.target.kb = Math.max(1, Math.round(v * Number(tunit.value))); emit(); }
  };
  tval.addEventListener('input', readTarget);
  tunit.addEventListener('change', readTarget);
  bg.addEventListener('input', () => { s.background = bg.value; emit(); });
  bghex.addEventListener('input', () => {
    const v = bghex.value.trim();
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v);
    if (!m) return;
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    s.background = `#${hex}`;
    emit();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-bg]').forEach((b) => b.addEventListener('click', () => { s.background = b.dataset.bg!; emit(); }));
  svg.addEventListener('change', () => { s.svgScale = Number(svg.value); emit(); });

  sync();
  return {
    get: () => cloneSettings(s),
    set: (n) => { s = cloneSettings(n); sync(); },
    setAspect: (a) => { aspect = a; },
  };
}
