// Data Explorer controller: loading (file / paste / sample) through the parse worker,
// the table with filters, the column profile, charts, SQL and exports.
import { debounce, downloadText, escapeHtml, formatBytes, initTabs, onThemeChange, setupDropzone, toast } from '../../lib/ui';
import { ChartPanel, pickMeasure } from './chart-ui';
import { baseName, viewToCsv, viewToJson } from './export';
import { Popover, describeFilter, openColumns, openFilter } from './filters';
import { isPlainInt, setNumFmt, type NumFmt } from './format';
import { Grid } from './grid';
import type { ParseMessage, ParseRequest } from './parse.worker';
import { renderProfile } from './profile';
import { SAMPLES } from './samples';
import { errorHtml, examplesFor, loadAlasql, quoteIdent, rowsForSql, runSql, type Example } from './sql';
import { TYPE_ICON, TYPE_LABEL, isNumericType, type Dataset } from './types';
import { DataView } from './view';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const DELIM_NAME: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe', ':': 'colon', '^': 'caret', '~': 'tilde', ' ': 'space' };
const delimLabel = (d?: string) => (d ? DELIM_NAME[d] ?? `“${d}”` : '');

interface Source {
  source: File | string;
  name: string;
  format?: string;
}

export function init() {
  const root = $('#dx');
  const errorEl = $('#dx-error');
  const warnEl = $('#dx-warn');
  const progEl = $('#dx-progress');
  const progBar = $('#dx-progress-bar');
  const progLabel = $('#dx-progress-label');
  const progPct = $('#dx-progress-pct');
  const countEl = $('#dx-count');
  const chipsEl = $('#dx-chips');
  const searchEl = $<HTMLInputElement>('#dx-search');
  const profSel = $<HTMLSelectElement>('#dx-prof-col');
  const profBody = $('#dx-prof-body');
  const delimSel = $<HTMLSelectElement>('#dx-delim');
  const headerChk = $<HTMLInputElement>('#dx-header');
  const pasteDlg = $<HTMLDialogElement>('#dx-paste');
  const pasteText = $<HTMLTextAreaElement>('#dx-paste-text');
  const pop = new Popover($('#dx-pop'));

  // ---------------------------------------------------------------- state
  let ds: Dataset | null = null;
  let view: DataView | null = null;
  let original: Dataset | null = null; // set while a query result is used as the dataset
  let lastSource: Source | null = null;
  let profCol = 0;
  let activeTab = 'table';
  let sqlRows: Record<string, unknown>[] | null = null;
  let sqlRowsKey = '';
  let sqlView: DataView | null = null;
  let sqlAutoRan: Dataset | null = null;

  const bump = (key: string) => (root.dataset[key] = String(Number(root.dataset[key] || 0) + 1));

  // ---------------------------------------------------------------- grid + panels
  const grid = new Grid($('#dx-grid'), {
    filters: true,
    onSortChange: () => update(),
    onFilterClick: (c, anchor) => {
      if (!view) return;
      if (pop.isFor(anchor)) return pop.close(true);
      openFilter(pop, view, c, anchor, () => update());
    },
    onSelect: (_r, c) => setProfile(c),
    emptyHtml: () =>
      `<p><strong>No rows match.</strong></p><p class="small muted">Try a different search or <button type="button" class="btn btn-sm" data-act="clear-filters">clear all filters</button></p>`,
  });
  const sqlGrid = new Grid($('#dx-sql-grid'), {
    onSortChange: () => {
      sqlView?.recompute();
      sqlGrid.refresh();
    },
    emptyHtml: () => '<p class="small muted">The query returned no rows.</p>',
  });
  const charts = new ChartPanel($('#dx-chart-panel'), () => view);

  // ---------------------------------------------------------------- loading
  let worker: Worker | null = null;
  let reqId = 0;
  let pending: { id: number; reject: (e: Error) => void } | null = null;

  function getWorker() {
    worker ??= new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
    return worker;
  }

  function showProgress(label: string, ratio: number) {
    progEl.hidden = false;
    progLabel.textContent = label;
    const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    progBar.style.width = `${Math.max(3, pct)}%`;
    progPct.textContent = `${pct}%`;
    progEl.querySelector('[role="progressbar"]')!.setAttribute('aria-valuenow', String(pct));
  }

  function parse(src: Source, delimiter: string, header: boolean): Promise<Dataset> {
    const id = ++reqId;
    pending?.reject(new Error('cancelled'));
    return new Promise<Dataset>((resolve, reject) => {
      pending = { id, reject };
      const w = getWorker();
      const onMsg = (e: MessageEvent<ParseMessage>) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === 'progress') {
          const phase = m.phase === 'types' ? 'Detecting column types' : m.phase === 'read' ? 'Reading' : 'Parsing';
          showProgress(`${phase}… ${src.name}`, m.ratio);
          return;
        }
        w.removeEventListener('message', onMsg);
        w.removeEventListener('error', onErr);
        if (pending?.id === id) pending = null;
        if (m.type === 'done') resolve(m.dataset);
        else reject(new Error(m.message));
      };
      const onErr = (e: ErrorEvent) => {
        w.removeEventListener('message', onMsg);
        w.removeEventListener('error', onErr);
        worker?.terminate();
        worker = null;
        reject(new Error(e.message || 'The parser stopped unexpectedly.'));
      };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      const req: ParseRequest = { id, source: src.source, name: src.name, delimiter, header, format: src.format };
      w.postMessage(req);
    });
  }

  async function load(src: Source, opts: { delimiter?: string; header?: boolean } = {}) {
    const delimiter = opts.delimiter ?? 'auto';
    const header = opts.header ?? true;
    errorEl.hidden = true;
    pop.close(false);
    showProgress(`Reading… ${src.name}`, 0);
    root.classList.add('dx-busy');
    try {
      const t0 = performance.now();
      const next = await parse(src, delimiter, header);
      lastSource = src;
      original = null;
      delimSel.value = delimiter;
      headerChk.checked = header;
      setDataset(next);
      const ms = performance.now() - t0;
      if (next.rowCount >= 20000) toast(`Loaded ${next.rowCount.toLocaleString()} rows in ${(ms / 1000).toFixed(1)} s`);
    } catch (e) {
      if ((e as Error).message === 'cancelled') return;
      showError(`Could not open ${src.name}: ${(e as Error).message}`);
    } finally {
      if (!pending) {
        progEl.hidden = true;
        root.classList.remove('dx-busy');
      }
    }
  }

  function showError(msg: string) {
    errorEl.innerHTML = `<strong>Something went wrong.</strong> ${escapeHtml(msg)}`;
    errorEl.hidden = false;
    bump('errors');
  }

  $('#dx-cancel').addEventListener('click', () => {
    pending?.reject(new Error('cancelled'));
    pending = null;
    worker?.terminate();
    worker = null;
    progEl.hidden = true;
    root.classList.remove('dx-busy');
    toast('Loading cancelled');
  });

  function loadFile(f: File) {
    if (f.size > 1024 * 1024 * 1024) return showError(`${f.name} is ${formatBytes(f.size)}; files over 1 GB are too large to open in a browser tab.`);
    load({ source: f, name: f.name });
  }

  function loadSample(id: string) {
    const s = SAMPLES.find((x) => x.id === id);
    if (!s) return;
    load({ source: s.make(), name: s.name, format: 'csv' });
  }

  // ---------------------------------------------------------------- dataset
  function setDataset(next: Dataset, derived = false) {
    if (derived && ds && !original) original = ds;
    if (!derived) original = null;
    ds = next;
    view = new DataView(next);
    searchEl.value = '';
    root.classList.add('dx-has-data');
    grid.setView(view);
    // Profile defaults to the first "interesting" numeric column.
    const nums = next.columns.map((_, i) => i).filter((i) => isNumericType(next.columns[i].type) && !isPlainInt(next.columns[i]));
    const firstNum = pickMeasure(next.columns.map((c) => c.name), nums);
    profSel.innerHTML = next.columns.map((c, i) => `<option value="${i}">${escapeHtml(c.name)} · ${TYPE_LABEL[c.type]}</option>`).join('');
    profCol = firstNum >= 0 ? firstNum : 0;
    renderDsBar();
    charts.setDataset(next);
    sqlRows = null;
    sqlView = null;
    $('#dx-sql-out').hidden = true;
    $('#dx-sql-error').hidden = true;
    $('#dx-sql-status').textContent = '';
    renderSqlSide(next);
    const w = next.meta.warnings ?? [];
    warnEl.hidden = !w.length;
    if (w.length) warnEl.innerHTML = `<strong>Some rows looked irregular</strong> (they were still loaded):<ul>${w.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
    update();
    bump('rev');
    if (activeTab === 'sql') maybeAutoRun();
  }

  function renderDsBar() {
    if (!ds) return;
    const m = ds.meta;
    $('#dx-ds-name').textContent = ds.name;
    const bits = [`${ds.rowCount.toLocaleString()} rows`, `${ds.columns.length} columns`];
    if (m.bytes) bits.push(formatBytes(m.bytes));
    if (m.format === 'csv' && m.delimiter) bits.push(`${delimLabel(m.delimiter)}-separated`);
    if (m.format === 'json') bits.push('JSON');
    if (m.format === 'sql') bits.push('from SQL');
    if (m.decimalComma) bits.push('decimal commas');
    $('#dx-ds-meta').textContent = bits.join(' · ');
    const canReparse = m.format === 'csv' && !!lastSource && !original;
    $('#dx-parse-opts').hidden = !canReparse;
    const autoOpt = delimSel.querySelector<HTMLOptionElement>('option[value="auto"]')!;
    autoOpt.textContent = m.delimiter && delimSel.value === 'auto' ? `Auto (${delimLabel(m.delimiter)})` : 'Auto-detect';
    const back = $('#dx-back');
    back.hidden = !original;
    if (original) back.querySelector('span')!.textContent = `Back to ${original.name}`;
  }

  const reparse = () => {
    if (lastSource) load(lastSource, { delimiter: delimSel.value, header: headerChk.checked });
  };
  delimSel.addEventListener('change', reparse);
  headerChk.addEventListener('change', reparse);

  $('#dx-back').addEventListener('click', () => {
    if (!original) return;
    const o = original;
    original = null;
    setDataset(o);
    toast(`Back to ${o.name}`);
  });

  // ---------------------------------------------------------------- view updates
  function update() {
    if (!view || !ds) return;
    view.recompute();
    grid.refresh();
    const n = view.indices.length;
    countEl.innerHTML = `Showing <b>${n.toLocaleString()}</b> of <b>${ds.rowCount.toLocaleString()}</b> rows`;
    countEl.classList.toggle('is-filtered', n !== ds.rowCount);
    renderChips();
    renderProfileNow();
    if (activeTab === 'chart') charts.render();
    else charts.dirty = true;
    bump('viewRev');
  }

  function renderChips() {
    if (!view || !ds) return;
    const chips: string[] = [];
    if (view.search.trim()) chips.push(`<span class="dx-chip"><span><b>Search</b> “${escapeHtml(view.search.trim())}”</span><button type="button" class="dx-chip-x" data-clear="search" aria-label="Clear search">×</button></span>`);
    for (const [c, f] of view.filters) {
      const col = ds.columns[c];
      chips.push(
        `<span class="dx-chip"><button type="button" class="dx-chip-edit" data-edit="${c}"><b>${escapeHtml(col.name)}</b> ${escapeHtml(describeFilter(col, f))}</button><button type="button" class="dx-chip-x" data-clear="${c}" aria-label="Remove filter on ${escapeHtml(col.name)}">×</button></span>`,
      );
    }
    chipsEl.innerHTML = chips.join('');
    chipsEl.hidden = !chips.length;
    $('#dx-clear').hidden = !chips.length;
    const hiddenN = view.hidden.size;
    $('#dx-cols-n').textContent = hiddenN ? `${view.visibleColumns.length}/${view.order.length}` : '';
  }

  function clearFilters() {
    if (!view) return;
    view.filters.clear();
    view.search = '';
    searchEl.value = '';
    update();
  }

  chipsEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const x = t.closest<HTMLElement>('[data-clear]');
    if (x && view) {
      if (x.dataset.clear === 'search') {
        view.search = '';
        searchEl.value = '';
      } else view.filters.delete(Number(x.dataset.clear));
      update();
      return;
    }
    const ed = t.closest<HTMLElement>('[data-edit]');
    if (ed && view) {
      const c = Number(ed.dataset.edit);
      if (view.hidden.has(c)) {
        view.hidden.delete(c);
        grid.refresh();
      }
      openFilter(pop, view, c, ed, () => update());
    }
  });
  root.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-act="clear-filters"]')) clearFilters();
  });
  $('#dx-clear').addEventListener('click', clearFilters);

  const onSearch = debounce(() => {
    if (!view) return;
    view.search = searchEl.value;
    update();
  }, 200);
  searchEl.addEventListener('input', onSearch);
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchEl.value) {
      searchEl.value = '';
      onSearch();
    }
  });

  $('#dx-cols-btn').addEventListener('click', (e) => {
    if (!view) return;
    const b = e.currentTarget as HTMLElement;
    if (pop.isFor(b)) return pop.close(true);
    openColumns(pop, view, b, () => {
      grid.refresh();
      renderChips();
      if (view!.search.trim()) update();
    });
  });

  $<HTMLSelectElement>('#dx-numfmt').addEventListener('change', (e) => {
    setNumFmt((e.target as HTMLSelectElement).value as NumFmt);
    grid.refresh();
    if (sqlView) sqlGrid.refresh();
  });

  // ---------------------------------------------------------------- profile
  function setProfile(c: number) {
    profCol = c;
    renderProfileNow();
  }
  function renderProfileNow() {
    if (!view || !ds) return;
    const col = ds.columns[profCol];
    if (!col) return;
    profSel.value = String(profCol);
    profBody.innerHTML = renderProfile(col, view.indices, ds.rowCount);
    bump('profRev');
  }
  profSel.addEventListener('change', () => setProfile(Number(profSel.value)));
  $('#dx-prof-chart').addEventListener('click', () => {
    if (!ds) return;
    const col = ds.columns[profCol];
    const numeric = isNumericType(col.type) || col.type === 'date';
    charts.setSpec(numeric && col.type !== 'date' ? { type: 'histogram', x: profCol, bins: 0, group: -1 } : { type: 'bar', x: profCol, y: -1, agg: 'count', group: -1 });
    selectTab('chart');
  });

  // ---------------------------------------------------------------- exports
  const exportView = (v: DataView | null, name: string, kind: 'csv' | 'json') => {
    if (!v) return;
    if (!v.indices.length) return toast('No rows to export', 'error');
    const text = kind === 'csv' ? viewToCsv(v) : viewToJson(v);
    downloadText(text, `${name}.${kind}`, kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/json');
    toast(`Exported ${v.indices.length.toLocaleString()} rows as ${kind.toUpperCase()}`);
  };
  const dsBase = () => (ds ? baseName(ds.name) + (view?.isFiltered ? '-filtered' : '') : 'data');
  $('#dx-exp-csv').addEventListener('click', () => exportView(view, dsBase(), 'csv'));
  $('#dx-exp-json').addEventListener('click', () => exportView(view, dsBase(), 'json'));
  $('#dx-sql-csv').addEventListener('click', () => exportView(sqlView, 'query-result', 'csv'));
  $('#dx-sql-json').addEventListener('click', () => exportView(sqlView, 'query-result', 'json'));

  // ---------------------------------------------------------------- SQL
  const sqlInput = $<HTMLTextAreaElement>('#dx-sql');
  const sqlStatus = $('#dx-sql-status');
  const sqlErr = $('#dx-sql-error');
  const sqlRunBtn = $<HTMLButtonElement>('#dx-sql-run');
  const sqlFiltered = $<HTMLInputElement>('#dx-sql-filtered');
  let examples: Example[] = [];

  function renderSqlSide(d: Dataset) {
    examples = examplesFor(d);
    $('#dx-sql-examples').innerHTML = examples.map((x, i) => `<button type="button" class="btn btn-sm dx-ex" data-ex="${i}">${escapeHtml(x.label)}</button>`).join('');
    $('#dx-sql-cols').innerHTML = d.columns
      .map((c) => {
        const q = quoteIdent(c.name);
        return `<button type="button" class="dx-sql-col" data-ins="${escapeHtml(q)}" title="Insert ${escapeHtml(q)} · ${TYPE_LABEL[c.type]}"><span class="dx-tico dx-t-${c.type}" aria-hidden="true">${TYPE_ICON[c.type]}</span><code>${escapeHtml(q)}</code></button>`;
      })
      .join('');
    const spaced = d.columns.find((c) => quoteIdent(c.name) !== c.name);
    $('#dx-sql-quote').innerHTML = spaced
      ? `Names with spaces, symbols or SQL keywords go in brackets: <code>${escapeHtml(quoteIdent(spaced.name))}</code>. Text values use single quotes: <code>'North'</code>.`
      : `Text values use single quotes, e.g. <code>'North'</code>. A column name with spaces would go in brackets: <code>[Order Date]</code>.`;
    if (!sqlInput.value.trim() || sqlInput.dataset.auto === '1') {
      sqlInput.value = (examples[1] ?? examples[0]).sql;
      sqlInput.dataset.auto = '1';
    }
    sqlFiltered.checked = false;
    updateFilteredLabel();
  }
  function updateFilteredLabel() {
    $('#dx-sql-filtered-label').textContent = view && view.isFiltered ? `Only the ${view.indices.length.toLocaleString()} filtered rows` : 'Only the filtered rows';
  }
  sqlInput.addEventListener('input', () => (sqlInput.dataset.auto = '0'));

  $('#dx-sql-examples').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ex]');
    if (!b) return;
    sqlInput.value = examples[Number(b.dataset.ex)].sql;
    sqlInput.dataset.auto = '0';
    runQuery();
  });
  $('#dx-sql-cols').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ins]');
    if (!b) return;
    const ins = b.dataset.ins!;
    const { selectionStart: s, selectionEnd: en, value } = sqlInput;
    sqlInput.value = value.slice(0, s) + ins + value.slice(en);
    sqlInput.focus();
    sqlInput.setSelectionRange(s + ins.length, s + ins.length);
    sqlInput.dataset.auto = '0';
  });
  sqlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runQuery();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      // Indent with two spaces; Esc then Tab still leaves the field.
      if (sqlInput.dataset.escaped === '1') return;
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = sqlInput;
      sqlInput.value = value.slice(0, s) + '  ' + value.slice(en);
      sqlInput.setSelectionRange(s + 2, s + 2);
    }
    sqlInput.dataset.escaped = e.key === 'Escape' ? '1' : '0';
  });
  sqlRunBtn.addEventListener('click', () => runQuery());
  sqlFiltered.addEventListener('change', () => runQuery());

  let running = false;
  async function runQuery() {
    if (!ds || !view || running) return;
    running = true;
    sqlRunBtn.disabled = true;
    sqlStatus.textContent = 'Running…';
    sqlErr.hidden = true;
    const d = ds;
    try {
      await new Promise((r) => setTimeout(r, 16)); // let "Running…" paint
      const useFiltered = sqlFiltered.checked && view.isFiltered;
      const key = useFiltered ? `f:${root.dataset.viewRev}` : 'all';
      if (!sqlRows || sqlRowsKey !== key) {
        sqlRows = rowsForSql(d, useFiltered ? view.indices : undefined);
        sqlRowsKey = key;
      }
      const res = await runSql(sqlInput.value, sqlRows);
      if (ds !== d) return;
      sqlView = new DataView(res.dataset);
      $('#dx-sql-out').hidden = false;
      // Size the result box to its rows (up to the usual height).
      sqlGrid.root.style.height = `${Math.min(560, 38 + Math.max(3, res.dataset.rowCount) * 30 + 18)}px`;
      sqlGrid.setView(sqlView);
      const n = res.dataset.rowCount;
      sqlStatus.innerHTML = `<b>${n.toLocaleString()}</b> row${n === 1 ? '' : 's'} · ${res.dataset.columns.length} column${res.dataset.columns.length === 1 ? '' : 's'} · ${res.ms < 10 ? res.ms.toFixed(1) : Math.round(res.ms)} ms${res.warning ? ` · <span class="faint">${escapeHtml(res.warning)}</span>` : ''}`;
      $<HTMLButtonElement>('#dx-sql-use').disabled = !n || !res.dataset.columns.length;
    } catch (e) {
      sqlErr.innerHTML = errorHtml(e);
      sqlErr.hidden = false;
      sqlStatus.textContent = '';
    } finally {
      running = false;
      sqlRunBtn.disabled = false;
      bump('sqlRev');
    }
  }

  /** Run the example query once per dataset, unless the user has written their own. */
  function maybeAutoRun() {
    if (!ds || sqlAutoRan === ds) return;
    sqlAutoRan = ds;
    if (sqlInput.dataset.auto === '1') runQuery();
    else if (!sqlView) sqlStatus.textContent = 'Press Ctrl+Enter to run the query.';
  }

  $('#dx-sql-use').addEventListener('click', () => {
    if (!sqlView) return;
    const res = sqlView.ds;
    const src = ds;
    selectTab('table');
    setDataset({ ...res, name: `Query on ${original?.name ?? src?.name ?? 'data'}` }, true);
    toast(`Now exploring the query result (${res.rowCount.toLocaleString()} rows)`);
  });

  // ---------------------------------------------------------------- tabs
  function selectTab(name: string) {
    $<HTMLButtonElement>(`[data-tabs="dx"] [data-tab="${name}"]`).click();
  }
  initTabs(root, (_g, tab) => {
    activeTab = tab;
    pop.close(false);
    if (tab === 'chart' && charts.dirty) charts.render();
    if (tab === 'sql') {
      updateFilteredLabel();
      if (!ds) return;
      sqlStatus.textContent = 'Loading the SQL engine…';
      loadAlasql()
        .then(() => {
          if (activeTab === 'sql') maybeAutoRun();
        })
        .catch((e) => {
          sqlErr.innerHTML = errorHtml(new Error(`Could not load the SQL engine: ${(e as Error).message}`));
          sqlErr.hidden = false;
          sqlStatus.textContent = '';
        });
    }
    if (tab === 'table') grid.refresh();
  });

  onThemeChange(() => {
    if (activeTab === 'chart') charts.render();
    else charts.dirty = true;
  });

  // ---------------------------------------------------------------- inputs
  const drop = $('#dx-drop');
  const openPicker = setupDropzone(drop, (files) => loadFile(files[0]), { accept: '.csv,.tsv,.tab,.txt,.psv,.dat,.json,.ndjson,.jsonl,text/csv,text/plain,application/json', pageWide: true });
  $('#dx-open').addEventListener('click', openPicker);

  root.addEventListener('click', (e) => {
    const s = (e.target as HTMLElement).closest<HTMLElement>('[data-sample]');
    if (s) loadSample(s.dataset.sample!);
  });
  $<HTMLSelectElement>('#dx-sample-sel').addEventListener('change', (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.value) loadSample(sel.value);
    sel.value = '';
  });

  const openPaste = () => {
    pasteDlg.showModal();
    pasteText.focus();
  };
  $('#dx-paste-open').addEventListener('click', openPaste);
  $('#dx-paste-btn').addEventListener('click', openPaste);
  $('#dx-paste-cancel').addEventListener('click', () => pasteDlg.close());
  const submitPaste = () => {
    const text = pasteText.value;
    if (!text.trim()) {
      toast('Paste some CSV, TSV or JSON first', 'error');
      pasteText.focus();
      return;
    }
    pasteDlg.close();
    load({ source: text, name: 'Pasted data' }, { delimiter: $<HTMLSelectElement>('#dx-paste-delim').value, header: $<HTMLInputElement>('#dx-paste-header').checked });
  };
  $('#dx-paste-load').addEventListener('click', submitPaste);
  pasteText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitPaste();
    }
  });
  // Pasting straight onto the page (outside inputs) loads the clipboard text.
  document.addEventListener('paste', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable], dialog')) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text.trim() || !text.includes('\n')) return;
    e.preventDefault();
    load({ source: text, name: 'Pasted data' });
  });

  root.dataset.ready = '1';
}
