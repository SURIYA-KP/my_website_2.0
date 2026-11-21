import { copyText, toast } from '../../lib/ui';
import {
  type Color,
  allFormats,
  formatOklchCss,
  hex,
  inP3,
  inSrgb,
  nearestNamed,
  parseColor,
  randomBase,
  serialize,
  toHsl,
  toOklch,
} from './color';
import { $, ICONS, showError, type App } from './core';

const CHECKER = 'conic-gradient(#d9d9d9 25%, #fff 0 50%, #d9d9d9 0 75%, #fff 0) 0 0 / 10px 10px';

export function initConvert(app: App) {
  const input = $<HTMLInputElement>('cv-input');
  const picker = $<HTMLInputElement>('cv-picker');
  const err = $('cv-error');
  const sl = {
    okL: $<HTMLInputElement>('cv-ok-l'),
    okC: $<HTMLInputElement>('cv-ok-c'),
    okH: $<HTMLInputElement>('cv-ok-h'),
    okA: $<HTMLInputElement>('cv-ok-a'),
    hslH: $<HTMLInputElement>('cv-hsl-h'),
    hslS: $<HTMLInputElement>('cv-hsl-s'),
    hslL: $<HTMLInputElement>('cv-hsl-l'),
  };
  const out = (id: string, v: string) => ($(id).textContent = v);
  // Hue is undefined for greys; remember the last one so the sliders do not jump.
  let lastOkH = 0;
  let lastHslH = 0;

  type Source = 'input' | 'picker' | 'oklch' | 'hsl' | 'other';
  function set(c: Color, source: Source = 'other') {
    app.state.color = c;
    render(source);
    app.saveHash();
  }

  function track(stops: string[]) {
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }

  function render(source: Source = 'other') {
    const c = app.state.color;
    const alpha = c.alpha ?? 1;
    $('cv-swatch').style.background = formatOklchCss(c);
    if (source !== 'input') {
      input.value = serialize(c);
      showError(err, null);
    }
    if (source !== 'picker') picker.value = hex(c);

    // Badges
    const badges: string[] = [];
    if (inSrgb(c)) badges.push('<span class="badge badge-success" id="cv-gamut">In sRGB gamut</span>');
    else {
      badges.push('<span class="badge badge-warning" id="cv-gamut" title="HEX, RGB, HSL, HWB and CMYK show the closest sRGB color">Out of sRGB gamut</span>');
      badges.push(inP3(c) ? '<span class="badge badge-accent">Fits Display P3</span>' : '<span class="badge badge-danger">Outside Display P3</span>');
    }
    if (alpha < 1) badges.push(`<span class="badge">${Math.round(alpha * 100)}% opacity</span>`);
    $('cv-badges').innerHTML = badges.join('');

    // Nearest named color
    const n = nearestNamed(c);
    $('cv-named-dot').style.background = n.hex;
    $('cv-named-text').textContent = n.deltaE < 0.5 ? n.name : `${n.name} (ΔE ${n.deltaE})`;
    $('cv-named').title = `Use ${n.name} (${n.hex})`;
    $('cv-named').dataset.name = n.name;

    // Formats
    const rows = allFormats(c);
    $('cv-mapped-note').hidden = !rows.some((r) => r.mapped);
    $('cv-formats').innerHTML = rows
      .map(
        (r) => `<li data-format="${r.id}"><span class="cl-fmt-label">${r.label}${r.id === 'cmyk' ? ' <span class="faint">≈</span>' : ''}</span>
<span class="cl-fmt-value">${r.value}${r.mapped ? '<span class="cl-fmt-mapped" title="Gamut-mapped to sRGB">*</span>' : ''}</span>
<button class="btn btn-sm btn-ghost btn-icon" type="button" data-copy="${r.value}" aria-label="Copy ${r.label}" title="Copy ${r.label}">${ICONS.copy}</button></li>`,
      )
      .join('');

    // OKLCH sliders
    const ok = toOklch(c);
    if (ok.h !== undefined && (ok.c ?? 0) > 0.0005) lastOkH = ok.h;
    if (source !== 'oklch') {
      sl.okL.value = String(+(ok.l * 100).toFixed(1));
      sl.okC.value = String(Math.min(0.4, ok.c ?? 0));
      sl.okH.value = String(lastOkH);
      sl.okA.value = String(Math.round(alpha * 100));
    }
    const L = Number(sl.okL.value) / 100, C = Number(sl.okC.value), H = Number(sl.okH.value);
    out('cv-ok-l-out', `${(+sl.okL.value).toFixed(1)}%`);
    out('cv-ok-c-out', (+sl.okC.value).toFixed(3));
    out('cv-ok-h-out', `${(+sl.okH.value).toFixed(1)}°`);
    out('cv-ok-a-out', `${sl.okA.value}%`);
    const samp = (n: number, f: (t: number) => Color) => Array.from({ length: n + 1 }, (_, i) => hex(f(i / n)));
    sl.okL.style.setProperty('--track', track(samp(10, (t) => ({ mode: 'oklch', l: t, c: C, h: H }))));
    sl.okC.style.setProperty('--track', track(samp(8, (t) => ({ mode: 'oklch', l: L, c: t * 0.4, h: H }))));
    sl.okH.style.setProperty('--track', track(samp(12, (t) => ({ mode: 'oklch', l: L, c: C, h: t * 360 }))));
    sl.okA.style.setProperty('--track', `linear-gradient(to right, transparent, ${hex(c)}), ${CHECKER}`);

    // HSL sliders
    const h = toHsl(c);
    if (h.h !== undefined && (h.s ?? 0) > 0.001) lastHslH = h.h;
    if (source !== 'hsl') {
      sl.hslH.value = String(lastHslH);
      sl.hslS.value = String(+(Math.min(1, Math.max(0, h.s ?? 0)) * 100).toFixed(1));
      sl.hslL.value = String(+(Math.min(1, Math.max(0, h.l ?? 0)) * 100).toFixed(1));
    }
    const hh = Number(sl.hslH.value), hs = Number(sl.hslS.value) / 100, hl = Number(sl.hslL.value) / 100;
    out('cv-hsl-h-out', `${hh.toFixed(1)}°`);
    out('cv-hsl-s-out', `${(hs * 100).toFixed(1)}%`);
    out('cv-hsl-l-out', `${(hl * 100).toFixed(1)}%`);
    sl.hslH.style.setProperty('--track', track(samp(12, (t) => ({ mode: 'hsl', h: t * 360, s: hs, l: hl }))));
    sl.hslS.style.setProperty('--track', track(samp(4, (t) => ({ mode: 'hsl', h: hh, s: t, l: hl }))));
    sl.hslL.style.setProperty('--track', track(samp(4, (t) => ({ mode: 'hsl', h: hh, s: hs, l: t }))));
  }

  input.addEventListener('input', () => {
    const c = parseColor(input.value);
    if (!c) {
      showError(err, input.value.trim() ? `"${input.value.trim()}" is not a color I understand. Try #ff0000, rgb(255 0 0), hsl(0 100% 50%), oklch(62.8% 0.258 29) or a name like tomato.` : null);
      return;
    }
    showError(err, null);
    set(c, 'input');
  });
  input.addEventListener('blur', () => {
    if (!err.hidden) return;
    input.value = serialize(app.state.color);
  });
  picker.addEventListener('input', () => set(parseColor(picker.value)!, 'picker'));

  const fromOklch = () => {
    const alpha = Number(sl.okA.value) / 100;
    const c: Color = { mode: 'oklch', l: Number(sl.okL.value) / 100, c: Number(sl.okC.value), h: Number(sl.okH.value) };
    if (alpha < 1) c.alpha = alpha;
    set(c, 'oklch');
  };
  [sl.okL, sl.okC, sl.okH, sl.okA].forEach((s) => s.addEventListener('input', fromOklch));
  const fromHsl = () => {
    const c: Color = { mode: 'hsl', h: Number(sl.hslH.value), s: Number(sl.hslS.value) / 100, l: Number(sl.hslL.value) / 100 };
    const a = app.state.color.alpha;
    if (a !== undefined && a < 1) c.alpha = a;
    set(c, 'hsl');
  };
  [sl.hslH, sl.hslS, sl.hslL].forEach((s) => s.addEventListener('input', fromHsl));

  $('cv-formats').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
    if (b) copyText(b.dataset.copy!, `Copied ${b.dataset.copy}`);
  });
  $('cv-named').addEventListener('click', () => {
    const name = $('cv-named').dataset.name;
    if (name) set(parseColor(name)!);
  });
  $('cv-random').addEventListener('click', () => set(parseColor(randomBase())!));

  const eye = $<HTMLButtonElement>('cv-eyedrop');
  const ED = (window as any).EyeDropper;
  if (typeof ED === 'function') {
    eye.hidden = false;
    eye.addEventListener('click', async () => {
      try {
        const res = await new ED().open();
        set(parseColor(res.sRGBHex)!);
        toast(`Picked ${res.sRGBHex}`);
      } catch (e: any) {
        if (e?.name !== 'AbortError') toast('Could not pick a color from the screen', 'error');
      }
    });
  }

  document.querySelectorAll<HTMLElement>('#cl-panel-convert [data-send]').forEach((b) =>
    b.addEventListener('click', () => app.send(b.dataset.send as any, serialize(app.state.color))),
  );

  app.render.convert = () => render();
}
