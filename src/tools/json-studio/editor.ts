// Plain <textarea> editor with a virtualized line-number gutter, an error-line band,
// Tab / Shift+Tab indentation, Enter auto-indent and an Esc escape hatch for keyboard users.
import { CodeView } from './codeview';
import { countLines, highlightJsonLine } from './util';

/** Above this size the text is shown in a virtualized read-only view: a native textarea needs seconds to lay out megabytes. */
export const LARGE_TEXT = 1_000_000;

const LH = 20;
const PAD = 10;

export class Editor {
  readonly ta: HTMLTextAreaElement;
  private gutter: HTMLElement;
  private gutterInner: HTMLElement;
  private band: HTMLElement;
  private totalLines = 1;
  private errorLine = 0;
  private escaped = false;
  private raf = 0;
  private big: string | null = null;
  private bigView: CodeView;
  private bigBox: HTMLElement;
  private editorEl: HTMLElement;
  indentUnit = '  ';
  onCursor?: (line: number, col: number) => void;
  onLargeChange?: (large: boolean) => void;

  constructor(root: HTMLElement) {
    this.ta = root.querySelector('textarea')!;
    this.gutter = root.querySelector('.jss-gutter')!;
    this.gutterInner = root.querySelector('.jss-gutter-inner')!;
    this.band = root.querySelector('.jss-errband')!;
    this.bigBox = root.querySelector('.jss-big')!;
    this.editorEl = root.querySelector('.jss-editor')!;
    this.bigView = new CodeView(root.querySelector('.jss-big-view')!, (l) => (l.length > 400 ? highlightJsonLine(l.slice(0, 400)) + '…' : highlightJsonLine(l)));
    const ta = this.ta;
    ta.addEventListener('scroll', () => this.schedule(), { passive: true });
    ta.addEventListener('input', () => {
      this.totalLines = countLines(ta.value);
      this.schedule();
    });
    ta.addEventListener('keydown', (e) => this.onKey(e));
    const cursor = () => this.reportCursor();
    ta.addEventListener('keyup', cursor);
    ta.addEventListener('click', cursor);
    ta.addEventListener('select', cursor);
    new ResizeObserver(() => this.schedule()).observe(ta);
  }

  get value() {
    return this.big ?? this.ta.value;
  }

  get isLarge() {
    return this.big !== null;
  }

  set value(v: string) {
    const wasLarge = this.big !== null;
    if (v.length > LARGE_TEXT) {
      this.big = v;
      this.ta.value = '';
      this.totalLines = 1;
      this.bigBox.hidden = false;
      this.editorEl.hidden = true;
      this.bigView.setText(v);
    } else {
      this.big = null;
      if (wasLarge) {
        this.bigView.setText('');
        this.bigBox.hidden = true;
        this.editorEl.hidden = false;
      }
      this.ta.value = v;
      this.totalLines = countLines(v);
      this.ta.scrollTop = 0;
      this.ta.scrollLeft = 0;
      this.renderGutter();
    }
    if (wasLarge !== (this.big !== null)) this.onLargeChange?.(this.big !== null);
  }

  /** Move a large document into the real textarea (slow, but the user asked for it). */
  editLarge() {
    if (this.big === null) return;
    const v = this.big;
    this.big = null;
    this.bigView.setText('');
    this.bigBox.hidden = true;
    this.editorEl.hidden = false;
    this.ta.value = v;
    this.totalLines = countLines(v);
    this.renderGutter();
    this.onLargeChange?.(false);
  }

