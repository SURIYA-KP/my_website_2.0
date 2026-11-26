// Chart building: aggregation over the filtered rows + Chart.js rendering themed
// from the site's CSS variables.
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PieController,
  PointElement,
  ScatterController,
  Title,
  Tooltip,
  type ChartConfiguration,
  type Plugin,
} from 'chart.js';
import { cssVar } from '../../lib/ui';
import { formatDate, formatStat } from './format';
import { histogram } from './profile';
import { BOOL_NULL, type Column, type Dataset } from './types';
import { keyOf } from './view';

Chart.register(
  ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, Legend, LinearScale,
  LineController, LineElement, PieController, PointElement, ScatterController, Title, Tooltip,
);

export type ChartType = 'bar' | 'line' | 'scatter' | 'histogram' | 'pie' | 'doughnut';
export type Agg = 'count' | 'sum' | 'mean' | 'min' | 'max';
export type Bucket = 'auto' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface ChartSpec {
  type: ChartType;
  x: number;
  y: number; // -1 = row count
  agg: Agg;
  group: number; // -1 = none
  bucket: Bucket;
  bins: number; // 0 = auto
  limit: number;
  sort: 'value' | 'label';
}

export interface Series {
  name: string;
  values: (number | null)[];
}

export interface ChartData {
  kind: 'category' | 'scatter';
  title: string;
  xLabel: string;
  yLabel: string;
  labels: string[];
  series: Series[];
  points?: { name: string; pts: { x: number; y: number }[] }[];
  xIsDate?: boolean;
  yIsDate?: boolean;
  note?: string;
  bucket?: Bucket;
}

const MAX_GROUPS = 8;
const MAX_POINTS = 6000;

const pad = (n: number) => String(n).padStart(2, '0');

function bucketKey(t: number, b: Exclude<Bucket, 'auto'>): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (b) {
    case 'year':
      return String(y);
    case 'quarter':
      return `${y}-Q${Math.floor(m / 3) + 1}`;
    case 'month':
      return `${y}-${pad(m + 1)}`;
    case 'week': {
      // ISO week
      const day = (d.getUTCDay() + 6) % 7;
      const th = new Date(Date.UTC(y, m, d.getUTCDate() - day + 3));
      const fy = th.getUTCFullYear();
      const firstTh = new Date(Date.UTC(fy, 0, 4));
      const wk = 1 + Math.round((th.getTime() - firstTh.getTime()) / 604800000 - ((firstTh.getUTCDay() + 6) % 7 - 3) / 7);
      return `${fy}-W${pad(wk)}`;
    }
    default:
      return formatDate(t);
  }
}

export function autoBucket(col: Column, rows: Uint32Array): Exclude<Bucket, 'auto'> {
  const d = col.data as Float64Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    const v = d[rows[i]];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const days = (hi - lo) / 86400000;
  if (!(days > 0) || days <= 92) return 'day';
  if (days <= 3 * 366) return 'month';
  return 'year';
}

function numericValue(col: Column, r: number): number {
  if (col.type === 'boolean') {
    const v = (col.data as Uint8Array)[r];
    return v === BOOL_NULL ? NaN : v;
  }
  if (col.type === 'string') return NaN;
  return (col.data as Float64Array)[r];
}

function aggLabel(spec: ChartSpec, ds: Dataset) {
  if (spec.y < 0 || spec.agg === 'count') return spec.y < 0 ? 'Rows' : `Count of ${ds.columns[spec.y].name}`;
  const a = { sum: 'Sum', mean: 'Mean', min: 'Min', max: 'Max', count: 'Count' }[spec.agg];
  return `${a} of ${ds.columns[spec.y].name}`;
}

