// Lazy mermaid loader with a small cache. Renders are serialized (mermaid is not re-entrant).
type Mermaid = typeof import('mermaid').default;

export interface DiagramResult {
  svg?: string;
  error?: string;
}

let mermaidP: Promise<Mermaid> | null = null;
const cache = new Map<string, DiagramResult>();
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function load() {
  mermaidP ??= import('mermaid').then((m) => {
    const mermaid = m.default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
      fontFamily: "'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
      suppressErrorRendering: true,
    } as any);
    return mermaid;
  });
  return mermaidP;
}

export function cachedDiagram(code: string) {
  return cache.get(code);
}

export function renderDiagram(code: string): Promise<DiagramResult> {
  const hit = cache.get(code);
  if (hit) return Promise.resolve(hit);
  const job = queue.then(async () => {
    const again = cache.get(code);
    if (again) return again;
    let result: DiagramResult;
    const id = `mdp-mmd-${++counter}`;
    try {
      const mermaid = await load();
      await mermaid.parse(code);
      const { svg } = await mermaid.render(id, code);
      result = { svg };
    } catch (e) {
      const msg = (e as { message?: string; str?: string })?.message || String(e);
      result = { error: msg.split('\n').slice(0, 6).join('\n') };
    } finally {
      // mermaid may leave its temporary container behind on failure
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
    if (cache.size > 60) cache.delete(cache.keys().next().value!);
    cache.set(code, result);
    return result;
  });
  queue = job.catch(() => {});
  return job;
}
