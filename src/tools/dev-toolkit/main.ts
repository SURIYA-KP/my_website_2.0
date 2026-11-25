// Dev Toolkit entry: tabs, #hash deep links, shared copy buttons, and lazy loading of each tab's code.
import { initTabs, copyText, toast } from '../../lib/ui';

export interface TabModule {
  init(panel: HTMLElement): void | Promise<void>;
  show?(): void;
  hide?(): void;
}

const LOADERS: Record<string, () => Promise<TabModule>> = {
  base64: () => import('./tabs/base64'),
  url: () => import('./tabs/url'),
  html: () => import('./tabs/html'),
  jwt: () => import('./tabs/jwt'),
  hash: () => import('./tabs/hash'),
  uuid: () => import('./tabs/ids'),
  time: () => import('./tabs/time'),
  password: () => import('./tabs/password'),
  bases: () => import('./tabs/bases'),
};

// Friendly aliases for deep links (…/dev-toolkit/#sha256 opens the Hash tab).
const ALIASES: Record<string, string> = {
  b64: 'base64', urlencode: 'url', uri: 'url', entities: 'html', html_entities: 'html', token: 'jwt',
  hashes: 'hash', md5: 'hash', sha1: 'hash', sha256: 'hash', hmac: 'hash', uuids: 'uuid', ids: 'uuid', ulid: 'uuid',
  nanoid: 'uuid', timestamp: 'time', timestamps: 'time', unix: 'time', epoch: 'time', passwords: 'password',
  passphrase: 'password', pw: 'password', base: 'bases', numbers: 'bases', bytes: 'bases', hex: 'bases',
};

function tabFromHash(): string | null {
  const h = decodeURIComponent(location.hash.slice(1)).trim().toLowerCase();
  if (!h) return null;
  if (h in LOADERS) return h;
  return ALIASES[h] ?? null;
}

const loaded = new Map<string, Promise<TabModule | null>>();
let current = '';

function load(tab: string) {
  let p = loaded.get(tab);
  if (!p) {
    const panel = document.getElementById(`dt-panel-${tab}`)!;
    panel.setAttribute('aria-busy', 'true');
    p = LOADERS[tab]()
      .then(async (mod) => {
        await mod.init(panel);
        panel.dataset.ready = 'true';
        return mod;
      })
      .catch((err) => {
        console.warn(err);
        const box = document.createElement('div');
        box.className = 'alert alert-error';
        box.textContent = `This tool failed to load (${err?.message || err}). Reload the page to try again.`;
        panel.prepend(box);
        return null;
      })
      .finally(() => panel.removeAttribute('aria-busy'));
    loaded.set(tab, p);
  }
  return p;
}

async function activate(tab: string, updateHash: boolean) {
  if (!(tab in LOADERS)) return;
  const prev = current;
  current = tab;
  if (updateHash && location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  const select = document.getElementById('dt-tab-select') as HTMLSelectElement | null;
  if (select) select.value = tab;
  document.getElementById(`dt-tab-${tab}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (prev && prev !== tab) loaded.get(prev)?.then((m) => m?.hide?.());
  const mod = await load(tab);
  if (current === tab) mod?.show?.();
}

function selectTab(tab: string) {
  document.getElementById(`dt-tab-${tab}`)?.click();
}

export function init() {
  const root = document.getElementById('dt')!;
  const fromHash = tabFromHash();
  if (fromHash) {
    root.querySelectorAll<HTMLElement>('[data-tabs="dt"] [data-tab]').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === fromHash));
    });
  }
  // The first call happens during setup; only rewrite the URL when a link asked for an alias.
  let first = true;
  initTabs(root, (group, tab) => {
    if (group !== 'dt') return;
    const update = !first || (!!location.hash && location.hash.slice(1) !== tab);
    first = false;
    activate(tab, update);
  });

  window.addEventListener('hashchange', () => {
    const t = tabFromHash();
    if (t && t !== current) selectTab(t);
  });
  const select = document.getElementById('dt-tab-select') as HTMLSelectElement;
  select.addEventListener('change', () => selectTab(select.value));

  // Shared copy buttons: data-copy="<element id>" copies that element's value or text.
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
    if (!btn) return;
    const el = document.getElementById(btn.dataset.copy!);
    const text = el ? ('value' in el && el.tagName !== 'OUTPUT' ? String((el as HTMLInputElement).value) : el.textContent ?? '') : '';
    if (!text.trim()) return toast('Nothing to copy yet', 'error');
    copyText(text, btn.dataset.copyMsg || 'Copied');
  });

  root.dataset.ready = 'true';
}
