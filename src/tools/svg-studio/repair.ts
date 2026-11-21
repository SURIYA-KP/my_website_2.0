// Extract Mermaid code from a pasted AI chat reply and repair common mistakes.
// Pure functions (no DOM), so they are easy to reason about and test.

/** First keywords of every diagram type this Mermaid version understands. */
export const DIAGRAM_KEYWORDS = [
  'flowchart-elk', 'flowchart', 'graph', 'sequenceDiagram', 'classDiagram-v2', 'classDiagram',
  'stateDiagram-v2', 'stateDiagram', 'erDiagram', 'journey', 'gantt', 'pie', 'quadrantChart',
  'requirementDiagram', 'requirement', 'gitGraph', 'mindmap', 'timeline', 'sankey-beta', 'sankey',
  'xychart-beta', 'xychart', 'block-beta', 'block', 'packet-beta', 'packet', 'architecture-beta',
  'architecture', 'kanban', 'radar-beta', 'treemap-beta', 'treemap', 'C4Context', 'C4Container',
  'C4Component', 'C4Dynamic', 'C4Deployment', 'swimlane-beta', 'usecase-beta', 'venn-beta',
  'ishikawa-beta', 'ishikawa', 'treeView-beta', 'wardley-beta', 'cynefin-beta', 'railroad-ebnf-beta',
  'railroad-abnf-beta', 'railroad-peg-beta', 'railroad-beta', 'eventmodeling', 'agentflow-beta', 'info',
];

const KEYWORD_RE = new RegExp(
  `^\\s*(?:${DIAGRAM_KEYWORDS.map((k) => k.replace(/-/g, '\\-')).join('|')})(?![\\w-])`,
);
const START_RE = new RegExp(`${KEYWORD_RE.source}|^---\\s*$|^\\s*%%\\{`);

/** Does this line start a Mermaid diagram (keyword, front matter or init directive)? */
export function isDiagramStart(line: string) {
  return START_RE.test(line);
}

/** The diagram keyword of a piece of Mermaid code (skipping front matter, directives, comments). */
export function detectKeyword(code: string): string | null {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? '')) {
    i = 1;
    while (i < lines.length && !/^---\s*$/.test(lines[i])) i++;
    i++;
  }
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith('%%')) continue;
    const m = KEYWORD_RE.exec(l);
    return m ? m[0].trim() : null;
  }
  return null;
}

export interface Block {
  code: string;
  /** Language tag of the fence ('' if none, 'auto' if found without a fence). */
  lang: string;
  keyword: string | null;
}

/**
 * Find Mermaid code in an AI reply. Prefers ```mermaid fences, then unlabeled
 * fences whose content looks like Mermaid, then bare diagram text.
 */
export function extractMermaidBlocks(input: string): Block[] {
  const text = input.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const lines = text.split('\n');
  const fenced: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*([\w+-]*)[^\n]*$/.exec(lines[i]);
    if (!open) continue;
    const fence = open[1];
    const lang = open[2].toLowerCase();
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      if (close.test(lines[j])) break;
      body.push(lines[j]);
    }
    fenced.push({ code: body.join('\n'), lang, keyword: detectKeyword(body.join('\n')) });
    i = j; // skip past the closing fence (or the end if the reply was cut off)
  }
  const labelled = fenced.filter((b) => b.lang === 'mermaid' || b.lang === 'mmd');
  if (labelled.length) return labelled.filter((b) => b.code.trim());
  const looksRight = fenced.filter((b) => b.keyword);
  if (looksRight.length) return looksRight;

  // No fences: copying a rendered chat drops them. Find diagram starts in the text.
  const found: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!KEYWORD_RE.test(lines[i]) && !/^\s*%%\{/.test(lines[i])) continue;
    const body = [lines[i]];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      // Stop at a blank line followed by something that reads like prose.
      if (!l.trim()) {
        const next = lines.slice(j + 1).find((x) => x.trim());
        if (next === undefined || looksLikeProse(next)) break;
      }
      if (KEYWORD_RE.test(l) && !/^\s/.test(l) && body.some((b) => b.trim())) break;
      body.push(l);
    }
    const code = body.join('\n');
    found.push({ code, lang: 'auto', keyword: detectKeyword(code) });
    i = j - 1;
  }
  return found;
}

