// Precise JSON error locator. JSON.parse tells us *that* the text is invalid; this strict
// scanner (run only on failure) tells us *where* and *why*, with a friendly hint for the
// usual suspects: trailing commas, single quotes, unquoted keys, comments, NaN/Infinity.

export interface JsonErrorInfo {
  pos: number;
  line: number;
  col: number;
  message: string;
  hint?: string;
  kind: string;
}

export function lineCol(text: string, pos: number) {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) {
    line++;
    last = i;
  }
  return { line, col: pos - last };
}

class Fail {
  constructor(public pos: number, public message: string, public kind: string, public hint?: string) {}
}

const HINTS = {
  trailingComma: 'JSON does not allow a comma after the last item. Remove it, or click Fix it.',
  singleQuote: 'JSON strings and keys need "double quotes". Fix it converts \'single quotes\' for you.',
  comment: 'JSON has no comments. Remove the // or /* */ comment, or click Fix it to strip them.',
  nan: 'NaN, Infinity and undefined are JavaScript, not JSON. Use null (Fix it does this) or a string.',
  python: 'Looks like Python. JSON uses lowercase true, false and null.',
  missingComma: 'Looks like a comma is missing between two items.',
};

function describe(text: string, pos: number) {
  if (pos >= text.length) return 'the end of the input';
  const c = text[pos];
  if (c === '\n') return 'a line break';
  if (c === '\t') return 'a tab';
  if (c === ' ') return 'a space';
  return `'${c}'`;
}

const isIdentStart = (c: string | undefined) => !!c && /[A-Za-z_$]/.test(c);

