// Shared types, replacement expansion, plain-language errors and the worker runner.

export interface RunRequest {
  id: number;
  pattern: string;
  flags: string;
  text: string;
  replacement?: string;
}

export interface MatchRange {
  s: number;
  e: number;
  /** Capture group ranges (index 0 = group 1); null when the group did not participate. */
  g: ([number, number] | null)[];
}

export interface RunResponse {
  id: number;
  ok: boolean;
  matches?: MatchRange[];
  truncated?: boolean;
  result?: string;
  segs?: { t: string; r?: number }[];
  error?: string;
  ms: number;
}

/** ECMAScript GetSubstitution: expands $$, $&, $`, $', $n, $nn and $<name>. */
export function expandReplacement(rep: string, m: RegExpExecArray, str: string): string {
  let out = '';
  const n = m.length - 1;
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c !== '$' || i + 1 >= rep.length) { out += c; continue; }
    const d = rep[i + 1];
    if (d === '$') { out += '$'; i++; }
    else if (d === '&') { out += m[0]; i++; }
    else if (d === '`') { out += str.slice(0, m.index); i++; }
    else if (d === "'") { out += str.slice(m.index + m[0].length); i++; }
    else if (d >= '0' && d <= '9') {
      const d2 = rep[i + 2];
      if (d2 !== undefined && d2 >= '0' && d2 <= '9') {
        const nn = Number(d + d2);
        if (nn >= 1 && nn <= n) { out += m[nn] ?? ''; i += 2; continue; }
      }
      const k = Number(d);
      if (k >= 1 && k <= n) { out += m[k] ?? ''; i++; }
      else out += '$';
    } else if (d === '<') {
      const close = rep.indexOf('>', i + 2);
      if (m.groups === undefined || close < 0) { out += '$'; continue; }
      const v = m.groups[rep.slice(i + 2, close)];
      out += v === undefined ? '' : String(v);
      i = close;
    } else {
      out += '$';
    }
  }
  return out;
}

const FRIENDLY: [RegExp, string][] = [
  [/Unterminated group/, 'A group was opened with "(" but never closed. Add the missing ")" or escape the parenthesis as \\( to match it literally.'],
  [/Unmatched '\)'/, 'There is a ")" without a matching "(". Remove it or escape it as \\) to match a literal parenthesis.'],
  [/Nothing to repeat/, 'A quantifier (*, +, ? or {…}) has nothing to repeat. It must follow a character, class or group, not the start of the pattern, a "|", an anchor or another quantifier. Escape it (\\*, \\+, \\?) to match it literally.'],
  [/Unterminated character class/, 'A character class was opened with "[" but never closed with "]". Add the "]" or escape the bracket as \\[.'],
  [/Range out of order/, 'A range inside [...] goes backwards, like [z-a]. Put the smaller character first, or escape the "-" (\\-) if you meant a literal dash.'],
  [/Invalid named capture referenced/, 'A \\k<name> backreference points to a group name that does not exist in the pattern.'],
  [/Duplicate capture group name/, 'Two groups have the same name. Each (?<name>…) needs a unique name (duplicates are only allowed in different alternatives in newer engines).'],
  [/Invalid capture group name/, 'A group name is not valid. Names must start with a letter, $ or _ and may contain letters, digits, $ and _.'],
  [/numbers out of order/i, 'In a {min,max} quantifier the first number must not be larger than the second.'],
  [/\\ at end of pattern/, 'The pattern ends with a single backslash. Write \\\\ to match a literal backslash.'],
  [/Invalid group/, 'Unknown group syntax after "(?". Use (?:…) for a non-capturing group, (?<name>…) for a named group, (?=…) / (?!…) for lookaheads or (?<=…) / (?<!…) for lookbehinds.'],
  [/Invalid property name/, 'Unknown Unicode property in \\p{…}. Examples of valid ones: \\p{L} (letters), \\p{N} (numbers), \\p{Script=Greek}, \\p{Emoji}.'],
  [/Incomplete quantifier/, 'A "{" is not a complete quantifier. With the u or v flag, write {n}, {n,} or {n,m}, or escape a literal brace as \\{.'],
  [/Lone quantifier brackets/, 'A lone "{" or "}" is not allowed with the u or v flag. Escape it as \\{ or \\}.'],
  [/Invalid Unicode escape/i, 'A \\u escape is malformed. Use \\u followed by 4 hex digits (\\u00e9) or, with the u flag, \\u{1F600}.'],
  [/Invalid escape/, 'An escape sequence is not valid here. With the u or v flag, only special characters such as \\. \\* \\( can be escaped; remove the backslash before ordinary letters.'],
  [/Invalid decimal escape/, 'A numbered escape like \\1 or \\01 is not valid here. With the u flag, backreferences must point to an existing group.'],
  [/Invalid class escape/, 'This escape cannot be used inside a character class [...].'],
  [/Invalid character class/, 'A character class is malformed, for example a range that starts or ends with \\d, \\w or \\s.'],
  [/Invalid class set operation|Invalid set operation/i, 'Invalid set operation in a v-mode class. Use [A&&B] for intersection or [A--B] for subtraction, and do not mix them without nesting.'],
  [/Invalid character in character class/, 'A character inside [...] must be escaped in v mode (for example ( ) [ ] { } / - | need a backslash).'],
  [/Invalid flags|Invalid regular expression flags/, 'The flags contain an unknown letter or a repeated one. Valid flags are d, g, i, m, s, u, v and y (u and v cannot be used together).'],
  [/Regular expression too large/, 'This pattern is too large for the engine to compile.'],
  [/Invalid named reference/, 'A \\k escape must be written as \\k<name> and refer to an existing named group.'],
  [/Invalid quantifier/, 'A quantifier is placed where it cannot apply.'],
];

