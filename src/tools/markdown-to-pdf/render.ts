// Markdown -> sanitized DOM. marked (GFM) + DOMPurify, highlight.js, KaTeX, mermaid placeholders,
// heading anchors, table of contents, page breaks, and privacy-safe image handling.
import { Marked, Renderer, type Tokens, type TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';

type Hljs = typeof import('highlight.js').default;
type Katex = typeof import('katex').default;

let hljs: Hljs | null = null;
let katex: Katex | null = null;
let hljsP: Promise<void> | null = null;
let katexP: Promise<void> | null = null;

const MATH_HINT = /\$|```\s*(math|latex|katex)\b/i;
const CODE_HINT = /(```|~~~)\s*[\w+#-]+/;

/** Lazily load the libraries a document actually needs. */
export async function ensureLibs(md: string) {
  const tasks: Promise<void>[] = [];
  if (!hljs && CODE_HINT.test(md)) {
    hljsP ??= import('highlight.js/lib/common').then((m) => {
      hljs = m.default;
    });
    tasks.push(hljsP);
  }
  if (!katex && MATH_HINT.test(md)) {
    katexP ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => {
      katex = m.default;
    });
    tasks.push(katexP);
  }
  await Promise.all(tasks);
}

export const hasMermaid = (md: string) => /^ {0,3}(```|~~~)\s*mermaid\b/im.test(md);

export function escapeAttr(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function slugify(text: string) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-') || 'section'
  );
}

// ---------- per-render state ----------
interface Ctx {
  slugs: Map<string, number>;
  mermaid: string[];
}
let ctx: Ctx = { slugs: new Map(), mermaid: [] };

function uniqueSlug(text: string) {
  const base = slugify(text);
  const n = ctx.slugs.get(base) ?? 0;
  ctx.slugs.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

// ---------- marked extensions ----------
const PAGEBREAK_RE = /^ {0,3}(?:<!--\s*page-?break\s*-->|\\pagebreak|\\newpage)[ \t]*(?:\n+|$)/i;
const TOC_RE = /^ {0,3}\[\[?toc\]?\][ \t]*(?:\n+|$)/i;

const pagebreak: TokenizerAndRendererExtension = {
  name: 'pagebreak',
  level: 'block',
  start(src) {
    return src.match(/^ {0,3}(?:<!--\s*page-?break|\\pagebreak|\\newpage)/im)?.index;
  },
  tokenizer(src) {
    const m = PAGEBREAK_RE.exec(src);
    if (m) return { type: 'pagebreak', raw: m[0] };
  },
  renderer() {
    return '<div class="mdp-pagebreak" role="separator" aria-label="Page break"></div>\n';
  },
};

const toc: TokenizerAndRendererExtension = {
  name: 'toc',
  level: 'block',
  start(src) {
    return src.match(/^ {0,3}\[\[?toc\]?\]/im)?.index;
  },
  tokenizer(src) {
    const m = TOC_RE.exec(src);
    if (m) return { type: 'toc', raw: m[0] };
  },
  renderer() {
    return '<div class="mdp-toc-slot" data-toc="1"></div>\n';
  },
};

const mathBlock: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src) {
    return src.match(/^ {0,3}\$\$/m)?.index;
  },
  tokenizer(src) {
    const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
  },
  renderer(t) {
    return `<div class="mdp-math-block" data-tex="${escapeAttr(t.text)}"></div>\n`;
  },
};

const mathInline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start(src) {
    const i = src.indexOf('$');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    let m = /^\$\$(?!\$)([\s\S]+?)\$\$/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
    // $...$ : no space just inside the dollars and no digit right after the closing one ($5 and $10 stay text).
    m = /^\$(?![\s$])((?:\\[\s\S]|[^\\$\n])+?)(?<![\s\\])\$(?!\d)/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: false };
  },
  renderer(t) {
    return `<span class="mdp-math" data-tex="${escapeAttr(t.text)}"${t.display ? ' data-display="1"' : ''}></span>`;
  },
};

// ---------- renderer overrides ----------
const renderer = {
  heading(this: Renderer, { tokens, depth }: Tokens.Heading) {
    const inner = this.parser.parseInline(tokens);
    const plain = inner.replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, ' ');
    const slug = uniqueSlug(plain);
    return `<h${depth} data-slug="${escapeAttr(slug)}">${inner}<a class="mdp-anchor" data-anchor="${escapeAttr(slug)}" aria-label="Link to this section">#</a></h${depth}>\n`;
  },
  code(this: Renderer, { text, lang }: Tokens.Code) {
    const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
    if (language === 'mermaid') {
      const i = ctx.mermaid.push(text) - 1;
      return `<div class="mdp-mermaid" data-mermaid="${i}"><div class="mdp-diagram-status">Rendering diagram…</div></div>\n`;
    }
    if (language === 'math' || language === 'latex' || language === 'katex') {
      return `<div class="mdp-math-block" data-tex="${escapeAttr(text)}"></div>\n`;
    }
    let body = escapeAttr(text);
    if (hljs && language && hljs.getLanguage(language)) {
      try {
        body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      } catch {
        /* keep plain */
      }
    }
    const label = language && language !== 'text' && language !== 'plaintext' ? ` data-lang="${escapeAttr(language)}"` : '';
    return `<pre class="mdp-code"${label}><code class="hljs${language ? ` language-${escapeAttr(language)}` : ''}">${body}</code></pre>\n`;
  },
  table(this: Renderer, token: Tokens.Table) {
    return `<div class="mdp-table">${Renderer.prototype.table.call(this, token)}</div>\n`;
  },
};

