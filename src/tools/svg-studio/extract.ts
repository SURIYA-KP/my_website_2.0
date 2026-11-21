// Find SVG (or Mermaid) inside a pasted AI chat reply. Pure string functions, no DOM.
import { extractMermaidBlocks } from './repair';

export interface SvgCandidate {
  code: string;
  /** Short human label for the picker: the title/id/aria-label or the first words. */
  label: string;
  /** Approximate size info for the picker. */
  info: string;
}

export type Extraction =
  | { kind: 'svg'; candidates: SvgCandidate[] }
  | { kind: 'mermaid'; code: string }
  | { kind: 'none' };

const SVG_RE = /<svg[\s>][\s\S]*?<\/svg\s*>/gi;

interface Fence {
  lang: string;
  body: string;
}

/** All fenced code blocks (``` or ~~~), including an unterminated last one (cut-off replies). */
export function fencedBlocks(text: string): Fence[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*([\w+.-]*)[^\n]*$/.exec(lines[i]);
    if (!open) continue;
    const fence = open[1];
    const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !close.test(lines[j]); j++) body.push(lines[j]);
    out.push({ lang: open[2].toLowerCase(), body: body.join('\n') });
    i = j;
  }
  return out;
}

/** Pull every complete <svg>…</svg> out of a string, outermost only (nested <svg> stays inside). */
export function rawSvgs(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const start = lower.indexOf('<svg', i);
    if (start < 0) break;
    const after = lower[start + 4];
    if (after && !/[\s>/]/.test(after)) {
      i = start + 4;
      continue;
    }
    // Walk forward, balancing nested <svg ...> / </svg>.
    let depth = 0;
    let end = -1;
    const re = /<svg[\s>/]|<\/svg\s*>/gi;
    re.lastIndex = start;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0][1] === '/') {
        depth--;
        if (depth === 0) {
          end = m.index + m[0].length;
          break;
        }
      } else {
        // Self-closing <svg ... /> at depth 0 is a complete (empty) document.
        const tagEnd = text.indexOf('>', m.index);
        if (tagEnd > 0 && text[tagEnd - 1] === '/') {
          if (depth === 0) {
            end = tagEnd + 1;
            break;
          }
          continue;
        }
        depth++;
      }
    }
    if (end < 0) break;
    out.push(text.slice(start, end));
    i = end;
  }
  return out;
}

function decodeEntities(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export function describeSvg(code: string): SvgCandidate {
  const title = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(code)?.[1];
  const aria = /<svg[^>]*\saria-label\s*=\s*"([^"]{1,80})"/i.exec(code)?.[1];
  const id = /<svg[^>]*\sid\s*=\s*"([^"]{1,60})"/i.exec(code)?.[1];
  const vb = /<svg[^>]*\sviewBox\s*=\s*"([^"]+)"/i.exec(code)?.[1];
  const w = /<svg[^>]*\swidth\s*=\s*"([^"]+)"/i.exec(code)?.[1];
  const h = /<svg[^>]*\sheight\s*=\s*"([^"]+)"/i.exec(code)?.[1];
  const elements = (code.match(/<[a-zA-Z]/g) || []).length;
  const size = w && h ? `${w}×${h}` : vb ? `viewBox ${vb}` : 'no size';
  const firstText = /<text[^>]*>([^<]{1,40})/i.exec(code)?.[1]?.trim();
  return {
    code,
    label: (title || aria || id || (firstText ? `“${firstText}”` : 'Untitled SVG')).trim(),
    info: `${size} · ${elements} element${elements === 1 ? '' : 's'}`,
  };
}

/**
 * Look for SVG in an AI reply: ```svg / ```xml / ```html fences first (and any fence with
 * an <svg> in it), then raw <svg> markup anywhere in the text. Falls back to Mermaid.
 */
export function extractFromReply(input: string): Extraction {
  const text = input.replace(/\r\n?/g, '\n');
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const k = s.trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      found.push(k);
    }
  };
  const fences = fencedBlocks(text);
  const preferred = ['svg', 'xml', 'html', 'htm', 'xhtml', 'jsx', 'tsx', 'vue', 'markup', ''];
  for (const lang of preferred) {
    for (const f of fences) if (f.lang === lang) rawSvgs(f.body).forEach(add);
  }
  for (const f of fences) rawSvgs(f.body).forEach(add);
  // Raw SVG in prose (the chat UI rendered away the fences), or HTML-escaped markup.
  if (!found.length) rawSvgs(text).forEach(add);
  if (!found.length && /&lt;svg[\s&]/i.test(text)) rawSvgs(decodeEntities(text)).forEach(add);
  if (found.length) return { kind: 'svg', candidates: found.map(describeSvg) };

  const mer = extractMermaidBlocks(text);
  if (mer.length && mer[0].code.trim()) return { kind: 'mermaid', code: mer[0].code };
  return { kind: 'none' };
}

/** Quick check for a paste that is (or contains) SVG markup. */
export function looksLikeSvg(text: string) {
  return /<svg[\s>]/i.test(text);
}
