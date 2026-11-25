import { copyText, escapeHtml } from '../../../lib/ui';
import { $, segmented } from '../util';

// Named entities used when encoding: the HTML 4 set (Latin-1, Greek, math, arrows, typography).
// Decoding accepts every HTML5 named entity (the browser resolves them).
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
const OTHERS: [string, number][] = [
  ['quot', 34], ['amp', 38], ['lt', 60], ['gt', 62], ['OElig', 338], ['oelig', 339], ['Scaron', 352], ['scaron', 353], ['Yuml', 376],
  ['fnof', 402], ['circ', 710], ['tilde', 732], ['ensp', 8194], ['emsp', 8195], ['thinsp', 8201], ['zwnj', 8204], ['zwj', 8205],
  ['lrm', 8206], ['rlm', 8207], ['ndash', 8211], ['mdash', 8212], ['lsquo', 8216], ['rsquo', 8217], ['sbquo', 8218], ['ldquo', 8220],
  ['rdquo', 8221], ['bdquo', 8222], ['dagger', 8224], ['Dagger', 8225], ['bull', 8226], ['hellip', 8230], ['permil', 8240],
  ['prime', 8242], ['Prime', 8243], ['lsaquo', 8249], ['rsaquo', 8250], ['oline', 8254], ['frasl', 8260], ['euro', 8364],
  ['image', 8465], ['weierp', 8472], ['real', 8476], ['trade', 8482], ['alefsym', 8501], ['larr', 8592], ['uarr', 8593],
  ['rarr', 8594], ['darr', 8595], ['harr', 8596], ['crarr', 8629], ['lArr', 8656], ['uArr', 8657], ['rArr', 8658], ['dArr', 8659],
  ['hArr', 8660], ['forall', 8704], ['part', 8706], ['exist', 8707], ['empty', 8709], ['nabla', 8711], ['isin', 8712],
  ['notin', 8713], ['ni', 8715], ['prod', 8719], ['sum', 8721], ['minus', 8722], ['lowast', 8727], ['radic', 8730], ['prop', 8733],
  ['infin', 8734], ['ang', 8736], ['and', 8743], ['or', 8744], ['cap', 8745], ['cup', 8746], ['int', 8747], ['there4', 8756],
  ['sim', 8764], ['cong', 8773], ['asymp', 8776], ['ne', 8800], ['equiv', 8801], ['le', 8804], ['ge', 8805], ['sub', 8834],
  ['sup', 8835], ['nsub', 8836], ['sube', 8838], ['supe', 8839], ['oplus', 8853], ['otimes', 8855], ['perp', 8869], ['sdot', 8901],
  ['lceil', 8968], ['rceil', 8969], ['lfloor', 8970], ['rfloor', 8971], ['lang', 9001], ['rang', 9002], ['loz', 9674],
  ['spades', 9824], ['clubs', 9827], ['hearts', 9829], ['diams', 9830], ['check', 10003],
];
const GREEK_UP = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho _ Sigma Tau Upsilon Phi Chi Psi Omega';
const GREEK_LO = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega';

export const NAMED = new Map<number, string>();
LATIN1.split(' ').forEach((n, i) => NAMED.set(160 + i, n));
GREEK_UP.split(' ').forEach((n, i) => n !== '_' && NAMED.set(913 + i, n));
GREEK_LO.split(' ').forEach((n, i) => NAMED.set(945 + i, n));
NAMED.set(977, 'thetasym').set(978, 'upsih').set(982, 'piv');
for (const [n, c] of OTHERS) NAMED.set(c, n);
// lang/rang above are the HTML 4 code points; HTML5 maps &lang; to U+27E8. Use numeric for those to be unambiguous.
NAMED.delete(9001);
NAMED.delete(9002);

// Windows-1252 remapping for numeric references in the 0x80–0x9F range (per the HTML spec).
const C1: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030,
  0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

export function encodeEntities(s: string, scope: string, format: string, stats = { count: 0 }) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const special = cp === 38 || cp === 60 || cp === 62 || cp === 34 || cp === 39;
    let enc = special;
    if (scope === 'nonascii') enc = special || cp > 126;
    else if (scope === 'all') enc = !/[A-Za-z0-9 \n\r\t]/.test(ch);
    if (!enc) {
      out += ch;
      continue;
    }
    stats.count++;
    if (format === 'named' && NAMED.has(cp)) out += `&${NAMED.get(cp)};`;
    else if (format === 'hex') out += `&#x${cp.toString(16).toUpperCase()};`;
    else out += `&#${cp};`;
  }
  return out;
}

