// Virtualized, read-only code viewer with line numbers: only the visible lines are in the DOM,
// so multi-megabyte outputs scroll smoothly and get syntax highlighting line by line.
import { escapeHtml } from '../../lib/ui';

const LH = 20;
const OVERSCAN = 20;

export class CodeView {
  private lines: string[] = [];
  private text = '';
  private inner: HTMLElement;
  private raf = 0;
  private lastRange = '';

  constructor(private host: HTMLElement, private highlight: (line: string) => string = escapeHtml) {
    host.classList.add('jss-cv');
    host.tabIndex = 0;
    this.inner = document.createElement('div');
    this.inner.className = 'jss-cv-inner';
    host.appendChild(this.inner);
    host.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(host);
  }

  get value() {
    return this.text;
  }

  setText(text: string, keepScroll = false) {
    this.text = text;
    this.lines = text === '' ? [] : text.split('\n');
    let max = 0;
    for (const l of this.lines) if (l.length > max) max = l.length;
    const gutterCh = String(this.lines.length).length + 2;
    this.host.style.setProperty('--jss-gutter', `${gutterCh}ch`);
    this.inner.style.height = `${this.lines.length * LH + 16}px`;
    this.inner.style.width = `calc(${Math.min(max, 20000) + gutterCh + 4}ch + 24px)`;
    this.lastRange = '';
    if (!keepScroll) {
      this.host.scrollTop = 0;
      this.host.scrollLeft = 0;
    }
    this.render();
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => ((this.raf = 0), this.render()));
  }

  render(force = false) {
    if (force) this.lastRange = '';
    const h = this.host.clientHeight || 600;
    const first = Math.max(0, Math.floor(this.host.scrollTop / LH) - OVERSCAN);
    const last = Math.min(this.lines.length, Math.ceil((this.host.scrollTop + h) / LH) + OVERSCAN);
    const key = `${first}:${last}`;
    if (key === this.lastRange) return;
    this.lastRange = key;
    let html = '';
    for (let i = first; i < last; i++) {
      html += `<div class="jss-cv-line" style="top:${i * LH + 8}px"><span class="jss-cv-ln">${i + 1}</span><span class="jss-cv-code">${this.highlight(this.lines[i])}</span></div>`;
    }
    this.inner.innerHTML = html;
  }
}