export function locateJsonError(text: string): JsonErrorInfo | null {
  const n = text.length;
  let i = 0;
  const stack: { ch: string; pos: number }[] = [];

  const fail = (pos: number, message: string, kind: string, hint?: string): never => {
    throw new Fail(pos, message, kind, hint);
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++;
      else break;
    }
  };
  const readWord = (from: number) => {
    const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(from, from + 64));
    return m ? m[0] : '';
  };
  const openedAt = (o: { ch: string; pos: number }) => {
    const lc = lineCol(text, o.pos);
    return `the '${o.ch}' opened at line ${lc.line}, column ${lc.col}`;
  };
  const unexpectedEnd = (): never => {
    const top = stack[stack.length - 1];
    fail(n, 'Unexpected end of input', 'eof', top ? `${cap(openedAt(top))} is never closed.` : undefined);
    throw 0;
  };
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

  // Diagnose a character where a value was expected.
  const badValue = (where: string): never => {
    if (i >= n) unexpectedEnd();
    const c = text[i];
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) fail(i, 'Comments are not allowed in JSON', 'comment', HINTS.comment);
    if (c === "'") fail(i, 'Strings must use double quotes, not single quotes', 'single-quote', HINTS.singleQuote);
    if (c === '+') fail(i, "Numbers cannot start with '+'", 'number', 'Remove the plus sign.');
    if (c === '.' && /\d/.test(text[i + 1] ?? '')) fail(i, 'Numbers need a digit before the decimal point', 'number', 'Write 0.5 instead of .5.');
    if (isIdentStart(c)) {
      const w = readWord(i);
      if (w === 'NaN' || w === 'Infinity' || w === 'undefined') fail(i, `${w} is not valid JSON`, 'nan', HINTS.nan);
      if (w === 'True' || w === 'False' || w === 'None') fail(i, `${w} is not valid JSON`, 'python', HINTS.python);
      fail(i, `Unexpected word '${w}'`, 'word', `Text values must be wrapped in double quotes, like "${w}".`);
    }
    fail(i, `Expected ${where} but found ${describe(text, i)}`, 'unexpected');
    throw 0;
  };

  const parseString = () => {
    const start = i;
    i++;
    for (;;) {
      if (i >= n) fail(start, 'Unterminated string', 'unterminated', 'This string never gets its closing double quote.');
      const c = text.charCodeAt(i);
      if (c === 34) {
        i++;
        return;
      }
      if (c === 92) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail(i, 'Invalid \\u escape: expected 4 hex digits', 'escape');
          i += 6;
          continue;
        }
        if (e !== undefined && '"\\/bfnrt'.includes(e)) {
          i += 2;
          continue;
        }
        fail(i, `Invalid escape sequence '\\${e ?? ''}'`, 'escape', 'Backslashes must be doubled (\\\\), which is common in Windows paths.');
      }
      if (c < 0x20) {
        if (c === 10 || c === 13) fail(i, 'Unescaped line break inside a string', 'control', 'Use \\n for line breaks inside strings, or check for a missing closing quote.');
        fail(i, 'Unescaped control character inside a string', 'control', 'Control characters such as tabs must be escaped (\\t).');
      }
      i++;
    }
  };

  const digits = () => {
    const s = i;
    while (i < n && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
    return i - s;
  };

  const parseNumber = () => {
    const start = i;
    if (text[i] === '-') {
      i++;
      if (isIdentStart(text[i])) {
        const w = readWord(i);
        if (w === 'Infinity') fail(start, '-Infinity is not valid JSON', 'nan', HINTS.nan);
      }
    }
    if (text[i] === '0') {
      i++;
      if (text[i] === 'x' || text[i] === 'X') fail(start, 'Hexadecimal numbers are not allowed in JSON', 'number', 'Write the number in decimal.');
      if (/\d/.test(text[i] ?? '')) fail(start, 'Numbers cannot have leading zeros', 'number', 'Remove the leading zero, or quote the value if it is an ID like "007".');
    } else if (!digits()) {
      fail(i, `Expected a digit but found ${describe(text, i)}`, 'number');
    }
    if (text[i] === '.') {
      i++;
      if (!digits()) fail(i, 'Expected a digit after the decimal point', 'number', 'Write 1.0 or 1 instead of 1.');
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!digits()) fail(i, 'Expected a digit in the exponent', 'number');
    }
  };

  const parseValue = (where = 'a value'): void => {
    ws();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    if (c === 't' || c === 'f' || c === 'n') {
      const w = readWord(i);
      if (w === 'true' || w === 'false' || w === 'null') {
        i += w.length;
        return;
      }
    }
    badValue(where);
  };

  const closer = (open: { ch: string; pos: number }, expect: string, after: string) => {
    const want = open.ch === '{' ? '}' : ']';
    if (i >= n) unexpectedEnd();
    const c = text[i];
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) fail(i, 'Comments are not allowed in JSON', 'comment', HINTS.comment);
    if ((c === '}' || c === ']') && c !== want)
      fail(i, `Expected ${expect} but found '${c}'`, 'mismatch', `Bracket mismatch: ${openedAt(open)} is closed with '${c}'.`);
    if (c === '"' || c === '{' || c === '[' || c === "'" || /[\d-]/.test(c) || isIdentStart(c))
      fail(i, `Expected ${expect} ${after}`, 'missing-comma', HINTS.missingComma);
    fail(i, `Expected ${expect} ${after} but found ${describe(text, i)}`, 'unexpected');
  };

  function parseObject() {
    const open = { ch: '{', pos: i };
    stack.push(open);
    i++;
    ws();
    if (text[i] === '}') {
      i++;
      stack.pop();
      return;
    }
    let commaPos = -1;
    for (;;) {
      ws();
      const c = text[i];
      if (c !== '"') {
        if (c === '}' && commaPos >= 0) fail(commaPos, "Trailing comma before '}'", 'trailing-comma', HINTS.trailingComma);
        if (c === "'") fail(i, 'Property names must use double quotes, not single quotes', 'single-quote', HINTS.singleQuote);
        if (isIdentStart(c) || /\d/.test(c ?? '')) {
          const w = readWord(i) || /^\w+/.exec(text.slice(i, i + 64))?.[0] || c;
          fail(i, `Property name '${w}' must be in double quotes`, 'unquoted-key', `Write "${w}" instead of ${w}. Fix it quotes keys for you.`);
        }
        if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) fail(i, 'Comments are not allowed in JSON', 'comment', HINTS.comment);
        if (c === ',') fail(i, 'Unexpected extra comma', 'extra-comma', 'Two commas in a row, or a comma right after {.');
        if (i >= n) unexpectedEnd();
        fail(i, `Expected a property name in double quotes but found ${describe(text, i)}`, 'unexpected');
      }
      parseString();
      ws();
      if (text[i] !== ':') {
        if (i >= n) unexpectedEnd();
        fail(i, `Expected ':' after the property name but found ${describe(text, i)}`, 'colon', text[i] === '=' ? 'JSON uses a colon, not =.' : undefined);
      }
      i++;
      parseValue('a value after the colon');
      ws();
      if (text[i] === ',') {
        commaPos = i;
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        stack.pop();
        return;
      }
      closer(open, "',' or '}'", 'after the property value');
    }
  }

  function parseArray() {
    const open = { ch: '[', pos: i };
    stack.push(open);
    i++;
    ws();
    if (text[i] === ']') {
      i++;
      stack.pop();
      return;
    }
    let commaPos = -1;
    for (;;) {
      ws();
      if (text[i] === ']' && commaPos >= 0) fail(commaPos, "Trailing comma before ']'", 'trailing-comma', HINTS.trailingComma);
      if (text[i] === ',') fail(i, 'Unexpected extra comma', 'extra-comma', 'Two commas in a row, or a comma right after [. Empty slots are not allowed.');
      parseValue();
      ws();
      if (text[i] === ',') {
        commaPos = i;
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        stack.pop();
        return;
      }
      closer(open, "',' or ']'", 'after the array item');
    }
  }

  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    ws();
    if (i >= n) return { pos: 0, line: 1, col: 1, message: 'Input is empty', kind: 'empty' };
    parseValue();
    ws();
    if (i < n) {
      const c = text[i];
      let hint = 'Only one top-level value is allowed. To hold several, wrap them in [ ] separated by commas.';
      if (c === '}' || c === ']') hint = `There is an extra closing '${c}'.`;
      if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) hint = HINTS.comment;
      fail(i, `Unexpected ${describe(text, i)} after the end of the JSON value`, 'extra', hint);
    }
    return null;
  } catch (e) {
    if (e instanceof Fail) {
      const { line, col } = lineCol(text, e.pos);
      return { pos: e.pos, line, col, message: e.message, hint: e.hint, kind: e.kind };
    }
    return null; // e.g. RangeError on absurd nesting: caller falls back to the native message
  }
}

/** Parse with the native parser; on failure, explain the error precisely. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: JsonErrorInfo } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const info = locateJsonError(text);
    if (info) return { ok: false, error: info };
    const msg = String((err as Error)?.message ?? err);
    const m = /position (\d+)/.exec(msg);
    const pos = m ? Math.min(Number(m[1]), text.length) : 0;
    const { line, col } = lineCol(text, pos);
    return { ok: false, error: { pos, line, col, message: msg, kind: 'native' } };
  }
}
