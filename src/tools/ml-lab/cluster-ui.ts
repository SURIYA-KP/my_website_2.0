// Clustering tab: paint points, step through Lloyd's k-means phase by phase, elbow analysis.
import { debounce, toast } from '../../lib/ui';
import { drawElbow, drawSparkline, type ElbowHit } from './charts';
import { drawGraphPaper, fitCanvas, rgba, type Theme } from './colors';
import { makeClusterData, type ClusterDataset, type P2 } from './datasets';
import { assign, elbowSteps, initCentroids, inertia as wcss, kneeK, suggestK, update, type ElbowPoint, type InitMethod } from './kmeans';
import { mulberry32, randomSeed } from './rng';

type Phase = 'empty' | 'init' | 'assigned' | 'updated';
type Kind = ClusterDataset | 'custom';

const MAX_POINTS = 3000;
const SPEED_MS: Record<string, number> = { slow: 1100, normal: 620, fast: 220 };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Tip { kind: Kind | 'any'; title: string; text: string; action?: string; apply?: () => void }

export function initClustering(theme: () => Theme) {
  const canvas = $<HTMLCanvasElement>('km-canvas');
  const wrap = canvas.parentElement!;
  const els = {
    n: $<HTMLInputElement>('km-n'), nOut: $('km-n-out'),
    noise: $<HTMLInputElement>('km-noise'), noiseOut: $('km-noise-out'),
    centers: $<HTMLInputElement>('km-centers'), centersOut: $('km-centers-out'), centersField: $('km-centers-field'),
    brush: $<HTMLInputElement>('km-brush'), brushOut: $('km-brush-out'),
    k: $<HTMLInputElement>('km-k'), kOut: $('km-k-out'),
    seed: $<HTMLInputElement>('km-seed'), speed: $<HTMLSelectElement>('km-speed'),
    step: $<HTMLButtonElement>('km-step'), stepLabel: $('km-step-label'), play: $<HTMLButtonElement>('km-play'),
    reset: $<HTMLButtonElement>('km-reset'),
    iter: $('km-iter'), inertia: $('km-inertia'), status: $('km-status'), count: $('km-count'),
    spark: $<HTMLCanvasElement>('km-spark'), elbow: $<HTMLCanvasElement>('km-elbow'), elbowNote: $('km-elbow-note'),
    useBest: $<HTMLButtonElement>('km-use-best'), empty: $('km-empty'),
    tipTitle: $('km-tip-title'), tipText: $('km-tip-text'), tipTry: $<HTMLButtonElement>('km-tip-try'), tipNext: $<HTMLButtonElement>('km-tip-next'),
  };

  // ------------------------------------------------------------------ state
  let points: P2[] = [];
  let labels = new Int32Array(0);
  let kind: Kind = 'blobs';
  let dataSeed = 11;
  let k = 4;
  let init: InitMethod = 'kmeans++';
  let tool: 'paint' | 'erase' = 'paint';
  let centroids: P2[] | null = null;
  let trails: P2[][] = [];
  let phase: Phase = 'empty';
  let iteration = 0;
  let converged = false;
  let curInertia = NaN;
  let inertiaHist: number[] = [];
  let lastChanged = 0;
  let emptyClusters: number[] = [];
  let playing = false;
  let playTimer: ReturnType<typeof setTimeout> | null = null;
  let tween: { from: P2[]; to: P2[]; t0: number; dur: number } | null = null;
  let spokes: { t0: number; dur: number } | null = null;
  let hover: P2 | null = null;
  let elbowRes: ElbowPoint[] = [];
  let elbowHits: ElbowHit[] = [];
  let elbowToken = 0;
  let elbowBusy = '';
  let tipIdx = 0;

  // ------------------------------------------------------------------ geometry
  let size = 400;
  const toPx = (p: P2) => ({ x: ((p.x + 1) / 2) * size, y: ((1 - p.y) / 2) * size });
  const toWorld = (px: number, py: number): P2 => ({ x: (px / size) * 2 - 1, y: 1 - (py / size) * 2 });

  /** Voronoi cell of centroid i, clipped to the canvas square (Sutherland-Hodgman on bisectors). */
  function voronoiCell(i: number, cs: P2[]): P2[] {
    let poly: P2[] = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
    const ci = cs[i];
    for (let j = 0; j < cs.length && poly.length; j++) {
      if (j === i) continue;
      const cj = cs[j];
      const nx = cj.x - ci.x, ny = cj.y - ci.y;
      if (Math.abs(nx) + Math.abs(ny) < 1e-12) { if (j < i) return []; continue; }
      const c = (cj.x * cj.x + cj.y * cj.y - ci.x * ci.x - ci.y * ci.y) / 2;
      const f = (p: P2) => p.x * nx + p.y * ny - c; // <= 0 means closer to ci
      const out: P2[] = [];
      for (let a = 0; a < poly.length; a++) {
        const P = poly[a], Q = poly[(a + 1) % poly.length];
        const fp = f(P), fq = f(Q);
        if (fp <= 0) out.push(P);
        if ((fp <= 0) !== (fq <= 0)) {
          const t = fp / (fp - fq);
          out.push({ x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t });
        }
      }
      poly = out;
    }
    return poly;
  }

  function shownCentroids(now: number): P2[] | null {
    if (!centroids) return null;
    if (!tween) return centroids;
    const t = Math.min(1, (now - tween.t0) / tween.dur);
    const e = ease(t);
    return tween.from.map((a, i) => ({ x: a.x + (tween!.to[i].x - a.x) * e, y: a.y + (tween!.to[i].y - a.y) * e }));
  }

  // ------------------------------------------------------------------ render
  let raf = 0;
  const requestRender = () => { if (!raf) raf = requestAnimationFrame(render); };

  function render(now: number) {
    raf = 0;
    const th = theme();
    size = Math.max(200, Math.floor(wrap.clientWidth));
    const { ctx } = fitCanvas(canvas, size, size);
    drawGraphPaper(ctx, size, th);
    const cs = shownCentroids(now);
    const pr = size < 420 ? 2.6 : 3.2;

    if (cs) {
      // Voronoi regions
      for (let i = 0; i < cs.length; i++) {
        const cell = voronoiCell(i, cs);
        if (cell.length < 3) continue;
        ctx.beginPath();
        cell.forEach((p, j) => { const q = toPx(p); j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
        ctx.closePath();
        ctx.fillStyle = rgba(th.rgb.cluster[i % 10], th.dark ? 0.16 : 0.11);
        ctx.fill();
        ctx.strokeStyle = rgba(th.rgb.cluster[i % 10], 0.55);
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // assignment "spokes": brief lines from each point to the centroid it just joined
    if (spokes && cs) {
      const t = (now - spokes.t0) / spokes.dur;
      if (t >= 1) spokes = null;
      else {
        ctx.lineWidth = 1;
        for (let c = 0; c < cs.length; c++) {
          const q = toPx(cs[c]);
          ctx.strokeStyle = rgba(th.rgb.cluster[c % 10], 0.42 * (1 - t));
          ctx.beginPath();
          for (let i = 0; i < points.length; i++) {
            if (labels[i] !== c) continue;
            const p = toPx(points[i]);
            ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
        }
      }
    }

    // points, batched by colour
    const groups = new Map<number, number[]>();
    for (let i = 0; i < points.length; i++) {
      const l = labels[i] ?? -1;
      let g = groups.get(l);
      if (!g) groups.set(l, (g = []));
      g.push(i);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = th.elev;
    for (const [l, idx] of groups) {
      ctx.fillStyle = l >= 0 ? th.cluster[l % 10] : th.faint;
      ctx.beginPath();
      for (const i of idx) {
        const p = toPx(points[i]);
        ctx.moveTo(p.x + pr, p.y);
        ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
    }

    // centroid trails + markers
    if (cs) {
      for (let c = 0; c < cs.length; c++) {
        const trail = trails[c] ?? [];
        const path = [...trail.slice(0, -1), cs[c]];
        if (tween == null) path.splice(path.length - 1, 1, trail[trail.length - 1] ?? cs[c]);
        if (path.length > 1) {
          ctx.strokeStyle = th.text;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          path.forEach((p, j) => { const q = toPx(p); j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          for (let j = 0; j < path.length - 1; j++) {
            const q = toPx(path[j]);
            ctx.beginPath();
            ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2);
            ctx.fillStyle = th.elev; ctx.fill();
            ctx.strokeStyle = th.cluster[c % 10]; ctx.lineWidth = 1.5; ctx.stroke();
          }
        }
      }
      for (let c = 0; c < cs.length; c++) {
        const q = toPx(cs[c]);
        const r = size < 420 ? 7 : 8.5;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r + 2.5, 0, Math.PI * 2);
        ctx.fillStyle = th.text; ctx.fill();
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        ctx.fillStyle = th.cluster[c % 10]; ctx.fill();
        ctx.strokeStyle = th.elev; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(q.x - r * 0.45, q.y); ctx.lineTo(q.x + r * 0.45, q.y);
        ctx.moveTo(q.x, q.y - r * 0.45); ctx.lineTo(q.x, q.y + r * 0.45);
        ctx.stroke();
      }
    }

    // brush cursor
    if (hover) {
      const q = toPx(hover);
      const r = Math.max(4, (brushRadius() / 2) * size);
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = tool === 'erase' ? th.danger : th.text;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.25;
      ctx.setLineDash(tool === 'erase' ? [3, 3] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    if (tween && now - tween.t0 >= tween.dur) tween = null;
    if (tween || spokes) requestRender();
  }

  // ------------------------------------------------------------------ UI sync
  const fmtI = (v: number) => (Number.isFinite(v) ? (v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toPrecision(3)) : '–');

  function syncUI() {
    els.iter.textContent = String(iteration);
    els.inertia.textContent = fmtI(curInertia);
    els.count.textContent = `${points.length} point${points.length === 1 ? '' : 's'}`;
    const next = !centroids ? 'Initialize' : phase === 'assigned' ? 'Update' : 'Assign';
    els.stepLabel.textContent = converged ? 'Converged' : next;
    els.step.disabled = converged || points.length === 0;
    els.play.disabled = converged || points.length === 0;
    setPlayIcon(els.play, playing);
    document.querySelectorAll<HTMLElement>('#km-phases [data-phase]').forEach((el) => {
      const p = el.dataset.phase;
      const on = (p === 'init' && phase === 'init') || (p === 'assign' && phase === 'assigned') || (p === 'update' && phase === 'updated');
      el.classList.toggle('is-on', on && !converged);
      el.classList.toggle('is-next', !converged && ((p === 'init' && !centroids) || (p === 'assign' && (phase === 'init' || phase === 'updated')) || (p === 'update' && phase === 'assigned')));
    });
    let status = '';
    let tone = '';
    if (!points.length) status = 'Paint some points or pick a dataset to begin.';
    else if (points.length < k) { status = `Need at least k = ${k} points.`; tone = 'warn'; }
    else if (!centroids) status = `Press Step to place ${k} starting centroid${k > 1 ? 's' : ''} (${init === 'kmeans++' ? 'k-means++' : 'random'}).`;
    else if (converged) { status = `Converged after ${iteration} iteration${iteration === 1 ? '' : 's'}: no point changed cluster.`; tone = 'ok'; }
    else if (phase === 'init') status = 'Centroids placed. Next: assign every point to its nearest centroid.';
    else if (phase === 'assigned') status = `Assigned: ${lastChanged} point${lastChanged === 1 ? '' : 's'} changed cluster. Next: move each centroid to the mean of its points.`;
    else status = 'Centroids moved to their cluster means. Next: reassign points.';
    if (emptyClusters.length && centroids && !converged) status += ` Cluster ${emptyClusters.map((c) => c + 1).join(', ')} is empty and stays put.`;
    els.status.textContent = status;
    els.status.dataset.tone = tone;
    els.empty.hidden = points.length > 0;
    drawSparkline(els.spark, inertiaHist, theme(), theme().accent);
    els.kOut.textContent = String(k);
    requestRender();
  }

  // ------------------------------------------------------------------ algorithm control
  function resetRun() {
    stopPlay();
    centroids = null;
    trails = [];
    phase = 'empty';
    iteration = 0;
    converged = false;
    curInertia = NaN;
    inertiaHist = [];
    emptyClusters = [];
    tween = null;
    spokes = null;
    labels = new Int32Array(points.length).fill(-1);
    syncUI();
  }

  function finishTween() {
    if (tween) tween = null;
  }

  function animDur() {
    return Math.min(420, SPEED_MS[els.speed.value] * 0.7);
  }

  function step(): boolean {
    if (!points.length) { toast('Add some points first', 'error'); return false; }
    if (points.length < k) { toast(`Need at least ${k} points for k = ${k}`, 'error'); return false; }
    if (converged) return false;
    finishTween();
    const now = performance.now();
    if (!centroids) {
      centroids = initCentroids(points, k, init, mulberry32(Number(els.seed.value) || 0));
      trails = centroids.map((c) => [{ ...c }]);
      labels = new Int32Array(points.length).fill(-1);
      phase = 'init';
      iteration = 0;
    } else if (phase === 'init' || phase === 'updated') {
      if (labels.length !== points.length) labels = new Int32Array(points.length).fill(-1);
      const { changed, inertia } = assign(points, centroids, labels);
      iteration++;
      lastChanged = changed;
      curInertia = inertia;
      inertiaHist.push(inertia);
      phase = 'assigned';
      spokes = { t0: now, dur: Math.max(380, animDur() * 1.4) };
      if (changed === 0) converged = true;
    } else {
      const res = update(points, labels, centroids);
      emptyClusters = res.empty;
      tween = { from: centroids.map((c) => ({ ...c })), to: res.centroids, t0: now, dur: animDur() };
      centroids = res.centroids;
      centroids.forEach((c, i) => trails[i].push({ ...c }));
      curInertia = wcss(points, labels, centroids);
      inertiaHist.push(curInertia);
      phase = 'updated';
      if (res.shift < 1e-9) converged = true;
    }
    if (converged) stopPlay();
    syncUI();
    return true;
  }

  function setPlayIcon(btn: HTMLButtonElement, on: boolean) {
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector<HTMLElement>('.ml-lab-ico-play')!.hidden = on;
    btn.querySelector<HTMLElement>('.ml-lab-ico-pause')!.hidden = !on;
    btn.querySelector<HTMLElement>('.ml-lab-play-text')!.textContent = on ? 'Pause' : 'Play';
  }

  function stopPlay() {
    playing = false;
    if (playTimer) clearTimeout(playTimer);
    playTimer = null;
  }

  function play() {
    if (playing) { stopPlay(); syncUI(); return; }
    if (!step()) return;
    if (converged) return;
    playing = true;
    const loop = () => {
      playTimer = setTimeout(() => {
        if (!playing) return;
        if (!step() || converged) { stopPlay(); syncUI(); return; }
        loop();
      }, SPEED_MS[els.speed.value] ?? 620);
    };
    loop();
    syncUI();
  }

  // ------------------------------------------------------------------ data
  function onDataChanged() {
    labels = new Int32Array(points.length).fill(-1);
    if (centroids) {
      if (phase === 'assigned') phase = 'updated';
      converged = false;
      curInertia = NaN;
    }
    scheduleElbow();
    syncUI();
  }

  function generate(newSeed = true) {
    if (newSeed) dataSeed = randomSeed();
    const data = makeClusterData(kind === 'custom' ? 'blobs' : kind, {
      n: Number(els.n.value), noise: Number(els.noise.value) / 100, centers: Number(els.centers.value), seed: dataSeed,
    });
    if (kind === 'custom') kind = 'blobs';
    points = data.points;
    resetRun();
    runElbow();
    syncDatasetButtons();
    showTipFor(kind);
  }

  function syncDatasetButtons() {
    document.querySelectorAll<HTMLButtonElement>('[data-km-ds]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kmDs === kind)));
    els.centersField.classList.toggle('is-disabled', !(kind === 'blobs' || kind === 'aniso'));
    els.centers.disabled = !(kind === 'blobs' || kind === 'aniso');
    els.noise.disabled = kind === 'uniform';
  }

  // ------------------------------------------------------------------ painting
  const brushRadius = () => (Number(els.brush.value) / 100) * 0.3; // world units
  let painting = false;
  let lastPaint: P2 | null = null;
  let paintRng = mulberry32(randomSeed());

  function sprayAt(p: P2) {
    const r = brushRadius();
    if (tool === 'erase') {
      const er = Math.max(r, 0.035);
      const before = points.length;
      const keep: P2[] = [];
      for (const q of points) if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 > er * er) keep.push(q);
      if (keep.length !== before) { points = keep; onDataChanged(); }
      return;
    }
    if (points.length >= MAX_POINTS) { toast(`Point limit reached (${MAX_POINTS})`, 'error'); painting = false; return; }
    const count = r < 0.015 ? 1 : Math.max(2, Math.round(2 + r * 28));
    for (let i = 0; i < count && points.length < MAX_POINTS; i++) {
      // Gaussian-ish spray: denser in the middle of the brush
      const a = paintRng() * Math.PI * 2;
      const d = r < 0.015 ? 0 : r * Math.sqrt(paintRng()) * (0.35 + 0.65 * paintRng());
      points.push({ x: Math.max(-1, Math.min(1, p.x + Math.cos(a) * d)), y: Math.max(-1, Math.min(1, p.y + Math.sin(a) * d)) });
    }
    if (kind !== 'custom' && points.length) {/* painting on top of a dataset keeps its tips */}
    onDataChanged();
  }

  function eventWorld(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return toWorld(((e.clientX - rect.left) / rect.width) * size, ((e.clientY - rect.top) / rect.height) * size);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    painting = true;
    const p = eventWorld(e);
    lastPaint = p;
    hover = p;
    sprayAt(p);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = eventWorld(e);
    hover = e.pointerType === 'mouse' ? p : null;
    if (painting && lastPaint) {
      const spacing = Math.max(0.025, brushRadius() * 0.6);
      if (Math.hypot(p.x - lastPaint.x, p.y - lastPaint.y) >= spacing) { lastPaint = p; sprayAt(p); }
    }
    requestRender();
  });
  const endPaint = () => { painting = false; lastPaint = null; };
  canvas.addEventListener('pointerup', endPaint);
  canvas.addEventListener('pointercancel', endPaint);
  canvas.addEventListener('pointerleave', () => { hover = null; requestRender(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ------------------------------------------------------------------ elbow
  const scheduleElbow = debounce(() => runElbow(), 700);

  function runElbow() {
    const token = ++elbowToken;
    elbowRes = [];
    const pts = points.slice();
    if (pts.length < 2) {
      elbowBusy = '';
      els.elbowNote.textContent = 'Add at least a few points to run the elbow analysis.';
      els.useBest.disabled = true;
      drawElbowNow();
      return;
    }
    const gen = elbowSteps(pts, 10, 4, 1234);
    elbowBusy = 'Computing…';
    els.useBest.disabled = true;
    els.elbowNote.textContent = 'Running k = 1…10 with 4 restarts each…';
    const tick = () => {
      if (token !== elbowToken) return;
      const t0 = performance.now();
      while (performance.now() - t0 < 10) {
        const r = gen.next();
        if (r.done) { finishElbow(); return; }
        elbowRes.push(r.value);
      }
      elbowBusy = `Computing k = ${elbowRes.length + 1}…`;
      drawElbowNow();
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  }

  function finishElbow() {
    elbowBusy = '';
    const best = suggestK(elbowRes);
    const knee = kneeK(elbowRes);
    const bestSil = elbowRes.find((r) => r.k === best)?.silhouette ?? NaN;
    els.useBest.disabled = !best || best === k;
    els.useBest.textContent = best ? `Use k = ${best}` : 'Use suggested k';
    els.useBest.dataset.k = String(best ?? '');
    let note = best ? `Highest silhouette at k = ${best} (${bestSil.toFixed(2)})` : 'Not enough distinct points for a silhouette score.';
    if (knee) note += knee === best ? `, which is also the elbow of the inertia curve.` : `. The inertia curve bends most at k = ${knee}.`;
    if (best && bestSil < 0.4) note += ' Scores this low mean there is little real cluster structure.';
    els.elbowNote.textContent = note;
    drawElbowNow();
  }

  function drawElbowNow() {
    elbowHits = drawElbow(els.elbow, elbowRes, theme(), {
      kMax: 10, selected: k, suggested: elbowBusy ? null : suggestK(elbowRes), knee: elbowBusy ? null : kneeK(elbowRes),
      progress: elbowRes.length === 0 ? (elbowBusy || 'No data') : '',
    });
    els.elbow.setAttribute('aria-label', elbowRes.length
      ? `Elbow chart. ${elbowRes.map((r) => `k=${r.k}: inertia ${r.inertia.toFixed(2)}${Number.isFinite(r.silhouette) ? `, silhouette ${r.silhouette.toFixed(2)}` : ''}`).join('; ')}`
      : 'Elbow chart (no data yet)');
  }

  els.elbow.addEventListener('click', (e) => {
    const rect = els.elbow.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hit = elbowHits.find((h) => x >= h.x0 && x < h.x1);
    if (hit) setK(hit.k);
  });
  els.elbow.addEventListener('mousemove', (e) => {
    const rect = els.elbow.getBoundingClientRect();
    const x = e.clientX - rect.left;
    els.elbow.style.cursor = elbowHits.some((h) => x >= h.x0 && x < h.x1) ? 'pointer' : 'default';
  });

  function setK(v: number) {
    k = Math.max(1, Math.min(10, Math.round(v)));
    els.k.value = String(k);
    resetRun();
    drawElbowNow();
    if (elbowRes.length && !elbowBusy) els.useBest.disabled = Number(els.useBest.dataset.k) === k;
  }

  // ------------------------------------------------------------------ tips
  const setDataset = (d: ClusterDataset) => { kind = d; generate(); };
  const tips: Tip[] = [
    { kind: 'blobs', title: 'The happy path', text: 'Round, well-separated blobs are k-means’ best case. Switch init to Random and try a few seeds: now and then two centroids start in the same blob and the run settles in a worse local minimum (higher inertia). k-means++ spreads the starting centroids out, which makes that rare.', action: 'Try random init', apply: () => { setInit('random'); els.seed.value = String(randomSeed() % 1000); resetRun(); play(); } },
    { kind: 'rings', title: 'k-means struggles with rings', text: 'Every border k-means can draw is a straight line halfway between two centroids (the dashed Voronoi edges). So instead of separating the inner ring from the outer one, it slices both into wedges. That is a property of the objective, not a bug.', action: 'Try rings with k = 2', apply: () => { setDataset('rings'); setK(2); play(); } },
    { kind: 'moons', title: 'Shapes that aren’t convex', text: 'Two interleaved moons can’t be split by a straight cut, and a straight cut is all k-means can do with k = 2. Density-based (DBSCAN) or spectral clustering follow the shape instead.', action: 'Try moons with k = 2', apply: () => { setDataset('moons'); setK(2); play(); } },
    { kind: 'aniso', title: 'Stretched clusters', text: 'k-means quietly assumes clusters are round and equally spread, because it only looks at Euclidean distance to the centre. Tilted, elongated blobs break that: borders cut across the ellipses. A Gaussian mixture with full covariances fits these much better.', action: 'Try stretched blobs', apply: () => { setDataset('aniso'); setK(Number(els.centers.value)); play(); } },
    { kind: 'uniform', title: 'Clusters that aren’t there', text: 'Uniform noise has no structure at all, yet k-means still returns exactly k tidy clusters. The elbow chart gives it away: no clear bend and a low silhouette score for every k.', action: 'Try uniform noise', apply: () => { setDataset('uniform'); play(); } },
    { kind: 'any', title: 'Reading the elbow chart', text: 'Inertia always falls as k grows (with k = n it would be zero), so the minimum is meaningless. Look for the elbow where extra clusters stop paying off, or the k with the highest silhouette, highlighted as “best”.', action: 'Use suggested k', apply: () => { const b = suggestK(elbowRes); if (b) { setK(b); play(); } else toast('Run the elbow analysis first', 'error'); } },
    { kind: 'custom', title: 'Paint your own', text: 'Paint one big, dense blob and one small, sparse one far away, then run k = 2. Because k-means minimises squared distances, it often moves the border into the big cluster rather than following the gap.', action: 'Clear and paint', apply: () => { points = []; kind = 'custom'; resetRun(); runElbow(); syncDatasetButtons(); toast('Canvas cleared: drag to paint'); } },
  ];

  function renderTip() {
    const t = tips[tipIdx];
    els.tipTitle.textContent = t.title;
    els.tipText.textContent = t.text;
    els.tipTry.hidden = !t.action;
    els.tipTry.textContent = t.action ?? '';
  }
  function showTipFor(kd: Kind) {
    const i = tips.findIndex((t) => t.kind === kd);
    if (i >= 0) { tipIdx = i; renderTip(); }
  }
  els.tipNext.addEventListener('click', () => { tipIdx = (tipIdx + 1) % tips.length; renderTip(); });
  els.tipTry.addEventListener('click', () => tips[tipIdx].apply?.());

  // ------------------------------------------------------------------ controls
  function setInit(m: InitMethod) {
    init = m;
    $('km-init-random').setAttribute('aria-pressed', String(m === 'random'));
    $('km-init-pp').setAttribute('aria-pressed', String(m === 'kmeans++'));
  }
  function setTool(t: 'paint' | 'erase') {
    tool = t;
    $('km-tool-paint').setAttribute('aria-pressed', String(t === 'paint'));
    $('km-tool-erase').setAttribute('aria-pressed', String(t === 'erase'));
    canvas.dataset.tool = t;
  }

  document.querySelectorAll<HTMLButtonElement>('[data-km-ds]').forEach((b) =>
    b.addEventListener('click', () => { kind = b.dataset.kmDs as ClusterDataset; generate(); }));
  $('km-generate').addEventListener('click', () => generate());
  $('km-clear').addEventListener('click', () => { points = []; kind = 'custom'; resetRun(); runElbow(); syncDatasetButtons(); showTipFor('custom'); });
  $('km-tool-paint').addEventListener('click', () => setTool('paint'));
  $('km-tool-erase').addEventListener('click', () => setTool('erase'));
  $('km-init-random').addEventListener('click', () => { setInit('random'); resetRun(); });
  $('km-init-pp').addEventListener('click', () => { setInit('kmeans++'); resetRun(); });
  $('km-seed-rand').addEventListener('click', () => { els.seed.value = String(randomSeed() % 1000); resetRun(); });
  els.seed.addEventListener('change', () => { if (!/^\d+$/.test(els.seed.value)) els.seed.value = '0'; resetRun(); });
  els.k.addEventListener('input', () => setK(Number(els.k.value)));
  els.useBest.addEventListener('click', () => { const b = Number(els.useBest.dataset.k); if (b) setK(b); });
  els.step.addEventListener('click', () => { stopPlay(); step(); });
  els.play.addEventListener('click', play);
  els.reset.addEventListener('click', resetRun);

  const regen = debounce(() => { if (kind !== 'custom') generate(false); }, 120);
  const bindRange = (inp: HTMLInputElement, out: HTMLElement, f: (v: number) => string, onChange?: () => void) => {
    const sync = () => { out.textContent = f(Number(inp.value)); };
    inp.addEventListener('input', () => { sync(); onChange?.(); });
    sync();
  };
  bindRange(els.n, els.nOut, (v) => String(v), regen);
  bindRange(els.noise, els.noiseOut, (v) => `${v}%`, regen);
  bindRange(els.centers, els.centersOut, (v) => String(v), regen);
  bindRange(els.brush, els.brushOut, (v) => (v < 5 ? 'dot' : String(v)));

  new ResizeObserver(() => { requestRender(); drawElbowNow(); drawSparkline(els.spark, inertiaHist, theme(), theme().accent); }).observe(wrap);

  // keyboard shortcuts while the tab is visible (ignored when typing in a field)
  document.addEventListener('keydown', (e) => {
    const panel = document.querySelector<HTMLElement>('[data-tabpanel="mllab:kmeans"]');
    if (!panel || panel.hidden) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && (e.target as HTMLElement)?.tagName !== 'BUTTON') { e.preventDefault(); play(); }
    else if (e.key === 'n' || e.key === 'ArrowRight') { if (tag !== 'BUTTON' || e.key === 'n') { e.preventDefault(); stopPlay(); step(); } }
    else if (e.key === 'r') { resetRun(); }
  });

  // initial state
  setInit('kmeans++');
  setTool('paint');
  els.k.value = String(k);
  kind = 'blobs';
  dataSeed = 11;
  generate(false);
  showTipFor('blobs');

  return {
    redraw() { requestRender(); drawElbowNow(); drawSparkline(els.spark, inertiaHist, theme(), theme().accent); },
    // exposed for tests / debugging
    get state() { return { n: points.length, k, iteration, phase, converged, inertia: curInertia, elbow: elbowRes.length } },
  };
}