const cache = new Map<string, string | null>();
const scratch = typeof document !== 'undefined' ? document.createElement('textarea') : null;
/** Resolve a named entity via the browser's own table (safe: the name is [A-Za-z0-9]+ only). */
function named(name: string): string | null {
  if (cache.has(name)) return cache.get(name)!;
  let r: string | null = null;
  if (scratch && /^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    scratch.innerHTML = `&${name};`;
    r = scratch.value === `&${name};` ? null : scratch.value;
  }
  cache.set(name, r);
  return r;
}

export function decodeEntities(s: string) {
  let unknown = 0;
  const text = s.replace(/&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]*));?/g, (m, hex, dec, name) => {
    if (name) {
      if (!m.endsWith(';')) return m; // named references need the semicolon here
      const r = named(name);
      if (r === null) unknown++;
      return r ?? m;
    }
    let cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    if (C1[cp]) cp = C1[cp];
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || !Number.isFinite(cp)) return '�';
    return String.fromCodePoint(cp);
  });
  return { text, unknown };
}

const CHEATS: [string, string][] = [
  ['&', 'amp'], ['<', 'lt'], ['>', 'gt'], ['"', 'quot'], ["'", '#39'], [' ', 'nbsp'], ['©', 'copy'], ['®', 'reg'], ['™', 'trade'],
  ['€', 'euro'], ['£', 'pound'], ['¥', 'yen'], ['¢', 'cent'], ['§', 'sect'], ['¶', 'para'], ['°', 'deg'], ['±', 'plusmn'], ['×', 'times'],
  ['÷', 'divide'], ['≠', 'ne'], ['≤', 'le'], ['≥', 'ge'], ['∞', 'infin'], ['½', 'frac12'], ['–', 'ndash'], ['—', 'mdash'], ['…', 'hellip'],
  ['•', 'bull'], ['·', 'middot'], ['‘', 'lsquo'], ['’', 'rsquo'], ['“', 'ldquo'], ['”', 'rdquo'], ['«', 'laquo'], ['»', 'raquo'],
  ['←', 'larr'], ['→', 'rarr'], ['↑', 'uarr'], ['↓', 'darr'], ['⇒', 'rArr'], ['✓', 'check'], ['♥', 'hearts'],
];

export function init() {
  const inp = $<HTMLTextAreaElement>('#html-in');
  const out = $<HTMLTextAreaElement>('#html-out');
  const scope = $<HTMLSelectElement>('#html-scope');
  const format = $<HTMLSelectElement>('#html-format');
  const stats = $('#html-stats');
  const opts = $('#html-enc-opts');
  const run = () => {
    const s = inp.value;
    const enc = mode.get() === 'encode';
    opts.hidden = !enc;
    if (enc) {
      const st = { count: 0 };
      out.value = encodeEntities(s, scope.value, format.value, st);
      stats.textContent = s ? `${st.count.toLocaleString('en')} character${st.count === 1 ? '' : 's'} encoded` : '';
    } else {
      const r = decodeEntities(s);
      out.value = r.text;
      const n = (s.match(/&(#[xX]?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g) ?? []).length - r.unknown;
      stats.textContent = s ? `${n.toLocaleString('en')} entities decoded${r.unknown ? ` · ${r.unknown} unknown name${r.unknown === 1 ? '' : 's'} left as is` : ''}` : '';
    }
  };
  const mode = segmented($('#html-mode'), run);
  inp.addEventListener('input', run);
  scope.addEventListener('change', run);
  format.addEventListener('change', run);
  $('#html-swap').addEventListener('click', () => {
    inp.value = out.value;
    mode.set(mode.get() === 'encode' ? 'decode' : 'encode');
  });
  run();

  const grid = $('#html-cheats');
  grid.innerHTML = CHEATS.map(([ch, n]) => {
    const code = `&${n};`;
    const shown = ch === ' ' ? '␣' : ch;
    return `<button type="button" class="dt-entity" data-code="${escapeHtml(code)}" title="Copy ${escapeHtml(code)}"><span class="dt-entity-ch">${escapeHtml(shown)}</span><span class="dt-entity-code">${escapeHtml(code)}</span></button>`;
  }).join('');
  grid.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-code]');
    if (b) copyText(b.dataset.code!, `${b.dataset.code} copied`);
  });
}
