// Charts tab: control wiring, defaults per dataset, lazy Chart.js, PNG export.
import { downloadBlob, escapeHtml, toast } from '../../lib/ui';
import type { Agg, Bucket, ChartSpec, ChartType } from './charts';
import { isNumericType, type Dataset } from './types';
import { keyOf, type DataView } from './view';

type ChartsMod = typeof import('./charts');
let chartsMod: Promise<ChartsMod> | null = null;
const loadCharts = () => (chartsMod ??= import('./charts'));

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel)!;

/** The most "measure-like" numeric column: revenue/amount first, then price/value-like names. */
export function pickMeasure(names: string[], nums: number[]): number {
  for (const re of [/revenue|sales|amount|total|profit|income/i, /price|value|temp|duration|score|cost/i]) {
    const hit = nums.find((i) => re.test(names[i]));
    if (hit !== undefined) return hit;
  }
  return nums[0] ?? -1;
}

export class ChartPanel {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private chart: { destroy(): void } | null = null;
  private spec: ChartSpec = { type: 'bar', x: 0, y: -1, agg: 'count', group: -1, bucket: 'auto', bins: 0, limit: 20, sort: 'value' };
  private ds: Dataset | null = null;
  private getView: () => DataView | null;
  private seq = 0;
  dirty = true;
  title = 'chart';

