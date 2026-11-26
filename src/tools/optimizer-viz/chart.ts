// Loss-vs-step chart on a canvas. Log y-axis of (f − f*) when f* is known, symlog otherwise.

export interface Series {
  color: string;
  losses: number[];
  dashed?: boolean;
  /** Drawn thicker and on top (the selected optimizer). */
  bold?: boolean;
  /** End marker: a dot for a finished run, a cross for a diverged one. */
  end?: 'dot' | 'cross';
}

export interface ChartTheme {
  text: string;
  muted: string;
  grid: string;
  bg: string;
}

export interface ChartOptions {
  fmin: number;
  maxSteps: number;
  theme: ChartTheme;
}

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const pow10 = (e: number) => (e === 0 ? '1' : e === 1 ? '10' : `10${String(e).replace(/./g, (c) => SUP[c] ?? c)}`);

function niceSteps(max: number) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

export function drawChart(canvas: HTMLCanvasElement, series: Series[], opts: ChartOptions) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const { theme, fmin } = opts;
  const logMode = true;
  const tf = (f: number) => Math.log10(Math.max(f - fmin, 1e-16));

  // Ranges
  let lo = Infinity;
  let hi = -Infinity;
  let maxLen = 1;
  for (const s of series) {
    maxLen = Math.max(maxLen, s.losses.length);
    for (const f of s.losses) {
      const v = tf(f);
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) {
    lo = logMode ? -4 : -1;
    hi = logMode ? 2 : 1;
  }
  if (logMode) {
    lo = Math.floor(Math.max(lo, hi - 14));
    hi = Math.ceil(hi + 1e-9);
    if (hi - lo < 2) lo = hi - 2;
  } else {
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad;
    hi += pad;
  }
  const xMax = Math.max(10, Math.min(opts.maxSteps, Math.ceil(maxLen * 1.1)));

  const padL = 38;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  const pw = cssW - padL - padR;
  const ph = cssH - padT - padB;
  const X = (i: number) => padL + (i / xMax) * pw;
  const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * ph;

  // Grid + labels
  ctx.font = '10px ' + getComputedStyle(canvas).fontFamily;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'right';
  const yTicks: number[] = [];
  if (logMode) {
    const every = Math.max(1, Math.ceil((hi - lo) / 5));
    for (let e = Math.ceil(lo); e <= hi; e += every) yTicks.push(e);
  } else {
    const st = niceSteps(hi - lo);
    for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) yTicks.push(v);
  }
  for (const v of yTicks) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + pw, y);
    ctx.stroke();
    ctx.fillText(logMode ? pow10(v) : +v.toPrecision(3) + '', padL - 5, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Integer tick spacing from the 1-2-5 series (steps are whole numbers).
  const rawX = xMax / 4;
  const px = Math.pow(10, Math.floor(Math.log10(rawX)));
  const xs = Math.max(1, (rawX / px <= 1 ? 1 : rawX / px <= 2 ? 2 : rawX / px <= 5 ? 5 : 10) * px);
  for (let i = 0; i <= xMax; i += xs) {
    const x = Math.round(X(i)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + ph);
    ctx.stroke();
    const lbl = String(Math.round(i));
    const tw = ctx.measureText(lbl).width;
    ctx.fillText(lbl, Math.min(x, cssW - tw / 2 - 1), padT + ph + 5);
  }

  // Series (decimated to ~2 points per pixel)
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, pw, ph);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const ordered = [...series.filter((s) => !s.bold), ...series.filter((s) => s.bold)];
  for (const s of ordered) {
    const n = s.losses.length;
    if (!n) continue;
    const stride = Math.max(1, Math.floor(n / (pw * 2)));
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i += stride) {
      const v = tf(s.losses[i]);
      if (!Number.isFinite(v)) continue;
      const x = X(i);
      const y = Y(Math.max(lo - 1, Math.min(hi + 1, v)));
      if (started) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        started = true;
      }
    }
    const last = tf(s.losses[n - 1]);
    const ex = X(n - 1);
    const ey = Y(Math.max(lo, Math.min(hi, Number.isFinite(last) ? last : hi)));
    if (Number.isFinite(last)) ctx.lineTo(ex, Y(Math.max(lo - 1, Math.min(hi + 1, last))));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.bold ? 2.4 : 1.4;
    ctx.globalAlpha = s.bold ? 1 : 0.85;
    ctx.setLineDash(s.dashed ? [4, 3] : []);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    if (s.end === 'dot') {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(ex, ey, s.bold ? 3.2 : 2.6, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.end === 'cross') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(ex - 3.5, ey - 3.5);
      ctx.lineTo(ex + 3.5, ey + 3.5);
      ctx.moveTo(ex + 3.5, ey - 3.5);
      ctx.lineTo(ex - 3.5, ey + 3.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}
