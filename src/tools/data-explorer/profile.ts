// Column profile: summary statistics, histogram and top values for one column,
// computed over the rows that pass the current filters.
import { escapeHtml } from '../../lib/ui';
import { formatDate, formatStat } from './format';
import { BOOL_NULL, TYPE_LABEL, type Column } from './types';
import { keyOf } from './view';

export interface NumStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  std: number;
  q: { p: number; v: number }[];
  sum: number;
}

export interface Bin {
  lo: number;
  hi: number;
  n: number;
}

export function quantileSorted(s: Float64Array, p: number): number {
  if (!s.length) return NaN;
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}

/** Non-missing numeric values (numbers or epoch dates) for the given rows, sorted. */
export function sortedValues(col: Column, rows: Uint32Array): Float64Array {
  const d = col.data as Float64Array;
  const out = new Float64Array(rows.length);
  let m = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = d[rows[i]];
    if (v === v) out[m++] = v;
  }
  return out.subarray(0, m).sort();
}

export function numStats(s: Float64Array): NumStats {
  const n = s.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  const mean = n ? sum / n : NaN;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (s[i] - mean) ** 2;
  return {
    count: n,
    min: n ? s[0] : NaN,
    max: n ? s[n - 1] : NaN,
    mean,
    median: quantileSorted(s, 0.5),
    std: n > 1 ? Math.sqrt(ss / (n - 1)) : NaN,
    q: [0.05, 0.25, 0.75, 0.95].map((p) => ({ p, v: quantileSorted(s, p) })),
    sum,
  };
}

/** Histogram bins (Freedman–Diaconis, clamped). Integers with a small range get one bin per value. */
export function histogram(s: Float64Array, integer: boolean, wanted?: number): Bin[] {
  const n = s.length;
  if (!n) return [];
  const min = s[0];
  const max = s[n - 1];
  if (min === max) return [{ lo: min, hi: max, n }];
  let k: number;
  if (wanted && wanted > 0) k = Math.min(200, Math.round(wanted));
  else if (integer && max - min < 30) k = max - min + 1;
  else {
    const iqr = quantileSorted(s, 0.75) - quantileSorted(s, 0.25);
    const h = (2 * iqr) / Math.cbrt(n);
    k = h > 0 ? Math.ceil((max - min) / h) : Math.ceil(Math.log2(n) + 1);
    k = Math.max(5, Math.min(40, k));
  }
  let width = (max - min) / k;
  let lo0 = min;
  if (integer && !wanted && max - min < 30) {
    width = 1;
    lo0 = min - 0.5;
  }
  const bins: Bin[] = Array.from({ length: k }, (_, i) => ({ lo: lo0 + i * width, hi: lo0 + (i + 1) * width, n: 0 }));
  for (let i = 0; i < n; i++) {
    let b = Math.floor((s[i] - lo0) / width);
    if (b >= k) b = k - 1;
    if (b < 0) b = 0;
    bins[b].n++;
  }
  return bins;
}

