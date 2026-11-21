// Pretty-printing / minifying XML serializer for the SVG document.
import { SVG_NS, XLINK_NS } from './sanitize';

/** Attributes the editor adds for its own bookkeeping. Never exported. */
export const EDITOR_ATTR_PREFIX = 'data-studio-';
export const LOCK_ATTR = 'data-studio-lock';

export interface SerializeOptions {
  /** Pretty-print with this indent (default 2 spaces). Ignored when minify is set. */
  indent?: string;
  minify?: boolean;
  /** Strip editor-only attributes (exports). */
  clean?: boolean;
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** Elements whose children must not get indentation whitespace (it would render as spaces). */
const TEXT_CONTENT = new Set(['text', 'tspan', 'textPath', 'title', 'desc']);

function hasMixedContent(el: Element) {
  if (TEXT_CONTENT.has(el.localName)) return true;
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE && n.nodeValue!.trim()) return true;
    if (n.nodeType === Node.CDATA_SECTION_NODE) return true;
  }
  return false;
}

function attrsOf(el: Element, opts: SerializeOptions, isRoot: boolean) {
  const out: string[] = [];
  const names = new Set<string>();
  for (const a of Array.from(el.attributes)) {
    if (opts.clean && a.name.startsWith(EDITOR_ATTR_PREFIX)) continue;
    names.add(a.name);
    let v = a.value;
    if (opts.minify && (a.name === 'd' || a.name === 'points' || a.name === 'transform' || a.name === 'viewBox')) v = v.replace(/\s+/g, ' ').trim();
    out.push(`${a.name}="${escAttr(v)}"`);
  }
  if (isRoot) {
    if (!names.has('xmlns')) out.unshift(`xmlns="${SVG_NS}"`);
  }
  return out;
}

function usesXlink(root: Element) {
  if (root.querySelector('*') === null) return false;
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('xlink:')) return true;
  }
  return false;
}

/** Serialize an SVG root (or any element) to a string. */
export function serialize(root: Element, opts: SerializeOptions = {}): string {
  const indent = opts.minify ? '' : opts.indent ?? '  ';
  const nl = opts.minify ? '' : '\n';
  const parts: string[] = [];
  const xlinkNeeded = usesXlink(root) && !root.hasAttribute('xmlns:xlink');

  const walk = (el: Element, depth: number, inline: boolean) => {
    const pad = inline ? '' : indent.repeat(depth);
    const attrs = attrsOf(el, opts, depth === 0);
    if (depth === 0 && xlinkNeeded) attrs.splice(1, 0, `xmlns:xlink="${XLINK_NS}"`);
    const name = el.tagName;
    let open = `<${name}`;
    if (attrs.length) {
      const oneLine = `${open} ${attrs.join(' ')}`;
      // Wrap very long tags (big paths stay on their own line) when pretty-printing.
      if (!opts.minify && !inline && oneLine.length > 110 && attrs.length > 1) {
        open = `${open} ${attrs[0]}` + attrs.slice(1).map((a) => `${nl}${pad}${indent}${indent}${a}`).join('');
      } else open = oneLine;
    }
    const kids = Array.from(el.childNodes).filter((n) => {
      if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.CDATA_SECTION_NODE) return true;
      if (n.nodeType === Node.COMMENT_NODE) return !opts.minify;
      if (n.nodeType === Node.TEXT_NODE) return inline || hasMixedContent(el) || el.localName === 'style' ? !!n.nodeValue : false;
      return false;
    });
    if (!kids.length) {
      parts.push(`${pad}${open}/>${inline ? '' : nl}`);
      return;
    }
    if (el.localName === 'style' || el.localName === 'script') {
      const css = (el.textContent || '').replace(/\r\n?/g, '\n');
      const body = opts.minify ? css.replace(/\s+/g, ' ').replace(/\s*([{};:,])\s*/g, '$1').trim() : reindent(css, pad + indent);
      const hasLt = /[<&]/.test(body);
      const content = hasLt ? `<![CDATA[${body.replace(/]]>/g, ']]]]><![CDATA[>')}]]>` : body;
      parts.push(opts.minify ? `${pad}${open}>${content}</${name}>` : `${pad}${open}>${nl}${content}${nl}${pad}</${name}>${nl}`);
      return;
    }
    const mixed = inline || hasMixedContent(el);
    if (mixed) {
      // Text content: whitespace is significant, keep everything on one line.
      let s = `${pad}${open}>`;
      const sub: string[] = [];
      const saved = parts.length;
      for (const n of kids) {
        if (n.nodeType === Node.TEXT_NODE) sub.push(escText(opts.minify ? n.nodeValue!.replace(/\s+/g, ' ') : n.nodeValue!));
        else if (n.nodeType === Node.CDATA_SECTION_NODE) sub.push(escText(n.nodeValue!));
        else if (n.nodeType === Node.COMMENT_NODE) sub.push(`<!--${n.nodeValue}-->`);
        else {
          walk(n as Element, depth + 1, true);
          sub.push(parts.splice(saved).join(''));
        }
      }
      s += sub.join('') + `</${name}>`;
      parts.push(s + (inline ? '' : nl));
      return;
    }
    parts.push(`${pad}${open}>${nl}`);
    for (const n of kids) {
      if (n.nodeType === Node.COMMENT_NODE) parts.push(`${pad}${indent}<!--${n.nodeValue}-->${nl}`);
      else if (n.nodeType === Node.CDATA_SECTION_NODE) parts.push(`${pad}${indent}<![CDATA[${n.nodeValue}]]>${nl}`);
      else walk(n as Element, depth + 1, false);
    }
    parts.push(`${pad}</${name}>${nl}`);
  };
  walk(root, 0, false);
  return parts.join('').replace(/\n$/, '') + (opts.minify ? '' : '\n');
}

function reindent(text: string, pad: string) {
  const lines = text.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ind = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const common = ind.length ? Math.min(...ind) : 0;
  return lines.map((l) => (l.trim() ? pad + l.slice(common).replace(/\s+$/, '') : '')).join('\n');
}

/** Format a number for attributes: up to `digits` decimals, no trailing zeros, no "-0". */
export function num(n: number, digits = 3) {
  if (!Number.isFinite(n)) return '0';
  const f = Number(n.toFixed(digits));
  return String(Object.is(f, -0) ? 0 : f);
}
