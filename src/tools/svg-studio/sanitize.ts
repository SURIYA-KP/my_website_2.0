// Parse untrusted SVG text into a safe SVG DOM. Browser-only (DOMParser).

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';

export interface ParseResult {
  root: SVGSVGElement;
  warnings: string[];
}

export class SvgParseError extends Error {
  line?: number;
  column?: number;
  constructor(message: string, line?: number, column?: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

/** HTML named entities AI output often contains but XML does not know. */
const ENTITIES: Record<string, string> = {
  nbsp: '#160', copy: '#169', reg: '#174', trade: '#8482', mdash: '#8212', ndash: '#8211', hellip: '#8230',
  laquo: '#171', raquo: '#187', ldquo: '#8220', rdquo: '#8221', lsquo: '#8216', rsquo: '#8217', bull: '#8226',
  middot: '#183', deg: '#176', times: '#215', divide: '#247', euro: '#8364', pound: '#163', yen: '#165',
  rarr: '#8594', larr: '#8592', uarr: '#8593', darr: '#8595', harr: '#8596', check: '#10003', hearts: '#9829',
  plusmn: '#177', micro: '#181', para: '#182', sect: '#167', frac12: '#189', frac14: '#188', frac34: '#190',
};

function fixEntities(s: string) {
  return s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
    if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return m;
    return ENTITIES[name] ? `&${ENTITIES[name]};` : m;
  });
}

function parseErrorInfo(doc: Document): SvgParseError | null {
  const err = doc.querySelector('parsererror');
  if (!err) return null;
  const text = (err.textContent || 'Invalid XML').replace(/\s+/g, ' ').trim();
  const m = /line\s+(\d+)(?:\D+column\s+(\d+))?/i.exec(text);
  const msg = text.replace(/^This page contains the following errors:\s*/i, '').replace(/Below is a rendering.*$/i, '').trim();
  return new SvgParseError(msg || 'Invalid XML', m ? Number(m[1]) : undefined, m?.[2] ? Number(m[2]) : undefined);
}

/**
 * Parse strictly as XML (used by the code editor, so mistakes are reported with a line).
 * With `lenient`, fall back to the HTML parser, which accepts what browsers render inline
 * (unquoted attributes, stray `&`, missing xmlns) and re-serializes it as XML.
 */
export function parseSvg(text: string, { lenient = false } = {}): ParseResult {
  let src = text.trim().replace(/^﻿/, '');
  // Drop XML prolog / doctype (entities in DOCTYPE could be abused; we do not need them).
  src = src.replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '').trim();
  src = fixEntities(src);
  const fixups: string[] = [];
  if (/^<svg[\s>]/i.test(src) && !/^<svg[^>]*\sxmlns\s*=/i.test(src)) {
    src = src.replace(/^<svg/i, `<svg xmlns="${SVG_NS}"`);
  }
  if (/\sxlink:/.test(src) && !/xmlns:xlink\s*=/.test(src)) {
    src = src.replace(/^<svg/i, `<svg xmlns:xlink="${XLINK_NS}"`);
  }
  let doc = new DOMParser().parseFromString(src, 'image/svg+xml');
  let err = parseErrorInfo(doc);
  if (err && lenient) {
    const html = new DOMParser().parseFromString(`<!doctype html><body>${src}</body>`, 'text/html');
    const svg = html.querySelector('svg');
    if (svg) {
      if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', SVG_NS);
      const xml = new XMLSerializer().serializeToString(svg);
      doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
      err = parseErrorInfo(doc);
      if (!err) fixups.push('The SVG had XML errors; it was repaired the way a browser would read it.');
    }
  }
  if (err) throw err;
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
    throw new SvgParseError('The root element must be <svg xmlns="http://www.w3.org/2000/svg">.');
  }
  const warnings = [...fixups, ...sanitize(root as unknown as SVGSVGElement)];
  return { root: root as unknown as SVGSVGElement, warnings };
}

const BANNED = new Set(['script', 'iframe', 'embed', 'object', 'applet', 'frame', 'frameset', 'base', 'link', 'meta', 'audio', 'video', 'portal']);
const EXTERNAL_URL = /^\s*(https?:)?\/\//i;
const JS_URL = /^\s*(javascript|vbscript|data:text\/html)/i;
const CSS_EXTERNAL_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\)/gi;

