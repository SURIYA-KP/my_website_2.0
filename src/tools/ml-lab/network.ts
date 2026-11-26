// Live SVG diagram of the MLP: neurons as columns, edges as curves whose width and colour
// encode the weight's magnitude and sign. Hidden neurons report hover / tap for the inspector.
import type { Theme } from './colors';

const NS = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

export interface NeuronRef { layer: number; index: number; x: number; y: number }

export interface NetworkView {
  build(sizes: number[], inputLabels: string[], classLabels: string[]): void;
  update(W: Float64Array[], b: Float64Array[]): void;
  restyle(th: Theme): void;
  setActive(ref: NeuronRef | null): void;
  /** viewBox size, for positioning overlays */
  readonly box: { w: number; h: number };
  readonly version: number;
}

export function createNetworkView(host: HTMLElement, theme: () => Theme, onNeuron: (ref: NeuronRef | null, ev?: PointerEvent) => void): NetworkView {
  let svg: SVGSVGElement | null = null;
  let edges: SVGPathElement[][] = [];
  let nodes: { g: SVGGElement; c: SVGCircleElement; ref: NeuronRef }[][] = [];
  let sizes: number[] = [];
  let lastW: Float64Array[] = [];
  let lastB: Float64Array[] = [];
  let version = 0;
  const box = { w: 640, h: 240 };
  let active: NeuronRef | null = null;

  let lastArgs: [number[], string[], string[]] | null = null;
  let builtWidth = 0;
  new ResizeObserver(() => {
    const w = host.clientWidth;
    if (lastArgs && w > 0 && Math.abs(Math.max(540, w) - builtWidth) > 8) build(...lastArgs);
  }).observe(host);

  function build(sz: number[], inputLabels: string[], classLabels: string[]) {
    lastArgs = [sz, inputLabels, classLabels];
    if (active) onNeuron(null);
    sizes = sz.slice();
    svg?.remove();
    const th = theme();
    const L = sizes.length;
    const maxN = Math.max(...sizes);
    const spacing = maxN > 12 ? 17 : maxN > 8 ? 20 : 24;
    const padY = 22;
    box.h = Math.max(150, (maxN - 1) * spacing + padY * 2 + 14);
    // Draw at the container's real pixel width so text and strokes are never scaled up.
    const padL = 58, padR = 58;
    box.w = Math.max(540, Math.round(host.clientWidth || 640));
    const span = Math.min(box.w - padL - padR, 230 * (L - 1));
    const x0 = (box.w - span) / 2;
    const colX = (l: number) => x0 + (span * l) / Math.max(1, L - 1);
    const pos = (l: number, i: number) => ({ x: colX(l), y: box.h / 2 + 7 + (i - (sizes[l] - 1) / 2) * spacing });

    builtWidth = box.w;
    svg = el('svg', { viewBox: `0 0 ${box.w} ${box.h}`, role: 'img', 'aria-label': `Network diagram: ${sizes.join(' → ')} neurons` });
    // layer captions
    const cap = el('g', { 'font-size': 10, 'text-anchor': 'middle', fill: th.faint });
    for (let l = 0; l < L; l++) {
      const t = el('text', { x: colX(l), y: 11, 'font-weight': 600 });
      t.textContent = l === 0 ? 'input' : l === L - 1 ? 'output' : `hidden ${l}`;
      cap.appendChild(t);
    }
    svg.appendChild(cap);

    const eg = el('g', { fill: 'none', 'stroke-linecap': 'round' });
    edges = [];
    for (let l = 0; l < L - 1; l++) {
      const arr: SVGPathElement[] = [];
      const nIn = sizes[l], nOut = sizes[l + 1];
      for (let o = 0; o < nOut; o++) {
        for (let i = 0; i < nIn; i++) {
          const a = pos(l, i), z = pos(l + 1, o);
          const mx = (a.x + z.x) / 2;
          const p = el('path', { d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} C${mx.toFixed(1)} ${a.y.toFixed(1)} ${mx.toFixed(1)} ${z.y.toFixed(1)} ${z.x.toFixed(1)} ${z.y.toFixed(1)}`, class: 'mll-edge', 'stroke-width': 1, stroke: th.borderStrong });
          p.dataset.l = String(l); p.dataset.i = String(i); p.dataset.o = String(o);
          arr.push(p);
          eg.appendChild(p);
        }
      }
      edges.push(arr);
    }
    svg.appendChild(eg);

    const ng = el('g');
    nodes = [];
    for (let l = 0; l < L; l++) {
      const col: typeof nodes[number] = [];
      for (let i = 0; i < sizes[l]; i++) {
        const { x, y } = pos(l, i);
        const hidden = l > 0 && l < L - 1;
        const g = el('g', { class: `mll-node${hidden ? ' is-hidden' : ''}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` });
        const r = spacing > 20 ? 7.5 : 6.5;
        const c = el('circle', { r, 'stroke-width': 1.5 });
        g.appendChild(c);
        if (l === 0 || l === L - 1) {
          const t = el('text', { x: l === 0 ? -r - 6 : r + 6, y: 3.5, 'font-size': 10.5, 'text-anchor': l === 0 ? 'end' : 'start' });
          t.style.fontFamily = 'var(--font-mono)';
          t.textContent = l === 0 ? (inputLabels[i] ?? `x${i}`) : (classLabels[i] ?? `c${i}`);
          g.appendChild(t);
        }
        const ref: NeuronRef = { layer: l, index: i, x, y };
        if (hidden) {
          g.setAttribute('tabindex', '0');
          g.setAttribute('role', 'button');
          g.setAttribute('aria-label', `Hidden layer ${l}, neuron ${i + 1}: show activation map`);
          // larger invisible hit target for touch
          g.insertBefore(el('circle', { r: Math.max(10, spacing / 2), fill: 'transparent' }), c);
          g.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') onNeuron(ref, e); });
          g.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') onNeuron(null, e); });
          g.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse') return;
            e.preventDefault();
            e.stopPropagation();
            onNeuron(active && active.layer === l && active.index === i ? null : ref, e);
          });
          g.addEventListener('focus', () => onNeuron(ref));
          g.addEventListener('blur', () => onNeuron(null));
        }
        col.push({ g, c, ref });
        ng.appendChild(g);
      }
      nodes.push(col);
    }
    svg.appendChild(ng);
    host.prepend(svg);
    restyle(th);
    if (lastW.length) update(lastW, lastB);
  }

  function restyle(th: Theme) {
    if (!svg) return;
    svg.querySelectorAll('text').forEach((t) => t.setAttribute('fill', th.muted));
    const L = sizes.length;
    nodes.forEach((col, l) => col.forEach(({ c }, i) => {
      if (l === L - 1) { c.setAttribute('fill', th.classes[i % th.classes.length]); c.setAttribute('stroke', th.elev); }
      else { c.setAttribute('fill', th.elev); c.setAttribute('stroke', l === 0 ? th.muted : th.text); }
    }));
    if (lastW.length) update(lastW, lastB);
  }

  function update(W: Float64Array[], b: Float64Array[]) {
    lastW = W; lastB = b;
    if (!svg || W.length !== edges.length) return;
    const th = theme();
    let maxAbs = 1e-9;
    for (const w of W) for (let i = 0; i < w.length; i++) { const a = Math.abs(w[i]); if (a > maxAbs) maxAbs = a; }
    // Edge width tracks |w| relative to the largest weight in the net (sqrt keeps small ones visible).
    for (let l = 0; l < W.length; l++) {
      const w = W[l], arr = edges[l];
      if (w.length !== arr.length) return;
      for (let k = 0; k < arr.length; k++) {
        const v = w[k];
        const m = Math.sqrt(Math.min(1, Math.abs(v) / maxAbs));
        const p = arr[k];
        p.setAttribute('stroke', v >= 0 ? th.pos : th.neg);
        p.setAttribute('stroke-width', (0.35 + 3.4 * m).toFixed(2));
        p.setAttribute('stroke-opacity', (0.18 + 0.75 * m).toFixed(2));
      }
    }
    // Hidden-neuron rings: colour by bias sign.
    for (let l = 1; l < nodes.length - 1; l++) {
      const bias = b[l - 1];
      if (!bias) continue;
      nodes[l].forEach(({ c }, i) => c.setAttribute('stroke', bias[i] >= 0 ? th.pos : th.neg));
    }
    version++;
    svg.dataset.version = String(version);
  }

  function setActive(ref: NeuronRef | null) {
    active = ref;
    nodes.forEach((col) => col.forEach(({ g, ref: r }) => g.classList.toggle('is-active', !!ref && r.layer === ref.layer && r.index === ref.index)));
    host.classList.toggle('is-focus', !!ref);
    edges.forEach((arr, l) => arr.forEach((p) => {
      const lit = !!ref && ((l === ref.layer - 1 && Number(p.dataset.o) === ref.index) || (l === ref.layer && Number(p.dataset.i) === ref.index));
      p.classList.toggle('is-lit', lit);
    }));
  }

  return {
    build, update, restyle, setActive, box,
    get version() { return version; },
  };
}
