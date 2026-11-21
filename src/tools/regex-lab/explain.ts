// Regex tokenizer / parser that produces a readable explanation tree.
// Pure TypeScript, no dependencies. Follows ECMAScript syntax, including
// the Annex B leniencies of non-unicode mode and the basics of `v` mode.

export type TokKind =
  | 'group' | 'look' | 'quant' | 'class' | 'escape' | 'anchor'
  | 'alt' | 'backref' | 'lit' | 'any' | 'err';

export interface Tok { s: number; e: number; k: TokKind }

export interface RNode {
  kind: string;
  s: number;
  e: number;
  label: string;
  desc: string;
  /** Short token text shown in the tree (defaults to the source slice). */
  chip?: string;
  children?: RNode[];
  warn?: string;
  /** For literal chars, the matched value. */
  value?: string;
  cp?: number;
  min?: number;
  max?: number;
}

export interface GroupInfo { index: number; name?: string; s: number; e: number }

export interface ExplainResult {
  root: RNode | null;
  groups: GroupInfo[];
  tokens: Tok[];
  error?: { message: string; s: number; e: number };
  warnings: string[];
}

class ParseError extends Error {
  constructor(message: string, public s: number, public e: number) {
    super(message);
  }
}

const INF = Infinity;

const PROPS: Record<string, string> = {
  L: 'letter', Letter: 'letter', Lu: 'uppercase letter', Uppercase_Letter: 'uppercase letter',
  Ll: 'lowercase letter', Lowercase_Letter: 'lowercase letter', Lt: 'titlecase letter',
  Lm: 'modifier letter', Lo: 'other letter (e.g. CJK, Arabic)', M: 'combining mark (accent)', Mark: 'combining mark (accent)',
  Mn: 'non-spacing mark', N: 'number', Number: 'number', Nd: 'decimal digit (any script)',
  Decimal_Number: 'decimal digit (any script)', Nl: 'letter number (e.g. Roman numerals)', No: 'other number (e.g. ½, ²)',
  P: 'punctuation', Punctuation: 'punctuation', Pd: 'dash', Ps: 'opening bracket', Pe: 'closing bracket',
  S: 'symbol', Symbol: 'symbol', Sc: 'currency symbol', Sm: 'math symbol', Sk: 'modifier symbol', So: 'other symbol',
  Z: 'separator', Separator: 'separator', Zs: 'space separator', C: 'control or other invisible character', Cc: 'control character',
  Emoji: 'emoji (including digits and #, which have emoji forms)', Emoji_Presentation: 'emoji shown as a picture by default',
  Extended_Pictographic: 'pictographic symbol (emoji and similar)', Alphabetic: 'alphabetic character',
  White_Space: 'whitespace character', ASCII: 'ASCII character (U+0000 to U+007F)', Any: 'code point (any character)',
  Uppercase: 'uppercase character', Lowercase: 'lowercase character', ASCII_Hex_Digit: 'hexadecimal digit (0-9, A-F)',
  RGI_Emoji: 'complete emoji (including multi-code-point sequences)',
};

export function charName(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  const named: Record<number, string> = {
    0x20: 'a space', 0x09: 'a tab', 0x0a: 'a line feed (newline, \\n)', 0x0d: 'a carriage return (\\r)',
    0x0b: 'a vertical tab', 0x0c: 'a form feed', 0x00: 'the NUL character', 0x08: 'a backspace', 0xa0: 'a non-breaking space',
  };
  if (named[cp]) return named[cp];
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return `control character U+${hex(cp)}`;
  return `"${ch}"`;
}

