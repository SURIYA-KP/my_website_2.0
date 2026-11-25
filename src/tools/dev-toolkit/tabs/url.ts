import { $, $$, segmented, setStatus } from '../util';

/** Point at the first malformed %-sequence so the error message is actionable. */
function badPercent(s: string) {
  const re = /%(?![0-9a-f]{2})/gi;
  const m = re.exec(s);
  if (m) return `“${s.slice(m.index, m.index + 3)}” at position ${m.index + 1} is not a valid %XX escape`;
  return 'the %XX escapes do not form valid UTF-8';
}

export function init() {
  // ---------------------------------------------------------------- encode / decode
  const inp = $<HTMLTextAreaElement>('#url-in');
  const out = $<HTMLTextAreaElement>('#url-out');
  const plus = $<HTMLInputElement>('#url-plus');
  const status = $('#url-status');
  const run = () => {
    const s = inp.value;
    setStatus(status, null);
    try {
      switch (mode.get()) {
        case 'component':
          out.value = plus.checked ? encodeURIComponent(s).replace(/%20/g, '+') : encodeURIComponent(s);
          break;
        case 'uri':
          out.value = plus.checked ? encodeURI(s).replace(/%20/g, '+') : encodeURI(s);
          break;
        default:
          out.value = decodeURIComponent(plus.checked ? s.replace(/\+/g, ' ') : s);
      }
    } catch (e: any) {
      out.value = '';
      if (mode.get() === 'decode') setStatus(status, 'error', `Cannot decode: ${badPercent(s)}.`);
      else setStatus(status, 'error', `Cannot encode: the text contains a lone surrogate character (${e.message}).`);
    }
  };
  const mode = segmented($('#url-mode'), run);
  inp.addEventListener('input', run);
  plus.addEventListener('change', run);
  $('#url-swap').addEventListener('click', () => {
    inp.value = out.value;
    mode.set(mode.get() === 'decode' ? 'component' : 'decode');
    inp.focus();
  });
  run();

  // ---------------------------------------------------------------- parser / builder
  const main = $<HTMLInputElement>('#url-parse');
  const pStatus = $('#url-parse-status');
  const parts = $$<HTMLInputElement>('[data-part]', $('#url-parts'));
  const origin = $<HTMLInputElement>('#url-origin');
  const rows = $('#url-param-rows');
  const count = $('#url-param-count');
  const empty = $('#url-params-empty');
  const query = $('#url-query');
  let url: URL | null = null;

  const fillParts = (skip?: HTMLElement) => {
    if (!url) return;
    for (const p of parts) {
      if (p === skip) continue;
      p.value = (url as any)[p.dataset.part!] ?? '';
    }
    $<HTMLInputElement>('#url-port').placeholder = defaultPort(url.protocol);
    origin.value = url.origin === 'null' ? '(opaque)' : url.origin;
    query.textContent = url.search.slice(1);
  };
  const paramRow = (k: string, v: string) => {
    const row = document.createElement('div');
    row.className = 'dt-param';
    row.setAttribute('role', 'row');
    row.innerHTML = `<input class="input mono" data-k spellcheck="false" autocomplete="off" aria-label="Parameter name" role="cell" />
      <input class="input mono" data-v spellcheck="false" autocomplete="off" aria-label="Parameter value" role="cell" />
      <button class="btn btn-icon btn-ghost" type="button" data-remove aria-label="Remove parameter" title="Remove parameter">✕</button>`;
    (row.querySelector('[data-k]') as HTMLInputElement).value = k;
    (row.querySelector('[data-v]') as HTMLInputElement).value = v;
    return row;
  };
  const updateCount = () => {
    const n = rows.children.length;
    count.textContent = String(n);
    empty.hidden = n > 0 || !url;
  };
  const fillParams = () => {
    rows.replaceChildren();
    if (url) for (const [k, v] of url.searchParams) rows.append(paramRow(k, v));
    updateCount();
  };
  const parse = () => {
    const s = main.value.trim();
    try {
      url = new URL(s);
      setStatus(pStatus, null);
      main.classList.remove('is-invalid');
    } catch {
      url = null;
      setStatus(pStatus, s ? 'error' : 'info', s ? 'Not a valid absolute URL. Include the scheme, e.g. https://example.com/path.' : 'Paste a URL to break it into parts.');
      parts.forEach((p) => (p.value = ''));
      origin.value = '';
      rows.replaceChildren();
      updateCount();
      return;
    }
    fillParts();
    fillParams();
  };
  const rebuildFromParams = () => {
    if (!url) return;
    const sp = new URLSearchParams();
    for (const r of Array.from(rows.children)) {
      const k = (r.querySelector('[data-k]') as HTMLInputElement).value;
      const v = (r.querySelector('[data-v]') as HTMLInputElement).value;
      if (k || v) sp.append(k, v);
    }
    const qs = sp.toString();
    url.search = qs ? `?${qs}` : '';
    main.value = url.href;
    query.textContent = qs;
    updateCount();
  };

  main.addEventListener('input', parse);
  for (const p of parts) {
    p.addEventListener('input', () => {
      if (!url) return;
      try {
        (url as any)[p.dataset.part!] = p.value;
      } catch {}
      main.value = url.href;
      fillParts(p);
    });
    // On blur, show what the URL parser actually kept (e.g. an invalid port is ignored).
    p.addEventListener('change', () => fillParts());
  }
  rows.addEventListener('input', rebuildFromParams);
  rows.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-remove]');
    if (!btn) return;
    const row = btn.closest('.dt-param')!;
    const next = (row.nextElementSibling ?? row.previousElementSibling)?.querySelector<HTMLInputElement>('[data-k]');
    row.remove();
    rebuildFromParams();
    (next ?? $('#url-add-param')).focus();
  });
  $('#url-add-param').addEventListener('click', () => {
    if (!url) return setStatus(pStatus, 'error', 'Enter a valid URL first.');
    const r = paramRow('', '');
    rows.append(r);
    updateCount();
    r.querySelector<HTMLInputElement>('[data-k]')!.focus();
  });
  parse();
}

function defaultPort(protocol: string) {
  return ({ 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' } as Record<string, string>)[protocol] ?? '';
}
