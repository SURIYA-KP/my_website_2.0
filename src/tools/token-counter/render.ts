// Token chip rendering with hover/focus details. Renders in pages so 1 MB inputs stay fast.
import { escapeHtml } from '../../lib/ui';
import { hexByte, splitUtf8 } from './core';

export interface TokenData {
  ids: Uint32Array;
  lens: Uint16Array;
  bytes: Uint8Array; // concatenated UTF-8 bytes of all tokens
}

export interface ChipOptions {
  showIds: boolean;
  showWs: boolean;
}

const PAGE = 2500;
const COLORS = 5;

function visibleWs(s: string) {
  return s.replace(/ /g, '·').replace(/\t/g, '→').replace(/\r/g, '␍').replace(/\n/g, '↵\n');
}

/** JSON-ish escaped preview for the tooltip. */
function preview(s: string) {
  const esc = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return esc.length > 60 ? `${esc.slice(0, 60)}…` : esc;
}

let tip: HTMLDivElement | null = null;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tc-tip';
    tip.id = 'tc-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

export class ChipView {
  readonly el: HTMLElement;
  private moreBtn: HTMLButtonElement;
  private moreText: HTMLElement;
  private data: TokenData | null = null;
  private offsets: Uint32Array = new Uint32Array(1);
  private rendered = 0;
  opts: ChipOptions = { showIds: false, showWs: false };
  emptyHtml = '';

  constructor(el: HTMLElement, more: HTMLElement) {
    this.el = el;
    this.moreText = more.querySelector('[data-more-text]')!;
    this.moreBtn = more.querySelector('button')!;
    this.moreBtn.addEventListener('click', () => this.renderMore(true));
    el.addEventListener('pointerover', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('.tc-chip');
      if (chip && el.contains(chip)) this.showTip(chip);
    });
    el.addEventListener('pointerleave', () => this.hideTip());
    el.addEventListener('focusin', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('.tc-chip');
      if (chip) this.showTip(chip);
    });
    el.addEventListener('focusout', () => this.hideTip());
    el.addEventListener('keydown', (e) => this.onKey(e));
    el.addEventListener('scroll', () => this.hideTip(), { passive: true });
  }

  get count() {
    return this.data?.ids.length ?? 0;
  }

  set(data: TokenData | null) {
    this.data = data;
    if (data) {
      const off = new Uint32Array(data.ids.length + 1);
      for (let i = 0; i < data.ids.length; i++) off[i + 1] = off[i] + data.lens[i];
      this.offsets = off;
    }
    this.rerender();
  }

  setOptions(opts: Partial<ChipOptions>) {
    this.opts = { ...this.opts, ...opts };
    this.rerender();
  }

  private rerender() {
    this.hideTip();
    const keep = Math.max(PAGE, this.rendered);
    this.rendered = 0;
    this.el.classList.toggle('tc-ids', this.opts.showIds);
    this.el.classList.toggle('tc-ws', this.opts.showWs);
    if (!this.data || !this.data.ids.length) {
      this.el.innerHTML = this.emptyHtml;
      this.updateMore();
      return;
    }
    this.el.innerHTML = '';
    this.renderUpTo(Math.min(keep, this.data.ids.length));
  }

  private renderMore(focusNew = false) {
    if (!this.data) return;
    const before = this.rendered;
    this.renderUpTo(Math.min(this.rendered + PAGE * 2, this.data.ids.length));
    if (focusNew) this.el.querySelector<HTMLElement>(`.tc-chip[data-i="${before}"]`)?.focus();
  }

  private renderUpTo(end: number) {
    const parts: string[] = [];
    for (let i = this.rendered; i < end; i++) parts.push(this.chipHtml(i));
    this.el.insertAdjacentHTML('beforeend', parts.join(''));
    if (this.rendered === 0) this.el.querySelector<HTMLElement>('.tc-chip')?.setAttribute('tabindex', '0');
    this.rendered = end;
    this.updateMore();
  }

  private updateMore() {
    const total = this.count;
    const more = total > this.rendered;
    this.moreBtn.parentElement!.hidden = !more;
    if (more) {
      this.moreText.textContent = `Showing ${this.rendered.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} tokens.`;
      this.moreBtn.textContent = `Show ${Math.min(PAGE * 2, total - this.rendered).toLocaleString('en-US')} more`;
    }
  }

  tokenBytes(i: number) {
    const d = this.data!;
    return d.bytes.subarray(this.offsets[i], this.offsets[i + 1]);
  }

  private chipHtml(i: number) {
    const id = this.data!.ids[i];
    const cls = `tc-chip tc-c${i % COLORS}`;
    if (this.opts.showIds) return `<span class="${cls}" data-i="${i}" tabindex="-1">${id}</span>`;
    const segs = splitUtf8(this.tokenBytes(i));
    let partial = false;
    let html = '';
    for (const s of segs) {
      if ('text' in s) {
        html += escapeHtml(this.opts.showWs ? visibleWs(s.text) : s.text);
      } else {
        partial = true;
        html += s.bytes.map((b) => `<span class="tc-byte" aria-hidden="true">${hexByte(b)}</span>`).join('');
      }
    }
    if (!html) html = '<span class="tc-empty">∅</span>';
    return `<span class="${cls}${partial ? ' tc-partial' : ''}" data-i="${i}" tabindex="-1">${html}</span>`;
  }

  private onKey(e: KeyboardEvent) {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.tc-chip');
    if (!chip) return;
    const i = Number(chip.dataset.i);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = i + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = this.rendered - 1;
    else if (e.key === 'Escape') return this.hideTip();
    else return;
    e.preventDefault();
    if (next < 0 || next >= this.rendered) return;
    const target = this.el.querySelector<HTMLElement>(`.tc-chip[data-i="${next}"]`);
    if (!target) return;
    chip.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  }

  private showTip(chip: HTMLElement) {
    if (!this.data) return;
    const i = Number(chip.dataset.i);
    const bytes = this.tokenBytes(i);
    const segs = splitUtf8(bytes);
    const partial = segs.some((s) => 'bytes' in s);
    const text = segs.map((s) => ('text' in s ? s.text : s.bytes.map((b) => `\\x${hexByte(b)}`).join(''))).join('');
    const hex = Array.from(bytes.subarray(0, 24), hexByte).join(' ') + (bytes.length > 24 ? ' …' : '');
    const t = tooltip();
    t.innerHTML =
      `<div class="tc-tip-head"><span>Token ${(i + 1).toLocaleString('en-US')}</span><strong>id ${this.data.ids[i]}</strong></div>` +
      `<div class="tc-tip-text">"${escapeHtml(preview(text))}"</div>` +
      `<div class="tc-tip-bytes">${bytes.length} byte${bytes.length === 1 ? '' : 's'}: ${hex}</div>` +
      (partial ? '<div class="tc-tip-note">Part of a multi-byte UTF-8 character: this token holds only some of its bytes.</div>' : '');
    t.hidden = false;
    chip.setAttribute('aria-describedby', 'tc-tip');
    const r = chip.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    let top = r.top - tr.height - 8;
    if (top < 8) top = r.bottom + 8;
    t.style.left = `${left}px`;
    t.style.top = `${top}px`;
  }

  private hideTip() {
    if (tip) tip.hidden = true;
  }
}
