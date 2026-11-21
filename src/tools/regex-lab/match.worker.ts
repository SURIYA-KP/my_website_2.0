// Runs regex matching off the main thread so a catastrophic pattern can be
// terminated without freezing the page.
import { expandReplacement, type MatchRange, type RunRequest, type RunResponse } from './engine';

const MAX_MATCHES = 10000;

function advance(str: string, i: number, unicode: boolean) {
  if (!unicode || i + 1 >= str.length) return i + 1;
  const c = str.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = str.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return i + 2;
  }
  return i + 1;
}

self.onmessage = (e: MessageEvent<RunRequest>) => {
  const { id, pattern, flags, text, replacement } = e.data;
  const t0 = performance.now();
  try {
    const re = new RegExp(pattern, flags.includes('d') ? flags : flags + 'd');
    const unicode = re.unicode || (re as any).unicodeSets === true;
    const matches: MatchRange[] = [];
    const segs: { t: string; r?: number }[] = [];
    const wantReplace = typeof replacement === 'string';
    let truncated = false;
    let last = 0;
    const push = (m: RegExpExecArray) => {
      const ind = (m as any).indices as ([number, number] | undefined)[];
      const groups: ([number, number] | null)[] = [];
      for (let g = 1; g < m.length; g++) groups.push(ind?.[g] ? [ind[g]![0], ind[g]![1]] : null);
      const s = m.index;
      const end = s + m[0].length;
      matches.push({ s, e: end, g: groups });
      if (wantReplace) {
        if (s > last) segs.push({ t: text.slice(last, s) });
        segs.push({ t: expandReplacement(replacement!, m, text), r: matches.length - 1 });
        last = end;
      }
    };
    if (re.global) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (matches.length >= MAX_MATCHES) { truncated = true; break; }
        push(m);
        if (m[0] === '') re.lastIndex = advance(text, re.lastIndex, unicode);
      }
    } else {
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m) push(m);
    }
    const matchMs = performance.now() - t0;
    let result: string | undefined;
    let resultSegs: { t: string; r?: number }[] | undefined;
    if (wantReplace) {
      result = text.replace(new RegExp(pattern, flags), replacement!);
      if (!truncated) {
        if (last < text.length) segs.push({ t: text.slice(last) });
        if (segs.map((x) => x.t).join('') === result) resultSegs = segs;
      }
    }
    const res: RunResponse = { id, ok: true, matches, truncated, result, segs: resultSegs, ms: matchMs };
    (self as any).postMessage(res);
  } catch (err) {
    const res: RunResponse = { id, ok: false, error: (err as Error).message, ms: performance.now() - t0 };
    (self as any).postMessage(res);
  }
};

(self as any).postMessage({ ready: true });