const marked = new Marked({ gfm: true, breaks: false });
marked.use({ extensions: [pagebreak, toc, mathBlock, mathInline], renderer: renderer as any });

// ---------- sanitizer ----------
const purify = DOMPurify(window);
export type ImageKind = 'ok' | 'remote' | 'relative' | 'invalid' | 'missing';

export function classifyImage(src: string | null): ImageKind {
  if (!src) return 'missing';
  const s = src.trim();
  if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return 'ok';
  if (/^data:/i.test(s)) return 'invalid';
  let u: URL;
  try {
    u = new URL(s, location.href);
  } catch {
    return 'invalid';
  }
  if (u.origin === location.origin) return s.startsWith('/') || /^https?:/i.test(s) ? 'ok' : 'relative';
  if (u.protocol === 'http:' || u.protocol === 'https:') return 'remote';
  return 'invalid';
}

// Neutralize images before the fragment is adopted into the live document (where they would start loading).
purify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;
  if (el.nodeName === 'IMG') {
    const src = el.getAttribute('src');
    const kind = classifyImage(src);
    if (kind !== 'ok') {
      el.removeAttribute('src');
      el.setAttribute('data-blocked', kind);
      if (src) el.setAttribute('data-blocked-src', src.slice(0, 300));
    }
  } else if (el.nodeName.toLowerCase() === 'image') {
    for (const a of ['href', 'xlink:href']) {
      const v = el.getAttribute(a);
      if (v && classifyImage(v) !== 'ok') el.removeAttribute(a);
    }
  }
  if (el.nodeName === 'A' && el.getAttribute('href')?.match(/^(https?:|mailto:|\/\/)/i)) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
});

const PURIFY_CFG = {
  FORBID_TAGS: ['style', 'form', 'video', 'audio', 'source', 'picture', 'track', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
  FORBID_ATTR: ['srcset', 'poster', 'background', 'formaction'],
  ADD_ATTR: ['target'],
  RETURN_DOM_FRAGMENT: true as const,
};

const IMG_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/><path d="M3 3l18 18"/></svg>';

function imagePlaceholder(img: HTMLImageElement): HTMLElement {
  const kind = img.dataset.blocked as ImageKind;
  const src = img.dataset.blockedSrc || '';
  const alt = img.getAttribute('alt') || 'Image';
  let reason: string;
  if (kind === 'remote') {
    let host = src;
    try {
      host = new URL(src, location.href).host;
    } catch {}
    reason = `Remote image from ${host} not loaded: this page's Content-Security-Policy blocks other sites for privacy. Save the image and drop it into the editor to embed it.`;
  } else if (kind === 'relative') {
    reason = `“${src}” is a path on your computer, which a web page cannot read. Drop the image file into the editor to embed it.`;
  } else if (kind === 'missing') {
    reason = 'This image has no source URL.';
  } else {
    reason = 'Unsupported image URL.';
  }
  const box = document.createElement('span');
  box.className = 'mdp-img-blocked';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `${alt} (image not loaded)`);
  box.innerHTML = IMG_ICON;
  const text = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = alt;
  const small = document.createElement('small');
  small.textContent = reason;
  text.append(strong, small);
  box.append(text);
  return box;
}

