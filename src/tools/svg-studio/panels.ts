// Layers tree, Properties panel and Code panel.
import { Editor, CONTAINERS } from './editor';
import { SvgParseError } from './sanitize';
import { LOCK_ATTR, EDITOR_ATTR_PREFIX } from './xml';
import { escapeHtml, debounce, toast } from '../../lib/ui';

const ICONS: Record<string, string> = {
  g: '<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>',
  a: '<path d="M7 9l2-2M6 11l-1 1a2 2 0 0 1-3-3l2-2a2 2 0 0 1 3 0M10 5l1-1a2 2 0 0 1 3 3l-2 2a2 2 0 0 1-3 0"/>',
  rect: '<rect x="3" y="4" width="10" height="8" rx="1"/>',
  circle: '<circle cx="8" cy="8" r="5"/>',
  ellipse: '<ellipse cx="8" cy="8" rx="6" ry="4"/>',
  line: '<path d="M3 13L13 3"/>',
  polyline: '<path d="M2 12l4-6 3 4 5-7"/>',
  polygon: '<path d="M8 2.5l5.5 10h-11z"/>',
  path: '<path d="M2.5 12c2-8 5-8 5.5-4s3.5 4 5.5-4"/>',
  text: '<path d="M4 4h8M8 4v9"/>',
  tspan: '<path d="M5 6h6M8 6v6"/>',
  textPath: '<path d="M4 4h8M8 4v9"/>',
  image: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M3 11l3-3 2.5 2.5L10 9l3 3"/>',
  use: '<rect x="2.5" y="2.5" width="7" height="7"/><rect x="6.5" y="6.5" width="7" height="7"/>',
  svg: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 8h6"/>',
  switch: '<path d="M3 5h10M3 11h10"/>',
  foreignObject: '<rect x="2.5" y="3.5" width="11" height="9"/><path d="M5 7h6M5 9.5h4"/>',
};
const icon = (tag: string) =>
  `<svg class="svgs-ico" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[tag] ?? ICONS.path}</svg>`;
const EYE = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 2l12 12M6.6 4c.5-.2 1-.3 1.4-.3 4.1 0 6.5 4.3 6.5 4.3s-.6 1.1-1.7 2.2M10.6 11.6c-.8.5-1.7.9-2.6.9-4.1 0-6.5-4.5-6.5-4.5s.8-1.5 2.3-2.8"/></svg>';
const LOCK = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
const UNLOCK = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/></svg>';
const CARET = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M6 4l5 4-5 4z"/></svg>';

export function labelFor(el: Element) {
  const id = el.getAttribute('id');
  // Mermaid ids (m1-flowchart-build-3): show the label text or a shorter id.
  if (id && /^m\d+-/.test(id)) {
    const preview = el.localName === 'g' ? groupPreview(el) : '';
    return preview || id.replace(/^m\d+-(flowchart-)?/, '');
  }
  if (id) return id;
  if (el.localName === 'text' || el.localName === 'tspan' || el.localName === 'textPath') {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t ? `“${t.length > 28 ? t.slice(0, 27) + '…' : t}”` : el.localName;
  }
  const cls = el.getAttribute('class')?.trim().split(/\s+/)[0];
  return cls ? `${el.localName}.${cls}` : el.localName;
}

/** Short text preview for a group that holds one or two labels (e.g. a Mermaid node). */
function groupPreview(el: Element) {
  const texts = el.querySelectorAll('text');
  if (!texts.length || texts.length > 2) return '';
  const t = Array.from(texts).map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
  return t ? `“${t.length > 24 ? t.slice(0, 23) + '…' : t}”` : '';
}

const MAX_ROWS = 2500;

// ====================================================================== Layers
export class LayersPanel {
  private expanded = new Set<string>();
  private renaming: string | null = null;
  private dragPath: string | null = null;
  private lastClick = { path: '', t: 0 };

  constructor(
    readonly body: HTMLElement,
    readonly editor: Editor,
  ) {
    editor.on((kind) => {
      if (kind === 'doc' || kind === 'replace' || kind === 'selection') {
        if (kind === 'selection') this.revealSelection();
        else this.lastClick = { path: '', t: 0 };
        this.render();
      }
    });
    this.bind();
  }

  private key(el: Element) {
    return this.editor.pathOf(el).join('.');
  }

  private revealSelection() {
    for (const el of this.editor.selection) {
      for (let p = el.parentElement; p && p !== (this.editor.root as Element); p = p.parentElement) this.expanded.add(this.key(p));
    }
  }