  /**
   * Replace the whole text. Small documents go through the browser's edit stack so Ctrl+Z
   * undoes the action; huge ones (or touch devices, where focusing pops the keyboard) are set directly.
   */
  setUndoable(text: string) {
    const ta = this.ta;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (!coarse && this.big === null && text.length < 500_000 && ta.value.length < 500_000) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(0, ta.value.length);
      if (document.execCommand('insertText', false, text) && ta.value === text) {
        ta.setSelectionRange(0, 0);
        ta.scrollTop = 0;
        ta.scrollLeft = 0;
        this.totalLines = countLines(text);
        this.renderGutter();
        return;
      }
    }
    this.value = text;
  }

  /** Scroll so that `line` is visible (about a third from the top) without moving focus. */
  reveal(line: number) {
    if (this.big !== null) return this.bigView.revealLine(line);
    const ta = this.ta;
    const top = (line - 1) * LH + PAD;
    if (top < ta.scrollTop || top + LH > ta.scrollTop + ta.clientHeight) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    this.renderGutter();
  }

  setErrorLine(line: number) {
    this.errorLine = line;
    if (this.big !== null) this.bigView.setMarkLine(line);
    this.renderGutter();
  }

  /** Select the error position, scroll it into view (about a third from the top) and focus. */
  goTo(pos: number, line: number) {
    if (this.big !== null) return this.bigView.revealLine(line);
    const ta = this.ta;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(pos, Math.min(pos + 1, ta.value.length));
    ta.scrollTop = Math.max(0, (line - 1) * LH - ta.clientHeight / 3);
    this.renderGutter();
    this.reportCursor();
  }

  private reportCursor() {
    if (!this.onCursor) return;
    const v = this.ta.value;
    const p = this.ta.selectionStart;
    let line = 1;
    let last = -1;
    for (let i = v.indexOf('\n'); i !== -1 && i < p; i = v.indexOf('\n', i + 1)) line++, (last = i);
    this.onCursor(line, p - last);
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => ((this.raf = 0), this.renderGutter()));
  }

  renderGutter() {
    if (this.big !== null) return;
    const st = this.ta.scrollTop;
    const h = this.ta.clientHeight || 400;
    const first = Math.floor(Math.max(0, st - PAD) / LH);
    const count = Math.ceil(h / LH) + 2;
    const last = Math.min(this.totalLines, first + count);
    let html = '';
    for (let i = first + 1; i <= last; i++) html += i === this.errorLine ? `<div class="is-error">${i}</div>` : `<div>${i}</div>`;
    this.gutterInner.innerHTML = html;
    this.gutterInner.style.transform = `translateY(${PAD + first * LH - st}px)`;
    this.gutter.style.setProperty('--jss-gw', `${Math.max(3, String(this.totalLines).length) + 1.5}ch`);
    if (this.errorLine) {
      this.band.hidden = false;
      this.band.style.transform = `translateY(${PAD + (this.errorLine - 1) * LH - st}px)`;
    } else this.band.hidden = true;
  }

  /** Replace [start,end) keeping the browser's undo stack when possible. */
  private replace(start: number, end: number, text: string) {
    const ta = this.ta;
    ta.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, start, end, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  private onKey(e: KeyboardEvent) {
    const ta = this.ta;
    if (e.key === 'Escape') {
      this.escaped = true;
      return;
    }
    if (e.key === 'Tab') {
      if (this.escaped || e.ctrlKey || e.metaKey || e.altKey) {
        this.escaped = false;
        return; // let focus move on
      }
      e.preventDefault();
      const v = ta.value;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      const unit = this.indentUnit;
      if (s === en && !e.shiftKey) {
        this.replace(s, en, unit);
        return;
      }
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const blockEnd = en > s && v[en - 1] === '\n' ? en - 1 : en;
      const lines = v.slice(lineStart, blockEnd).split('\n');
      const out = lines.map((l) =>
        e.shiftKey ? l.replace(unit === '\t' ? /^\t/ : new RegExp(`^ {1,${unit.length}}|^\\t`), '') : unit + l,
      );
      const text = out.join('\n');
      this.replace(lineStart, blockEnd, text);
      const delta1 = e.shiftKey ? (out[0].length - lines[0].length) : unit.length;
      ta.setSelectionRange(Math.max(lineStart, s + delta1), lineStart + text.length);
      return;
    }
    this.escaped = false;
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && ta.value.length < 2_000_000) {
      const v = ta.value;
      const s = ta.selectionStart;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(lineStart, s))![0];
      const prev = v.slice(lineStart, s).trimEnd().slice(-1);
      const next = v[ta.selectionEnd];
      e.preventDefault();
      if ((prev === '{' || prev === '[') && (next === '}' || next === ']')) {
        this.replace(s, ta.selectionEnd, `\n${indent}${this.indentUnit}\n${indent}`);
        const caret = s + 1 + indent.length + this.indentUnit.length;
        ta.setSelectionRange(caret, caret);
      } else {
        this.replace(s, ta.selectionEnd, `\n${indent}${prev === '{' || prev === '[' ? this.indentUnit : ''}`);
      }
    }
  }
}