// ---------- front matter ----------
export function splitFrontMatter(md: string): { body: string; title: string | null } {
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(md);
  if (!m) return { body: md, title: null };
  const t = /^title:\s*(.+)$/m.exec(m[1]);
  const title = t ? t[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null;
  // keep line numbers stable for scroll sync
  return { body: '\n'.repeat((m[0].match(/\n/g) || []).length) + md.slice(m[0].length), title };
}

// ---------- TOC ----------
export interface Heading {
  depth: number;
  text: string;
  id: string;
}

function buildToc(headings: Heading[]): HTMLElement | null {
  const h1s = headings.filter((h) => h.depth === 1).length;
  const minDepth = h1s === 1 && headings.length > 1 ? 2 : 1;
  const items = headings.filter((h) => h.depth >= minDepth && h.depth <= minDepth + 2);
  if (!items.length) return null;
  const nav = document.createElement('nav');
  nav.className = 'mdp-toc';
  nav.setAttribute('aria-label', 'Table of contents');
  const title = document.createElement('p');
  title.className = 'mdp-toc-title';
  title.textContent = 'Contents';
  nav.append(title);
  const root = document.createElement('ol');
  nav.append(root);
  const stack: { depth: number; list: HTMLOListElement }[] = [{ depth: minDepth, list: root }];
  for (const h of items) {
    while (stack.length > 1 && h.depth < stack[stack.length - 1].depth) stack.pop();
    let top = stack[stack.length - 1];
    if (h.depth > top.depth) {
      const parentLi = top.list.lastElementChild ?? top.list.appendChild(document.createElement('li'));
      const ol = document.createElement('ol');
      parentLi.append(ol);
      top = { depth: h.depth, list: ol };
      stack.push(top);
    }
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.text;
    li.append(a);
    top.list.append(li);
  }
  return nav;
}

// ---------- main entry ----------
export interface RenderOutput {
  fragment: DocumentFragment;
  mermaid: string[];
  headings: Heading[];
  title: string | null;
}

export function renderMarkdown(source: string, opts: { toc: boolean }): RenderOutput {
  ctx = { slugs: new Map(), mermaid: [] };
  const { body, title: fmTitle } = splitFrontMatter(source.replace(/\r\n?/g, '\n'));

  // Parse top-level blocks one by one so each can carry its source line (for scroll sync).
  const tokens = marked.lexer(body);
  let line = 0;
  let html = '';
  for (const t of tokens) {
    let part = marked.parser([t] as any);
    if (t.type !== 'space' && t.type !== 'html' && t.type !== 'def') {
      part = part.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 data-line="${line}"`);
    }
    html += part;
    line += (t.raw.match(/\n/g) || []).length;
  }

  const fragment = purify.sanitize(html, PURIFY_CFG) as DocumentFragment;

  // Headings: real ids + anchor links (ids set after sanitizing so names like "images" survive).
  const headings: Heading[] = [];
  fragment.querySelectorAll<HTMLElement>('h1[data-slug],h2[data-slug],h3[data-slug],h4[data-slug],h5[data-slug],h6[data-slug]').forEach((h) => {
    const id = h.dataset.slug!;
    h.id = id;
    h.removeAttribute('data-slug');
    const a = h.querySelector<HTMLAnchorElement>('a.mdp-anchor[data-anchor]');
    if (a) {
      a.href = `#${id}`;
      a.removeAttribute('data-anchor');
    }
    const clone = h.cloneNode(true) as HTMLElement;
    clone.querySelector('.mdp-anchor')?.remove();
    headings.push({ depth: Number(h.tagName[1]), text: (clone.textContent || '').trim(), id });
  });

  // Math
  fragment.querySelectorAll<HTMLElement>('[data-tex]').forEach((el) => {
    const tex = el.dataset.tex || '';
    const display = el.classList.contains('mdp-math-block') || el.dataset.display === '1';
    el.removeAttribute('data-tex');
    el.removeAttribute('data-display');
    if (!katex) {
      el.textContent = display ? `$$${tex}$$` : `$${tex}$`;
      return;
    }
    try {
      el.innerHTML = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: false, trust: false, output: 'htmlAndMathml' });
    } catch (e) {
      el.textContent = tex;
      el.classList.add('mdp-math-error');
      el.title = (e as Error).message;
    }
  });

  // Images that could not be loaded
  fragment.querySelectorAll<HTMLImageElement>('img[data-blocked]').forEach((img) => img.replaceWith(imagePlaceholder(img)));
  fragment.querySelectorAll('img').forEach((img) => {
    img.setAttribute('decoding', 'async');
  });

  // Table of contents
  const slots = fragment.querySelectorAll('.mdp-toc-slot');
  if (slots.length) {
    slots.forEach((slot) => {
      const nav = buildToc(headings);
      if (nav) {
        const dl = (slot as HTMLElement).dataset.line;
        if (dl) nav.dataset.line = dl;
        slot.replaceWith(nav);
      } else slot.remove();
    });
  } else if (opts.toc) {
    const nav = buildToc(headings);
    if (nav) {
      const first = fragment.firstElementChild;
      if (first?.tagName === 'H1') first.after(nav);
      else fragment.prepend(nav);
    }
  }

  const firstH1 = headings.find((h) => h.depth === 1)?.text || null;
  return { fragment, mermaid: ctx.mermaid, headings, title: fmTitle || firstH1 };
}
