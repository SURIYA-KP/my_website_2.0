// Small shared helpers for tools. Browser-only, no storage, no network.

/** Copy text to the clipboard and show a toast. */
export async function copyText(text: string, message = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    // Fallback for non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? message : 'Copy failed', ok ? 'info' : 'error');
  }
}

/** Trigger a download of a Blob. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(text: string, filename: string, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

let toastHost: HTMLElement | null = null;
/** Show a short, non-blocking message. */
export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 2200) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' toast-error' : ''}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export interface DropzoneOptions {
  accept?: string; // e.g. "image/*,.svg"
  multiple?: boolean;
}

/**
 * Make an element a click-or-drop file target. Also accepts files dropped anywhere
 * on the page when `pageWide` is true. Returns a function that opens the picker.
 */
export function setupDropzone(
  el: HTMLElement,
  onFiles: (files: File[]) => void,
  opts: DropzoneOptions & { pageWide?: boolean } = {},
) {
  const input = document.createElement('input');
  input.type = 'file';
  if (opts.accept) input.accept = opts.accept;
  if (opts.multiple) input.multiple = true;
  input.hidden = true;
  el.appendChild(input);

  const open = () => input.click();
  el.addEventListener('click', (e) => {
    if (e.target === input) return;
    open();
  });
  el.tabIndex = el.tabIndex >= 0 ? el.tabIndex : 0;
  el.setAttribute('role', 'button');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) onFiles(files);
  });

  const target: HTMLElement | Window = opts.pageWide ? window : el;
  let depth = 0;
  target.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    el.classList.add('is-dragover');
  });
  target.addEventListener('dragover', (e) => e.preventDefault());
  target.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) el.classList.remove('is-dragover');
  });
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    el.classList.remove('is-dragover');
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    if (files.length) onFiles(opts.multiple ? files : files.slice(0, 1));
  });
  return open;
}

/**
 * Wire up tabs. Markup:
 *   <div class="tabs" role="tablist" data-tabs="name">
 *     <button class="tab" role="tab" data-tab="a" aria-selected="true">A</button> ...
 *   </div>
 *   <section data-tabpanel="name:a">...</section>
 */
export function initTabs(root: ParentNode = document, onChange?: (group: string, tab: string) => void) {
  root.querySelectorAll<HTMLElement>('[data-tabs]').forEach((list) => {
    const group = list.dataset.tabs!;
    const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[data-tab]'));
    const select = (name: string, focus = false) => {
      tabs.forEach((t) => {
        const on = t.dataset.tab === name;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        if (on && focus) t.focus();
      });
      document.querySelectorAll<HTMLElement>(`[data-tabpanel^="${group}:"]`).forEach((p) => {
        p.hidden = p.dataset.tabpanel !== `${group}:${name}`;
      });
      onChange?.(group, name);
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t.dataset.tab!));
      t.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) select(tabs[(i + d + tabs.length) % tabs.length].dataset.tab!, true);
      });
    });
    const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
    if (initial) select(initial.dataset.tab!);
  });
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms = 200) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function formatBytes(bytes: number, digits = 1) {
  if (!Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Read a CSS custom property (e.g. '--accent') from :root — handy for canvas drawing. */
export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Fires when the effective theme changes (system or toggle). */
export function onThemeChange(cb: () => void) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', cb);
  new MutationObserver(cb).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function isDarkTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
