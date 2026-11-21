// Lenient, JSON5-like parser used by "Fix it". Accepts comments (// /* */ #), trailing and
// missing commas, 'single' and `backtick` quotes, unquoted keys, hex / +1 / .5 / 5. numbers,
// NaN / Infinity / undefined (become null), Python True / False / None, raw line breaks in
// strings and unclosed brackets at the end of the input. Returns plain data + a list of fixes.
import { lineCol } from './jsonError';

export class RepairError extends Error {
  constructor(message: string, public pos: number, public line: number, public col: number) {
    super(message);
  }
}

export interface RepairResult {
  value: unknown;
  fixes: string[];
}

/** Assign a property safely (a "__proto__" key must become an own property, as JSON.parse does). */
export function setProp(obj: Record<string, unknown>, key: string, value: unknown) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

const LABELS: Record<string, [string, string]> = {
  comments: ['comment removed', 'comments removed'],
  trailing: ['trailing comma removed', 'trailing commas removed'],
  quotes: ['string re-quoted', 'strings re-quoted'],
  keys: ['key quoted', 'keys quoted'],
  special: ['NaN/Infinity/undefined → null', 'NaN/Infinity/undefined → null'],
  python: ['Python literal converted', 'Python literals converted'],
  missing: ['missing comma added', 'missing commas added'],
  unclosed: ['unclosed bracket closed', 'unclosed brackets closed'],
  numbers: ['number normalized', 'numbers normalized'],
  breaks: ['line break in string escaped', 'line breaks in strings escaped'],
  escapes: ['invalid escape fixed', 'invalid escapes fixed'],
};