export function topValues(col: Column, rows: Uint32Array, limit = 10) {
  const counts = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const k = keyOf(col, rows[i]);
    if (k === '') continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const all = Array.from(counts, ([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || (a.value < b.value ? -1 : 1));
  return { top: all.slice(0, limit), unique: counts.size, other: all.slice(limit).reduce((s, x) => s + x.n, 0) };
}

function missingCount(col: Column, rows: Uint32Array) {
  let m = 0;
  if (col.type === 'string') {
    const d = col.data as (string | null)[];
    for (let i = 0; i < rows.length; i++) if (d[rows[i]] == null) m++;
  } else if (col.type === 'boolean') {
    const d = col.data as Uint8Array;
    for (let i = 0; i < rows.length; i++) if (d[rows[i]] === BOOL_NULL) m++;
  } else {
    const d = col.data as Float64Array;
    for (let i = 0; i < rows.length; i++) if (d[rows[i]] !== d[rows[i]]) m++;
  }
  return m;
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(a && a / b < 0.001 ? 2 : 1)}%` : '–');

function stat(label: string, value: string, key: string) {
  return `<div class="dx-stat" data-stat="${key}"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function histHtml(bins: Bin[], label: (b: Bin) => string) {
  const max = Math.max(1, ...bins.map((b) => b.n));
  const bars = bins
    .map((b) => `<div class="dx-hbar" style="height:${Math.max(b.n ? 3 : 0, (b.n / max) * 100)}%" title="${escapeHtml(label(b))}: ${b.n.toLocaleString()}"></div>`)
    .join('');
  return `<div class="dx-hist" role="img" aria-label="Histogram with ${bins.length} bins">${bars}</div>
    <div class="dx-hist-axis small faint"><span>${escapeHtml(label(bins[0]).split(' – ')[0])}</span><span>${escapeHtml(label(bins[bins.length - 1]).split(' – ').pop()!)}</span></div>`;
}

function topHtml(t: ReturnType<typeof topValues>, total: number) {
  if (!t.top.length) return '<p class="small faint">No values.</p>';
  const max = t.top[0].n;
  let html = '<ol class="dx-top">';
  for (const { value, n } of t.top) {
    html += `<li title="${escapeHtml(value)}"><span class="dx-top-bar" style="width:${(n / max) * 100}%"></span><span class="dx-top-val">${escapeHtml(value.length > 60 ? value.slice(0, 60) + '…' : value)}</span><span class="dx-top-n">${n.toLocaleString()} <span class="faint">${pct(n, total)}</span></span></li>`;
  }
  html += '</ol>';
  if (t.other) html += `<p class="small faint dx-top-other">+ ${(t.unique - t.top.length).toLocaleString()} more values (${t.other.toLocaleString()} rows)</p>`;
  return html;
}

/** Render the profile of one column for the given rows. */
export function renderProfile(col: Column, rows: Uint32Array, totalRows: number): string {
  const n = rows.length;
  const miss = missingCount(col, rows);
  let html = `<div class="dx-prof-head"><h3 class="dx-prof-name">${escapeHtml(col.name)}</h3><span class="badge badge-accent dx-prof-type">${TYPE_LABEL[col.type]}</span></div>`;
  html += `<p class="small muted dx-prof-scope">${n === totalRows ? `All ${n.toLocaleString()} rows` : `${n.toLocaleString()} filtered rows of ${totalRows.toLocaleString()}`}</p>`;
  html += '<dl class="dx-stats">';
  html += stat('Values', (n - miss).toLocaleString(), 'count');
  html += stat('Missing', `${miss.toLocaleString()} <span class="faint">(${pct(miss, n)})</span>`, 'missing');

  if (col.type === 'integer' || col.type === 'float') {
    const s = sortedValues(col, rows);
    const st = numStats(s);
    const uniq = new Set(s).size;
    html += stat('Unique', uniq.toLocaleString(), 'unique');
    html += stat('Sum', formatStat(st.sum), 'sum');
    html += stat('Min', formatStat(st.min), 'min');
    html += stat('Max', formatStat(st.max), 'max');
    html += stat('Mean', formatStat(st.mean), 'mean');
    html += stat('Median', formatStat(st.median), 'median');
    html += stat('Std dev', formatStat(st.std), 'std');
    html += stat('Q1 · Q3', `${formatStat(st.q[1].v)} · ${formatStat(st.q[2].v)}`, 'quartiles');
    html += stat('P5 · P95', `${formatStat(st.q[0].v)} · ${formatStat(st.q[3].v)}`, 'p5p95');
    html += '</dl>';
    if (s.length) {
      const bins = histogram(s, col.type === 'integer');
      const lab = (b: Bin) => (col.type === 'integer' && bins.length && bins[0].hi - bins[0].lo === 1 ? formatStat(b.lo + 0.5) : `${formatStat(b.lo)} – ${formatStat(b.hi)}`);
      html += `<h4 class="dx-prof-sub">Distribution</h4>${histHtml(bins, lab)}`;
    }
    if (uniq <= 12 && s.length) html += `<h4 class="dx-prof-sub">Top values</h4>${topHtml(topValues(col, rows), n)}`;
    return html;
  }

  if (col.type === 'date') {
    const s = sortedValues(col, rows);
    const uniq = new Set(s).size;
    html += stat('Unique', uniq.toLocaleString(), 'unique');
    if (s.length) {
      const days = (s[s.length - 1] - s[0]) / 86400000;
      html += stat('Earliest', formatDate(s[0], col.hasTime), 'min');
      html += stat('Latest', formatDate(s[s.length - 1], col.hasTime), 'max');
      html += stat('Span', days >= 1 ? `${formatStat(Math.round(days))} days` : `${formatStat(Math.round(days * 24 * 10) / 10)} hours`, 'span');
      html += stat('Median', formatDate(quantileSorted(s, 0.5), col.hasTime), 'median');
    }
    html += '</dl>';
    if (s.length > 1 && s[0] !== s[s.length - 1]) {
      const bins = histogram(s, false);
      html += `<h4 class="dx-prof-sub">Over time</h4>${histHtml(bins, (b) => `${formatDate(b.lo)} – ${formatDate(b.hi)}`)}`;
    }
    return html;
  }

  const t = topValues(col, rows);
  html += stat('Unique', t.unique.toLocaleString(), 'unique');
  if (col.type === 'string') {
    const d = col.data as (string | null)[];
    let minL = Infinity;
    let maxL = 0;
    let sumL = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      const v = d[rows[i]];
      if (v == null) continue;
      cnt++;
      sumL += v.length;
      if (v.length < minL) minL = v.length;
      if (v.length > maxL) maxL = v.length;
    }
    if (cnt) html += stat('Length', `${minL} – ${maxL} <span class="faint">(avg ${formatStat(Math.round((sumL / cnt) * 10) / 10)})</span>`, 'length');
  }
  html += '</dl>';
  html += `<h4 class="dx-prof-sub">${col.type === 'boolean' ? 'Values' : 'Top values'}</h4>${topHtml(t, n)}`;
  return html;
}