/** Turn a native SyntaxError message into a plain-language explanation. */
export function friendlyError(raw: string): string {
  for (const [re, msg] of FRIENDLY) if (re.test(raw)) return msg;
  return raw.replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, '');
}

/** Check that a flag string is valid and return a friendly error if not. */
export function checkFlags(flags: string): string | null {
  const seen = new Set<string>();
  for (const f of flags) {
    if (!'dgimsuvy'.includes(f)) return `"${f}" is not a regex flag. Valid flags are d, g, i, m, s, u, v and y.`;
    if (seen.has(f)) return `The flag "${f}" appears twice.`;
    seen.add(f);
  }
  if (seen.has('u') && seen.has('v')) return 'The u and v flags cannot be used together (v is an upgraded u). Pick one.';
  return null;
}

export const TIMEOUT_MS = 500;

type Req = Omit<RunRequest, 'id'>;

/**
 * Owns one matching worker. Each run gets a timer; if the worker does not answer
 * in time it is terminated and a fresh one is started. A new run while the
 * previous one is still busy also replaces the worker (the old result is stale).
 */
export class Runner {
  private w: Worker | null = null;
  private ready = false;
  private queued: (Req & { id: number }) | null = null;
  private busy: { id: number; req: Req; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private seq = 0;
  restarts = 0;

  constructor(
    private onResult: (res: RunResponse, req: Req) => void,
    private onTimeout: (req: Req) => void,
    private timeoutMs = TIMEOUT_MS,
  ) {
    this.spawn();
  }

  private spawn() {
    this.ready = false;
    const w = new Worker(new URL('./match.worker.ts', import.meta.url), { type: 'module', name: 'regex-lab-matcher' });
    w.onmessage = (e: MessageEvent) => {
      if (w !== this.w) return;
      if (e.data && e.data.ready) {
        this.ready = true;
        if (this.queued) { const q = this.queued; this.queued = null; this.post(q); }
        return;
      }
      const res = e.data as RunResponse;
      if (!this.busy || res.id !== this.busy.id) return;
      if (this.busy.timer) clearTimeout(this.busy.timer);
      const { req } = this.busy;
      this.busy = null;
      this.onResult(res, req);
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      if (w !== this.w) return;
      const busy = this.busy;
      this.busy = null;
      if (busy) {
        if (busy.timer) clearTimeout(busy.timer);
        this.onResult({ id: busy.id, ok: false, error: ev.message || 'The matching worker crashed.', ms: 0 }, busy.req);
      }
      this.restart();
    };
    this.w = w;
  }

  private restart() {
    this.w?.terminate();
    this.restarts++;
    this.spawn();
  }

  private post(req: Req & { id: number }) {
    if (!this.busy || this.busy.id !== req.id) return;
    this.busy.timer = setTimeout(() => {
      if (!this.busy || this.busy.id !== req.id) return;
      const r = this.busy.req;
      this.busy = null;
      this.restart();
      this.onTimeout(r);
    }, this.timeoutMs);
    this.w!.postMessage(req);
  }

  run(req: Req) {
    if (this.busy) {
      // Previous run still going (maybe stuck): its answer would be stale anyway.
      if (this.busy.timer) clearTimeout(this.busy.timer);
      const wasPosted = this.busy.timer !== null;
      this.busy = null;
      if (wasPosted) this.restart();
    }
    const id = ++this.seq;
    this.busy = { id, req, timer: null };
    const full = { ...req, id };
    if (this.ready) this.post(full);
    else this.queued = full;
  }
}