  constructor(root: HTMLElement, getView: () => DataView | null) {
    this.root = root;
    this.getView = getView;
    this.canvas = $(root, '#dx-chart');
    root.addEventListener('change', (e) => this.onControl(e.target as HTMLElement));
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ctype]');
      if (b) {
        this.spec.type = b.dataset.ctype as ChartType;
        this.fixSpec();
        this.syncControls();
        this.render();
      }
    });
    $(root, '#dx-ch-png').addEventListener('click', () => this.exportPng());
  }

  private onControl(t: HTMLElement) {
    const v = (t as HTMLSelectElement).value;
    switch (t.id) {
      case 'dx-ch-x': this.spec.x = Number(v); break;
      case 'dx-ch-y': this.spec.y = Number(v); if (this.spec.y >= 0 && this.spec.agg === 'count') this.spec.agg = 'sum'; break;
      case 'dx-ch-agg': this.spec.agg = v as Agg; break;
      case 'dx-ch-group': this.spec.group = Number(v); break;
      case 'dx-ch-bucket': this.spec.bucket = v as Bucket; break;
      case 'dx-ch-bins': this.spec.bins = Number(v); break;
      case 'dx-ch-limit': this.spec.limit = Number(v); break;
      case 'dx-ch-sort': this.spec.sort = v as 'value' | 'label'; break;
      default: return;
    }
    this.fixSpec();
    this.syncControls();
    this.render();
  }

  /** Pick sensible defaults for a new dataset. */
  setDataset(ds: Dataset) {
    this.ds = ds;
    this.title = ds.name;
    const cols = ds.columns;
    const n = Math.min(ds.rowCount, 2000);
    const distinct = (c: number) => {
      const s = new Set<string>();
      for (let r = 0; r < n && s.size < 60; r++) s.add(keyOf(cols[c], r));
      return s.size;
    };
    const idLike = (i: number) => cols[i].type === 'integer' && /(^|[\s_])id$|^id$/i.test(cols[i].name);
    const nums = cols.map((_, i) => i).filter((i) => isNumericType(cols[i].type) && !idLike(i) && distinct(i) > 1);
    const y = pickMeasure(cols.map((c) => c.name), nums);
    let x = cols.findIndex((c, i) => (c.type === 'string' || c.type === 'boolean') && distinct(i) >= 2 && distinct(i) <= 30);
    if (x < 0) x = cols.findIndex((c) => c.type === 'date');
    if (x < 0) x = nums.find((i) => i !== y) ?? 0;
    this.spec = { type: 'bar', x, y, agg: y >= 0 ? 'sum' : 'count', group: -1, bucket: 'auto', bins: 0, limit: 20, sort: 'value' };
    const opt = (i: number) => `<option value="${i}">${escapeHtml(cols[i].name)}</option>`;
    const all = cols.map((_, i) => opt(i)).join('');
    $<HTMLSelectElement>(this.root, '#dx-ch-x').innerHTML = all;
    $<HTMLSelectElement>(this.root, '#dx-ch-y').innerHTML = `<option value="-1">Row count</option>${cols.map((c, i) => (c.type === 'string' ? '' : opt(i))).join('')}`;
    $<HTMLSelectElement>(this.root, '#dx-ch-group').innerHTML = `<option value="-1">None</option>${cols.map((c, i) => (c.type === 'string' || c.type === 'boolean' ? opt(i) : '')).join('')}`;
    this.fixSpec();
    this.syncControls();
    this.dirty = true;
  }

  /** Programmatic spec change (used by "Chart this column" in the profile). */
  setSpec(patch: Partial<ChartSpec>) {
    Object.assign(this.spec, patch);
    this.fixSpec();
    this.syncControls();
    this.dirty = true;
  }

  private fixSpec() {
    const ds = this.ds;
    if (!ds) return;
    const s = this.spec;
    const cols = ds.columns;
    if (s.type === 'scatter') {
      if (cols[s.x]?.type === 'string') s.x = cols.findIndex((c) => c.type !== 'string');
      if (s.y < 0 || cols[s.y]?.type === 'string') s.y = cols.findIndex((c, i) => isNumericType(c.type) && i !== s.x);
    }
    if (s.type === 'histogram' && !(isNumericType(cols[s.x]?.type) || cols[s.x]?.type === 'date')) {
      const num = s.y >= 0 && isNumericType(cols[s.y].type) ? s.y : cols.findIndex((c) => isNumericType(c.type));
      if (num >= 0) s.x = num;
    }
    if (s.x < 0) s.x = 0;
    if (s.y < 0 && s.agg !== 'count') s.agg = 'count';
  }

  private syncControls() {
    const s = this.spec;
    const ds = this.ds;
    if (!ds) return;
    this.root.querySelectorAll<HTMLElement>('[data-ctype]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ctype === s.type)));
    const set = (id: string, v: string | number) => {
      $<HTMLSelectElement>(this.root, id).value = String(v);
    };
    set('#dx-ch-x', s.x);
    set('#dx-ch-y', s.y);
    set('#dx-ch-agg', s.agg);
    set('#dx-ch-group', s.group);
    set('#dx-ch-bucket', s.bucket);
    set('#dx-ch-bins', s.bins);
    set('#dx-ch-limit', s.limit);
    set('#dx-ch-sort', s.sort);
    const show = (f: string, on: boolean) => {
      $(this.root, `[data-f="${f}"]`).hidden = !on;
    };
    const pie = s.type === 'pie' || s.type === 'doughnut';
    const cat = s.type === 'bar' || s.type === 'line' || pie;
    show('y', s.type !== 'histogram');
    show('agg', cat && s.y >= 0);
    show('group', !pie);
    show('bucket', cat && ds.columns[s.x]?.type === 'date');
    show('bins', s.type === 'histogram');
    show('limit', cat);
    show('sort', cat && s.type !== 'line');
    $(this.root, '[data-f="x"] .label').textContent = pie ? 'Slices' : s.type === 'histogram' ? 'Column' : 'X axis';
    $(this.root, '[data-f="y"] .label').textContent = pie ? 'Value' : 'Y axis';
    $(this.root, '[data-f="group"] .label').textContent = s.type === 'scatter' ? 'Color by' : 'Group by';
    const yNone = $<HTMLSelectElement>(this.root, '#dx-ch-y').querySelector<HTMLOptionElement>('option[value="-1"]');
    if (yNone) yNone.disabled = s.type === 'scatter';
  }

  /** Compute on the view's filtered rows and draw. */
  async render() {
    const view = this.getView();
    const ds = this.ds;
    if (!view || !ds || view.ds !== ds) return;
    this.dirty = false;
    const seq = ++this.seq;
    const err = $(this.root, '#dx-ch-error');
    const note = $(this.root, '#dx-ch-note');
    const box = $(this.root, '.dx-chart-box');
    box.classList.add('is-loading');
    let mod: ChartsMod;
    try {
      mod = await loadCharts();
    } catch (e) {
      err.textContent = `Could not load the chart library: ${(e as Error).message}`;
      err.hidden = false;
      return;
    }
    if (seq !== this.seq) return;
    box.classList.remove('is-loading');
    this.chart?.destroy();
    this.chart = null;
    try {
      if (!view.indices.length) throw new Error('No rows match the current filters, so there is nothing to chart.');
      const data = mod.computeChart(ds, view.indices, this.spec);
      const empty = data.kind === 'scatter' ? !data.points!.some((p) => p.pts.length) : !data.labels.length;
      if (empty) throw new Error('The selected columns have no values to plot.');
      err.hidden = true;
      this.chart = mod.drawChart(this.canvas, data, this.spec.type);
      this.canvas.setAttribute('aria-label', `${data.title}. ${data.kind === 'scatter' ? '' : `${data.labels.length} categories.`}`);
      this.title = data.title;
      const filtered = view.indices.length !== ds.rowCount ? `Computed on ${view.indices.length.toLocaleString()} filtered rows of ${ds.rowCount.toLocaleString()}.` : '';
      note.textContent = [data.note, filtered].filter(Boolean).join(' ');
      box.hidden = false;
      this.root.dataset.chartRev = String(Number(this.root.dataset.chartRev || 0) + 1);
    } catch (e) {
      err.textContent = (e as Error).message;
      err.hidden = false;
      note.textContent = '';
      box.hidden = true;
      this.root.dataset.chartRev = String(Number(this.root.dataset.chartRev || 0) + 1);
    }
  }

  exportPng() {
    if (!this.chart) {
      toast('Nothing to export yet', 'error');
      return;
    }
    const name = this.title.replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'chart';
    this.canvas.toBlob((b) => {
      if (!b) return toast('Could not export the chart', 'error');
      downloadBlob(b, `${name}.png`);
      toast('Chart downloaded as PNG');
    }, 'image/png');
  }
}