/** Remove anything that could run code or load from another origin. Returns user-facing warnings. */
export function sanitize(root: Element): string[] {
  const notes = new Map<string, number>();
  const note = (k: string) => notes.set(k, (notes.get(k) || 0) + 1);
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    if (!el.isConnected && el !== root && !root.contains(el)) continue;
    const name = el.localName.toLowerCase();
    if (BANNED.has(name)) {
      note(name === 'script' ? 'script' : 'embed');
      el.remove();
      continue;
    }
    // <animate attributeName="href" to="javascript:..."> and <set> tricks.
    if (/^(animate|set|animatemotion|animatetransform)$/.test(name)) {
      const attr = (el.getAttribute('attributeName') || '').toLowerCase();
      const vals = ['to', 'from', 'values', 'by'].map((a) => el.getAttribute(a) || '').join(' ');
      if (/href$/.test(attr) || /^on/.test(attr) || JS_URL.test(vals) || /javascript:/i.test(vals)) {
        note('script');
        el.remove();
        continue;
      }
    }
    for (const a of Array.from(el.attributes)) {
      const an = a.name.toLowerCase();
      const v = a.value;
      if (an.startsWith('on')) {
        el.removeAttributeNode(a);
        note('handler');
      } else if (an === 'href' || an.endsWith(':href') || an === 'src' || an === 'action' || an === 'formaction') {
        if (JS_URL.test(v) || /javascript:/i.test(v.replace(/[\s\u0000-\u001f]/g, ''))) {
          el.removeAttributeNode(a);
          note('jsurl');
        } else if (EXTERNAL_URL.test(v) && name !== 'a') {
          el.removeAttributeNode(a);
          note(name === 'image' ? 'image' : 'external');
          if (name === 'image' || name === 'use') el.remove();
        }
      } else if (an === 'style') {
        if (CSS_EXTERNAL_URL.test(v) || /expression\s*\(|javascript:/i.test(v)) {
          el.setAttribute('style', v.replace(CSS_EXTERNAL_URL, 'none').replace(/expression\s*\(|javascript:/gi, ''));
          note('css');
        }
        CSS_EXTERNAL_URL.lastIndex = 0;
      } else if (/(fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end|cursor)$/.test(an) && EXTERNAL_URL.test(v.replace(/^url\(\s*['"]?/i, ''))) {
        el.removeAttributeNode(a);
        note('external');
      }
    }
    if (name === 'style') {
      const css = el.textContent || '';
      let clean = css.replace(/@import[^;]*;?/gi, () => {
        note('font');
        return '';
      });
      clean = clean.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
        if (/url\(\s*['"]?\s*(https?:)?\/\//i.test(block)) {
          note('font');
          return '';
        }
        return block;
      });
      clean = clean.replace(CSS_EXTERNAL_URL, () => {
        note('css');
        return 'none';
      });
      clean = clean.replace(/expression\s*\(|javascript:/gi, '');
      if (clean !== css) el.textContent = clean;
    }
    if (name === 'foreignobject') {
      // HTML inside foreignObject: strip handlers/scripts the loop above may not reach by name.
      el.querySelectorAll('*').forEach((c) => {
        if (BANNED.has(c.localName.toLowerCase())) c.remove();
      });
    }
  }
  const msgs: Record<string, string> = {
    script: 'Removed <script> code (scripts never run here).',
    handler: 'Removed event handler attributes (onclick, onload…).',
    jsurl: 'Removed javascript: links.',
    embed: 'Removed embedded iframes/objects.',
    image: 'Removed external images (http links cannot load here; embed them as data: URLs instead).',
    external: 'Removed references to external files.',
    font: 'Removed external fonts (@import / web fonts); text uses a fallback font.',
    css: 'Removed external url() references from CSS.',
  };
  return Array.from(notes.keys()).map((k) => (notes.get(k)! > 1 ? `${msgs[k]} (${notes.get(k)}×)` : msgs[k]));
}
