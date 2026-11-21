import { escapeHtml } from '../../lib/ui';
import {
  apcaGuidance,
  apcaLc,
  contrastRatio,
  formatRatio,
  hex,
  hexAuto,
  parseColor,
  serialize,
  suggestForeground,
  WCAG,
  type Color,
} from './color';
import { $, CONTRAST_TARGETS, showError, type App, type ContrastTarget } from './core';

const css = (c: Color) => {
  const h = hexAuto(c);
  return h;
};

export function initContrast(app: App) {
  const fgIn = $<HTMLInputElement>('ct-fg');
  const bgIn = $<HTMLInputElement>('ct-bg');
  const fgPick = $<HTMLInputElement>('ct-fg-picker');
  const bgPick = $<HTMLInputElement>('ct-bg-picker');
  const target = $<HTMLSelectElement>('ct-target');
  const sugg = $('ct-suggestion');

  const badge = (ok: boolean, need: number) =>
    `<span class="badge ${ok ? 'badge-success' : 'badge-danger'}">${ok ? '✓ Pass' : '✗ Fail'}</span><span class="cl-need">${need}:1</span>`;

  function render(source?: 'fg' | 'bg') {
    const s = app.state;
    const fg = parseColor(s.fg)!;
    const bg = parseColor(s.bg)!;
    if (source !== 'fg') {
      fgIn.value = s.fg;
      showError($('ct-fg-error'), null);
    }
    if (source !== 'bg') {
      bgIn.value = s.bg;
      showError($('ct-bg-error'), null);
    }
    fgPick.value = hex(fg);
    bgPick.value = hex(bg);
    target.value = s.target;

    const pv = $('ct-preview');
    pv.style.background = hex(bg);
    pv.style.color = css(fg);
    const btn = pv.querySelector<HTMLElement>('.cl-prev-btn')!;
    btn.style.background = css(fg);
    btn.style.color = hex(bg);

    const r = contrastRatio(fg, bg);
    $('ct-ratio').textContent = formatRatio(r);
    $('ct-ratio').dataset.raw = String(r);
    const rows: [string, string, boolean, number, boolean | null, number | null][] = [
      ['normal', 'Normal text', r >= WCAG.normal.AA, WCAG.normal.AA, r >= WCAG.normal.AAA, WCAG.normal.AAA],
      ['large', 'Large text <span class="faint small">(24px, or 18.66px bold)</span>', r >= WCAG.large.AA, WCAG.large.AA, r >= WCAG.large.AAA, WCAG.large.AAA],
      ['ui', 'UI components &amp; graphics', r >= WCAG.ui.AA, WCAG.ui.AA, null, null],
    ];
    $('ct-results').innerHTML = rows
      .map(
        ([id, label, aa, aaNeed, aaa, aaaNeed]) =>
          `<tr data-row="${id}"><td>${label}</td><td data-level="AA">${badge(aa, aaNeed)}</td><td data-level="AAA">${aaa === null ? '<span class="faint small">n/a</span>' : badge(aaa, aaaNeed!)}</td></tr>`,
      )
      .join('');
    const lc = apcaLc(fg, bg);
    $('ct-apca').textContent = `Lc ${lc.toFixed(1)}`;
    $('ct-apca').dataset.raw = String(lc);
    $('ct-apca-note').textContent = apcaGuidance(lc);
  }

  function update(which: 'fg' | 'bg', value: string, source?: 'fg' | 'bg') {
    app.state[which] = value;
    sugg.innerHTML = '';
    render(source);
    app.saveHash();
  }

  for (const [which, inp, pick] of [
    ['fg', fgIn, fgPick],
    ['bg', bgIn, bgPick],
  ] as const) {
    inp.addEventListener('input', () => {
      const c = parseColor(inp.value);
      const errEl = $(`ct-${which}-error`);
      if (!c) {
        showError(errEl, inp.value.trim() ? 'Not a valid CSS color.' : null);
        return;
      }
      showError(errEl, null);
      update(which, inp.value.trim(), which);
    });
    inp.addEventListener('blur', () => {
      if ($(`ct-${which}-error`).hidden) inp.value = app.state[which];
    });
    pick.addEventListener('input', () => update(which, pick.value));
  }

  $('ct-swap').addEventListener('click', () => {
    const s = app.state;
    [s.fg, s.bg] = [s.bg, s.fg];
    sugg.innerHTML = '';
    render();
    app.saveHash();
  });

  target.addEventListener('change', () => {
    app.state.target = target.value as ContrastTarget;
    sugg.innerHTML = '';
    app.saveHash();
  });

  $('ct-suggest').addEventListener('click', () => {
    const s = app.state;
    const t = CONTRAST_TARGETS[s.target];
    const fg = parseColor(s.fg)!;
    const bg = parseColor(s.bg)!;
    const res = suggestForeground(fg, bg, t.ratio);
    const bgHex = hex(bg);
    if (!res) {
      sugg.innerHTML = `<div class="alert alert-warning" id="ct-sugg-none">No lightness of this hue reaches ${t.ratio}:1 on ${escapeHtml(bgHex)}. Pick a lighter or darker background.</div>`;
      return;
    }
    if (res.alreadyPasses) {
      sugg.innerHTML = `<div class="alert alert-success" id="ct-sugg-ok">Already passes ${t.label} (${formatRatio(res.ratio)}:1). No change needed.</div>`;
      return;
    }
    const sw = (c: string) => `<span class="cl-sugg-swatch" style="background:${bgHex};color:${c}">Aa</span>`;
    const dl = res.deltaL > 0 ? `+${(res.deltaL * 100).toFixed(1)}` : (res.deltaL * 100).toFixed(1);
    sugg.innerHTML = `<div class="cl-sugg">
      ${sw(css(fg))}<span class="cl-arrow" aria-hidden="true">→</span>${sw(css(res.color))}
      <div class="stack" style="gap:2px">
        <strong class="mono" id="ct-sugg-hex">${escapeHtml(serialize(res.color))}</strong>
        <span class="small muted"><span id="ct-sugg-ratio">${formatRatio(res.ratio)}</span>:1 · lightness ${dl}%</span>
      </div>
      <button class="btn btn-sm btn-primary" type="button" id="ct-apply">Apply</button>
    </div>`;
    $('ct-apply').addEventListener('click', () => update('fg', serialize(res.color)));
  });

  app.render.contrast = () => render();
}
