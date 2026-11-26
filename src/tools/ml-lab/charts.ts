// Tiny hand-rolled canvas charts (theme-aware, no dependencies).
import { fitCanvas, type Theme } from './colors';
import type { ElbowPoint } from './kmeans';

export interface Series { pts: [number, number][]; color: string; dash?: number[]; width?: number; label: string }

const fmt = (v: number) => {
  if (!Number.isFinite(v)) return '–';
  if (v === 0 || (Number.isInteger(v) && Math.abs(v) < 1e6)) return String(v);
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(2);
};

/** Round up to 1, 2, 2.5 or 5 times a power of ten, so axis labels stay readable. */
export function niceCeil(v: number) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p * 1.0001) return m * p;
  return 10 * p;
}

/** Line chart for training curves. */
export function drawLineChart(canvas: HTMLCanvasElement, series: Series[], th: Theme, o: { yMin?: number; yMax?: number; yFmt?: (v: number) => string; empty?: string } = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 36, padR = 8, padT = 8, padB = 18;
  const pw = w - padL - padR, ph = h - padT - padB;
  let xMax = 1, yMax = o.yMax ?? -Infinity, yMin = o.yMin ?? Infinity;
  for (const s of series) for (const [x, y] of s.pts) {
    if (x > xMax) xMax = x;
    if (o.yMax === undefined && Number.isFinite(y) && y > yMax) yMax = y;
    if (o.yMin === undefined && Number.isFinite(y) && y < yMin) yMin = y;
  }
  if (!Number.isFinite(yMax)) yMax = 1;
  if (o.yMax === undefined) yMax = niceCeil(yMax);
  if (!Number.isFinite(yMin)) yMin = 0;
  if (yMax - yMin < 1e-9) yMax = yMin + 1;
  const X = (x: number) => padL + (x / xMax) * pw;
  const Y = (y: number) => padT + (1 - (y - yMin) / (yMax - yMin)) * ph;
  ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--font-mono');
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = th.border;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = th.faint;
    ctx.textAlign = 'right';
    ctx.fillText((o.yFmt ?? fmt)(v), padL - 5, y);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`epoch ${Math.round(xMax)}`, w - padR, h - 4);
  ctx.textAlign = 'left';
  ctx.fillText('0', padL, h - 4);
  const any = series.some((s) => s.pts.length > 0);
  if (!any) {
    ctx.fillStyle = th.faint;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillText(o.empty ?? 'No data yet', padL + pw / 2, padT + ph / 2);
    return;
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT - 2, pw, ph + 4); ctx.clip();
  for (const s of series) {
    if (!s.pts.length) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 1.75;
    ctx.setLineDash(s.dash ?? []);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const [x, y] of s.pts) {
      if (!Number.isFinite(y)) { started = false; continue; }
      if (!started) { ctx.moveTo(X(x), Y(y)); started = true; } else ctx.lineTo(X(x), Y(y));
    }
    if (s.pts.length === 1) { const [x, y] = s.pts[0]; ctx.moveTo(X(x) - 2, Y(y)); ctx.lineTo(X(x) + 2, Y(y)); }
    ctx.stroke();
  }
  ctx.restore();
  ctx.setLineDash([]);
}

/** Sparkline (no axes). */
export function drawSparkline(canvas: HTMLCanvasElement, values: number[], th: Theme, color: string) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const vals = values.filter(Number.isFinite);
  if (vals.length < 2) {
    ctx.strokeStyle = th.border;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const X = (i: number) => 2 + (i / (vals.length - 1)) * (w - 4);
  const Y = (v: number) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (h - 6);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(X(vals.length - 1), Y(vals[vals.length - 1]), 2.5, 0, Math.PI * 2); ctx.fill();
}

export interface ElbowHit { k: number; x0: number; x1: number }