  render() {
    const ed = this.editor;
    if (!ed.root) return;
    const rows: string[] = [];
    let count = 0;
    const walk = (parent: Element, depth: number, parentHidden: boolean, parentLocked: boolean) => {
      const kids = ed.layerChildren(parent).reverse();
      for (const el of kids) {
        if (count++ > MAX_ROWS) return;
        const path = ed.pathOf(el).join('.');
        const kidsOf = ed.layerChildren(el);
        const isContainer = kidsOf.length > 0 && (CONTAINERS.has(el.localName) || el.localName === 'text');
        const open = this.expanded.has(path);
        const hidden = ed.isHidden(el);
        const locked = el.hasAttribute(LOCK_ATTR);
        const sel = ed.selection.includes(el);
        const label = labelFor(el);
        const preview = isContainer && el.localName !== 'text' && label !== groupPreview(el) ? groupPreview(el) : '';
        const lab =
          this.renaming === path
            ? `<input class="svgs-layer-rename input" value="${escapeHtml(el.getAttribute('id') || '')}" aria-label="Rename (id)" spellcheck="false"/>`
            : `<span class="svgs-layer-name${el.getAttribute('id') ? '' : ' is-anon'}">${escapeHtml(label)}</span>`;
        rows.push(
          `<div class="svgs-layer${sel ? ' is-selected' : ''}${hidden || parentHidden ? ' is-hidden' : ''}${locked || parentLocked ? ' is-locked' : ''}" role="treeitem" aria-level="${depth + 1}" aria-selected="${sel}"${isContainer ? ` aria-expanded="${open}"` : ''} data-path="${path}" draggable="${this.renaming === path ? 'false' : 'true'}" style="--depth:${depth}" tabindex="${sel ? 0 : -1}">` +
            `<button type="button" class="svgs-twisty" data-act="toggle" tabindex="-1" aria-label="${open ? 'Collapse' : 'Expand'}"${isContainer ? '' : ' hidden'}>${CARET}</button>` +
            `${icon(el.localName)}${lab}` +
            (preview ? `<span class="svgs-layer-preview">${escapeHtml(preview)}</span>` : '') +
            (depth < 3 ? `<span class="svgs-layer-tag">${el.localName}</span>` : '') +
            `<button type="button" class="svgs-layer-btn${hidden ? ' is-on' : ''}" data-act="eye" tabindex="-1" aria-pressed="${hidden}" title="${hidden ? 'Show' : 'Hide'}" aria-label="${hidden ? 'Show' : 'Hide'} ${escapeHtml(label)}">${hidden ? EYE_OFF : EYE}</button>` +
            `<button type="button" class="svgs-layer-btn${locked ? ' is-on' : ''}" data-act="lock" tabindex="-1" aria-pressed="${locked}" title="${locked ? 'Unlock' : 'Lock'}" aria-label="${locked ? 'Unlock' : 'Lock'} ${escapeHtml(label)}">${locked ? LOCK : UNLOCK}</button>` +
            `</div>`,
        );
        if (isContainer && open) walk(el, depth + 1, hidden || parentHidden, locked || parentLocked);
      }
    };
    walk(ed.root, 0, false, false);
    if (count > MAX_ROWS) rows.push(`<p class="small muted svgs-empty">Showing the first ${MAX_ROWS} layers.</p>`);
    if (!rows.length) rows.push('<p class="small muted svgs-empty">No visible elements. Paste or open an SVG.</p>');
    this.body.innerHTML = rows.join('');
    if (!this.body.querySelector('[tabindex="0"]')) this.body.querySelector<HTMLElement>('.svgs-layer')?.setAttribute('tabindex', '0');
    const input = this.body.querySelector<HTMLInputElement>('.svgs-layer-rename');
    if (input) {
      input.focus();
      input.select();
    } else {
      this.body.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
    }
  }

  private rowEl(t: EventTarget | null) {
    return (t as Element | null)?.closest?.('.svgs-layer') as HTMLElement | null;
  }
  private elOf(row: HTMLElement) {
    return this.editor.elAt(row.dataset.path!.split('.').map(Number));
  }

  private finishRename(input: HTMLInputElement, save: boolean) {
    const path = this.renaming;
    if (path === null) return;
    this.renaming = null;
    const el = this.editor.elAt(path.split('.').map(Number));
    if (save && el && !this.editor.rename(el, input.value)) toast(`The id “${input.value.trim()}” is already used`, 'error');
    this.render();
  }

