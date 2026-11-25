import { setupDropzone, formatBytes, escapeHtml, debounce, toast } from '../../../lib/ui';
import { createHash, createHmac, HASH_ALGOS, type HashAlgo } from '../hashes';
import { $, $$, enc, bytesToBase64, bytesToHex, base64ToBytes, hexToBytes, segmented, kvRow, setStatus } from '../util';

export function init() {
  const textBox = $('#hash-text-box');
  const fileBox = $('#hash-file-box');
  const inp = $<HTMLTextAreaElement>('#hash-in');
  const results = $('#hash-results');
  const title = $('#hash-results-title');
  const empty = $('#hash-empty');
  const hmac = $<HTMLInputElement>('#hash-hmac');
  const keyRow = $('#hash-key-row');
  const key = $<HTMLInputElement>('#hash-key');
  const keyEnc = $<HTMLSelectElement>('#hash-key-enc');
  const expect = $<HTMLInputElement>('#hash-expect');
  const compare = $('#hash-compare');
  const fileInfo = $('#hash-file-info');
  const progress = $('#hash-progress');
  const fill = $('#hash-progress-fill');
  const bar = $('#hash-progress-bar');
  const ptext = $('#hash-progress-text');
  const algoBox = $('#hash-algos');

  algoBox.innerHTML = HASH_ALGOS.map((a) => `<label class="checkbox"><input type="checkbox" value="${a}" checked /> ${a}</label>`).join('');
  const algos = () => $$<HTMLInputElement>('input', algoBox).filter((c) => c.checked).map((c) => c.value as HashAlgo);

  let digests: Partial<Record<HashAlgo, Uint8Array>> = {};
  let keyError = '';
  let file: File | null = null;
  let fileDone = false;

  const keyBytes = (): Uint8Array | null => {
    keyError = '';
    if (!hmac.checked) return null;
    try {
      if (keyEnc.value === 'hex') return hexToBytes(key.value);
      if (keyEnc.value === 'base64') return base64ToBytes(key.value);
    } catch (e: any) {
      keyError = `HMAC key: ${e.message}`;
      return enc.encode('');
    }
    return enc.encode(key.value);
  };

  const fmtDigest = (b: Uint8Array) => {
    const f = fmt.get();
    return f === 'base64' ? bytesToBase64(b) : bytesToHex(b, f === 'HEX');
  };

  const render = () => {
    results.replaceChildren();
    const label = hmac.checked ? 'HMAC-' : '';
    title.textContent = hmac.checked ? 'HMAC digests' : 'Digests';
    const isFile = src.get() === 'file';
    empty.hidden = !(isFile && !file);
    for (const a of HASH_ALGOS) {
      const d = digests[a];
      if (!d) continue;
      const row = kvRow(`${label}${a}`, fmtDigest(d), { cls: 'dt-hash-row' });
      row.dataset.algo = a;
      results.append(row);
    }
    if (keyError) {
      const err = document.createElement('div');
      err.className = 'alert alert-error';
      err.textContent = keyError;
      results.prepend(err);
    }
    doCompare();
  };

  const doCompare = () => {
    const raw = expect.value.trim().replace(/^(?:md5|sha-?\d+)[:=\s]+/i, '').replace(/\s+/g, '');
    $$('.dt-kv-row', results).forEach((r) => r.classList.remove('is-match'));
    if (!raw) return (compare.innerHTML = '');
    if (!Object.keys(digests).length) return (compare.innerHTML = '<span class="badge">Waiting for a digest…</span>');
    const candidates: Uint8Array[] = [];
    if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) candidates.push(hexToBytes(raw));
    try {
      candidates.push(base64ToBytes(raw));
    } catch {}
    for (const a of HASH_ALGOS) {
      const d = digests[a];
      if (!d) continue;
      if (candidates.some((c) => c.length === d.length && c.every((x, i) => x === d[i]))) {
        results.querySelector(`[data-algo="${a}"]`)?.classList.add('is-match');
        compare.innerHTML = `<span class="badge badge-success">✓ Match</span><span class="muted">${hmac.checked ? 'HMAC-' : ''}${a}</span>`;
        return;
      }
    }
    const lens = candidates.map((c) => c.length * 8);
    const hint = lens.includes(128) ? 'same length as MD5' : lens.includes(160) ? 'same length as SHA-1' : lens.includes(256) ? 'same length as SHA-256' : lens.includes(384) ? 'same length as SHA-384' : lens.includes(512) ? 'same length as SHA-512' : 'not a recognized digest length';
    compare.innerHTML = `<span class="badge badge-danger">✗ No match</span><span class="muted">${escapeHtml(hint)}</span>`;
  };

  // ---- text
  const hashText = () => {
    if (src.get() !== 'text') return;
    const data = enc.encode(inp.value);
    const k = keyBytes();
    digests = {};
    for (const a of algos()) digests[a] = (k ? createHmac(a, k) : createHash(a)).update(data).digest();
    render();
  };

  // ---- file (worker)
  let worker: Worker | null = null;
  let jobId = 0;
  const stopWorker = () => {
    worker?.terminate();
    worker = null;
  };
  const hashFile = () => {
    if (!file) return render();
    stopWorker();
    const id = ++jobId;
    digests = {};
    fileDone = false;
    render();
    progress.hidden = false;
    fill.style.width = '0%';
    ptext.textContent = `Hashing… 0%`;
    const started = performance.now();
    worker = new Worker(new URL('../hash.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.progress !== undefined) {
        const pct = Math.round(m.progress * 100);
        fill.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
        ptext.textContent = `Hashing… ${pct}%`;
      } else if (m.error) {
        progress.hidden = true;
        stopWorker();
        toast(`Could not hash the file: ${m.error}`, 'error');
      } else {
        digests = m.results;
        fileDone = true;
        stopWorker();
        const secs = (performance.now() - started) / 1000;
        fill.style.width = '100%';
        ptext.textContent = `Done in ${secs < 1 ? `${Math.round(secs * 1000)} ms` : `${secs.toFixed(1)} s`}`;
        bar.setAttribute('aria-valuenow', '100');
        $('#hash-cancel').hidden = true;
        render();
      }
    };
    worker.onerror = (e) => {
      progress.hidden = true;
      stopWorker();
      toast(`Hashing failed: ${e.message}`, 'error');
    };
    $('#hash-cancel').hidden = false;
    worker.postMessage({ id, file, algos: algos(), key: keyBytes() });
  };
  $('#hash-cancel').addEventListener('click', () => {
    stopWorker();
    jobId++;
    progress.hidden = true;
    toast('Hashing cancelled');
  });
  setupDropzone($('#hash-drop'), ([f]) => {
    file = f;
    fileInfo.innerHTML = `<span><b>${escapeHtml(f.name)}</b></span><span>${formatBytes(f.size)} (${f.size.toLocaleString('en')} bytes)</span>`;
    fileInfo.hidden = false;
    hashFile();
  });

  const recompute = () => (src.get() === 'text' ? hashText() : hashFile());
  const src = segmented($('#hash-src'), (v) => {
    textBox.hidden = v !== 'text';
    fileBox.hidden = v !== 'file';
    if (v === 'text') {
      stopWorker();
      jobId++;
      hashText();
    } else if (file && fileDone) {
      hashFile();
    } else {
      digests = {};
      render();
    }
  });
  const fmt = segmented($('#hash-fmt'), render);
  inp.addEventListener('input', debounce(hashText, 60));
  hmac.addEventListener('change', () => {
    keyRow.hidden = !hmac.checked;
    if (hmac.checked) key.focus();
    recompute();
  });
  key.addEventListener('input', debounce(recompute, 150));
  keyEnc.addEventListener('change', recompute);
  algoBox.addEventListener('change', () => {
    if (!algos().length) {
      toast('Pick at least one algorithm', 'error');
      (algoBox.querySelector('input') as HTMLInputElement).checked = true;
    }
    recompute();
  });
  expect.addEventListener('input', doCompare);
  hashText();
}
