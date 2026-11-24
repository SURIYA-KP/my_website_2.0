// JSON Studio controller: wires the editor, live validation, actions, output tabs, tree and sharing.
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import { copyText, debounce, downloadText, formatBytes, initTabs, setupDropzone, toast } from '../../lib/ui';
import { CodeView } from './codeview';
import { Editor } from './editor';
import { EXAMPLE_TEXT } from './example';
import { parseJson, type JsonErrorInfo } from './jsonError';
import { RepairError, repairJson } from './repair';
import { TreeView } from './tree';
import { generateTypeScript } from './tsgen';
import {
  byteLength, computeStats, highlightJsonLine, highlightTsLine, highlightYamlLine, indentValue, isContainer,
  sortKeysDeep, toJsPath, toJsonPath, type Seg, type Stats,
} from './util';

type Convert = typeof import('./convert');
let convertMod: Promise<Convert> | null = null;
const convert = () => (convertMod ??= import('./convert'));

const SHARE_LIMIT = 8 * 1024;
const HASH_KEY = 'json=';
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

type Tab = 'formatted' | 'tree' | 'yaml' | 'csv' | 'ts';
type FormatName = 'yaml' | 'csv' | 'jsonl';
const FORMAT_LABEL: Record<FormatName, string> = { yaml: 'YAML', csv: 'CSV', jsonl: 'JSON Lines' };