/** Elbow chart: inertia line (left axis) + silhouette bars (right axis, 0..1). Returns hit columns. */
export function drawElbow(canvas: HTMLCanvasElement, res: ElbowPoint[], th: Theme, o: { kMax: number; selected: number; suggested: number | null; knee: number | null; progress?: string }): ElbowHit[] {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 40, padR = 34, padT = 14, padB = 22;
  const pw = w - padL - padR, ph = h - padT - padB;
  const K = o.kMax;
  const colW = pw / K;
  const X = (k: number) => padL + (k - 0.5) * colW;
  const mono = getComputedStyle(document.body).getPropertyValue('--font-mono');
  ctx.font = `10px ${mono}`;
  const hits: ElbowHit[] = [];
  for (let k = 1; k <= K; k++) hits.push({ k, x0: padL + (k - 1) * colW, x1: padL + k * colW });

  // highlight suggested + selected columns
  if (o.suggested) {
    ctx.fillStyle = th.accent;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(padL + (o.suggested - 1) * colW, padT - 6, colW, ph + 6);
    ctx.globalAlpha = 1;
  }
  const maxI = niceCeil(Math.max(1e-9, ...res.map((r) => r.inertia)));
  const Yi = (v: number) => padT + (1 - v / maxI) * ph;
  const Ys = (v: number) => padT + (1 - Math.max(0, v)) * ph;

  // axes / grid
  ctx.lineWidth = 1;
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(padT + (i / 4) * ph) + 0.5;
    ctx.strokeStyle = th.border;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = th.faint;
    ctx.textAlign = 'right';
    ctx.fillText(fmt(maxI * (1 - i / 4)), padL - 5, y);
    ctx.textAlign = 'left';
    ctx.fillText((1 - i / 4).toFixed(2), w - padR + 5, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let k = 1; k <= K; k++) {
    const sel = k === o.selected;
    ctx.fillStyle = sel ? th.text : th.faint;
    ctx.font = `${sel ? '600 ' : ''}10px ${mono}`;
    ctx.fillText(String(k), X(k), h - 6);
  }
  ctx.font = `10px ${mono}`;

  // silhouette bars
  for (const r of res) {
    if (!Number.isFinite(r.silhouette)) continue;
    const bw = Math.min(18, colW * 0.5);
    ctx.fillStyle = r.k === o.suggested ? th.accent : th.borderStrong;
    ctx.globalAlpha = r.k === o.suggested ? 0.75 : 0.6;
    const y = Ys(r.silhouette);
    ctx.fillRect(X(r.k) - bw / 2, y, bw, padT + ph - y);
    ctx.globalAlpha = 1;
  }
  // inertia line
  if (res.length) {
    ctx.strokeStyle = th.text;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    res.forEach((r, i) => (i ? ctx.lineTo(X(r.k), Yi(r.inertia)) : ctx.moveTo(X(r.k), Yi(r.inertia))));
    ctx.stroke();
    for (const r of res) {
      const isKnee = r.k === o.knee;
      ctx.beginPath();
      ctx.arc(X(r.k), Yi(r.inertia), isKnee ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = isKnee ? th.elev : th.text;
      ctx.fill();
      if (isKnee) { ctx.lineWidth = 2; ctx.strokeStyle = th.text; ctx.stroke(); }
    }
  }
  // selected k marker
  if (o.selected >= 1 && o.selected <= K) {
    const x = Math.round(X(o.selected)) + 0.5;
    ctx.strokeStyle = th.text;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT - 6); ctx.lineTo(x, padT + ph); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (o.suggested) {
    ctx.fillStyle = th.accent;
    ctx.textAlign = 'center';
    ctx.font = `600 10px ${mono}`;
    const x = Math.min(Math.max(X(o.suggested), padL + 22), w - padR - 22);
    ctx.fillText('best', x, padT - 3);
  }
  if (o.progress) {
    ctx.fillStyle = th.muted;
    ctx.textAlign = 'center';
    ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillText(o.progress, padL + pw / 2, padT + ph / 2);
  }
  return hits;
}