function looksLikeProse(line: string) {
  const l = line.trim();
  if (isDiagramStart(l)) return true;
  // Sentences: several words, ends with punctuation, no arrows or brackets.
  return /^[A-Z*#>][^]*[.:!?)]$/.test(l) && l.split(/\s+/).length >= 4 && !/(-->|->>|--|==>|:::|\[|\]|\{|\})/.test(l);
}

export interface RepairResult {
  code: string;
  fixes: string[];
}

const FLOW_KEYWORDS = new Set(['flowchart', 'graph', 'flowchart-elk', 'swimlane-beta']);

/** Fix the mistakes AI assistants and copy/paste most often introduce. */
export function repairMermaid(input: string): RepairResult {
  const fixes: string[] = [];
  let code = input.replace(/\r\n?/g, '\n');
  const count = (re: RegExp) => (code.match(re) || []).length;

  // Invisible / odd whitespace.
  let n = count(/[   ​‌‍⁠﻿]/g);
  if (n) {
    code = code.replace(/[   ]/g, ' ').replace(/[​‌‍⁠﻿]/g, '');
    fixes.push(`Removed ${n} invisible or non-breaking space character${n > 1 ? 's' : ''}`);
  }
  n = count(/\t/g);
  if (n) {
    code = code.replace(/\t/g, '    ');
    fixes.push('Converted tabs to spaces');
  }

  // Stray markdown fences and chat UI leftovers ("Copy code", a lone "mermaid" line).
  const before = code;
  code = code
    .split('\n')
    .filter((l, i, arr) => {
      if (/^\s*(`{3,}|~{3,})\s*[\w-]*\s*$/.test(l)) return false;
      if (/^\s*(copy code|copy|edit|code)\s*$/i.test(l)) return false;
      if (/^\s*mermaid\s*$/i.test(l)) {
        const next = arr.slice(i + 1).find((x) => x.trim());
        return !(next && isDiagramStart(next));
      }
      return true;
    })
    .join('\n');
  if (code !== before) fixes.push('Removed stray markdown fences / copy-button text');

  // HTML-escaped code (e.g. copied from page source): --&gt; instead of -->.
  if (/(-|=|\.)&gt;|&lt;(-|=|\|)|&quot;/.test(code)) {
    code = code.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    fixes.push('Decoded HTML entities (&gt; → >)');
  }

  // Smart quotes.
  n = count(/[“”„‟″«»]/g);
  if (n) {
    code = code.replace(/[“”„‟″«»]/g, '"');
    fixes.push(`Replaced ${n} curly double quote${n > 1 ? 's' : ''} with straight quotes`);
  }
  n = count(/[‘’‚‛′]/g);
  if (n) {
    code = code.replace(/[‘’‚‛′]/g, "'");
    fixes.push(`Replaced ${n} curly single quote${n > 1 ? 's' : ''} / apostrophe${n > 1 ? 's' : ''}`);
  }

  // Typographic arrows and dashes in links.
  n = count(/[–—−]+>|→|⟶/g);
  if (n) {
    code = code.replace(/[–—−]+>/g, '-->').replace(/\s*[→⟶]\s*/g, ' --> ');
    fixes.push(`Replaced ${n} typographic arrow${n > 1 ? 's' : ''} with -->`);
  }

  // <br> variants → <br/>; literal "\n" inside labels → <br/>.
  n = count(/<\s*\/?\s*br\s*\/?\s*>/gi) - count(/<br\/>/g);
  if (n > 0) {
    code = code.replace(/<\s*\/?\s*br\s*\/?\s*>/gi, '<br/>');
    fixes.push(`Normalized ${n} line break tag${n > 1 ? 's' : ''} to <br/>`);
  }
  n = count(/\[[^\]\n]*\\n[^\]\n]*\]|"[^"\n]*\\n[^"\n]*"/g);
  if (n) {
    code = code.replace(/(\[[^\]\n]*\]|"[^"\n]*")/g, (m) => m.replace(/\\n/g, '<br/>'));
    fixes.push('Turned literal \\n in labels into <br/>');
  }

  // Escaped quotes inside labels break the parser: use the #quot; entity.
  n = count(/\\"/g);
  if (n) {
    code = code.replace(/\\"/g, '#quot;');
    fixes.push(`Replaced ${n} escaped quote${n > 1 ? 's' : ''} (\\") with #quot;`);
  }

  // Leading blank lines and a common indentation (e.g. code nested in a list item).
  const lines = code.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  const firstIndent = indents[0] ?? 0;
  if (common > 0) {
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i].slice(common);
    fixes.push(`Removed ${common} leading space${common > 1 ? 's' : ''} of indentation`);
  } else if (firstIndent > 0 && /^\s+---\s*$/.test(lines[0])) {
    lines[0] = '---';
    fixes.push('Moved front matter fence to the start of the line');
  }
  code = lines.join('\n');

  // Flowchart labels with parentheses / brackets must be quoted.
  const keyword = detectKeyword(code);
  if (keyword && FLOW_KEYWORDS.has(keyword)) {
    const res = quoteFlowLabels(code);
    if (res.count) {
      code = res.code;
      fixes.push(`Quoted ${res.count} label${res.count > 1 ? 's' : ''} containing special characters`);
    }
  }

  // A missing diagram keyword is common when only the body was pasted.
  if (code.trim() && !detectKeyword(code) && /(-->|---|==>|-\.->)/.test(code) && !/^---\s*$/m.test(code.split('\n')[0])) {
    code = `flowchart TD\n${code}`;
    fixes.push('Added missing "flowchart TD" header');
  }

  return { code: code.replace(/\s+$/, '') + '\n', fixes };
}

const SPECIAL_IN_LABEL = /[()[\]{}"|;]/;
const ID_CHAR = /[A-Za-z0-9_\-.À-￿]/;
const SKIP_LINE = /^\s*(%%|classDef\b|class\b|style\b|linkStyle\b|click\b|accTitle\b|accDescr\b)/;

/** Quote unquoted flowchart node labels (`A[Run (fast)]` → `A["Run (fast)"]`) and edge labels. */
export function quoteFlowLabels(code: string): { code: string; count: number } {
  let count = 0;
  const out = code.split('\n').map((line) => {
    if (SKIP_LINE.test(line)) return line;
    let res = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '"') {
        const end = line.indexOf('"', i + 1);
        const stop = end < 0 ? line.length : end + 1;
        res += line.slice(i, stop);
        i = stop;
        continue;
      }
      // Edge label: |text|
      if (ch === '|') {
        const end = line.indexOf('|', i + 1);
        if (end > i) {
          const content = line.slice(i + 1, end);
          if (!/^\s*".*"\s*$/.test(content) && /[()[\]{}]/.test(content)) {
            res += `|"${content.replace(/"/g, '#quot;')}"|`;
            count++;
          } else res += line.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      // Node: id followed directly by a simple opener [ ( {
      if (ID_CHAR.test(ch) && (i === 0 || !ID_CHAR.test(line[i - 1]))) {
        let j = i;
        while (j < line.length && ID_CHAR.test(line[j])) j++;
        const opener = line[j];
        const pair: Record<string, string> = { '[': ']', '(': ')', '{': '}' };
        const next = line[j + 1];
        const special = next === undefined || '[({/\\>|'.includes(next) || (opener === '(' && next === '-');
        if (opener && pair[opener] && !special && !/^(subgraph|end|direction)$/.test(line.slice(i, j))) {
          const close = pair[opener];
          let depth = 0;
          let k = j;
          let inQuote = false;
          for (; k < line.length; k++) {
            const c = line[k];
            if (c === '"') inQuote = !inQuote;
            if (inQuote) continue;
            if (c === opener) depth++;
            else if (c === close) {
              depth--;
              if (depth === 0) break;
            }
          }
          if (k < line.length) {
            const content = line.slice(j + 1, k);
            const quoted = /^\s*".*"\s*$/.test(content) || /^\s*"`/.test(content);
            if (!quoted && SPECIAL_IN_LABEL.test(content)) {
              res += `${line.slice(i, j)}${opener}"${content.trim().replace(/"/g, '#quot;')}"${close}`;
              count++;
            } else {
              res += line.slice(i, k + 1);
            }
            i = k + 1;
            continue;
          }
        }
        res += line.slice(i, j);
        i = j;
        continue;
      }
      res += ch;
      i++;
    }
    return res;
  });
  return { code: out.join('\n'), count };
}
