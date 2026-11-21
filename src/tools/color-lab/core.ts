// Shared app state and wiring between the tabs.
import type { Color, Harmony, GradientState, Cluster } from './color';
import type { TabId } from './hash';

export type SendTarget = 'convert' | 'fg' | 'bg' | 'base' | 'stop';
export type ContrastTarget = 'aa' | 'aaa' | 'aa-large' | 'aaa-large';
export const CONTRAST_TARGETS: Record<ContrastTarget, { ratio: number; label: string }> = {
  aa: { ratio: 4.5, label: 'AA normal text' },
  aaa: { ratio: 7, label: 'AAA normal text' },
  'aa-large': { ratio: 3, label: 'AA large text / UI' },
  'aaa-large': { ratio: 4.5, label: 'AAA large text' },
};

export interface State {
  color: Color;
  fg: string;
  bg: string;
  target: ContrastTarget;
  palette: {
    base: string;
    harmony: Harmony;
    colors: string[];
    locks: boolean[];
    name: string;
    exportFmt: 'css' | 'tailwind' | 'json';
  };
  gradient: GradientState;
  gsel: number;
  image: { k: number; clusters: Cluster[]; selected: number; hasImage: boolean };
  vision: string[];
  visionCustom: boolean;
}

export interface App {
  state: State;
  activeTab(): TabId;
  switchTab(tab: TabId): void;
  saveHash(): void;
  send(target: SendTarget, color: string): void;
  render: Partial<Record<TabId, () => void>>;
  /** Downsampled pixels of the image loaded in the From image tab (for the vision check). */
  visionImage: ImageData | null;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const ICONS = {
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/></svg>',
  target: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>',
};

export function showError(el: HTMLElement, msg: string | null) {
  el.hidden = !msg;
  el.textContent = msg ?? '';
}
