// Standalone HTML export: the rendered document with every stylesheet inlined (KaTeX fonts as data URLs).
import docCss from './doc.css?raw';
import { escapeAttr } from './render';

const katexFontUrls = import.meta.glob('../../../node_modules/katex/dist/fonts/*.woff2', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;

let katexCssP: Promise<string> | null = null;

async function toDataUrl(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:font/woff2;base64,${btoa(bin)}`;
}

/** KaTeX CSS with its woff2 fonts embedded (fetched from this site, never from a CDN). */
function katexCss(): Promise<string> {
  katexCssP ??= (async () => {
    const css = (await import('katex/dist/katex.min.css?raw')).default as string;
    const byName = new Map<string, () => Promise<string>>();
    for (const [path, load] of Object.entries(katexFontUrls)) byName.set(path.split('/').pop()!, load);
    const names = [...new Set([...css.matchAll(/url\(fonts\/([\w-]+\.woff2)\)/g)].map((m) => m[1]))];
    const data = new Map<string, string>();
    await Promise.all(
      names.map(async (n) => {
        const load = byName.get(n);
        if (!load) return;
        try {
          data.set(n, await toDataUrl(await load()));
        } catch {
          /* font stays missing; KaTeX falls back to system fonts */
        }
      }),
    );
    return css.replace(/src:([^;}]*)/g, (whole, list: string) => {
      const m = /url\(fonts\/([\w-]+\.woff2)\)/.exec(list);
      const url = m && data.get(m[1]);
      return url ? `src:url(${url}) format("woff2")` : 'src:local("Times New Roman")';
    });
  })();
  return katexCssP;
}

export interface ExportOptions {
  title: string;
  theme: string;
  fontSize: number;
  pageCss: string;
  paperWidth: string;
}

export async function buildStandaloneHtml(bodyHtml: string, hasMath: boolean, o: ExportOptions) {
  const math = hasMath ? await katexCss() : '';
  const shell = `
html { background: #eef0f3; }
body { margin: 0; padding: 32px 16px; }
.mdp-doc { box-sizing: border-box; max-width: ${o.paperWidth}; margin: 0 auto; padding: 56px 64px; border-radius: 4px; box-shadow: 0 1px 3px rgb(0 0 0 / .08), 0 8px 30px rgb(0 0 0 / .06); }
@media (max-width: 700px) { body { padding: 0; } .mdp-doc { padding: 24px 18px; border-radius: 0; box-shadow: none; } }
@media print { html { background: #fff; } body { padding: 0; } .mdp-doc { max-width: none; padding: 0; box-shadow: none; } }
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Markdown → PDF (in-browser)">
<title>${escapeAttr(o.title)}</title>
<style>
${docCss}
${math}
${o.pageCss}
${shell}
</style>
</head>
<body>
<article class="mdp-doc theme-${escapeAttr(o.theme)}" style="--mdp-fs:${o.fontSize}pt">
${bodyHtml}
</article>
</body>
</html>
`;
}
