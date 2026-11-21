import { copyText, downloadText, formatBytes, initTabs, setupDropzone, toast } from '../../lib/ui';
import {
  APPROX_MODELS,
  ENCODINGS,
  approximate,
  estimateCost,
  formatContext,
  formatInt,
  formatUSD,
  isEncodingName,
  parseTokenIds,
  splitUtf8,
  type EncodingName,
  type TextStats,
} from './core';
import { encoder, onEncoderStatus, type Encoded } from './client';
import { ChipView } from './render';
import { EXAMPLES } from './examples';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const encMeta = (name: EncodingName) => ENCODINGS.find((e) => e.name === name)!;
const utf8 = new TextEncoder();

const DEFAULT_CONTEXTS = [8192, 32768, 128000, 200000, 1000000];
const PRESETS = [
  { key: 'small', label: 'Example: small model ($0.15 in / $0.60 out)', input: 0.15, output: 0.6 },
  { key: 'mid', label: 'Example: mid-size model ($3 in / $15 out)', input: 3, output: 15 },
  { key: 'large', label: 'Example: large model ($15 in / $75 out)', input: 15, output: 75 },
  { key: 'embed', label: 'Example: embeddings ($0.02 in / $0 out)', input: 0.02, output: 0 },
];
const FILE_ACCEPT =
  '.txt,.text,.md,.markdown,.json,.jsonl,.ndjson,.csv,.tsv,.xml,.html,.htm,.css,.scss,.less,.js,.mjs,.cjs,.ts,.tsx,.jsx,' +
  '.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cc,.cs,.php,.sh,.bash,.zsh,.ps1,.yaml,.yml,.toml,.ini,.cfg,.conf,' +
  '.env,.sql,.log,.tex,.r,.lua,.pl,.vue,.svelte,.astro,.srt,.vtt,text/*,application/json';
const MAX_FILE = 30 * 1024 * 1024;

interface MainResult {
  count: number;
  stats: TextStats;
}