function hex(cp: number) {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

function quoteText(s: string) {
  if (s === ' ') return 'a space';
  if (s.length === 1) return charName(s);
  const shown = s.replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
  return `"${shown}"`;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function explain(src: string, flags: string): ExplainResult {
  return new Parser(src, flags).run();
}

class Parser {
  i = 0;
  tokens: Tok[] = [];
  groups: GroupInfo[] = [];
  warnings: string[] = [];
  groupCount = 0;
  totalGroups = 0;
  names = new Set<string>();
  uni: boolean;
  v: boolean;
  ic: boolean;
  ml: boolean;
  dotAll: boolean;

  constructor(public src: string, flags: string) {
    this.v = flags.includes('v');
    this.uni = flags.includes('u') || this.v;
    this.ic = flags.includes('i');
    this.ml = flags.includes('m');
    this.dotAll = flags.includes('s');
    this.precount();
  }

  run(): ExplainResult {
    try {
      const d = this.disj();
      if (this.peek() === ')') this.fail('Unmatched ")": there is no "(" before it for it to close.', this.i);
      const children = this.toChildren(d);
      const root: RNode = {
        kind: 'root', s: 0, e: this.src.length, label: 'Pattern',
        desc: this.src.length ? this.rootDesc() : 'Empty pattern: matches an empty string at the first possible position.',
        children,
      };
      return { root, groups: this.groups, tokens: this.tokens, warnings: this.warnings };
    } catch (e) {
      if (e instanceof ParseError) {
        this.tokens.push({ s: e.s, e: Math.max(e.e, e.s + 1), k: 'err' });
        return {
          root: null, groups: this.groups, tokens: this.tokens, warnings: this.warnings,
          error: { message: e.message, s: e.s, e: Math.max(e.e, e.s + 1) },
        };
      }
      throw e;
    }
  }

  rootDesc() {
    const bits: string[] = [];
    if (this.groupCount) bits.push(plural(this.groupCount, 'capturing group'));
    return bits.length ? `The whole regular expression (${bits.join(', ')}).` : 'The whole regular expression.';
  }

  // ---------- helpers ----------
  peek(o = 0) { return this.src[this.i + o]; }
  eof() { return this.i >= this.src.length; }
  tok(s: number, e: number, k: TokKind) { if (e > s) this.tokens.push({ s, e, k }); }
  fail(msg: string, s = this.i, e = s + 1): never { throw new ParseError(msg, s, e); }
  raw(s: number, e: number) { return this.src.slice(s, e); }

  precount() {
    const src = this.src;
    let depth = 0;
    for (let j = 0; j < src.length; j++) {
      const c = src[j];
      if (c === '\\') { j++; continue; }
      if (depth > 0) {
        if (c === ']') depth--;
        else if (c === '[' && this.v) depth++;
        continue;
      }
      if (c === '[') { depth = 1; continue; }
      if (c !== '(') continue;
      if (src[j + 1] !== '?') { this.totalGroups++; continue; }
      if (src[j + 2] === '<' && src[j + 3] !== '=' && src[j + 3] !== '!') {
        this.totalGroups++;
        const m = /^[^>]*/.exec(src.slice(j + 3));
        if (m) this.names.add(m[0]);
      }
    }
  }

  readCodePoint(): { ch: string; cp: number } {
    const cp = this.uni ? this.src.codePointAt(this.i)! : this.src.charCodeAt(this.i);
    const ch = String.fromCodePoint(cp);
    this.i += cp > 0xffff ? 2 : 1;
    return { ch, cp };
  }

  // ---------- grammar ----------
  disj(): RNode[][] {
    const alts: RNode[][] = [this.alternative()];
    const starts: number[] = [];
    while (this.peek() === '|') {
      starts.push(this.i);
      this.tok(this.i, this.i + 1, 'alt');
      this.i++;
      alts.push(this.alternative());
    }
    return alts;
  }

  toChildren(alts: RNode[][]): RNode[] {
    if (alts.length === 1) return alts[0];
    const all = alts.flat();
    const s = all.length ? Math.min(...all.map((n) => n.s)) : this.i;
    const e = all.length ? Math.max(...all.map((n) => n.e)) : this.i;
    return [{
      kind: 'alternation', s, e, chip: '|',
      label: `Alternation (${alts.length} options)`,
      desc: `Matches one of ${alts.length} alternatives. They are tried from left to right and the first one that lets the rest of the pattern match wins.`,
      children: alts.map((terms, k) => {
        const as = terms.length ? terms[0].s : s;
        const ae = terms.length ? terms[terms.length - 1].e : as;
        return {
          kind: 'alternative', s: as, e: ae, chip: terms.length ? undefined : '(empty)',
          label: `Option ${k + 1}`,
          desc: terms.length ? '' : 'Empty alternative: matches an empty string, so this whole alternation can match nothing.',
          children: terms,
        };
      }),
    }];
  }

  alternative(): RNode[] {
    const terms: RNode[] = [];
    while (!this.eof() && this.peek() !== '|' && this.peek() !== ')') {
      terms.push(this.term());
    }
    return this.mergeLiterals(terms);
  }

  mergeLiterals(terms: RNode[]): RNode[] {
    const out: RNode[] = [];
    let run: RNode[] = [];
    const flush = () => {
      if (!run.length) return;
      if (run.length === 1) {
        out.push(run[0]);
      } else {
        const text = run.map((n) => n.value).join('');
        out.push({
          kind: 'literal', s: run[0].s, e: run[run.length - 1].e, value: text,
          label: 'Literal text',
          desc: `Matches the text ${quoteText(text)} exactly${this.ic ? ', ignoring case' : ''}.`,
        });
      }
      run = [];
    };
    for (const t of terms) {
      if (t.kind === 'char') run.push(t);
      else { flush(); out.push(t); }
    }
    flush();
    return out;
  }

  term(): RNode {
    const atom = this.atom();
    return this.quant(atom);
  }

  isQuantStart(): RegExpExecArray | null {
    return /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.src.slice(this.i));
  }

  charNode(s: number, ch: string, cp: number, how?: string): RNode {
    return {
      kind: 'char', s, e: this.i, value: ch, cp,
      label: how ?? 'Character',
      desc: `Matches ${charName(ch)}${this.ic && /\p{L}/u.test(ch) ? ' (either case)' : ''}.`,
    };
  }

  atom(): RNode {
    const s = this.i;
    const c = this.peek();
    switch (c) {
      case '^':
        this.i++;
        this.tok(s, this.i, 'anchor');
        return {
          kind: 'anchor', s, e: this.i, label: this.ml ? 'Start of line' : 'Start of input',
          desc: this.ml
            ? 'Asserts the position is at the start of the text or right after a line break (multiline flag m is on). Consumes no characters.'
            : 'Asserts the position is at the very start of the text. Consumes no characters. (Turn on the m flag to make it match at every line start.)',
        };
      case '$':
        this.i++;
        this.tok(s, this.i, 'anchor');
        return {
          kind: 'anchor', s, e: this.i, label: this.ml ? 'End of line' : 'End of input',
          desc: this.ml
            ? 'Asserts the position is at the end of the text or right before a line break (multiline flag m is on).'
            : 'Asserts the position is at the very end of the text. (Turn on the m flag to make it match at every line end.)',
        };
      case '.':
        this.i++;
        this.tok(s, this.i, 'any');
        return {
          kind: 'any', s, e: this.i, label: 'Any character',
          desc: this.dotAll
            ? 'Matches any single character, including line breaks (dotAll flag s is on).'
            : 'Matches any single character except line breaks (\\n, \\r, U+2028, U+2029). Turn on the s flag to include them.',
        };
      case '(':
        return this.group();
      case '[':
        return this.cls();
      case '\\':
        return this.escape(false);
      case '*': case '+': case '?':
        this.fail(`Nothing to repeat: the quantifier "${c}" must come right after something it can repeat, such as a character or a group.`);
      case '{':
        if (this.isQuantStart()) this.fail('Nothing to repeat: the quantifier "{…}" must come right after something it can repeat.');
        if (this.uni) this.fail('A lone "{" is not allowed with the u or v flag. Escape it as \\{ to match a literal brace.');
        break;
      case '}': case ']':
        if (this.uni) this.fail(`A lone "${c}" is not allowed with the u or v flag. Escape it as \\${c} to match it literally.`);
        break;
    }
    const { ch, cp } = this.readCodePoint();
    this.tok(s, this.i, 'lit');
    return this.charNode(s, ch, cp);
  }

  quant(atom: RNode): RNode {
    const s = this.i;
    const c = this.peek();
    let min: number, max: number;
    if (c === '*') { min = 0; max = INF; this.i++; }
    else if (c === '+') { min = 1; max = INF; this.i++; }
    else if (c === '?') { min = 0; max = 1; this.i++; }
    else if (c === '{') {
      const m = this.isQuantStart();
      if (!m) {
        if (this.uni) this.fail('Incomplete quantifier: "{" must be written as {n}, {n,} or {n,m}. Escape it as \\{ to match a literal brace.');
        return atom;
      }
      min = Number(m[1]);
      max = m[2] ? (m[3] === '' ? INF : Number(m[3])) : min;
      this.i += m[0].length;
      if (max < min) this.fail(`Numbers out of order in the {} quantifier: the minimum (${min}) is larger than the maximum (${max}).`, s, this.i);
    } else {
      return atom;
    }
    let lazy = false;
    if (this.peek() === '?') { lazy = true; this.i++; }
    const notRepeatable = atom.kind === 'anchor' || atom.kind === 'lookbehind' || (atom.kind === 'lookahead' && this.uni);
    if (notRepeatable) this.fail(`Nothing to repeat: ${atom.label.toLowerCase()} matches a position, not characters, so it cannot be repeated.`, s, this.i);
    this.tok(s, this.i, 'quant');

    let times: string;
    let label: string;
    if (min === 0 && max === INF) { times = 'zero or more times'; label = 'Zero or more'; }
    else if (min === 1 && max === INF) { times = 'one or more times'; label = 'One or more'; }
    else if (min === 0 && max === 1) { times = 'zero or one time (makes it optional)'; label = 'Optional'; }
    else if (min === max) { times = `exactly ${plural(min, 'time')}`; label = `Exactly ${min}`; }
    else if (max === INF) { times = `${min} or more times`; label = `${min} or more`; }
    else { times = `between ${min} and ${max} times`; label = `${min} to ${max}`; }

    let mode = '';
    if (min !== max) {
      mode = lazy
        ? ' Lazy: it takes as few repetitions as possible and only adds more if the rest of the pattern fails.'
        : ' Greedy: it takes as many repetitions as possible and gives some back if the rest of the pattern needs them.';
      label += lazy ? ' (lazy)' : ' (greedy)';
    } else if (lazy) {
      mode = ' (The trailing ? has no effect on a fixed count.)';
    }
    const node: RNode = {
      kind: 'quant', s: atom.s, e: this.i, chip: this.raw(s, this.i), min, max,
      label, desc: `Repeats the item below ${times}.${mode}`, children: [atom],
    };
    if (max === INF && this.hasUnbounded(atom)) {
      node.warn = 'Nested unbounded quantifiers: when the inner part can match the same text in many different ways, a failing match can take exponential time (catastrophic backtracking).';
      this.warnings.push(`Nested quantifier at position ${s}: "${this.raw(atom.s, this.i)}" may cause catastrophic backtracking.`);
    }
    return node;
  }

  hasUnbounded(n: RNode): boolean {
    if (!n.children) return false;
    return n.children.some((c) => (c.kind === 'quant' && c.max === INF && c.min !== c.max) || this.hasUnbounded(c));
  }

  group(): RNode {
    const s = this.i;
    this.i++;
    let kind = 'group';
    let label = '';
    let desc = '';
    let tk: TokKind = 'group';
    let info: GroupInfo | null = null;
    if (this.peek() === '?') {
      const n1 = this.peek(1);
      const n2 = this.peek(2);
      if (n1 === ':') {
        this.i += 2;
        kind = 'noncap';
        label = 'Non-capturing group';
        desc = 'Groups the enclosed pattern (for alternation or quantifiers) without saving what it matched.';
      } else if (n1 === '=' || n1 === '!') {
        this.i += 2;
        kind = 'lookahead';
        tk = 'look';
        label = n1 === '=' ? 'Positive lookahead' : 'Negative lookahead';
        desc = n1 === '='
          ? 'Asserts that what comes next matches the enclosed pattern, without consuming any characters.'
          : 'Asserts that what comes next does NOT match the enclosed pattern, without consuming any characters.';
      } else if (n1 === '<' && (n2 === '=' || n2 === '!')) {
        this.i += 3;
        kind = 'lookbehind';
        tk = 'look';
        label = n2 === '=' ? 'Positive lookbehind' : 'Negative lookbehind';
        desc = n2 === '='
          ? 'Asserts that the text just before this position matches the enclosed pattern, without consuming any characters.'
          : 'Asserts that the text just before this position does NOT match the enclosed pattern, without consuming any characters.';
      } else if (n1 === '<') {
        const m = /^<([^>]*)>/.exec(this.src.slice(this.i + 1));
        if (!m) this.fail('Invalid capture group name: a named group is written (?<name>…) and the closing ">" is missing.', s, this.i + 2);
        const name = m[1];
        if (!/^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u.test(name)) {
          this.fail(`Invalid capture group name "${name}": names must start with a letter, $ or _ and contain only letters, digits, $ or _.`, s, this.i + 1 + m[0].length);
        }
        this.i += 1 + m[0].length;
        kind = 'named';
        const index = ++this.groupCount;
        info = { index, name, s, e: s };
        label = `Named group "${name}" (#${index})`;
        desc = `Captures the text matched by the enclosed pattern as group ${index}, also available by name as "${name}" (use $<${name}> in a replacement or \\k<${name}> to match it again).`;
      } else {
        const m = /^\?([ims]*)(?:-([ims]*))?:/.exec(this.src.slice(this.i));
        if (!m || (!m[1] && m[2] === undefined)) {
          this.fail('Invalid group: after "(?" the engine expects ":" (non-capturing), "=" or "!" (lookahead), "<=" or "<!" (lookbehind), or "<name>" (named group).', s, this.i + 2);
        }
        this.i += m[0].length;
        kind = 'modifiers';
        const names: Record<string, string> = { i: 'ignore case', m: 'multiline anchors', s: 'dot matches line breaks' };
        const on = [...m[1]].map((f) => names[f]);
        const off = [...(m[2] ?? '')].map((f) => names[f]);
        label = 'Modifier group';
        desc = `Changes flags only inside this group${on.length ? `: turns on ${on.join(', ')}` : ''}${off.length ? `${on.length ? ';' : ':'} turns off ${off.join(', ')}` : ''}.`;
      }
    } else {
      kind = 'capture';
      const index = ++this.groupCount;
      info = { index, s, e: s };
      label = `Capturing group #${index}`;
      desc = `Captures the text matched by the enclosed pattern as group ${index} (use $${index} in a replacement or \\${index} to match it again).`;
    }
    const openEnd = this.i;
    this.tok(s, openEnd, tk);
    if (info) this.groups.push(info);
    const d = this.disj();
    if (this.peek() !== ')') this.fail('Unterminated group: this "(" is never closed with a matching ")".', s, openEnd);
    this.tok(this.i, this.i + 1, tk);
    this.i++;
    if (info) info.e = this.i;
    const children = this.toChildren(d);
    if (!children.length) desc += ' It is empty, so it always matches an empty string.';
    const open = this.raw(s, openEnd);
    return { kind, s, e: this.i, chip: `${open}…)`, label, desc, children };
  }

  // ---------- character classes ----------
  cls(): RNode {
    const s = this.i;
    this.i++;
    let negate = false;
    if (this.peek() === '^') { negate = true; this.i++; }
    this.tok(s, this.i, 'class');
    const items = this.v ? this.classItemsV() : this.classItems();
    if (this.peek() !== ']') this.fail('Unterminated character class: this "[" is never closed with a matching "]".', s, s + 1);
    this.tok(this.i, this.i + 1, 'class');
    this.i++;
    let label = negate ? 'Negated character class' : 'Character class';
    let desc = negate
      ? 'Matches any single character that is NOT one of the following:'
      : 'Matches any single character that is one of the following:';
    if (!items.length) {
      desc = negate ? 'Matches any single character at all, including line breaks.' : 'An empty set: never matches anything.';
      label = negate ? 'Any character' : 'Empty class';
    }
    if (this.ic && items.length) desc = desc.replace(/:$/, ' (ignoring case):');
    return { kind: 'class', s, e: this.i, chip: this.raw(s, this.i), label, desc, children: this.mergeClassChars(items) };
  }

  mergeClassChars(items: RNode[]): RNode[] {
    const out: RNode[] = [];
    let run: RNode[] = [];
    const flush = () => {
      if (run.length === 1) out.push(run[0]);
      else if (run.length) {
        const list = run.map((r) => charName(r.value!)).join(', ');
        out.push({ kind: 'chars', s: run[0].s, e: run[run.length - 1].e, label: 'Characters', desc: `Any of: ${list}.` });
      }
      run = [];
    };
    for (const it of items) {
      if (it.kind === 'char') run.push(it);
      else { flush(); out.push(it); }
    }
    flush();
    return out;
  }

  classAtom(): RNode {
    const s = this.i;
    if (this.peek() === '\\') return this.escape(true);
    const { ch, cp } = this.readCodePoint();
    this.tok(s, this.i, 'class');
    return this.charNode(s, ch, cp);
  }

  rangeOrAtom(): RNode {
    const a = this.classAtom();
    if (this.peek() === '-' && this.peek(1) !== undefined && this.peek(1) !== ']') {
      const save = this.i;
      if (this.v && this.peek(1) === '-') return a; // "--" subtraction operator
      this.tok(this.i, this.i + 1, 'class');
      this.i++;
      const b = this.classAtom();
      if (a.cp === undefined || b.cp === undefined || a.kind !== 'char' || b.kind !== 'char') {
        if (this.uni) this.fail('Invalid character class: a range like a-z cannot start or end with a class escape such as \\d or \\w.', a.s, b.e);
        this.i = save; // Annex B: treat as literal "-" between the two
        return a;
      }
      if (a.cp > b.cp) this.fail(`Range out of order in character class: "${a.value}" comes after "${b.value}" in Unicode, so ${this.raw(a.s, b.e)} is empty. Swap the two ends.`, a.s, b.e);
      return {
        kind: 'range', s: a.s, e: b.e, label: 'Range',
        desc: `Any character from ${charName(a.value!)} to ${charName(b.value!)} (U+${hex(a.cp)} to U+${hex(b.cp)}).`,
      };
    }
    return a;
  }

  classItems(): RNode[] {
    const items: RNode[] = [];
    while (!this.eof() && this.peek() !== ']') items.push(this.rangeOrAtom());
    return items;
  }

  classItemsV(): RNode[] {
    const items: RNode[] = [];
    while (!this.eof() && this.peek() !== ']') {
      const s = this.i;
      if (this.src.startsWith('&&', this.i)) {
        this.i += 2;
        this.tok(s, this.i, 'quant');
        items.push({ kind: 'op', s, e: this.i, label: 'Intersection', desc: 'Keeps only characters that are in both the part before and the part after.' });
      } else if (this.src.startsWith('--', this.i)) {
        this.i += 2;
        this.tok(s, this.i, 'quant');
        items.push({ kind: 'op', s, e: this.i, label: 'Subtraction', desc: 'Removes the characters of the part after from the part before.' });
      } else if (this.peek() === '[') {
        items.push(this.cls());
      } else if (this.src.startsWith('\\q{', this.i)) {
        const end = this.src.indexOf('}', this.i);
        if (end < 0) this.fail('Unterminated \\q{…} string literal.', s, s + 3);
        const strs = this.src.slice(this.i + 3, end).split('|');
        this.i = end + 1;
        this.tok(s, this.i, 'escape');
        items.push({ kind: 'strings', s, e: this.i, label: 'String alternatives', desc: `Matches one of the strings: ${strs.map(quoteText).join(', ')}.` });
      } else {
        items.push(this.rangeOrAtom());
      }
    }
    return items;
  }

  // ---------- escapes ----------
  escape(inClass: boolean): RNode {
    const s = this.i;
    this.i++;
    if (this.eof()) this.fail('The pattern ends with a lone backslash "\\". Write \\\\ to match a literal backslash.', s);
    const c = this.src[this.i];
    this.i++;
    const done = (k: TokKind, node: Omit<RNode, 's' | 'e'>): RNode => {
      this.tok(s, this.i, k);
      return { s, e: this.i, ...node };
    };
    const lit = (ch: string, label = 'Escaped character') => {
      this.tok(s, this.i, inClass ? 'escape' : 'escape');
      const cp = ch.codePointAt(0)!;
      return { ...this.charNode(s, ch, cp, label), s, e: this.i };
    };
    const sets: Record<string, [string, string]> = {
      d: ['Digit', 'Matches any digit 0-9.'],
      D: ['Non-digit', 'Matches any character that is not a digit 0-9.'],
      w: ['Word character', 'Matches a letter, digit or underscore: [A-Za-z0-9_].'],
      W: ['Non-word character', 'Matches any character that is not a letter, digit or underscore.'],
      s: ['Whitespace', 'Matches a whitespace character: space, tab, line breaks and other Unicode spaces.'],
      S: ['Non-whitespace', 'Matches any character that is not whitespace.'],
    };
    if (sets[c]) return done('escape', { kind: 'set', label: sets[c][0], desc: sets[c][1] });
    switch (c) {
      case 'b':
        if (inClass) return lit('\b', 'Backspace');
        return done('anchor', { kind: 'anchor', label: 'Word boundary', desc: 'Asserts a position between a word character (\\w) and a non-word character, or at the start/end of the text next to a word character.' });
      case 'B':
        if (inClass) {
          if (this.uni) this.fail('Invalid escape "\\B" inside a character class.', s, this.i);
          return lit('B');
        }
        return done('anchor', { kind: 'anchor', label: 'Not a word boundary', desc: 'Asserts a position that is NOT a word boundary (both sides are word characters, or both are not).' });
      case 't': return lit('\t', 'Tab');
      case 'n': return lit('\n', 'Line feed');
      case 'r': return lit('\r', 'Carriage return');
      case 'v': return lit('\v', 'Vertical tab');
      case 'f': return lit('\f', 'Form feed');
      case '0':
        if (!/[0-9]/.test(this.peek() ?? '')) return lit('\0', 'NUL character');
        if (this.uni) this.fail('Invalid decimal escape: \\0 cannot be followed by another digit with the u or v flag.', s, this.i + 1);
        return this.octal(s);
      case 'c': {
        const n = this.peek();
        if (n && /[A-Za-z]/.test(n)) {
          this.i++;
          const code = n.toUpperCase().charCodeAt(0) % 32;
          return lit(String.fromCharCode(code), `Control character Ctrl+${n.toUpperCase()}`);
        }
        if (this.uni) this.fail('Invalid escape: \\c must be followed by a letter A-Z.', s, this.i);
        this.i = s + 1; // Annex B: the backslash is literal
        return lit('\\', 'Backslash');
      }
      case 'x': {
        const m = /^[0-9a-fA-F]{2}/.exec(this.src.slice(this.i));
        if (m) {
          this.i += 2;
          const cp = parseInt(m[0], 16);
          return lit(String.fromCharCode(cp), `Hex escape U+${hex(cp)}`);
        }
        if (this.uni) this.fail('Invalid escape: \\x must be followed by exactly two hex digits, like \\x41.', s, this.i);
        return lit('x');
      }
      case 'u': {
        if (this.uni && this.peek() === '{') {
          const m = /^\{([0-9a-fA-F]+)\}/.exec(this.src.slice(this.i));
          const cp = m ? parseInt(m[1], 16) : NaN;
          if (!m || cp > 0x10ffff) this.fail('Invalid Unicode escape: write \\u{…} with 1 to 6 hex digits up to 10FFFF.', s, this.i + 1);
          this.i += m[0].length;
          return lit(String.fromCodePoint(cp), `Unicode escape U+${hex(cp)}`);
        }
        const m = /^[0-9a-fA-F]{4}/.exec(this.src.slice(this.i));
        if (m) {
          this.i += 4;
          let cp = parseInt(m[0], 16);
          if (this.uni && cp >= 0xd800 && cp <= 0xdbff) {
            const m2 = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(this.src.slice(this.i));
            if (m2) {
              this.i += 6;
              cp = 0x10000 + ((cp - 0xd800) << 10) + (parseInt(m2[1], 16) - 0xdc00);
            }
          }
          return lit(String.fromCodePoint(cp), `Unicode escape U+${hex(cp)}`);
        }
        if (this.uni) this.fail('Invalid Unicode escape: \\u must be followed by 4 hex digits (\\u00e9) or, with the u flag, \\u{…}.', s, this.i);
        return lit('u');
      }
      case 'p': case 'P': {
        if (!this.uni) return lit(c);
        const m = /^\{([^}]*)\}/.exec(this.src.slice(this.i));
        if (!m) this.fail(`Invalid property escape: write \\${c}{Name}, for example \\${c}{L} for letters.`, s, this.i);
        this.i += m[0].length;
        const body = m[1];
        const neg = c === 'P';
        let what: string;
        const eq = body.indexOf('=');
        if (eq >= 0) {
          const key = body.slice(0, eq);
          const val = body.slice(eq + 1).replace(/_/g, ' ');
          if (/^(Script|sc)$/.test(key)) what = `a character from the ${val} script`;
          else if (/^(Script_Extensions|scx)$/.test(key)) what = `a character used in the ${val} script`;
          else if (/^(General_Category|gc)$/.test(key)) what = `a ${PROPS[body.slice(eq + 1)] ?? val}`;
          else what = `a character with ${key} = ${val}`;
        } else {
          what = PROPS[body] ? `a ${PROPS[body]}` : `a character with the Unicode property ${body}`;
        }
        return done('escape', {
          kind: 'set', label: `Unicode property ${neg ? '(negated)' : ''}`.trim(),
          desc: neg ? `Matches any character that is NOT ${what}.` : `Matches ${what}.`,
        });
      }
      case 'k': {
        if (!inClass && (this.uni || this.names.size)) {
          const m = /^<([^>]*)>/.exec(this.src.slice(this.i));
          if (!m) this.fail('Invalid named reference: write \\k<name>.', s, this.i);
          this.i += m[0].length;
          if (!this.names.has(m[1])) this.fail(`Invalid named reference: there is no group named "${m[1]}".`, s, this.i);
          return done('backref', {
            kind: 'backref', label: `Backreference to "${m[1]}"`,
            desc: `Matches the exact same text that the group named "${m[1]}" captured earlier in this match.`,
          });
        }
        if (this.uni) this.fail('Invalid escape "\\k".', s, this.i);
        return lit('k');
      }
    }
    if (c >= '1' && c <= '9') {
      if (!inClass) {
        const m = /^\d*/.exec(this.src.slice(this.i))!;
        const n = Number(c + m[0]);
        if (n <= this.totalGroups) {
          this.i += m[0].length;
          return done('backref', {
            kind: 'backref', label: `Backreference to #${n}`,
            desc: `Matches the exact same text that group ${n} captured earlier in this match.`,
          });
        }
      }
      if (this.uni) this.fail(`Invalid escape: \\${c} refers to a group that does not exist (the pattern has ${plural(this.totalGroups, 'capturing group')}).`, s, this.i);
      if (c <= '7') return this.octal(s);
      return lit(c);
    }
    if (this.uni) {
      const syntax = /[\^$\\.*+?()[\]{}|/]/.test(c);
      const okInClass = inClass && (c === '-' || (this.v && /[&\-!#%,:;<=>@`~]/.test(c)));
      if (!syntax && !okInClass) {
        this.fail(`Invalid escape "\\${c}": with the u or v flag only special characters can be escaped. Remove the backslash to match "${c}".`, s, this.i);
      }
    }
    this.i = s + 1;
    const { ch } = this.readCodePoint();
    this.tok(s, this.i, 'escape');
    return { ...this.charNode(s, ch, ch.codePointAt(0)!, 'Escaped character'), s, e: this.i };
  }

  octal(s: number): RNode {
    // Annex B legacy octal escape (up to 3 digits, value <= 0o377)
    this.i = s + 1;
    const m = /^[0-3][0-7]{0,2}|^[4-7][0-7]?/.exec(this.src.slice(this.i))!;
    this.i += m[0].length;
    const cp = parseInt(m[0], 8);
    this.tok(s, this.i, 'escape');
    return { ...this.charNode(s, String.fromCharCode(cp), cp, `Legacy octal escape U+${hex(cp)}`), s, e: this.i };
  }
}

// ---------- rendering ----------

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function shorten(s: string, n = 42) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const KIND_CLASS: Record<string, string> = {
  capture: 'group', named: 'group', noncap: 'group', modifiers: 'group',
  lookahead: 'look', lookbehind: 'look', quant: 'quant', class: 'class', range: 'class', chars: 'class',
  set: 'escape', anchor: 'anchor', backref: 'backref', alternation: 'alt', alternative: 'alt',
  any: 'any', char: 'lit', literal: 'lit', root: 'root', op: 'quant', strings: 'escape',
};

/** Render an explanation tree as nested lists. */
export function renderTree(node: RNode, src: string): string {
  const chip = node.chip ?? src.slice(node.s, node.e);
  const k = KIND_CLASS[node.kind] ?? 'lit';
  const kids = node.children?.length
    ? `<ul class="rl-tree" role="group">${node.children.map((c) => renderTree(c, src)).join('')}</ul>`
    : '';
  const isRoot = node.kind === 'root';
  return `<li class="rl-tree-item" role="treeitem" aria-expanded="${kids ? 'true' : 'false'}">
    <div class="rl-tree-node" data-s="${node.s}" data-e="${node.e}">
      ${isRoot ? '' : `<code class="rl-chip rl-k-${k}">${esc(shorten(chip)) || '&nbsp;'}</code>`}
      <span class="rl-tree-text"><span class="rl-tree-label">${esc(node.label)}</span>${node.desc ? ` <span class="rl-tree-desc">${esc(node.desc)}</span>` : ''}${node.warn ? `<span class="rl-tree-warn">⚠ ${esc(node.warn)}</span>` : ''}</span>
    </div>${kids}</li>`;
}

/** Render the pattern with syntax colors for the editor overlay. */
export function renderTokens(src: string, tokens: Tok[]): string {
  const kinds: (TokKind | null)[] = new Array(src.length).fill(null);
  let errAt: [number, number] | null = null;
  for (const t of tokens) {
    if (t.k === 'err') { errAt = [t.s, Math.min(t.e, src.length)]; continue; }
    for (let j = t.s; j < t.e && j < src.length; j++) kinds[j] = t.k;
  }
  let out = '';
  let j = 0;
  while (j < src.length) {
    const k = kinds[j];
    const inErr = errAt && j >= errAt[0] && j < errAt[1];
    let e = j + 1;
    while (e < src.length && kinds[e] === k && !!(errAt && e >= errAt[0] && e < errAt[1]) === !!inErr) e++;
    const text = esc(src.slice(j, e));
    const cls = [k ? `rl-k-${k}` : '', inErr ? 'rl-k-errpos' : ''].filter(Boolean).join(' ');
    out += cls ? `<span class="${cls}">${text}</span>` : text;
    j = e;
  }
  if (errAt && errAt[0] >= src.length) out += '<span class="rl-k-errpos rl-k-errend"> </span>';
  return out;
}