  private bind() {
    const b = this.body;
    b.addEventListener('click', (e) => {
      const row = this.rowEl(e.target);
      if (!row || (e.target as Element).closest('input')) return;
      const el = this.elOf(row);
      if (!el) return;
      const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'toggle') {
        const k = row.dataset.path!;
        if (this.expanded.has(k)) this.expanded.delete(k);
        else this.expanded.add(k);
        this.render();
      } else if (act === 'eye') this.editor.toggleHidden(el);
      else if (act === 'lock') this.editor.toggleLock(el);
      else if (e.shiftKey || e.metaKey || e.ctrlKey) this.editor.toggleSelect(el);
      else {
        // Rows are re-rendered on select, so detect a double click ourselves.
        const now = performance.now();
        const again = this.lastClick.path === row.dataset.path && now - this.lastClick.t < 450;
        this.lastClick = { path: row.dataset.path!, t: again ? 0 : now };
        if (again && (e.target as Element).closest('.svgs-layer-name')) {
          this.renaming = row.dataset.path!;
          this.render();
        } else this.editor.select([el]);
      }
    });
    b.addEventListener('dblclick', (e) => {
      const row = this.rowEl(e.target);
      if (!row || (e.target as Element).closest('[data-act]')) return;
      this.renaming = row.dataset.path!;
      this.render();
    });
    b.addEventListener('keydown', (e) => {
      const input = (e.target as Element).closest?.('.svgs-layer-rename') as HTMLInputElement | null;
      if (input) {
        if (e.key === 'Enter') this.finishRename(input, true);
        else if (e.key === 'Escape') this.finishRename(input, false);
        e.stopPropagation();
        return;
      }
      const row = this.rowEl(e.target);
      if (!row) return;
      const rows = Array.from(b.querySelectorAll<HTMLElement>('.svgs-layer'));
      const i = rows.indexOf(row);
      const el = this.elOf(row);
      const go = (r?: HTMLElement) => {
        if (!r) return;
        const t = this.elOf(r);
        if (t) this.editor.select([t]);
        b.querySelector<HTMLElement>('.is-selected')?.focus();
      };
      if (e.key === 'ArrowDown') go(rows[i + 1]);
      else if (e.key === 'ArrowUp') go(rows[i - 1]);
      else if (e.key === 'ArrowRight' && row.getAttribute('aria-expanded') === 'false') {
        this.expanded.add(row.dataset.path!);
        this.render();
        b.querySelector<HTMLElement>('.is-selected')?.focus();
      } else if (e.key === 'ArrowLeft' && row.getAttribute('aria-expanded') === 'true') {
        this.expanded.delete(row.dataset.path!);
        this.render();
        b.querySelector<HTMLElement>('.is-selected')?.focus();
      } else if (e.key === 'Enter' || e.key === 'F2') {
        this.renaming = row.dataset.path!;
        this.render();
      } else if ((e.key === 'h' || e.key === 'H') && el) {
        this.editor.toggleHidden(el);
      } else if ((e.key === 'l' || e.key === 'L') && el) {
        this.editor.toggleLock(el);
      } else if (e.key === ' ' && el) {
        this.editor.select([el]);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    b.addEventListener('focusout', (e) => {
      const input = (e.target as Element).closest?.('.svgs-layer-rename') as HTMLInputElement | null;
      if (input && this.renaming !== null) this.finishRename(input, true);
    });
    // Drag and drop reordering (the list shows front-most first).
    b.addEventListener('dragstart', (e) => {
      const row = this.rowEl(e.target);
      if (!row) return;
      this.dragPath = row.dataset.path!;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', this.dragPath);
    });
    const where = (row: HTMLElement, e: DragEvent) => {
      const r = row.getBoundingClientRect();
      const f = (e.clientY - r.top) / r.height;
      const el = this.elOf(row);
      const container = el && (el.localName === 'g' || el.localName === 'a');
      if (container && f > 0.3 && f < 0.7) return 'inside';
      return f < 0.5 ? 'above' : 'below';
    };
    b.addEventListener('dragover', (e) => {
      const row = this.rowEl(e.target);
      if (!row || this.dragPath === null) return;
      e.preventDefault();
      b.querySelectorAll('.drop-above,.drop-below,.drop-inside').forEach((r) => r.classList.remove('drop-above', 'drop-below', 'drop-inside'));
      row.classList.add(`drop-${where(row, e)}`);
    });
    b.addEventListener('dragleave', (e) => this.rowEl(e.target)?.classList.remove('drop-above', 'drop-below', 'drop-inside'));
    b.addEventListener('drop', (e) => {
      const row = this.rowEl(e.target);
      if (!row || this.dragPath === null) return;
      e.preventDefault();
      const src = this.editor.elAt(this.dragPath.split('.').map(Number));
      const ref = this.elOf(row);
      const w = where(row, e);
      this.dragPath = null;
      if (src && ref && src !== ref) {
        // "above" in the list = in front = after in document order.
        this.editor.moveTo(src, ref, w === 'inside' ? 'inside' : w === 'above' ? 'after' : 'before');
        this.editor.select([src]);
      } else this.render();
    });
    b.addEventListener('dragend', () => {
      this.dragPath = null;
      b.querySelectorAll('.drop-above,.drop-below,.drop-inside').forEach((r) => r.classList.remove('drop-above', 'drop-below', 'drop-inside'));
    });
  }
}

// ====================================================================== Properties
const GEOMETRY: Record<string, string[]> = {
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  text: ['x', 'y', 'dx', 'dy'],
  tspan: ['x', 'y', 'dx', 'dy'],
  image: ['x', 'y', 'width', 'height'],
  use: ['x', 'y', 'width', 'height'],
  svg: ['x', 'y', 'width', 'height'],
  foreignObject: ['x', 'y', 'width', 'height'],
};
const LONG_GEOMETRY: Record<string, string> = { path: 'd', polygon: 'points', polyline: 'points' };
const FONTS = ['Inter, Helvetica, Arial, sans-serif', 'Helvetica, Arial, sans-serif', 'Georgia, serif', 'Times New Roman, serif', 'ui-monospace, Menlo, Consolas, monospace', 'system-ui, sans-serif', 'cursive', 'fantasy'];

let colorCtx: CanvasRenderingContext2D | null = null;
/** Any CSS color → #rrggbb for <input type=color> (null for none/url/unknown). */
export function toHex(value: string): string | null {
  const v = value.trim();
  if (!v || /^(none|transparent|inherit|currentcolor)$/i.test(v) || v.startsWith('url(')) return null;
  colorCtx ??= document.createElement('canvas').getContext('2d');
  if (!colorCtx) return null;
  colorCtx.fillStyle = '#010203';
  colorCtx.fillStyle = v;
  const out = colorCtx.fillStyle as string;
  if (out === '#010203' && !/^#010203$/i.test(v)) return null;
  if (out.startsWith('#')) return out;
  const m = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(out);
  return m ? '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : null;
}

export class PropsPanel {
  private selfEdit = false;
  private pending = 0;

  constructor(
    readonly body: HTMLElement,
    readonly editor: Editor,
    readonly hooks: { onBackground: (bg: string) => void; getBackground: () => string; onFit: () => void },
  ) {
    editor.on((kind) => {
      if (kind === 'view') return;
      if (kind === 'live') {
        cancelAnimationFrame(this.pending);
        this.pending = requestAnimationFrame(() => this.refreshTransformField());
        return;
      }
      this.render();
    });
    this.bind();
  }

  private refreshTransformField() {
    const el = this.editor.selection[0];
    const f = this.body.querySelector<HTMLInputElement>('[data-attr="transform"]');
    if (el && f && document.activeElement !== f) f.value = el.getAttribute('transform') || '';
  }

  /** Live preview (color picker / slider drags): no undo step, no panel re-render. */
  private live(fn: () => void) {
    this.selfEdit = true;
    try {
      fn();
      this.editor.emit('live');
    } finally {
      this.selfEdit = false;
    }
  }

  focusText() {
    const t = this.body.querySelector<HTMLTextAreaElement>('[data-text]');
    if (t) {
      t.focus();
      t.select();
    }
  }

  render() {
    const ed = this.editor;
    if (!ed.root) return;
    // Re-rendering keeps keyboard focus on the same field (e.g. after Tab from a changed input).
    const active = document.activeElement as HTMLInputElement | null;
    let focusKey: string | null = null;
    let caret: [number | null, number | null] = [null, null];
    if (active && this.body.contains(active)) {
      for (const k of ['data-attr', 'data-style', 'data-stop-text', 'data-stop-offset', 'data-rename', 'data-text', 'data-color-for', 'data-opacity-range']) {
        if (active.hasAttribute(k)) {
          focusKey = `[${k}="${CSS.escape(active.getAttribute(k) || '')}"]`;
          break;
        }
      }
      if (!focusKey && active.id) focusKey = `#${CSS.escape(active.id)}`;
      try {
        caret = [active.selectionStart, active.selectionEnd];
      } catch {
        /* not a text field */
      }
    }
    const sel = ed.selection;
    let html = '';
    if (!sel.length) html = this.docHtml();
    else if (sel.length === 1) html = this.singleHtml(sel[0]);
    else html = this.multiHtml(sel);
    this.body.innerHTML = html;
    if (focusKey) {
      const el = this.body.querySelector<HTMLInputElement>(focusKey);
      if (el) {
        el.focus({ preventScroll: true });
        try {
          if (caret[0] !== null) el.setSelectionRange(caret[0], caret[1]);
        } catch {
          /* not a text field */
        }
      }
    }
  }

  private colorRow(prop: string, label: string, value: string, source: string, placeholder = '') {
    const hex = toHex(value);
    const shown = source === 'computed' ? '' : value;
    const badge = source === 'style' ? '<span class="badge" title="Set in the style attribute">style</span>' : source === 'computed' && value ? '<span class="badge" title="Inherited or from CSS">inherited</span>' : '';
    return `<div class="svgs-field svgs-color" data-prop="${prop}">
      <label class="label" for="svgs-p-${prop}">${label} ${badge}</label>
      <div class="svgs-color-row">
        <input type="color" aria-label="${label} color picker" value="${hex ?? '#000000'}" data-color-for="${prop}" ${hex ? '' : 'data-empty="1"'}/>
        <input class="input mono" id="svgs-p-${prop}" data-style="${prop}" value="${escapeHtml(shown)}" placeholder="${escapeHtml(source === 'computed' ? value || placeholder : placeholder)}" spellcheck="false" autocomplete="off"/>
        <button type="button" class="btn btn-sm btn-ghost" data-set-none="${prop}" title="Set to none">none</button>
      </div>
    </div>`;
  }

  private gradientHtml(el: Element, prop: 'fill' | 'stroke') {
    const g = this.editor.gradientFor(el, prop);
    if (!g) return '';
    const stops = g.stops
      .map((s, i) => {
        const color = this.editor.getProp(s, 'stop-color').value || '#000000';
        return `<div class="svgs-stop" data-stop="${i}">
          <input type="color" aria-label="Stop ${i + 1} color" value="${toHex(color) ?? '#000000'}" data-stop-color="${i}"/>
          <input class="input mono" aria-label="Stop ${i + 1} color value" data-stop-text="${i}" value="${escapeHtml(color)}" spellcheck="false"/>
          <input class="input mono svgs-offset" aria-label="Stop ${i + 1} offset" data-stop-offset="${i}" value="${escapeHtml(s.getAttribute('offset') || '0')}"/>
        </div>`;
      })
      .join('');
    return `<div class="svgs-gradient" data-grad-prop="${prop}"><div class="small muted">${g.grad.localName === 'radialGradient' ? 'Radial' : 'Linear'} gradient <code>#${escapeHtml(g.grad.getAttribute('id') || '')}</code> · ${g.stops.length} stops</div>${stops}</div>`;
  }

  private numField(attr: string, label: string, value: string, opts: { style?: boolean; step?: string; placeholder?: string } = {}) {
    return `<div class="svgs-field"><label class="label" for="svgs-a-${attr}">${label}</label><input class="input mono" id="svgs-a-${attr}" ${opts.style ? `data-style="${attr}"` : `data-attr="${attr}"`} value="${escapeHtml(value)}" placeholder="${escapeHtml(opts.placeholder ?? '')}" spellcheck="false" autocomplete="off" inputmode="decimal"/></div>`;
  }

  private styleSection(el: Element, multi = false) {
    const ed = this.editor;
    const fill = ed.getProp(el, 'fill');
    const stroke = ed.getProp(el, 'stroke');
    const sw = ed.getProp(el, 'stroke-width');
    const op = ed.getProp(el, 'opacity');
    const opv = op.source === 'computed' ? 1 : Number.parseFloat(op.value);
    return `<section class="svgs-sec"><h3 class="svgs-h">Appearance${multi ? ` <span class="muted small">(applies to all)</span>` : ''}</h3>
      ${this.colorRow('fill', 'Fill', fill.value, fill.source, 'black')}
      ${multi ? '' : this.gradientHtml(el, 'fill')}
      ${this.colorRow('stroke', 'Stroke', stroke.value, stroke.source, 'none')}
      ${multi ? '' : this.gradientHtml(el, 'stroke')}
      <div class="svgs-grid2">
        ${this.numField('stroke-width', 'Stroke width', sw.source === 'computed' ? '' : sw.value, { style: true, placeholder: sw.source === 'computed' ? sw.value.replace(/px$/, '') : '' })}
        <div class="svgs-field"><label class="label" for="svgs-opacity">Opacity</label>
          <div class="svgs-range-row"><input type="range" id="svgs-opacity" min="0" max="1" step="0.01" value="${Number.isFinite(opv) ? opv : 1}" data-opacity-range/><output class="small mono">${Number.isFinite(opv) ? Math.round(opv * 100) : 100}%</output></div>
        </div>
      </div>
    </section>`;
  }

  private singleHtml(el: Element) {
    const ed = this.editor;
    const tag = el.localName;
    const id = el.getAttribute('id') || '';
    let html = `<div class="svgs-sel-head">${icon(tag)}<strong>&lt;${tag}&gt;</strong><input class="input mono svgs-id" aria-label="Element id" data-rename value="${escapeHtml(id)}" placeholder="no id" spellcheck="false"/></div>`;
    html += this.styleSection(el);
    if (tag === 'text' || tag === 'tspan' || tag === 'textPath') {
      const { lines } = ed.textLines(el);
      const fam = ed.getProp(el, 'font-family');
      const size = ed.getProp(el, 'font-size');
      const weight = ed.getProp(el, 'font-weight');
      const anchor = ed.getProp(el, 'text-anchor');
      const wv = weight.source === 'computed' ? '' : weight.value;
      html += `<section class="svgs-sec"><h3 class="svgs-h">Text</h3>
        <div class="svgs-field"><label class="label" for="svgs-text">Content${lines.length > 1 ? ' (one line per row)' : ''}</label>
        <textarea class="textarea svgs-text" id="svgs-text" data-text rows="${Math.min(6, Math.max(2, lines.length))}" spellcheck="true">${escapeHtml(lines.join('\n'))}</textarea></div>
        <div class="svgs-field"><label class="label" for="svgs-a-font-family">Font family</label><input class="input" id="svgs-a-font-family" list="svgs-fonts" data-style="font-family" value="${escapeHtml(fam.source === 'computed' ? '' : fam.value)}" placeholder="${escapeHtml(fam.value)}"/></div>
        <datalist id="svgs-fonts">${FONTS.map((f) => `<option value="${escapeHtml(f)}"></option>`).join('')}</datalist>
        <div class="svgs-grid2">
          ${this.numField('font-size', 'Size', size.source === 'computed' ? '' : size.value, { style: true, placeholder: size.value })}
          <div class="svgs-field"><label class="label" for="svgs-a-font-weight">Weight</label><select class="select" id="svgs-a-font-weight" data-style="font-weight">
            ${['', '300', '400', '500', '600', '700', '800', 'normal', 'bold'].map((w) => `<option value="${w}"${w === wv ? ' selected' : ''}>${w || `(inherit: ${escapeHtml(weight.value)})`}</option>`).join('')}
            ${wv && !['300', '400', '500', '600', '700', '800', 'normal', 'bold'].includes(wv) ? `<option selected value="${escapeHtml(wv)}">${escapeHtml(wv)}</option>` : ''}
          </select></div>
        </div>
        <div class="svgs-field"><label class="label" for="svgs-a-text-anchor">Anchor</label><select class="select" id="svgs-a-text-anchor" data-style="text-anchor">
          ${['', 'start', 'middle', 'end'].map((a) => `<option value="${a}"${a === (anchor.source === 'computed' ? '' : anchor.value) ? ' selected' : ''}>${a || '(inherit)'}</option>`).join('')}
        </select></div>
      </section>`;
    }
    const geo = GEOMETRY[tag];
    const long = LONG_GEOMETRY[tag];
    if (geo || long) {
      html += `<section class="svgs-sec"><h3 class="svgs-h">Geometry</h3>`;
      if (geo) html += `<div class="svgs-grid2">${geo.map((a) => this.numField(a, a, el.getAttribute(a) ?? '')).join('')}</div>`;
      if (long) {
        const v = el.getAttribute(long) || '';
        html += `<div class="svgs-field"><label class="label" for="svgs-a-${long}">${long === 'd' ? 'Path data (d)' : 'Points'}</label><textarea class="textarea code-input svgs-long" id="svgs-a-${long}" data-attr="${long}" rows="3" spellcheck="false">${escapeHtml(v)}</textarea></div>`;
      }
      html += `</section>`;
    }
    if (ed.canTransform(el)) {
      html += `<section class="svgs-sec"><h3 class="svgs-h">Transform</h3>
        <div class="svgs-field"><label class="label" for="svgs-a-transform">transform</label>
        <div class="svgs-color-row"><input class="input mono" id="svgs-a-transform" data-attr="transform" value="${escapeHtml(el.getAttribute('transform') || '')}" placeholder="none" spellcheck="false"/>
        <button type="button" class="btn btn-sm btn-ghost" data-clear-transform title="Remove the transform">Reset</button></div></div>
      </section>`;
    }
    html += this.attrTable(el);
    return html;
  }

  private attrTable(el: Element) {
    const rows = Array.from(el.attributes)
      .filter((a) => !a.name.startsWith(EDITOR_ATTR_PREFIX))
      .map(
        (a) => `<tr><th scope="row" class="mono">${escapeHtml(a.name)}</th><td><input class="input mono" aria-label="${escapeHtml(a.name)}" data-attr="${escapeHtml(a.name)}" value="${escapeHtml(a.value)}" spellcheck="false"/></td>
        <td><button type="button" class="btn btn-sm btn-ghost svgs-x" data-remove-attr="${escapeHtml(a.name)}" aria-label="Remove ${escapeHtml(a.name)}" title="Remove">×</button></td></tr>`,
      )
      .join('');
    return `<section class="svgs-sec"><details class="svgs-details" open><summary class="svgs-h">All attributes</summary>
      <table class="svgs-attrs"><tbody>${rows || '<tr><td colspan="3" class="small muted">No attributes</td></tr>'}</tbody></table>
      <form class="svgs-add-attr" data-add-attr>
        <input class="input mono" name="name" aria-label="New attribute name" placeholder="name" spellcheck="false" autocomplete="off"/>
        <input class="input mono" name="value" aria-label="New attribute value" placeholder="value" spellcheck="false" autocomplete="off"/>
        <button class="btn btn-sm" type="submit">Add</button>
      </form></details></section>`;
  }

  private multiHtml(sel: Element[]) {
    return `<div class="svgs-sel-head"><strong>${sel.length} elements selected</strong></div>
      ${this.styleSection(sel[0], true)}
      <section class="svgs-sec"><h3 class="svgs-h">Align</h3>
        <div class="svgs-align" role="group" aria-label="Align selection">
          ${[['left', 'Left'], ['hcenter', 'Center'], ['right', 'Right'], ['top', 'Top'], ['vcenter', 'Middle'], ['bottom', 'Bottom']].map(([k, l]) => `<button type="button" class="btn btn-sm" data-align="${k}">${l}</button>`).join('')}
        </div>
      </section>
      <p class="small muted">Tip: <kbd>Ctrl</kbd>+<kbd>G</kbd> groups the selection.</p>`;
  }

  private docHtml() {
    const ed = this.editor;
    const r = ed.root;
    const bg = this.hooks.getBackground();
    const count = r.querySelectorAll('*').length;
    const anim = ed.hasAnimation();
    return `<div class="svgs-sel-head"><strong>Document</strong><span class="small muted">nothing selected</span></div>
      <section class="svgs-sec">
        <div class="svgs-grid2">
          ${this.numField('width', 'Width', r.getAttribute('width') || '')}
          ${this.numField('height', 'Height', r.getAttribute('height') || '')}
        </div>
        <div class="svgs-field"><label class="label" for="svgs-a-viewBox">viewBox</label><input class="input mono" id="svgs-a-viewBox" data-attr="viewBox" value="${escapeHtml(r.getAttribute('viewBox') || '')}" spellcheck="false"/></div>
        <button type="button" class="btn btn-sm" data-fit-viewbox>Fit viewBox to content</button>
      </section>
      <section class="svgs-sec"><h3 class="svgs-h">Preview background</h3>
        <div class="btn-group" role="group" aria-label="Preview background">
          ${[['checker', 'Checkerboard'], ['white', 'White'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" class="btn btn-sm" data-bg="${k}" aria-pressed="${bg === k}">${l}</button>`).join('')}
        </div>
      </section>
      <section class="svgs-sec small muted">
        <p>${count} elements${anim ? ' · animated' : ''}${r.querySelector('style') ? ' · has &lt;style&gt;' : ''}</p>
        <p>Click a part on the canvas to select it. Double-click to go inside a group, <kbd>Esc</kbd> selects the parent. <kbd>Shift</kbd>-click adds to the selection; drag across empty space to box-select whole parts.</p>
      </section>`;
  }

  private bind() {
    const b = this.body;
    const ed = this.editor;
    const targets = () => ed.selection.length ? ed.selection : [ed.root];

    b.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.colorFor) {
        const prop = t.dataset.colorFor;
        this.live(() => targets().forEach((el) => ed.setProp(el, prop, t.value)));
        const txt = b.querySelector<HTMLInputElement>(`[data-style="${prop}"]`);
        if (txt) txt.value = t.value;
      } else if (t.dataset.stopColor !== undefined) {
        const g = ed.gradientFor(ed.selection[0], (t.closest('[data-grad-prop]') as HTMLElement).dataset.gradProp as 'fill');
        const stop = g?.stops[Number(t.dataset.stopColor)];
        if (stop) this.live(() => ed.setProp(stop, 'stop-color', t.value));
        const txt = b.querySelector<HTMLInputElement>(`[data-stop-text="${t.dataset.stopColor}"]`);
        if (txt) txt.value = t.value;
      } else if (t.hasAttribute('data-opacity-range')) {
        this.live(() => targets().forEach((el) => ed.setProp(el, 'opacity', t.value === '1' ? '' : t.value)));
        const out = t.parentElement!.querySelector('output');
        if (out) out.textContent = `${Math.round(Number(t.value) * 100)}%`;
      }
    });

    b.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.closest('[data-add-attr]')) return;
      const sel = ed.selection;
      if (t.dataset.colorFor || t.hasAttribute('data-opacity-range') || t.dataset.stopColor !== undefined) {
        ed.commit();
        return;
      }
      if (t.hasAttribute('data-rename')) {
        if (!ed.rename(sel[0], t.value)) {
          toast(`The id “${t.value.trim()}” is already used`, 'error');
          t.value = sel[0].getAttribute('id') || '';
        }
        return;
      }
      if (t.dataset.style) {
        const prop = t.dataset.style;
        const v = t.value;
        targets().forEach((el) => ed.setProp(el, prop, v));
        ed.commit();
        return;
      }
      if (t.dataset.stopText !== undefined || t.dataset.stopOffset !== undefined) {
        const holder = t.closest('[data-grad-prop]') as HTMLElement;
        const g = ed.gradientFor(sel[0], holder.dataset.gradProp as 'fill');
        const i = Number(t.dataset.stopText ?? t.dataset.stopOffset);
        const stop = g?.stops[i];
        if (stop) {
          if (t.dataset.stopText !== undefined) ed.setProp(stop, 'stop-color', t.value);
          else ed.setAttr(stop, 'offset', t.value, false);
          ed.commit();
        }
        return;
      }
      if (t.hasAttribute('data-text')) {
        ed.setTextLines(sel[0], t.value.split('\n'));
        return;
      }
      if (t.dataset.attr) {
        const name = t.dataset.attr;
        const el = sel.length ? sel[0] : ed.root;
        const v = t.value.trim();
        if (name === 'transform' && v) {
          // Validate before writing.
          const probe = el.cloneNode(false) as SVGGraphicsElement;
          probe.setAttribute('transform', v);
          if (!probe.transform?.baseVal || (probe.transform.baseVal.numberOfItems === 0 && v)) {
            toast('That transform is not valid', 'error');
            t.value = el.getAttribute('transform') || '';
            return;
          }
        }
        ed.setAttr(el, name, v === '' ? null : t.value);
        return;
      }
    });

    b.addEventListener('click', (e) => {
      const t = (e.target as Element).closest<HTMLElement>('button');
      if (!t) return;
      const sel = ed.selection;
      if (t.dataset.setNone) {
        const prop = t.dataset.setNone;
        targets().forEach((el) => ed.setProp(el, prop, 'none'));
        ed.commit();
      } else if (t.dataset.removeAttr) {
        ed.setAttr(sel[0] ?? ed.root, t.dataset.removeAttr, null);
      } else if (t.hasAttribute('data-clear-transform')) {
        ed.setAttr(sel[0], 'transform', null);
      } else if (t.hasAttribute('data-fit-viewbox')) {
        if (ed.fitViewBox()) {
          this.hooks.onFit();
          toast('viewBox fitted to the content');
        } else toast('Nothing to fit', 'error');
      } else if (t.dataset.bg) {
        this.hooks.onBackground(t.dataset.bg);
        b.querySelectorAll('[data-bg]').forEach((x) => x.setAttribute('aria-pressed', String(x === t)));
      } else if (t.dataset.align) {
        this.align(t.dataset.align);
      }
    });

    // Enter commits and leaves the field (so Ctrl+Z undoes the document, not the text box).
    b.addEventListener('keydown', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.closest('[data-add-attr]')) return;
      const single = t.tagName === 'INPUT' && t.type !== 'color' && t.type !== 'range';
      if ((e.key === 'Enter' && single) || (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && t.tagName === 'TEXTAREA')) {
        e.preventDefault();
        t.blur();
      } else if (e.key === 'Escape' && (single || t.tagName === 'TEXTAREA')) {
        e.stopPropagation();
        t.blur();
      }
    });

    b.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      const name = (f.elements.namedItem('name') as HTMLInputElement).value.trim();
      const value = (f.elements.namedItem('value') as HTMLInputElement).value;
      if (!/^[A-Za-z_][\w:.-]*$/.test(name) || /^on/i.test(name)) {
        toast(/^on/i.test(name) ? 'Event handler attributes are not allowed' : 'Invalid attribute name', 'error');
        return;
      }
      if (/javascript:/i.test(value)) {
        toast('javascript: URLs are not allowed', 'error');
        return;
      }
      ed.setAttr(ed.selection[0] ?? ed.root, name, value);
    });
  }

  private align(how: string) {
    const ed = this.editor;
    const items = ed.gestureItems();
    const boxes = items.map(({ el }) => {
      const q = ed.screenQuad(el)!;
      const xs = q.map((p) => p.x);
      const ys = q.map((p) => p.y);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    });
    const X0 = Math.min(...boxes.map((b) => b.x0));
    const X1 = Math.max(...boxes.map((b) => b.x1));
    const Y0 = Math.min(...boxes.map((b) => b.y0));
    const Y1 = Math.max(...boxes.map((b) => b.y1));
    items.forEach((item, i) => {
      const bb = boxes[i];
      let dx = 0;
      let dy = 0;
      if (how === 'left') dx = X0 - bb.x0;
      if (how === 'right') dx = X1 - bb.x1;
      if (how === 'hcenter') dx = (X0 + X1) / 2 - (bb.x0 + bb.x1) / 2;
      if (how === 'top') dy = Y0 - bb.y0;
      if (how === 'bottom') dy = Y1 - bb.y1;
      if (how === 'vcenter') dy = (Y0 + Y1) / 2 - (bb.y0 + bb.y1) / 2;
      ed.applyScreen([item], new DOMMatrix().translate(dx, dy));
    });
    ed.commit();
  }
}

// ====================================================================== Code
export class CodePanel {
  private applying = false;
  private dirty = false;
  readonly textarea: HTMLTextAreaElement;
  private gutter: HTMLElement;
  private status: HTMLElement;
  private lastLines = 0;

  constructor(
    root: HTMLElement,
    readonly editor: Editor,
  ) {
    this.textarea = root.querySelector('textarea')!;
    this.gutter = root.querySelector('.svgs-gutter')!;
    this.status = root.querySelector('.svgs-code-status')!;
    editor.on((kind) => {
      if (kind === 'doc' || kind === 'replace') {
        if (this.applying) return;
        this.setText(editor.code());
      }
    });
    const parse = debounce(() => this.apply(), 450);
    this.textarea.addEventListener('input', () => {
      this.dirty = true;
      this.updateGutter();
      this.status.textContent = 'Editing…';
      this.status.className = 'svgs-code-status small muted';
      parse();
    });
    this.textarea.addEventListener('scroll', () => {
      this.gutter.scrollTop = this.textarea.scrollTop;
    });
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
      }
      e.stopPropagation();
    });
    this.textarea.addEventListener('blur', () => {
      if (this.dirty) this.apply();
    });
  }

  setText(text: string) {
    this.textarea.value = text;
    this.dirty = false;
    this.updateGutter();
    this.setStatus();
  }

  private setStatus(err?: SvgParseError | Error) {
    const g = this.gutter;
    g.querySelectorAll('.is-error').forEach((x) => x.classList.remove('is-error'));
    if (!err) {
      const lines = this.textarea.value.split('\n').length;
      this.status.textContent = `${lines} lines · ${this.textarea.value.length.toLocaleString()} chars · in sync`;
      this.status.className = 'svgs-code-status small muted';
      return;
    }
    const line = (err as SvgParseError).line;
    this.status.textContent = `${line ? `Line ${line}: ` : ''}${err.message.replace(/^error on line \d+ at column \d+:\s*/i, '')} — showing the last valid version.`;
    this.status.className = 'svgs-code-status small is-error';
    if (line) g.children[line - 1]?.classList.add('is-error');
  }

  private updateGutter() {
    const n = this.textarea.value.split('\n').length;
    if (n !== this.lastLines) {
      const parts: string[] = [];
      for (let i = 1; i <= n; i++) parts.push(`<span>${i}</span>`);
      this.gutter.innerHTML = parts.join('');
      this.lastLines = n;
    }
    this.gutter.scrollTop = this.textarea.scrollTop;
  }

  apply() {
    if (!this.dirty) return;
    this.dirty = false;
    this.applying = true;
    try {
      const warnings = this.editor.applyCode(this.textarea.value);
      this.setStatus();
      if (warnings.length) toast(warnings[0]);
    } catch (e) {
      this.setStatus(e as Error);
    } finally {
      this.applying = false;
    }
  }

  format() {
    this.setText(this.editor.code());
  }
}

