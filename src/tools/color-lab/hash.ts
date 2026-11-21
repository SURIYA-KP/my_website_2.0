// URL #hash (de)serialization. Only the active tab's state is written, so a shared link
// opens exactly what the sender was looking at. The hash never leaves the browser.
import type { GradientState, Harmony, GradientType, GradientSpace } from './color';
import { HARMONIES } from './color';

export type TabId = 'convert' | 'contrast' | 'palette' | 'gradient' | 'image' | 'vision';
export const TABS: TabId[] = ['convert', 'contrast', 'palette', 'gradient', 'image', 'vision'];

export interface HashState {
  tab: TabId;
  color?: string;
  fg?: string;
  bg?: string;
  target?: string;
  base?: string;
  harmony?: Harmony;
  colors?: string[];
  locks?: boolean[];
  name?: string;
  gradient?: GradientState;
  k?: number;
  clusters?: { hex: string; share: number }[];
  vision?: string[];
}

/** Hex colors are stored without '#', anything else (oklch(...)) as-is. */
const enc = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c.slice(1).toLowerCase() : c);
const dec = (c: string) => (/^[0-9a-f]{3,8}$/i.test(c) ? '#' + c.toLowerCase() : c);
const list = (s: string | null) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

export function encodeHash(s: HashState): string {
  const p = new URLSearchParams();
  p.set('tab', s.tab);
  switch (s.tab) {
    case 'convert':
      if (s.color) p.set('c', enc(s.color));
      break;
    case 'contrast':
      if (s.fg) p.set('fg', enc(s.fg));
      if (s.bg) p.set('bg', enc(s.bg));
      if (s.target) p.set('t', s.target);
      break;
    case 'palette':
      if (s.base) p.set('base', enc(s.base));
      if (s.harmony) p.set('h', s.harmony);
      if (s.colors?.length) p.set('p', s.colors.map(enc).join(','));
      if (s.locks?.some(Boolean)) p.set('l', s.locks.map((x) => (x ? '1' : '0')).join(''));
      if (s.name) p.set('n', s.name);
      break;
    case 'gradient':
      if (s.gradient) {
        const g = s.gradient;
        p.set('g', g.type);
        p.set('a', String(Math.round(g.angle)));
        p.set('s', g.space);
        p.set('st', g.stops.map((st) => `${enc(st.color)}@${Math.round(st.pos * 10) / 10}`).join(','));
      }
      break;
    case 'image':
      if (s.k) p.set('k', String(s.k));
      if (s.clusters?.length) p.set('p', s.clusters.map((c) => `${enc(c.hex)}@${Math.round(c.share * 1000) / 10}`).join(','));
      break;
    case 'vision':
      if (s.vision?.length) p.set('p', s.vision.map(enc).join(','));
      break;
  }
  // URLSearchParams escapes '#', '(', ' ' etc. Keep commas and '@' readable.
  return p.toString().replace(/%2C/gi, ',').replace(/%40/g, '@');
}

export function decodeHash(hash: string): HashState | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const tab = p.get('tab') as TabId | null;
  if (!tab || !TABS.includes(tab)) return null;
  const s: HashState = { tab };
  const get = (k: string) => p.get(k) ?? undefined;
  if (get('c')) s.color = dec(get('c')!);
  if (get('fg')) s.fg = dec(get('fg')!);
  if (get('bg')) s.bg = dec(get('bg')!);
  if (get('t')) s.target = get('t');
  if (get('base')) s.base = dec(get('base')!);
  const h = get('h') as Harmony | undefined;
  if (h && HARMONIES.some((x) => x.id === h)) s.harmony = h;
  if (get('n')) s.name = get('n');
  if (get('l')) s.locks = get('l')!.split('').map((x) => x === '1');
  if (tab === 'palette' && get('p')) s.colors = list(get('p')!).map(dec);
  if (tab === 'vision' && get('p')) s.vision = list(get('p')!).map(dec);
  if (tab === 'image') {
    const k = Number(get('k'));
    if (Number.isFinite(k) && k >= 5 && k <= 10) s.k = Math.round(k);
    if (get('p'))
      s.clusters = list(get('p')!).map((x) => {
        const [c, pct] = x.split('@');
        return { hex: dec(c), share: (Number(pct) || 0) / 100 };
      });
  }
  if (tab === 'gradient' && get('st')) {
    const type = (['linear', 'radial', 'conic'].includes(get('g') ?? '') ? get('g') : 'linear') as GradientType;
    const space = (['srgb', 'oklab', 'oklch'].includes(get('s') ?? '') ? get('s') : 'oklch') as GradientSpace;
    const angle = Number(get('a'));
    const stops = list(get('st')!).map((x) => {
      const i = x.lastIndexOf('@');
      const color = dec(i >= 0 ? x.slice(0, i) : x);
      const pos = i >= 0 ? Number(x.slice(i + 1)) : NaN;
      return { color, pos: Number.isFinite(pos) ? Math.min(100, Math.max(0, pos)) : 0 };
    });
    s.gradient = { type, space, angle: Number.isFinite(angle) ? angle : 90, stops };
  }
  return s;
}