export function init() {
  const root = $('#jss');
  const editor = new Editor($('#jss-editor'));
  const indentSel = $<HTMLSelectElement>('#jss-indent');
  const msg = $('#jss-msg');
  const fixedBox = $('#jss-fixed');
  const statsEl = $('#jss-stats');
  const badge = $('#jss-valid');
  const cursorEl = $('#jss-cursor');
  const shareBtn = $<HTMLButtonElement>('[data-cmd="share"]');
  const staleEl = $('#jss-stale');

  const views = {
    formatted: new CodeView($('#jss-fmt-view'), highlightJsonLine),
    yaml: new CodeView($('#jss-yaml-view'), highlightYamlLine),
    csv: new CodeView($('#jss-csv-view')),
    ts: new CodeView($('#jss-ts-view'), highlightTsLine),
  };
  const tree = new TreeView($('#jss-tree'));

  // ---------------------------------------------------------------- state
  let doc: unknown = undefined; // last valid value
  let hasDoc = false;
  let ver = 0; // bumps whenever `doc` changes
  let stats: Stats | null = null;
  let lastText: string | null = null;
  let error: JsonErrorInfo | null = null;
  let guessed: FormatName | null = null;
  let tab: Tab = 'formatted';
  let baseName = 'data';
  let undoText: string | null = null;
  const rendered: Record<string, string> = {};

  const indent = () => indentValue(indentSel.value);
  const pretty = (v: unknown) => JSON.stringify(v, null, indent()) ?? '';
  editor.indentUnit = indentSel.value === 'tab' ? '\t' : ' '.repeat(Number(indentSel.value));

  // ---------------------------------------------------------------- analysis
  function analyze(opts: { jump?: boolean; force?: boolean } = {}) {
    const text = editor.value;
    if (text === lastText && !opts.force) return;
    lastText = text;
    guessed = null;
    if (!text.trim()) {
      error = null;
      hasDoc = false;
      doc = undefined;
      stats = null;
      ver++;
    } else {
      const res = parseJson(text);
      if (res.ok) {
        error = null;
        doc = res.value;
        hasDoc = true;
        stats = computeStats(doc);
        ver++;
      } else {
        error = res.error;
        if (!/^\s*[[{"]/.test(text)) void convert().then((c) => {
          if (editor.value !== text) return;
          const f = c.sniffFormat(text);
          if (f !== 'json') {
            guessed = f;
            showMessage();
          }
        });
      }
    }
    root.dataset.rev = String(Number(root.dataset.rev ?? 0) + 1);
    editor.setErrorLine(error ? error.line : 0);
    if (error && opts.jump) editor.reveal(error.line);
    showMessage();
    updateStats(text);
    renderOutput();
  }
  const analyzeSoon = debounce(() => analyze(), 120);
  const analyzeLater = debounce(() => analyze(), 450);

  function showMessage() {
    if (!error) {
      msg.hidden = true;
      msg.innerHTML = '';
      return;
    }
    const e = error;
    msg.hidden = false;
    msg.className = guessed ? 'alert alert-info jss-msg' : 'alert alert-error jss-msg';
    msg.innerHTML = '';
    const body = el('div', 'jss-msg-body');
    if (guessed) {
      body.append(el('strong', '', `This looks like ${FORMAT_LABEL[guessed]}.`), el('span', 'jss-msg-hint', `Convert it to JSON to format, explore and export it.`));
    } else {
      const head = el('strong', 'jss-msg-title');
      head.append(el('span', 'jss-msg-pos', `Line ${e.line}, column ${e.col}`), document.createTextNode(` ${e.message}`));
      body.append(head);
      if (e.hint) body.append(el('span', 'jss-msg-hint', e.hint));
    }
    const actions = el('div', 'jss-msg-actions');
    if (guessed) actions.append(btn(`Convert ${FORMAT_LABEL[guessed]} to JSON`, 'btn btn-sm btn-primary', () => convertInput(guessed!), 'convert'));
    if (e.kind !== 'empty') {
      actions.append(btn(`Go to line ${e.line}`, 'btn btn-sm', () => editor.goTo(e.pos, e.line), 'goto'));
      if (!guessed) actions.append(btn('Fix it', 'btn btn-sm btn-primary', fixIt, 'fix'));
    }
    msg.append(body, actions);
  }

  function updateStats(text: string) {
    const bytes = byteLength(text);
    const state = !text.trim() ? 'empty' : error ? 'invalid' : 'valid';
    badge.textContent = state === 'valid' ? 'Valid JSON' : state === 'invalid' ? 'Invalid' : 'Empty';
    badge.className = `badge ${state === 'valid' ? 'badge-success' : state === 'invalid' ? 'badge-danger' : ''}`;
    root.dataset.state = state;
    const s = state === 'valid' ? stats : null;
    const set = (k: string, v: string) => ($(`#jss-stats [data-stat="${k}"]`).textContent = v);
    set('size', `${formatBytes(bytes)}${bytes >= 1024 ? ` (${bytes.toLocaleString('en-US')} bytes)` : ''}`);
    set('keys', s ? s.keys.toLocaleString('en-US') : '–');
    set('depth', s ? String(s.maxDepth) : '–');
    set('arrays', s ? s.arrays.toLocaleString('en-US') : '–');
    set('type', s ? s.rootType : '–');
    statsEl.dataset.bytes = String(bytes);
    // Sharing: only small documents fit in a URL.
    const tooBig = bytes > SHARE_LIMIT;
    const empty = !text.trim();
    shareBtn.setAttribute('aria-disabled', String(tooBig || empty));
    shareBtn.title = empty
      ? 'Nothing to share yet'
      : tooBig
        ? `Share links are limited to 8 KB so they stay short and work everywhere. This document is ${formatBytes(bytes)}: download it instead.`
        : 'Copy a link that contains this JSON (compressed in the #hash, never sent to a server)';
    $('#jss-share-note').textContent = tooBig ? 'Share: over 8 KB' : '';
  }

  // ---------------------------------------------------------------- output tabs
  function renderOutput() {
    const empty = !hasDoc;
    root.querySelectorAll<HTMLElement>('.jss-out-empty').forEach((e) => (e.hidden = !empty));
    root.querySelectorAll<HTMLElement>('.jss-out-body').forEach((e) => (e.hidden = empty));
    staleEl.hidden = !(hasDoc && error);
    if (empty) return;
    const key = `${ver}`;
    if (tab === 'formatted') {
      const k = `${key}:${indentSel.value}`;
      if (rendered.formatted !== k) {
        const same = rendered.formatted?.startsWith(`${ver - 1}:`) ?? false;
        views.formatted.setText(pretty(doc), same);
        rendered.formatted = k;
      } else views.formatted.render(true);
    } else if (tab === 'tree') {
      if (rendered.tree !== key) {
        tree.setData(doc, stats?.nodes ?? 0);
        rendered.tree = key;
        clearPath();
        updateSearchCount();
      } else tree.refresh();
    } else if (tab === 'yaml') {
      if (rendered.yaml !== key) {
        rendered.yaml = key;
        void convert().then((c) => {
          if (rendered.yaml !== key) return;
          try {
            views.yaml.setText(c.jsonToYaml(doc), true);
            setOutError('yaml', '');
          } catch (err) {
            setOutError('yaml', `Could not convert to YAML: ${(err as Error).message}`);
          }
        });
      } else views.yaml.render(true);
    } else if (tab === 'csv') {
      renderCsv(false);
    } else if (tab === 'ts') {
      renderTs(false);
    }
  }

  function setOutError(name: string, text: string) {
    const box = $(`#jss-${name}-error`);
    box.hidden = !text;
    box.textContent = text;
  }

  // CSV: choose which array becomes the rows.
  const csvRows = $<HTMLSelectElement>('#jss-csv-rows');
  const csvDelim = $<HTMLSelectElement>('#jss-csv-delim');
  let csvCandidatesVer = -1;
  function csvCandidates() {
    if (csvCandidatesVer === ver) return;
    csvCandidatesVer = ver;
    const prev = csvRows.value;
    const found: { segs: Seg[]; count: number }[] = [];
    if (Array.isArray(doc)) found.push({ segs: [], count: doc.length });
    else {
      // Arrays of objects reachable through objects (not through other arrays), shallow first.
      const queue: { v: unknown; segs: Seg[] }[] = [{ v: doc, segs: [] }];
      while (queue.length && found.length < 30) {
        const { v, segs } = queue.shift()!;
        if (!isContainer(v) || Array.isArray(v) || segs.length > 4) continue;
        for (const [k, c] of Object.entries(v)) {
          if (Array.isArray(c) && c.some((e) => e && typeof e === 'object' && !Array.isArray(e))) found.push({ segs: [...segs, k], count: c.length });
          else if (isContainer(c) && !Array.isArray(c)) queue.push({ v: c, segs: [...segs, k] });
        }
      }
    }
    const opts = [{ segs: [] as Seg[], count: Array.isArray(doc) ? doc.length : 1 }, ...found.filter((f) => f.segs.length)];
    csvRows.innerHTML = '';
    for (const o of opts) {
      const path = toJsonPath(o.segs);
      const opt = new Option(`${path === '$' ? '$ (whole document)' : path} · ${o.count} ${o.count === 1 ? 'row' : 'rows'}`, JSON.stringify(o.segs));
      csvRows.add(opt);
    }
    const values = Array.from(csvRows.options).map((o) => o.value);
    if (values.includes(prev)) csvRows.value = prev;
    else {
      // Default: the biggest array of objects (the shallowest on ties), else the document.
      const best = found.filter((f) => f.segs.length).sort((a, b) => b.count - a.count || a.segs.length - b.segs.length)[0];
      csvRows.value = JSON.stringify(Array.isArray(doc) || !best ? [] : best.segs);
    }
  }
  function csvData() {
    let v: unknown = doc;
    for (const s of JSON.parse(csvRows.value || '[]') as Seg[]) v = (v as Record<string | number, unknown>)[s];
    return v;
  }
  function renderCsv(forceRender: boolean) {
    csvCandidates();
    const key = `${ver}:${csvRows.value}:${csvDelim.value}`;
    if (rendered.csv === key && !forceRender) return views.csv.render(true);
    rendered.csv = key;
    void convert().then((c) => {
      if (rendered.csv !== key) return;
      try {
        const data = csvData();
        const text = c.jsonToCsv(data, csvDelim.value === 'tab' ? '\t' : csvDelim.value);
        const { fields, rows } = c.flattenRows(data);
        views.csv.setText(text, true);
        $('#jss-csv-info').textContent = `${rows.length} ${rows.length === 1 ? 'row' : 'rows'} × ${fields.length} ${fields.length === 1 ? 'column' : 'columns'}`;
        setOutError('csv', '');
      } catch (err) {
        setOutError('csv', `Could not convert to CSV: ${(err as Error).message}`);
      }
    });
  }

  const tsRoot = $<HTMLInputElement>('#jss-ts-root');
  const tsStyle = $<HTMLSelectElement>('#jss-ts-style');
  const tsRo = $<HTMLInputElement>('#jss-ts-ro');
  function renderTs(force: boolean) {
    const key = `${ver}:${tsRoot.value}:${tsStyle.value}:${tsRo.checked}`;
    if (rendered.ts === key && !force) return views.ts.render(true);
    rendered.ts = key;
    views.ts.setText(generateTypeScript(doc, { rootName: tsRoot.value, style: tsStyle.value as 'interface' | 'type', readonly: tsRo.checked }), true);
  }
  tsRoot.addEventListener('input', debounce(() => renderTs(false), 150));
  tsStyle.addEventListener('change', () => renderTs(false));
  tsRo.addEventListener('change', () => renderTs(false));
  csvRows.addEventListener('change', () => renderCsv(false));
  csvDelim.addEventListener('change', () => renderCsv(false));

  initTabs(root, (group, name) => {
    if (group !== 'out') return;
    tab = name as Tab;
    renderOutput();
  });

  // ---------------------------------------------------------------- tree
  const searchInput = $<HTMLInputElement>('#jss-search');
  const searchCount = $('#jss-search-count');
  let clickCopies: 'jsonpath' | 'js' = 'jsonpath';
  const pathBox = $('#jss-path');
  let selected: Seg[] | null = null;

  function clearPath() {
    selected = null;
    pathBox.hidden = true;
  }
  function showPath(segs: Seg[]) {
    selected = segs;
    pathBox.hidden = false;
    $('#jss-path-jp').textContent = toJsonPath(segs);
    $('#jss-path-js').textContent = toJsPath(segs);
  }
  function copyPath(segs: Seg[], kind = clickCopies) {
    const p = kind === 'js' ? toJsPath(segs) : toJsonPath(segs);
    void copyText(p, `Copied ${kind === 'js' ? 'JS path' : 'JSONPath'} ${p.length > 48 ? p.slice(0, 47) + '…' : p}`);
  }
  tree.onSelect = (segs, _v, viaKeyboard) => {
    showPath(segs);
    if (!viaKeyboard) copyPath(segs);
  };
  tree.onActivate = (segs) => {
    showPath(segs);
    copyPath(segs);
  };
  $('#jss-copy-jp').addEventListener('click', () => selected && copyPath(selected, 'jsonpath'));
  $('#jss-copy-js').addEventListener('click', () => selected && copyPath(selected, 'js'));
  root.querySelectorAll<HTMLButtonElement>('[data-copies]').forEach((b) =>
    b.addEventListener('click', () => {
      clickCopies = b.dataset.copies as 'jsonpath' | 'js';
      root.querySelectorAll('[data-copies]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    }),
  );

  function updateSearchCount() {
    const n = tree.matchCount;
    const q = searchInput.value;
    searchCount.textContent = !q ? '' : n ? `${tree.currentMatch + 1} of ${n.toLocaleString('en-US')}` : 'No matches';
    searchCount.classList.toggle('is-none', !!q && !n);
  }
  const runSearch = () => {
    tree.search(searchInput.value.trim());
    updateSearchCount();
  };
  searchInput.addEventListener('input', debounce(runSearch, 160));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (tree.matchCount && searchInput.value.trim() === tree.queryText) tree.gotoMatch(tree.currentMatch + (e.shiftKey ? -1 : 1));
      else runSearch();
      updateSearchCount();
    } else if (e.key === 'Escape' && searchInput.value) {
      searchInput.value = '';
      runSearch();
    }
  });
  $('#jss-search-prev').addEventListener('click', () => (tree.gotoMatch(tree.currentMatch - 1), updateSearchCount()));
  $('#jss-search-next').addEventListener('click', () => (tree.gotoMatch(tree.currentMatch + 1), updateSearchCount()));
  $('#jss-expand').addEventListener('click', () => tree.expandAll());
  $('#jss-collapse').addEventListener('click', () => tree.collapseAll());

  // ---------------------------------------------------------------- input actions
  function setInput(text: string, opts: { undoable?: boolean } = {}) {
    if (opts.undoable) editor.setUndoable(text);
    else editor.value = text;
    analyze({ jump: true, force: true });
  }

  function requireValid(action: string): boolean {
    analyze();
    if (hasDoc && !error) return true;
    if (!editor.value.trim()) toast(`Nothing to ${action} yet. Paste or open some JSON first.`, 'error', 3200);
    else toast(`Fix the error on line ${error!.line} first (or click Fix it).`, 'error', 3200);
    return false;
  }

  function hideFixed() {
    fixedBox.hidden = true;
    undoText = null;
  }

  function fixIt() {
    const before = editor.value;
    try {
      const { value, fixes } = repairJson(before);
      const out = pretty(value);
      undoText = before;
      setInput(out, { undoable: true });
      fixedBox.hidden = false;
      $('#jss-fixed-text').textContent = fixes.length ? `Repaired: ${fixes.join(', ')}.` : 'Reformatted: nothing needed fixing.';
      toast(fixes.length ? `Fixed ${fixes.length} kind${fixes.length === 1 ? '' : 's'} of problem` : 'Nothing to fix');
    } catch (err) {
      if (err instanceof RepairError) {
        toast(`Could not repair: ${err.message}`, 'error', 4500);
        editor.goTo(err.pos, err.line);
      } else toast(`Could not repair: ${(err as Error).message}`, 'error', 4500);
    }
  }

  async function convertInput(format: FormatName, text = editor.value, delimiter?: string) {
    const c = await convert();
    try {
      const value = format === 'yaml' ? c.yamlToJson(text) : format === 'csv' ? c.csvToJson(text, { delimiter }) : c.jsonLinesToArray(text);
      if (value === null) throw new Error('Every line must be a JSON value');
      hideFixed();
      setInput(pretty(value), { undoable: true });
      toast(`${FORMAT_LABEL[format]} converted to JSON`);
      return true;
    } catch (err) {
      const m = (err as Error).message.split('\n')[0];
      toast(`Could not read ${FORMAT_LABEL[format]}: ${m}`, 'error', 5000);
      if (editor.value !== text) setInput(text);
      return false;
    }
  }

  /** Load text from a file / paste / share link, converting YAML, CSV and JSON Lines. */
  async function loadText(text: string, name?: string) {
    hideFixed();
    const ext = name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
    if (name) baseName = name.replace(/\.[^.]+$/, '') || 'data';
    if (ext === 'yaml' || ext === 'yml') return convertInput('yaml', text);
    if (ext === 'csv' || ext === 'tsv') return convertInput('csv', text, ext === 'tsv' ? '\t' : undefined);
    if (ext === 'jsonl' || ext === 'ndjson') return convertInput('jsonl', text);
    const t = text.replace(/^﻿/, '');
    if (!['json', 'jsonc', 'json5', 'geojson', 'map'].includes(ext) && t.length < 20_000_000) {
      const parsed = parseJson(t);
      if (!parsed.ok) {
        const f = (await convert()).sniffFormat(t);
        if (f !== 'json') return convertInput(f, t);
      }
    }
    setInput(t, { undoable: !name });
    return true;
  }

  async function openFiles(files: File[]) {
    const f = files[0];
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) return toast('That file is over 200 MB, too big to edit in a browser tab.', 'error', 4000);
    try {
      const text = await f.text();
      const ok = await loadText(text, f.name);
      if (ok && !error) toast(`Opened ${f.name} (${formatBytes(f.size)})`);
      else if (error) toast(`Opened ${f.name}, but it is not valid JSON yet`, 'error', 3000);
    } catch (err) {
      toast(`Could not read ${f.name}: ${(err as Error).message}`, 'error', 4000);
    }
  }
  setupDropzone($('#jss-open'), openFiles, { accept: '.json,.jsonc,.json5,.geojson,.jsonl,.ndjson,.yaml,.yml,.csv,.tsv,.txt,application/json,text/*', pageWide: true });
  // Mirror the drag highlight onto the editor so it is obvious where a file can go.
  new MutationObserver(() => root.classList.toggle('is-dragover', $('#jss-open').classList.contains('is-dragover'))).observe($('#jss-open'), {
    attributes: true,
    attributeFilter: ['class'],
  });

  // Pasting YAML / CSV over the whole document converts it.
  editor.ta.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const ta = editor.ta;
    const replacingAll = ta.value.trim() === '' || (ta.selectionStart === 0 && ta.selectionEnd === ta.value.length);
    if (!text || !replacingAll || /^\s*[[{"]/.test(text)) {
      pendingJump = true;
      return;
    }
    if (parseJson(text).ok) return;
    e.preventDefault();
    void loadText(text);
  });
  let pendingJump = false;

  const commands: Record<string, () => void | Promise<void>> = {
    async paste() {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        editor.ta.focus();
        toast('Clipboard access was blocked. Press Ctrl+V (⌘V) in the editor instead.', 'error', 4000);
        return;
      }
      if (!text.trim()) return void toast('The clipboard is empty', 'error');
      await loadText(text);
    },
    example() {
      baseName = 'example';
      hideFixed();
      setInput(EXAMPLE_TEXT, { undoable: true });
      toast('Example loaded');
    },
    format() {
      if (!requireValid('format')) return;
      setInput(pretty(doc), { undoable: true });
      toast(`Formatted with ${indentSel.value === 'tab' ? 'tabs' : `${indentSel.value} spaces`}`);
    },
    minify() {
      if (!requireValid('minify')) return;
      const before = byteLength(editor.value);
      const out = JSON.stringify(doc);
      setInput(out, { undoable: true });
      toast(`Minified: ${formatBytes(before)} → ${formatBytes(byteLength(out))}`);
    },
    sort() {
      if (!requireValid('sort')) return;
      setInput(pretty(sortKeysDeep(doc)), { undoable: true });
      toast('Keys sorted A→Z at every level');
    },
    escape() {
      const text = editor.value;
      if (!text) return void toast('Nothing to escape', 'error');
      setInput(JSON.stringify(text), { undoable: true });
      toast('Escaped as a JSON string');
    },
    unescape() {
      const text = editor.value.trim();
      let out: unknown;
      try {
        out = JSON.parse(text);
      } catch {
        try {
          out = JSON.parse(`"${text.replace(/^"|"$/g, '')}"`);
        } catch {
          out = undefined;
        }
      }
      if (typeof out !== 'string') return void toast('Unescape needs a JSON string literal, like "{\\"a\\":1}"', 'error', 3500);
      // Escaped JSON is usually wanted pretty.
      const inner = parseJson(out);
      setInput(inner.ok && isContainer(inner.value) && !out.includes('\n') ? pretty(inner.value) : out, { undoable: true });
      toast('Unescaped the JSON string');
    },
    copy() {
      if (!editor.value) return void toast('Nothing to copy', 'error');
      void copyText(editor.value, 'Input copied');
    },
    download() {
      if (!editor.value) return void toast('Nothing to download', 'error');
      downloadText(editor.value, `${baseName}.json`, 'application/json');
      toast(`Downloading ${baseName}.json`);
    },
    clear() {
      hideFixed();
      setInput('', { undoable: true });
      editor.ta.focus();
    },
    share() {
      const text = editor.value;
      if (shareBtn.getAttribute('aria-disabled') === 'true') return void toast(shareBtn.title, 'error', 5000);
      const hash = HASH_KEY + compressToEncodedURIComponent(text);
      const url = `${location.href.split('#')[0]}#${hash}`;
      history.replaceState(null, '', url);
      void copyText(url, 'Share link copied. The JSON lives in the link itself.');
    },
    'go-error'() {
      if (error) editor.goTo(error.pos, error.line);
    },
    fix: fixIt,
    undo() {
      if (undoText === null) return;
      const t = undoText;
      hideFixed();
      setInput(t);
      toast('Restored the original text');
    },
    'out-copy'() {
      const t = outText();
      if (t === null) return;
      void copyText(t, `${OUT_NAME[tab]} copied`);
    },
    'out-download'() {
      const t = outText();
      if (t === null) return;
      const [ext, mime] = OUT_FILE[tab];
      const name = tab === 'ts' ? `${baseName}.types.ts` : `${baseName}.${ext}`;
      downloadText(t, name, mime);
      toast(`Downloading ${name}`);
    },
  };
  const OUT_NAME: Record<Tab, string> = { formatted: 'Formatted JSON', tree: 'JSON', yaml: 'YAML', csv: 'CSV', ts: 'TypeScript' };
  const OUT_FILE: Record<Tab, [string, string]> = {
    formatted: ['json', 'application/json'],
    tree: ['json', 'application/json'],
    yaml: ['yaml', 'application/yaml'],
    csv: ['csv', 'text/csv;charset=utf-8'],
    ts: ['ts', 'text/plain;charset=utf-8'],
  };
  function outText(): string | null {
    if (!hasDoc) {
      toast('Nothing to export yet', 'error');
      return null;
    }
    if (tab === 'formatted' || tab === 'tree') return pretty(doc);
    const v = views[tab].value;
    if (!v) toast('Still converting, try again in a moment', 'error');
    return v || null;
  }

  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
    if (!b || !root.contains(b)) return;
    const fn = commands[b.dataset.cmd!];
    if (fn) void fn();
  });

  indentSel.addEventListener('change', () => {
    editor.indentUnit = indentSel.value === 'tab' ? '\t' : ' '.repeat(Number(indentSel.value));
    editor.ta.style.tabSize = indentSel.value === '4' ? '4' : '2';
    renderOutput();
  });

  editor.ta.addEventListener('input', () => {
    if (undoText !== null && !fixedBox.hidden) fixedBox.hidden = true;
    if (pendingJump) {
      pendingJump = false;
      analyze({ jump: true });
    } else if (editor.value.length > 1_000_000) analyzeLater();
    else analyzeSoon();
  });
  editor.onCursor = (line, col) => (cursorEl.textContent = `Ln ${line}, Col ${col}`);

  // Keyboard shortcut: Shift+Alt+F formats (as in VS Code).
  root.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF')) {
      e.preventDefault();
      void commands.format();
    }
  });

  // ---------------------------------------------------------------- start
  function fromHash(): boolean {
    const h = location.hash.slice(1);
    if (!h.startsWith(HASH_KEY)) return false;
    const text = decompressFromEncodedURIComponent(h.slice(HASH_KEY.length));
    if (text === null || text === '') {
      toast('The share link looks damaged, so the example was loaded instead.', 'error', 4000);
      return false;
    }
    baseName = 'shared';
    setInput(text);
    toast('Loaded JSON from the link');
    return true;
  }
  window.addEventListener('hashchange', () => void fromHash());
  if (!fromHash()) {
    baseName = 'example';
    setInput(EXAMPLE_TEXT);
  }
  root.dataset.ready = 'true';
}

// ---------------------------------------------------------------- tiny DOM helpers
function el(tag: string, cls = '', text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label: string, cls: string, onClick: () => void, name: string) {
  const b = el('button', cls, label) as HTMLButtonElement;
  b.type = 'button';
  b.dataset.msgAction = name;
  b.addEventListener('click', onClick);
  return b;
}