/** Compute the chart's data from the dataset rows (already filtered). */
export function computeChart(ds: Dataset, rows: Uint32Array, spec: ChartSpec): ChartData {
  const xc = ds.columns[spec.x];
  if (!xc) throw new Error('Choose a column for the X axis.');
  if (spec.type === 'scatter') return computeScatter(ds, rows, spec);
  if (spec.type === 'histogram') return computeHistogram(ds, rows, spec);

  const yc = spec.y >= 0 ? ds.columns[spec.y] : null;
  const agg: Agg = yc ? spec.agg : 'count';
  const pie = spec.type === 'pie' || spec.type === 'doughnut';
  const gc = !pie && spec.group >= 0 && spec.group !== spec.x ? ds.columns[spec.group] : null;
  let bucket: Exclude<Bucket, 'auto'> | undefined;
  if (xc.type === 'date') bucket = spec.bucket === 'auto' ? autoBucket(xc, rows) : spec.bucket;
  const xKey = (r: number): string => {
    if (xc.type === 'date') {
      const t = (xc.data as Float64Array)[r];
      return t === t ? bucketKey(t, bucket!) : '';
    }
    return keyOf(xc, r);
  };

  // Group-by: keep the most frequent groups, fold the rest into "Other".
  let groupOf: ((r: number) => string) | null = null;
  let groupNames: string[] = [''];
  if (gc) {
    const counts = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const k = keyOf(gc, rows[i]) || '(empty)';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sorted = Array.from(counts).sort((a, b) => b[1] - a[1]);
    const keep = new Set(sorted.slice(0, MAX_GROUPS).map((e) => e[0]));
    groupNames = sorted.slice(0, MAX_GROUPS).map((e) => e[0]);
    if (sorted.length > MAX_GROUPS) groupNames.push('Other');
    groupOf = (r) => {
      const k = keyOf(gc, r) || '(empty)';
      return keep.has(k) ? k : 'Other';
    };
  }
  const gIndex = new Map(groupNames.map((g, i) => [g, i]));
  type Acc = { s: Float64Array; n: Float64Array; mn: Float64Array; mx: Float64Array };
  const G = groupNames.length;
  const accs = new Map<string, Acc>();
  const yData = yc ? (r: number) => numericValue(yc, r) : null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const k = xKey(r) || '(empty)';
    let a = accs.get(k);
    if (!a) {
      a = { s: new Float64Array(G), n: new Float64Array(G), mn: new Float64Array(G).fill(Infinity), mx: new Float64Array(G).fill(-Infinity) };
      accs.set(k, a);
    }
    const g = groupOf ? gIndex.get(groupOf(r))! : 0;
    if (yData) {
      const v = yData(r);
      if (v !== v) continue;
      a.s[g] += v;
      a.n[g]++;
      if (v < a.mn[g]) a.mn[g] = v;
      if (v > a.mx[g]) a.mx[g] = v;
    } else a.n[g]++;
  }
  const valueOf = (a: Acc, g: number): number | null => {
    if (!a.n[g]) return agg === 'count' || agg === 'sum' ? 0 : null;
    switch (agg) {
      case 'count':
        return a.n[g];
      case 'sum':
        return a.s[g];
      case 'mean':
        return a.s[g] / a.n[g];
      case 'min':
        return a.mn[g];
      case 'max':
        return a.mx[g];
    }
  };
  let labels = Array.from(accs.keys());
  const total = (k: string) => {
    const a = accs.get(k)!;
    let t = 0;
    for (let g = 0; g < G; g++) t += valueOf(a, g) ?? 0;
    return t;
  };
  const numericX = xc.type === 'integer' || xc.type === 'float';
  const byLabel = (a: string, b: string) => {
    if (a === '(empty)') return 1;
    if (b === '(empty)') return -1;
    return numericX ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0;
  };
  const sortByValue = spec.sort === 'value' && (spec.type !== 'line' || (xc.type !== 'date' && !numericX));
  if (sortByValue) {
    const totals = new Map(labels.map((l) => [l, total(l)]));
    labels.sort((a, b) => totals.get(b)! - totals.get(a)! || byLabel(a, b));
  } else labels.sort(byLabel);

  let note: string | undefined;
  const limit = Math.max(1, spec.limit || 20);
  let other: number | null = null;
  if (labels.length > limit) {
    const rest = labels.slice(limit);
    if (pie && (agg === 'count' || agg === 'sum')) other = rest.reduce((s, l) => s + total(l), 0);
    note = `Showing ${limit} of ${labels.length.toLocaleString()} categories${other !== null ? ' (the rest are grouped as "Other")' : ''}. Raise "Max categories" to see more.`;
    labels = labels.slice(0, limit);
  }
  const series: Series[] = groupNames.map((name, g) => ({
    name: gc ? name : aggLabel(spec, ds),
    values: labels.map((l) => valueOf(accs.get(l)!, g)),
  }));
  if (other !== null) {
    labels.push('Other');
    series[0].values.push(other);
  }
  const yLabel = aggLabel(spec, ds);
  return {
    kind: 'category',
    title: `${yLabel} by ${xc.name}${bucket ? ` (${bucket})` : ''}${gc ? `, grouped by ${gc.name}` : ''}`,
    xLabel: xc.name,
    yLabel,
    labels,
    series,
    note,
    bucket,
  };
}