export function repairJson(text: string): RepairResult {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  const err = (message: string, pos = i): never => {
    const { line, col } = lineCol(text, pos);
    throw new RepairError(`${message} (line ${line}, column ${col})`, pos, line, col);
  };

  const skip = () => {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\u00a0' || c === '\ufeff' || c === '\u2028' || c === '\u2029') {
        i++;
      } else if (c === '/' && text[i + 1] === '/') {
        bump('comments');
        while (i < n && text[i] !== '\n') i++;
      } else if (c === '#') {
        bump('comments');
        while (i < n && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        bump('comments');
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
      } else break;
    }
  };

  const parseString = (): string => {
    const q = text[i];
    if (q !== '"') bump('quotes');
    const start = i;
    i++;
    let out = '';
    let chunk = i;
    while (i < n) {
      const c = text[i];
      if (c === q) {
        out += text.slice(chunk, i);
        i++;
        return out;
      }
      if (c === '\\') {
        out += text.slice(chunk, i);
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'v': out += '\v'; break;
          case '0': out += '\0'; break;
          case '"': case "'": case '`': case '\\': case '/': out += e; break;
          case '\n': break; // line continuation
          case '\r': if (text[i] === '\n') i++; break;
          case 'u': {
            if (text[i] === '{') {
              const end = text.indexOf('}', i);
              const cp = parseInt(text.slice(i + 1, end), 16);
              if (end === -1 || !Number.isFinite(cp)) err('Invalid \\u{...} escape', i - 2);
              out += String.fromCodePoint(cp);
              i = end + 1;
            } else {
              const hex = text.slice(i, i + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) err('Invalid \\u escape', i - 2);
              out += String.fromCharCode(parseInt(hex, 16));
              i += 4;
            }
            break;
          }
          case 'x': {
            const hex = text.slice(i, i + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) err('Invalid \\x escape', i - 2);
            out += String.fromCharCode(parseInt(hex, 16));
            i += 2;
            break;
          }
          case undefined: err('Unterminated string', start); break;
          default:
            bump('escapes');
            out += '\\' + e; // keep the backslash literally (e.g. C:\Users)
        }
        chunk = i;
        continue;
      }
      if (c === '\n' || c === '\r') bump('breaks');
      i++;
    }
    return err('Unterminated string', start);
  };

  const NUM = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)/;
  const STRICT_NUM = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  const parseNumber = (): number | null => {
    const m = NUM.exec(text.slice(i, i + 400));
    if (!m) return err(`Unexpected character '${text[i]}'`);
    const s = m[0];
    i += s.length;
    if (/Infinity|NaN/.test(s)) {
      bump('special');
      return null;
    }
    let body = s.replace(/^\+/, '');
    const neg = body.startsWith('-');
    if (neg) body = body.slice(1);
    const v = /^0[xX]/.test(body) ? parseInt(body, 16) : Number(body);
    if (!STRICT_NUM.test(s)) bump('numbers');
    return neg ? -v : v;
  };

  const WORD = /^[A-Za-z_$\u00c0-\uffff][\w$\u00c0-\uffff-]*/;

  const parseValue = (depth: number): unknown => {
    if (depth > 5000) err('Nesting is too deep');
    skip();
    if (i >= n) return err('Unexpected end of input, expected a value');
    const c = text[i];
    if (c === '{') return parseObject(depth);
    if (c === '[') return parseArray(depth);
    if (c === '"' || c === "'" || c === '`') return parseString();
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return parseNumber();
    const m = WORD.exec(text.slice(i, i + 200));
    if (m) {
      const w = m[0];
      const lit: Record<string, [unknown, string | null]> = {
        true: [true, null], false: [false, null], null: [null, null],
        True: [true, 'python'], False: [false, 'python'], None: [null, 'python'],
        undefined: [null, 'special'], NaN: [null, 'special'], Infinity: [null, 'special'],
      };
      if (w in lit) {
        i += w.length;
        const [v, k] = lit[w];
        if (k) bump(k);
        return v;
      }
      return err(`Unexpected word '${w}' (text values need quotes)`);
    }
    return err(`Unexpected character '${c}'`);
  };

  const startsValue = (c: string | undefined) => !!c && (/["'`{\[\d+.-]/.test(c) || WORD.test(c));

  function parseObject(depth: number) {
    i++;
    const obj: Record<string, unknown> = {};
    let afterComma = false;
    let first = true;
    for (;;) {
      skip();
      if (i >= n) {
        bump('unclosed');
        return obj;
      }
      const c = text[i];
      if (c === '}') {
        if (afterComma) bump('trailing');
        i++;
        return obj;
      }
      if (c === ',') {
        bump('trailing');
        i++;
        continue;
      }
      if (!first && !afterComma) bump('missing');
      let key: string;
      if (c === '"' || c === "'" || c === '`') key = parseString();
      else {
        const m = /^[^\s:,{}\[\]"'`\/#]+/.exec(text.slice(i, i + 500));
        if (!m) return err(`Expected a property name but found '${c}'`);
        key = m[0];
        i += key.length;
        bump('keys');
      }
      skip();
      if (text[i] === ':' || text[i] === '=') i++;
      else return err(`Expected ':' after property name "${key}"`);
      setProp(obj, key, parseValue(depth + 1));
      first = false;
      skip();
      if (text[i] === ',') {
        i++;
        afterComma = true;
      } else {
        afterComma = false;
        if (i < n && text[i] !== '}' && !startsValue(text[i])) return err(`Expected ',' or '}' but found '${text[i]}'`);
      }
    }
  }

  function parseArray(depth: number) {
    i++;
    const arr: unknown[] = [];
    let afterComma = false;
    for (;;) {
      skip();
      if (i >= n) {
        bump('unclosed');
        return arr;
      }
      const c = text[i];
      if (c === ']') {
        if (afterComma) bump('trailing');
        i++;
        return arr;
      }
      if (c === ',') {
        bump('trailing');
        i++;
        continue;
      }
      if (arr.length && !afterComma) bump('missing');
      arr.push(parseValue(depth + 1));
      skip();
      if (text[i] === ',') {
        i++;
        afterComma = true;
      } else {
        afterComma = false;
        if (i < n && text[i] !== ']' && !startsValue(text[i])) return err(`Expected ',' or ']' but found '${text[i]}'`);
      }
    }
  }

  skip();
  if (i >= n) err('Nothing to repair: the input is empty');
  const value = parseValue(0);
  skip();
  while (text[i] === ';') {
    i++;
    skip();
  }
  if (i < n) err(`Unexpected '${text[i]}' after the end of the value`);

  const fixes = Object.entries(counts).map(([k, c]) => {
    const [one, many] = LABELS[k];
    return k === 'special' ? `${c} × ${one}` : `${c} ${c === 1 ? one : many}`;
  });
  return { value, fixes };
}
