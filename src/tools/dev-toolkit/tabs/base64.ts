import { setupDropzone, downloadBlob, downloadText, formatBytes, toast, debounce, escapeHtml, cssVar } from '../../../lib/ui';
import { $, bytesToBase64, base64ToBytes, utf8OrNull, isPrintable, segmented, setStatus, enc } from '../util';
import { detectType, type FileType } from '../magic';

const MAX_FILE = 100 * 1024 * 1024;
const SHOW_LIMIT = 1_000_000; // characters shown in a textarea before we truncate the view

const plural = (n: number, w: string) => `${n.toLocaleString('en')} ${w}${n === 1 ? '' : 's'}`;

/** Heuristic for auto mode: a Base64 string that decodes to readable UTF-8 text. */
function autoDecodes(text: string) {
  const t = text.replace(/\s+/g, '');
  if (t.length < 4 || t.length % 4 === 1) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return false;
  if (/[+/]/.test(t) && /[-_]/.test(t)) return false;
  try {
    const u = utf8OrNull(base64ToBytes(t));
    return u !== null && u.length > 0 && isPrintable(u);
  } catch {
    return false;
  }
}

export function init() {
  // ---------------------------------------------------------------- text ⇄ Base64
  const inp = $<HTMLTextAreaElement>('#b64-in');
  const out = $<HTMLTextAreaElement>('#b64-out');
  const detect = $('#b64-detect');
  const stats = $('#b64-stats');
  const status = $('#b64-status');
  const urlsafe = $<HTMLInputElement>('#b64-urlsafe');
  const nopad = $<HTMLInputElement>('#b64-nopad');

  const run = () => {
    const text = inp.value;
    const m = mode.get();
    const dir = m === 'auto' ? (autoDecodes(text) ? 'decode' : 'encode') : m;
    detect.textContent = (m === 'auto' ? 'Auto: ' : '') + (dir === 'encode' ? 'encoding' : 'decoding');
    detect.className = `badge ${dir === 'encode' ? 'badge-accent' : 'badge-success'}`;
    setStatus(status, null);
    if (!text) {
      out.value = '';
      stats.textContent = 'Type or paste text. Auto mode decodes valid Base64 and encodes everything else.';
      return;
    }
    if (dir === 'encode') {
      const bytes = enc.encode(text);
      out.value = bytesToBase64(bytes, urlsafe.checked, !nopad.checked);
      stats.textContent = `${plural(bytes.length, 'UTF-8 byte')} → ${plural(out.value.length, 'character')}`;
    } else {
      try {
        const bytes = base64ToBytes(text);
        const u = utf8OrNull(bytes);
        if (u === null) {
          out.value = new TextDecoder().decode(bytes);
          const t = detectType(bytes);
          setStatus(status, 'warning', `The decoded ${plural(bytes.length, 'byte')} are not valid UTF-8 text (looks like: ${t.label}). Use “Base64 → File” below to download them.`);
        } else out.value = u;
        stats.textContent = `${plural(text.replace(/\s+/g, '').length, 'character')} → ${plural(bytes.length, 'byte')}`;
      } catch (e: any) {
        out.value = '';
        setStatus(status, 'error', e.message);
        stats.textContent = '';
      }
    }
  };
  const mode = segmented($('#b64-mode'), run);
  inp.addEventListener('input', run);
  urlsafe.addEventListener('change', run);
  nopad.addEventListener('change', run);
  $('#b64-swap').addEventListener('click', () => {
    if (!out.value) return toast('Nothing to swap yet', 'error');
    inp.value = out.value;
    run();
    inp.focus();
  });
  $('#b64-clear').addEventListener('click', () => {
    inp.value = '';
    run();
    inp.focus();
  });
  $('#b64-example').addEventListener('click', () => {
    inp.value = inp.value === 'héllo 🌍' ? 'aMOpbGxvIPCfjI0=' : 'héllo 🌍';
    run();
  });
  run();

  // ---------------------------------------------------------------- file → Base64
  const fileOut = $<HTMLTextAreaElement>('#b64-file-out');
  const fileInfo = $('#b64-file-info');
  const filePrev = $<HTMLImageElement>('#b64-file-preview');
  const fileDl = $<HTMLButtonElement>('#b64-file-dl');
  const fileStatus = $('#b64-file-status');
  let file: { name: string; type: string; size: number; b64: string } | null = null;
  let fileUrl = '';

  const renderFile = () => {
    if (!file) return;
    const full = fmt.get() === 'dataurl' ? `data:${file.type};base64,${file.b64}` : file.b64;
    fileOut.value = full.length > SHOW_LIMIT ? `${full.slice(0, SHOW_LIMIT)}…` : full;
    fileOut.dataset.full = full.length > SHOW_LIMIT ? '1' : '';
    (fileOut as any)._full = full;
    fileInfo.innerHTML = `<span><b>${escapeHtml(file.name)}</b></span><span>${escapeHtml(file.type)}</span><span>File <b>${formatBytes(file.size)}</b></span><span>Base64 <b>${full.length.toLocaleString('en')}</b> chars (${formatBytes(full.length)})</span>`;
    fileInfo.hidden = false;
    if (full.length > SHOW_LIMIT) setStatus(fileStatus, 'info', 'The output is large, so only the first 1,000,000 characters are shown. Copy and Download use the full text.');
    else setStatus(fileStatus, null);
  };
  const fmt = segmented($('#b64-file-fmt'), renderFile);
  setupDropzone($('#b64-drop'), async ([f]) => {
    if (f.size > MAX_FILE) return setStatus(fileStatus, 'error', `${f.name} is ${formatBytes(f.size)}. The limit is 100 MB, because Base64 text that large is impractical to copy or paste.`);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const t = detectType(bytes);
      file = { name: f.name, type: f.type || t.mime, size: f.size, b64: bytesToBase64(bytes) };
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      fileUrl = '';
      filePrev.hidden = true;
      if (t.image || f.type.startsWith('image/')) {
        fileUrl = URL.createObjectURL(f);
        filePrev.src = fileUrl;
        filePrev.hidden = false;
      }
      fileDl.disabled = false;
      renderFile();
      toast(`Encoded ${f.name}`);
    } catch (e: any) {
      setStatus(fileStatus, 'error', `Could not read the file: ${e.message}`);
    }
  });
  // The copy button copies the textarea value; make it copy the untruncated text instead.
  fileOut.closest('.dt-card')!.querySelector('[data-copy="b64-file-out"]')!.addEventListener(
    'click',
    (e) => {
      const full = (fileOut as any)._full as string | undefined;
      if (full && fileOut.dataset.full) {
        e.stopPropagation();
        navigator.clipboard.writeText(full).then(() => toast('Base64 copied'), () => toast('Copy failed', 'error'));
      }
    },
    true,
  );
  fileDl.addEventListener('click', () => {
    if (!file) return;
    downloadText((fileOut as any)._full, `${file.name}.b64.txt`);
    toast('Download started');
  });

  // ---------------------------------------------------------------- Base64 → file
  const decIn = $<HTMLTextAreaElement>('#b64-dec-in');
  const decStatus = $('#b64-dec-status');
  const decInfo = $('#b64-dec-info');
  const decPrev = $<HTMLImageElement>('#b64-dec-preview');
  const decName = $<HTMLInputElement>('#b64-dec-name');
  const decDl = $<HTMLButtonElement>('#b64-dec-dl');
  let decoded: { bytes: Uint8Array; type: FileType; mime: string } | null = null;
  let decUrl = '';
  let nameTouched = false;
  decName.addEventListener('input', () => (nameTouched = !!decName.value));

  const decode = () => {
    const raw = decIn.value.trim();
    decoded = null;
    decDl.disabled = true;
    decInfo.hidden = true;
    decPrev.hidden = true;
    if (decUrl) URL.revokeObjectURL(decUrl);
    decUrl = '';
    setStatus(decStatus, null);
    if (!raw) return;
    let declared = '';
    let body = raw;
    const m = raw.match(/^data:([^,;]*)((?:;[^,;]+)*?),(.*)$/s);
    if (m) {
      declared = m[1];
      if (!/;base64/i.test(m[2])) {
        // Percent-encoded data URL (e.g. inline SVG)
        try {
          const bytes = enc.encode(decodeURIComponent(m[3]));
          return show(bytes, declared);
        } catch {
          return setStatus(decStatus, 'error', 'This data URL is not Base64 and its percent-encoding is malformed.');
        }
      }
      body = m[3];
    }
    try {
      const bytes = base64ToBytes(body);
      if (!bytes.length) return setStatus(decStatus, 'error', 'Nothing to decode.');
      show(bytes, declared);
    } catch (e: any) {
      setStatus(decStatus, 'error', e.message);
    }
  };
  function show(bytes: Uint8Array, declared: string) {
    const type = detectType(bytes);
    const mime = type.mime === 'application/octet-stream' && declared ? declared : type.mime;
    decoded = { bytes, type, mime };
    decDl.disabled = false;
    if (!nameTouched) decName.value = `decoded.${type.ext}`;
    const mismatch = declared && declared !== type.mime && type.mime !== 'application/octet-stream' ? `<span class="badge badge-warning">Declared ${escapeHtml(declared)}</span>` : '';
    decInfo.innerHTML = `<span>Detected <b>${escapeHtml(type.label)}</b></span><span class="mono">${escapeHtml(mime)}</span><span><b>${formatBytes(bytes.length)}</b> (${bytes.length.toLocaleString('en')} bytes)</span>${mismatch}`;
    decInfo.hidden = false;
    if (type.image) {
      decUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: type.mime }));
      decPrev.src = decUrl;
      decPrev.hidden = false;
      decPrev.onerror = () => {
        decPrev.hidden = true;
        setStatus(decStatus, 'warning', 'The data starts like an image but the browser could not display it. It may be truncated or corrupt.');
      };
    }
  }
  decIn.addEventListener('input', debounce(decode, 120));
  decDl.addEventListener('click', () => {
    if (!decoded) return;
    const name = decName.value.trim() || `decoded.${decoded.type.ext}`;
    downloadBlob(new Blob([decoded.bytes as BlobPart], { type: decoded.mime }), name);
    toast(`Downloading ${name}`);
  });
  const example = () => {
    decIn.value = exampleImage();
    nameTouched = false;
    decName.value = '';
    decode();
  };
  $('#b64-dec-example').addEventListener('click', example);
  example();
}

/** A small generated PNG so the decoder shows a preview right away. */
function exampleImage() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, cssVar('--c1') || '#4f46e5');
  grad.addColorStop(1, cssVar('--c2') || '#0891b2');
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(2, 2, 60, 60, 14);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.lineCap = g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(18, 22);
  g.lineTo(30, 32);
  g.lineTo(18, 42);
  g.moveTo(34, 42);
  g.lineTo(46, 42);
  g.stroke();
  return c.toDataURL('image/png');
}