function computeHistogram(ds: Dataset, rows: Uint32Array, spec: ChartSpec): ChartData {
  const xc = ds.columns[spec.x];
  if (xc.type !== 'integer' && xc.type !== 'float' && xc.type !== 'date') throw new Error(`A histogram needs a numeric or date column; "${xc.name}" is text.`);
  const d = xc.data as Float64Array;
  const all: number[] = [];
  for (let i = 0; i < rows.length; i++) if (d[rows[i]] === d[rows[i]]) all.push(d[rows[i]]);
  const sorted = Float64Array.from(all).sort();
  const bins = histogram(sorted, xc.type === 'integer', spec.bins || undefined);
  const isDate = xc.type === 'date';
  const unitBins = xc.type === 'integer' && bins.length > 0 && bins[0].hi - bins[0].lo === 1;
  const lab = (lo: number, hi: number) =>
    isDate ? `${formatDate(lo)} – ${formatDate(hi)}` : unitBins ? formatStat(lo + 0.5) : `${formatStat(lo)} – ${formatStat(hi)}`;
  const labels = bins.map((b) => lab(b.lo, b.hi));
  const gc = spec.group >= 0 && spec.group !== spec.x ? ds.columns[spec.group] : null;
  let series: Series[];
  if (gc && bins.length) {
    const counts = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const k = keyOf(gc, rows[i]) || '(empty)';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const names = Array.from(counts).sort((a, b) => b[1] - a[1]).slice(0, MAX_GROUPS).map((e) => e[0]);
    const idx = new Map(names.map((n, i) => [n, i]));
    if (counts.size > MAX_GROUPS) names.push('Other');
    const grid = names.map(() => new Array<number>(bins.length).fill(0));
    const lo0 = bins[0].lo;
    const w = bins[0].hi - bins[0].lo || 1;
    for (let i = 0; i < rows.length; i++) {
      const v = d[rows[i]];
      if (v !== v) continue;
      let b = Math.floor((v - lo0) / w);
      if (b >= bins.length) b = bins.length - 1;
      if (b < 0) b = 0;
      const g = idx.get(keyOf(gc, rows[i]) || '(empty)') ?? names.length - 1;
      grid[g][b]++;
    }
    series = names.map((name, g) => ({ name, values: grid[g] }));
  } else series = [{ name: 'Rows', values: bins.map((b) => b.n) }];
  return {
    kind: 'category',
    title: `Distribution of ${xc.name}${gc ? ` by ${gc.name}` : ''}`,
    xLabel: xc.name,
    yLabel: 'Rows',
    labels,
    series,
  };
}

function computeScatter(ds: Dataset, rows: Uint32Array, spec: ChartSpec): ChartData {
  const xc = ds.columns[spec.x];
  const yc = ds.columns[spec.y];
  if (!yc) throw new Error('A scatter plot needs a numeric column for the Y axis.');
  for (const c of [xc, yc]) if (c.type === 'string') throw new Error(`A scatter plot needs numeric or date columns; "${c.name}" is text.`);
  const gc = spec.group >= 0 ? ds.columns[spec.group] : null;
  const step = Math.max(1, Math.ceil(rows.length / MAX_POINTS));
  const groups = new Map<string, { x: number; y: number }[]>();
  let order: string[] = [];
  if (gc) {
    const counts = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
      const k = keyOf(gc, rows[i]) || '(empty)';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    order = Array.from(counts).sort((a, b) => b[1] - a[1]).slice(0, MAX_GROUPS).map((e) => e[0]);
    if (counts.size > MAX_GROUPS) order.push('Other');
  } else order = [`${yc.name} vs ${xc.name}`];
  const keep = new Set(order);
  for (const g of order) groups.set(g, []);
  let plotted = 0;
  for (let i = 0; i < rows.length; i += step) {
    const r = rows[i];
    const x = numericValue(xc, r);
    const y = numericValue(yc, r);
    if (x !== x || y !== y) continue;
    let g = order[0];
    if (gc) {
      const k = keyOf(gc, r) || '(empty)';
      g = keep.has(k) ? k : 'Other';
    }
    groups.get(g)!.push({ x, y });
    plotted++;
  }
  return {
    kind: 'scatter',
    title: `${yc.name} vs ${xc.name}${gc ? ` by ${gc.name}` : ''}`,
    xLabel: xc.name,
    yLabel: yc.name,
    labels: [],
    series: [],
    points: order.map((name) => ({ name, pts: groups.get(name)! })),
    xIsDate: xc.type === 'date',
    yIsDate: yc.type === 'date',
    note: step > 1 ? `Showing a sample of ${plotted.toLocaleString()} of ${rows.length.toLocaleString()} points.` : undefined,
  };
}

function palette(): string[] {
  return ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'].map((v) => cssVar(v) || '#4f46e5');
}

function alpha(color: string, a: number) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color + Math.round(a * 255).toString(16).padStart(2, '0');
  return color;
}