export function init() {
  const input = $<HTMLTextAreaElement>('#tc-input');
  const special = $<HTMLInputElement>('#tc-special');
  const statusEl = $('#tc-status');
  const countEl = $('#tc-count');

  let encoding: EncodingName = 'o200k_base';
  let current: MainResult | null = null;
  let currentIds: Uint32Array | null = null;
  let o200kCount: number | null = null;
  let approxPending = false;
  let activeTab = 'count';
  let compareDirty = true;

  // ---------- Chip views ----------
  const mainView = new ChipView($('#tc-chips'), $('#tc-more'));
  mainView.emptyHtml = '<p class="tc-placeholder">Tokens appear here as you type. Try an example above.</p>';
  const cmpViews = {
    a: new ChipView($('#tc-cmp-a-chips'), $('#tc-cmp-a-more')),
    b: new ChipView($('#tc-cmp-b-chips'), $('#tc-cmp-b-more')),
  };
  cmpViews.a.emptyHtml = cmpViews.b.emptyHtml = '<p class="tc-placeholder">Enter text in the Count tab to compare.</p>';
  const decView = new ChipView($('#tc-dec-chips'), $('#tc-dec-more'));
  decView.emptyHtml = '<p class="tc-placeholder">No tokens.</p>';

  // ---------- Status ----------
  let statusKind: 'idle' | 'busy' | 'error' = 'idle';
  const setStatus = (text: string, kind: 'idle' | 'busy' | 'error' = 'idle') => {
    statusKind = kind;
    statusEl.textContent = text;
    statusEl.classList.toggle('is-busy', kind === 'busy');
    statusEl.classList.toggle('is-error', kind === 'error');
  };
  onEncoderStatus(() => {
    const h = encoder(encoding);
    if (h.failed) setStatus(h.failed, 'error');
  });

  // ---------- Main tokenization ----------
  let runSeq = 0;
  async function runMain() {
    const text = input.value;
    const seq = ++runSeq;
    compareDirty = true;
    if (activeTab === 'compare') runCompare();
    runApprox(text);
    if (!text) {
      current = { count: 0, stats: { chars: 0, words: 0, lines: 0, bytes: 0 } };
      currentIds = new Uint32Array(0);
      if (encoding === 'o200k_base') o200kCount = 0;
      mainView.set(null);
      setStatus('');
      renderNumbers();
      return;
    }
    const h = encoder(encoding);
    const meta = encMeta(encoding);
    if (!h.ready) setStatus(`Loading ${meta.name} (${meta.size})…`, 'busy');
    else if (text.length > 100_000) setStatus('Tokenizing…', 'busy');
    let res: Encoded | null;
    try {
      res = await h.encode('main', text, { allowSpecial: special.checked }, (done, total) => {
        if (seq === runSeq) setStatus(`Tokenizing… ${Math.floor((done / total) * 100)}%`, 'busy');
      });
    } catch (err: any) {
      if (seq === runSeq) setStatus(err?.message || 'Tokenization failed.', 'error');
      return;
    }
    if (!res || seq !== runSeq) return;
    current = { count: res.ids.length, stats: res.stats! };
    currentIds = res.ids;
    if (encoding === 'o200k_base') {
      o200kCount = res.ids.length;
      approxPending = false;
    }
    mainView.set({ ids: res.ids, lens: res.lens!, bytes: utf8.encode(text) });
    setStatus(`${meta.name} · ${res.ms < 1 ? '<1' : res.ms} ms`);
    renderNumbers();
  }

  let approxSeq = 0;
  async function runApprox(text: string) {
    if (encoding === 'o200k_base') return; // filled by runMain
    const seq = ++approxSeq;
    if (!text) {
      o200kCount = 0;
      approxPending = false;
      renderNumbers();
      return;
    }
    approxPending = true;
    renderApprox();
    try {
      const res = await encoder('o200k_base').encode('approx', text, { allowSpecial: special.checked, countOnly: true });
      if (!res || seq !== approxSeq) return;
      o200kCount = res.ids.length;
      approxPending = false;
      renderNumbers();
    } catch {
      approxPending = false;
      o200kCount = null;
      renderNumbers();
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (immediate = false) => {
    clearTimeout(timer);
    const n = input.value.length;
    const delay = immediate ? 0 : n < 20_000 ? 60 : n < 200_000 ? 150 : 300;
    timer = setTimeout(runMain, delay);
  };
  input.addEventListener('input', () => schedule());
  special.addEventListener('change', () => schedule(true));

  // ---------- Numbers: stats, context, cost, approx ----------
  const fmtRatio = (n: number) => (Number.isFinite(n) && n > 0 ? n.toFixed(2) : '–');
  function renderStats() {
    const s = current?.stats;
    const c = current?.count ?? 0;
    countEl.textContent = current ? formatInt(c) : '–';
    countEl.dataset.count = current ? String(c) : '';
    const set = (k: string, v: string) => ($(`[data-stat="${k}"]`).textContent = v);
    set('chars', s ? formatInt(s.chars) : '–');
    set('words', s ? formatInt(s.words) : '–');
    set('lines', s ? formatInt(s.lines) : '–');
    set('bytes', s ? formatInt(s.bytes) : '–');
    set('cpt', s && c ? fmtRatio(s.chars / c) : '–');
    set('tpw', s && s.words ? fmtRatio(c / s.words) : '–');
    $('#tc-tokens-title').textContent = current ? `Tokens · ${formatInt(c)}` : 'Tokens';
  }

  // Approximations
  const approxEl = $('#tc-approx');
  approxEl.innerHTML = APPROX_MODELS.map(
    (m) => `<div class="tc-approx-row" data-approx="${m.key}">
      <div class="tc-approx-top">
        <span class="tc-approx-name">${m.name}<small>${m.vendor}</small></span>
        <span class="tc-approx-val" data-v>–</span>
      </div>
      <div class="tc-approx-range" data-r>±${Math.round(m.spread * 100)}% range</div>
      <p class="tc-approx-note">${m.note}</p>
    </div>`,
  ).join('');
  function approxFor(key: string) {
    const m = APPROX_MODELS.find((x) => x.key === key)!;
    return o200kCount == null ? null : approximate(o200kCount, m.factor, m.spread);
  }
  function renderApprox() {
    for (const m of APPROX_MODELS) {
      const row = approxEl.querySelector<HTMLElement>(`[data-approx="${m.key}"]`)!;
      const a = approxFor(m.key);
      const v = row.querySelector<HTMLElement>('[data-v]')!;
      const r = row.querySelector<HTMLElement>('[data-r]')!;
      if (approxPending || !a) {
        v.textContent = approxPending ? 'estimating…' : '–';
        r.textContent = `≈ ${m.factor}× o200k, ±${Math.round(m.spread * 100)}%`;
        continue;
      }
      v.textContent = `≈ ${formatInt(a.mid)} ± ${formatInt(a.plusMinus)}`;
      v.dataset.mid = String(a.mid);
      r.textContent = `Likely ${formatInt(a.low)} – ${formatInt(a.high)} tokens (≈ ${m.factor}× o200k, ±${Math.round(m.spread * 100)}%)`;
    }
  }

  // Context bars
  const ctxEl = $('#tc-ctx');
  function buildContextRows(sizes: number[]) {
    ctxEl.innerHTML = sizes
      .map(
        (s, i) => `<div class="tc-ctx-row" data-ctx="${i}">
        <input class="input" type="number" min="1" step="1" value="${s}" aria-label="Context size ${i + 1} in tokens" inputmode="numeric" />
        <div>
          <div class="tc-ctx-meta"><span data-label></span><strong data-pct></strong></div>
          <div class="tc-bar" role="img"><div class="tc-bar-in"></div><div class="tc-bar-out"></div></div>
        </div>
      </div>`,
      )
      .join('');
    renderContext();
  }
  ctxEl.addEventListener('input', () => renderContext());
  $('#tc-ctx-reset').addEventListener('click', () => {
    buildContextRows(DEFAULT_CONTEXTS);
    toast('Context sizes reset');
  });

  const outTokensEl = $<HTMLInputElement>('#tc-out-tokens');
  const num = (el: HTMLInputElement) => {
    const v = parseFloat(el.value);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };

  function renderContext() {
    const used = current?.count ?? 0;
    const out = Math.round(num(outTokensEl));
    $('#tc-ctx-out-note').hidden = out <= 0;
    ctxEl.querySelectorAll<HTMLElement>('.tc-ctx-row').forEach((row) => {
      const size = Math.floor(num(row.querySelector('input')!));
      const label = row.querySelector<HTMLElement>('[data-label]')!;
      const pctEl = row.querySelector<HTMLElement>('[data-pct]')!;
      const inBar = row.querySelector<HTMLElement>('.tc-bar-in')!;
      const outBar = row.querySelector<HTMLElement>('.tc-bar-out')!;
      const bar = row.querySelector<HTMLElement>('.tc-bar')!;
      if (!size) {
        label.textContent = 'Enter a size';
        pctEl.textContent = '–';
        inBar.style.width = outBar.style.width = '0';
        row.classList.remove('is-over');
        return;
      }
      const total = used + out;
      const pct = (total / size) * 100;
      const inPct = Math.min(100, (used / size) * 100);
      const outPct = Math.min(100 - inPct, (out / size) * 100);
      inBar.style.width = `${inPct}%`;
      outBar.style.left = `${inPct}%`;
      outBar.style.width = `${outPct}%`;
      const over = total > size;
      row.classList.toggle('is-over', over);
      label.textContent = `${formatContext(size)} · ${formatInt(total)} / ${formatInt(size)}`;
      pctEl.textContent = over ? `over by ${formatInt(total - size)}` : `${pct < 0.1 && pct > 0 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)}%`;
      pctEl.dataset.pct = pct.toFixed(4);
      bar.setAttribute('aria-label', `${pct.toFixed(1)}% of ${formatInt(size)} tokens`);
    });
  }

  // Cost
  const presetEl = $<HTMLSelectElement>('#tc-preset');
  const priceIn = $<HTMLInputElement>('#tc-price-in');
  const priceOut = $<HTMLInputElement>('#tc-price-out');
  const requestsEl = $<HTMLInputElement>('#tc-requests');
  const basisEl = $<HTMLSelectElement>('#tc-basis');
  presetEl.innerHTML =
    `<option value="custom">Custom prices</option><optgroup label="Examples, check current pricing">` +
    PRESETS.map((p) => `<option value="${p.key}">${p.label}</option>`).join('') +
    '</optgroup>';
  const applyPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    priceIn.value = String(p.input);
    priceOut.value = String(p.output);
  };
  presetEl.value = 'mid';
  applyPreset('mid');
  presetEl.addEventListener('change', () => {
    applyPreset(presetEl.value);
    renderCost();
  });
  [priceIn, priceOut].forEach((el) =>
    el.addEventListener('input', () => {
      presetEl.value = 'custom';
      renderCost();
    }),
  );
  requestsEl.addEventListener('input', () => renderCost());
  outTokensEl.addEventListener('input', () => {
    renderCost();
    renderContext();
  });
  basisEl.addEventListener('change', () => renderCost());

  function renderBasisOptions() {
    const prev = basisEl.value || 'exact';
    const c = current?.count;
    const opts = [`<option value="exact">Exact ${encoding}${c != null ? ` (${formatInt(c)})` : ''}</option>`];
    for (const m of APPROX_MODELS) {
      const a = approxFor(m.key);
      opts.push(`<option value="${m.key}">Approx. ${m.name}${a && !approxPending ? ` (≈ ${formatInt(a.mid)})` : ''}</option>`);
    }
    basisEl.innerHTML = opts.join('');
    basisEl.value = prev;
  }

  function basisTokens() {
    if (basisEl.value === 'exact') return current?.count ?? 0;
    const a = approxFor(basisEl.value);
    return a ? a.mid : 0;
  }

  function renderCost() {
    const r = estimateCost({
      inputTokens: basisTokens(),
      outputTokens: num(outTokensEl),
      inputPricePerM: num(priceIn),
      outputPricePerM: num(priceOut),
      requests: num(requestsEl),
    });
    const set = (k: string, v: number) => {
      const el = $(`[data-cost="${k}"]`);
      el.textContent = formatUSD(v);
      el.dataset.value = String(v);
    };
    set('input', r.input);
    set('output', r.output);
    set('per', r.perRequest);
    set('total', r.total);
    $('#tc-cost-req').textContent = r.requests > 1 ? `× ${formatInt(r.requests)}` : '';
  }

  function renderNumbers() {
    renderStats();
    renderContext();
    renderApprox();
    renderBasisOptions();
    renderCost();
  }

  // ---------- Encoding picker ----------
  const encGroup = $('#tc-enc');
  const encButtons = Array.from(encGroup.querySelectorAll<HTMLButtonElement>('[data-enc]'));
  function selectEncoding(name: EncodingName, focus = false) {
    encButtons.forEach((b) => {
      const on = b.dataset.enc === name;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    if (name === encoding) return;
    encoding = name;
    if (name !== 'o200k_base') o200kCount = null;
    schedule(true);
  }
  encButtons.forEach((b, i) => {
    b.addEventListener('click', () => selectEncoding(b.dataset.enc as EncodingName));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = encButtons[(i + d + encButtons.length) % encButtons.length];
      selectEncoding(next.dataset.enc as EncodingName, true);
    });
  });

  // ---------- Info popover ----------
  const infoBtn = $('#tc-info-btn');
  const info = $('#tc-info');
  const setInfo = (open: boolean) => {
    info.hidden = !open;
    infoBtn.setAttribute('aria-expanded', String(open));
  };
  infoBtn.addEventListener('click', () => setInfo(info.hidden));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !info.hidden) {
      setInfo(false);
      infoBtn.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!info.hidden && !info.contains(e.target as Node) && !infoBtn.contains(e.target as Node)) setInfo(false);
  });

  // ---------- Visualization toggles + export ----------
  const idsBtn = $('#tc-toggle-ids');
  const wsBtn = $('#tc-toggle-ws');
  const toggle = (btn: HTMLElement, key: 'showIds' | 'showWs') => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    [mainView, cmpViews.a, cmpViews.b, decView].forEach((v) => v.setOptions({ [key]: on }));
  };
  idsBtn.addEventListener('click', () => toggle(idsBtn, 'showIds'));
  wsBtn.addEventListener('click', () => toggle(wsBtn, 'showWs'));

  $('#tc-copy-ids').addEventListener('click', () => {
    if (!currentIds?.length) return toast('No tokens to copy yet', 'error');
    copyText(`[${Array.from(currentIds).join(', ')}]`, `Copied ${formatInt(currentIds.length)} token ids`);
  });
  $('#tc-download').addEventListener('click', () => {
    if (!currentIds?.length || !current) return toast('No tokens to download yet', 'error');
    const payload = {
      encoding,
      specialTokensParsed: special.checked,
      tokenCount: currentIds.length,
      characters: current.stats.chars,
      utf8Bytes: current.stats.bytes,
      ids: Array.from(currentIds),
    };
    downloadText(JSON.stringify(payload), `tokens-${encoding}.json`, 'application/json');
    toast(`Downloaded ${formatInt(currentIds.length)} token ids`);
  });

  // ---------- Input helpers: examples, file, clear ----------
  document.querySelectorAll<HTMLButtonElement>('[data-example]').forEach((b) =>
    b.addEventListener('click', () => {
      const ex = EXAMPLES.find((x) => x.key === b.dataset.example);
      if (!ex) return;
      input.value = ex.text;
      schedule(true);
    }),
  );
  $('#tc-clear').addEventListener('click', () => {
    input.value = '';
    schedule(true);
    input.focus();
  });

  async function loadFile(file: File) {
    if (file.size > MAX_FILE) {
      toast(`${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE)}.`, 'error', 4000);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      toast(`Could not read ${file.name}`, 'error');
      return;
    }
    if (text.slice(0, 8000).includes('\u0000')) {
      toast(`${file.name} looks like a binary file. Drop a plain-text file instead.`, 'error', 4000);
      return;
    }
    input.value = text;
    schedule(true);
    toast(`Loaded ${file.name} (${formatBytes(file.size)})`);
  }
  setupDropzone($('#tc-drop'), (files) => loadFile(files[0]), { accept: FILE_ACCEPT, pageWide: true });

  // ---------- Compare ----------
  const cmpSel = { a: $<HTMLSelectElement>('#tc-cmp-a'), b: $<HTMLSelectElement>('#tc-cmp-b') };
  const cmpCount = { a: $('#tc-cmp-a-count'), b: $('#tc-cmp-b-count') };
  const cmpCounts: { a: number | null; b: number | null } = { a: null, b: null };
  const cmpSummary = $('#tc-cmp-summary');
  let cmpSeq = 0;
  function renderCmpSummary() {
    const { a, b } = cmpCounts;
    const ea = cmpSel.a.value;
    const eb = cmpSel.b.value;
    if (a == null || b == null) {
      cmpSummary.textContent = '';
      return;
    }
    if (!a && !b) cmpSummary.textContent = 'No text to compare.';
    else if (a === b) cmpSummary.textContent = `Both encodings produce ${formatInt(a)} tokens.`;
    else {
      const diff = b - a;
      const pct = a ? Math.abs(diff / a) * 100 : 100;
      cmpSummary.textContent = `${eb} uses ${formatInt(Math.abs(diff))} ${diff > 0 ? 'more' : 'fewer'} tokens than ${ea} (${diff > 0 ? '+' : '−'}${pct.toFixed(1)}%).`;
    }
  }
  async function runCompareSide(side: 'a' | 'b', text: string, seq: number) {
    const name = cmpSel[side].value as EncodingName;
    const h = encoder(name);
    cmpCount[side].textContent = h.ready ? 'Tokenizing…' : `Loading ${encMeta(name).size}…`;
    try {
      const res = await h.encode(`cmp-${side}`, text, { allowSpecial: special.checked });
      if (!res || seq !== cmpSeq) return;
      cmpCounts[side] = res.ids.length;
      cmpCount[side].textContent = `${formatInt(res.ids.length)} tokens`;
      cmpCount[side].dataset.count = String(res.ids.length);
      cmpViews[side].set({ ids: res.ids, lens: res.lens!, bytes: utf8.encode(text) });
      renderCmpSummary();
    } catch (err: any) {
      if (seq === cmpSeq) cmpCount[side].textContent = err?.message || 'Failed';
    }
  }
  function runCompare() {
    compareDirty = false;
    const text = input.value;
    const seq = ++cmpSeq;
    cmpCounts.a = cmpCounts.b = null;
    renderCmpSummary();
    if (!text) {
      (['a', 'b'] as const).forEach((s) => {
        cmpCounts[s] = 0;
        cmpCount[s].textContent = '0 tokens';
        cmpCount[s].dataset.count = '0';
        cmpViews[s].set(null);
      });
      renderCmpSummary();
      return;
    }
    runCompareSide('a', text, seq);
    runCompareSide('b', text, seq);
  }
  Object.values(cmpSel).forEach((s) => s.addEventListener('change', () => runCompare()));

  // ---------- Decode ----------
  const idsInput = $<HTMLTextAreaElement>('#tc-ids-input');
  const decEnc = $<HTMLSelectElement>('#tc-dec-enc');
  const decErr = $('#tc-dec-error');
  const decText = $('#tc-dec-text');
  const decMeta = $('#tc-dec-meta');
  decEnc.value = 'cl100k_base';
  let decSeq = 0;
  let decodedText = '';
  async function runDecode() {
    const seq = ++decSeq;
    const showError = (msg: string) => {
      decErr.textContent = msg;
      decErr.hidden = false;
    };
    decErr.hidden = true;
    let ids: number[];
    try {
      ids = parseTokenIds(idsInput.value);
    } catch (err: any) {
      showError(err.message);
      return;
    }
    if (!ids.length) {
      decodedText = '';
      decText.textContent = '';
      decMeta.textContent = '';
      decView.set(null);
      return;
    }
    const name = decEnc.value as EncodingName;
    const h = encoder(name);
    if (!h.ready) decMeta.textContent = `(loading ${name}…)`;
    try {
      const res = await h.decode('decode', ids);
      if (!res || seq !== decSeq) return;
      decodedText = res.text;
      decText.textContent = res.text;
      const partial = splitUtf8(res.bytes).some((s) => 'bytes' in s);
      decMeta.textContent = `(${formatInt(res.ids.length)} tokens, ${formatInt(res.bytes.length)} bytes${partial ? ', incomplete UTF-8 shown as �' : ''})`;
      decView.set({ ids: res.ids, lens: res.lens, bytes: res.bytes });
    } catch (err: any) {
      if (seq !== decSeq) return;
      showError(err?.message || 'Decoding failed.');
      decText.textContent = '';
      decMeta.textContent = '';
      decView.set(null);
    }
  }
  let decTimer: ReturnType<typeof setTimeout> | undefined;
  idsInput.addEventListener('input', () => {
    clearTimeout(decTimer);
    decTimer = setTimeout(runDecode, 150);
  });
  decEnc.addEventListener('change', () => runDecode());
  $('#tc-dec-copy').addEventListener('click', () => {
    if (!decodedText) return toast('Nothing to copy', 'error');
    copyText(decodedText, 'Decoded text copied');
  });

  // ---------- Tabs ----------
  let decodeStarted = false;
  initTabs(document, (group, tab) => {
    if (group !== 'tc') return;
    activeTab = tab;
    if (tab === 'compare' && compareDirty) runCompare();
    if (tab === 'decode' && !decodeStarted) {
      decodeStarted = true;
      runDecode();
    }
  });

  // ---------- Start ----------
  buildContextRows(DEFAULT_CONTEXTS);
  const hashEnc = new URLSearchParams(location.hash.slice(1)).get('enc');
  if (hashEnc && isEncodingName(hashEnc)) selectEncoding(hashEnc);
  input.value = EXAMPLES[0].text;
  renderNumbers();
  void statusKind;
  runMain();
}
