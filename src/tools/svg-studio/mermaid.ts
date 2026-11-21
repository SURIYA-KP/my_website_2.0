// Render Mermaid to an editable SVG string (lazy-loads mermaid on first use).
import { repairMermaid } from './repair';

type MermaidApi = typeof import('mermaid').default;
let api: Promise<MermaidApi> | null = null;
let counter = 0;

function load() {
  if (!api) {
    api = import('mermaid').then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'default',
        // Real SVG <text> labels (not HTML in <foreignObject>) so every label is editable.
        htmlLabels: false,
        flowchart: { htmlLabels: false, useMaxWidth: false },
        sequence: { useMaxWidth: false },
        class: { htmlLabels: false, useMaxWidth: false },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
        journey: { useMaxWidth: false, textPlacement: 'tspan' },
        pie: { useMaxWidth: false },
        mindmap: { useMaxWidth: false },
        timeline: { useMaxWidth: false, textPlacement: 'tspan' },
        fontFamily: 'Helvetica, Arial, sans-serif',
      } as Parameters<MermaidApi['initialize']>[0]);
      return mermaid;
    });
  }
  return api;
}

export interface MermaidResult {
  svg: string;
  fixes: string[];
}

/** Render Mermaid code. Throws an Error with a readable message on syntax errors. */
export async function renderMermaid(code: string): Promise<MermaidResult> {
  const mermaid = await load();
  let src = code;
  let fixes: string[] = [];
  try {
    await mermaid.parse(src);
  } catch (first) {
    // Try the automatic repairs before giving up.
    const repaired = repairMermaid(code);
    try {
      await mermaid.parse(repaired.code);
      src = repaired.code;
      fixes = repaired.fixes;
    } catch {
      throw new Error(cleanError(first));
    }
  }
  // The render id prefixes every element id, so keep it short (ids show up in the layers panel).
  const id = `m${++counter}`;
  try {
    const { svg } = await mermaid.render(id, src);
    return { svg, fixes };
  } catch (e) {
    throw new Error(cleanError(e));
  } finally {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

function cleanError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+$/, '').slice(0, 600) || 'Mermaid could not render this code.';
}

/**
 * Mermaid output uses width="100%" and a max-width style; give the document a real size
 * (from its viewBox) so it behaves like any other SVG in the editor and in PNG export.
 */
export function normalizeMermaidSvg(root: SVGSVGElement) {
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite)) {
    root.setAttribute('width', String(Math.ceil(vb[2])));
    root.setAttribute('height', String(Math.ceil(vb[3])));
  }
  root.style.removeProperty('max-width');
  if (!root.getAttribute('style')?.trim()) root.removeAttribute('style');
  root.removeAttribute('aria-roledescription');
}