const background: Plugin = {
  id: 'dxBackground',
  beforeDraw(chart) {
    const { ctx, width, height } = chart;
    ctx.save();
    ctx.fillStyle = cssVar('--bg-elev') || '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
};

/** Draw (or redraw) the chart on the canvas. Colors are read from CSS variables. */
export function drawChart(canvas: HTMLCanvasElement, data: ChartData, type: ChartType): Chart {
  const pal = palette();
  const text = cssVar('--text');
  const muted = cssVar('--text-muted');
  const grid = cssVar('--border');
  const elev = cssVar('--bg-elev');
  const font = cssVar('--font-sans') || 'system-ui';
  Chart.defaults.color = muted;
  Chart.defaults.borderColor = grid;
  Chart.defaults.font.family = font;

  const tickFmt = (isDate?: boolean) => (v: number | string) => (isDate ? formatDate(Number(v)) : formatStat(Number(v)));
  const multi = (data.points?.length ?? data.series.length) > 1;
  const pie = type === 'pie' || type === 'doughnut';
  let config: ChartConfiguration;

  if (data.kind === 'scatter') {
    config = {
      type: 'scatter',
      data: {
        datasets: data.points!.map((g, i) => ({
          label: g.name,
          data: g.pts,
          backgroundColor: alpha(pal[i % pal.length], 0.55),
          borderColor: pal[i % pal.length],
          borderWidth: 1,
          pointRadius: g.pts.length > 2000 ? 2 : 3,
          pointHoverRadius: 5,
        })),
      },
      options: {
        scales: {
          x: { type: 'linear', title: { display: true, text: data.xLabel }, ticks: { callback: tickFmt(data.xIsDate), maxRotation: 0 } },
          y: { type: 'linear', title: { display: true, text: data.yLabel }, ticks: { callback: tickFmt(data.yIsDate) } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (c) => {
                const p = c.raw as { x: number; y: number };
                return `${multi ? c.dataset.label + ': ' : ''}${tickFmt(data.xIsDate)(p.x)}, ${tickFmt(data.yIsDate)(p.y)}`;
              },
            },
          },
        },
      },
    };
  } else if (pie) {
    config = {
      type,
      data: {
        labels: data.labels,
        datasets: [
          {
            label: data.series[0].name,
            data: data.series[0].values as number[],
            backgroundColor: data.labels.map((_, i) => (i < pal.length ? pal[i] : alpha(pal[i % pal.length], 0.55))),
            borderColor: elev,
            borderWidth: 2,
          },
        ],
      },
      options: {
        plugins: {
          legend: { position: canvas.clientWidth < 560 ? 'bottom' : 'right' },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${formatStat(Number(c.raw))}` } },
        },
      },
    };
  } else {
    const isLine = type === 'line';
    const hist = type === 'histogram';
    const many = data.labels.length > 60;
    config = {
      type: isLine ? 'line' : 'bar',
      data: {
        labels: data.labels,
        datasets: data.series.map((s, i) => {
          const c = pal[i % pal.length];
          return isLine
            ? {
                label: s.name,
                data: s.values,
                borderColor: c,
                backgroundColor: alpha(c, 0.14),
                fill: !multi,
                tension: 0.25,
                borderWidth: 2,
                pointRadius: many ? 0 : 2.5,
                spanGaps: true,
              }
            : {
                label: s.name,
                data: s.values,
                backgroundColor: alpha(c, 0.85),
                hoverBackgroundColor: c,
                borderRadius: hist ? 0 : 3,
                maxBarThickness: hist ? undefined : 72,
                barPercentage: hist ? 1 : 0.85,
                categoryPercentage: hist ? 1 : 0.8,
                borderWidth: hist ? 1 : 0,
                borderColor: elev,
              };
        }),
      },
      options: {
        scales: {
          x: { stacked: hist && multi, title: { display: true, text: data.xLabel }, ticks: { autoSkip: true, maxRotation: 50 }, grid: { display: false } },
          y: { stacked: hist && multi, beginAtZero: true, title: { display: true, text: data.yLabel }, ticks: { callback: tickFmt(false) } },
        },
        plugins: {
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw == null ? '–' : formatStat(Number(c.raw))}` } },
        },
      },
    };
  }
  config.options = {
    ...config.options,
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    layout: { padding: 8 },
  };
  config.options.plugins = {
    ...config.options.plugins,
    title: { display: true, text: data.title, color: text, font: { size: 14, weight: 600 }, padding: { bottom: 12 } },
    legend: { display: multi || pie, ...(config.options.plugins?.legend ?? {}), labels: { color: muted, boxWidth: 12, boxHeight: 12 } },
  };
  config.plugins = [background];
  return new Chart(canvas, config);
}
