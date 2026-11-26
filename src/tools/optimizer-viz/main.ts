// Optimizer Race UI: state, controls, animation loop, standings, explanations, share hash.
import * as engine from './engine';
import {
  DEFAULT_KAPPA, LANDSCAPES, OPTIMIZERS, OPTIMIZER_BY_ID, OPTIMIZER_IDS, PRESETS, Race, STATUS_LABEL,
  decodeHash, defaultHyper, encodeHash, getLandscape, isFinished, noiseSigma,
  type Hyper, type Landscape, type LandscapeId, type OptimizerId, type ParamSpec, type Preset, type Runner, type Vec2,
} from './engine';
import { drawChart } from './chart';
import { Stage, readPalette, renderThumb, shapeSvg, type Palette } from './stage';
import { copyText, escapeHtml, onThemeChange, toast } from '../../lib/ui';

interface Config {
  landscape: LandscapeId;
  kappa: number;
  start: Vec2;
  enabled: Set<OptimizerId>;
  hyper: Record<OptimizerId, Hyper>;
  noise: number;
  clip: number;
  maxSteps: number;
  speed: number;
  selected: OptimizerId;
  preset: string | null;
}

const SEED = 7;
const SPEEDS = [1, 2, 3, 5, 10, 20, 50];
const MAX_STEPS = [100, 200, 400, 600, 800, 1000, 1200, 1500, 2000, 3000, 4000, 6000, 10000];
const CLIPS = [0, 0.5, 1, 2, 5, 10, 20, 50, 100];
const SHORT: Record<LandscapeId, string> = {
  bowl: 'Bowl', rosenbrock: 'Rosenbrock', beale: 'Beale', himmelblau: 'Himmelblau',
  saddle: 'Saddle', rastrigin: 'Rastrigin', camel: 'Camel', noisy: 'Noisy bowl',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Compact number formatting with a real minus sign. */
export function fmt(v: number, digits = 3) {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : 'NaN';
  const a = Math.abs(v);
  let s: string;
  if (a === 0) s = '0';
  else if (a >= 1e4 || a < 1e-3) s = v.toExponential(digits - 1).replace('e+', 'e').replace(/\.?0+e/, 'e');
  else s = String(+v.toPrecision(digits));
  return s.replace(/-/g, '−');
}

/* ---------- slider <-> value mappings ---------- */
const NINES = new Set(['mu', 'rho', 'b1', 'b2']);
function toSlider(p: ParamSpec, v: number) {
  if (p.log) return (Math.log10(Math.max(p.min, v)) - Math.log10(p.min)) / (Math.log10(p.max) - Math.log10(p.min));
  if (NINES.has(p.key)) return Math.min(1, -Math.log10(Math.max(1e-5, 1 - v)) / 4);
  return (v - p.min) / (p.max - p.min);
}
function fromSlider(p: ParamSpec, s: number) {
  let v: number;
  if (p.log) v = Math.pow(10, Math.log10(p.min) + s * (Math.log10(p.max) - Math.log10(p.min)));
  else if (NINES.has(p.key)) v = 1 - Math.pow(10, -4 * s);
  else v = p.min + s * (p.max - p.min);
  v = Math.min(p.max, Math.max(p.min, v));
  return +v.toPrecision(p.log ? 2 : 4);
}

export function init() {
  const root = $('opt-root');
  if (!root) return;
  const canvas = $<HTMLCanvasElement>('opt-canvas');
  const stage = new Stage(canvas);
  let pal: Palette = readPalette();

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ================= state ================= */
  const cfg: Config = defaultsFor('bowl');
  cfg.enabled = new Set(OPTIMIZER_IDS);
  let race: Race = makeRace();
  let playing = false;
  let hover: Vec2 | null = null;
  let lastUi = 0;
  let launched = false;

  function defaultsFor(id: LandscapeId, kappa = DEFAULT_KAPPA): Config {
    const l = getLandscape(id, kappa);
    const hyper = {} as Record<OptimizerId, Hyper>;
    for (const o of OPTIMIZER_IDS) hyper[o] = defaultHyper(o, l);
    return {
      landscape: id, kappa, start: [...l.start] as Vec2, enabled: new Set(OPTIMIZER_IDS), hyper,
      noise: 0, clip: 0, maxSteps: l.maxSteps, speed: l.speed, selected: 'adam', preset: null,
    };
  }
  function landscape(): Landscape {
    return getLandscape(cfg.landscape, cfg.kappa);
  }
  function makeRace() {
    return new Race({
      landscape: landscape(),
      start: cfg.start,
      optimizers: OPTIMIZER_IDS.filter((id) => cfg.enabled.has(id)).map((id) => ({ id, hyper: cfg.hyper[id] })),
      noise: cfg.noise,
      clip: cfg.clip,
      maxSteps: cfg.maxSteps,
      seed: SEED,
    });
  }

  /* ================= elements ================= */
  const el = {
    presets: $('opt-presets'),
    lessonTitle: $('opt-lesson-title'),
    lessonText: $('opt-lesson-text'),
    lessonTag: $('opt-lesson-tag'),
    strip: $('opt-strip'),
    formula: $('opt-formula'),
    kappaField: $('opt-kappa-field'),
    kappa: $<HTMLInputElement>('opt-kappa'),
    kappaOut: $('opt-kappa-out'),
    racers: $('opt-racers'),
    tuneTitle: $('opt-tune-title'),
    tune: $('opt-tune'),
    tuneReset: $('opt-tune-reset'),
    noise: $<HTMLInputElement>('opt-noise'),
    noiseOut: $('opt-noise-out'),
    clip: $<HTMLSelectElement>('opt-clip'),
    speed: $<HTMLSelectElement>('opt-speed'),
    maxSteps: $<HTMLSelectElement>('opt-max'),
    play: $<HTMLButtonElement>('opt-play'),
    step: $<HTMLButtonElement>('opt-step'),
    reset: $<HTMLButtonElement>('opt-reset'),
    share: $<HTMLButtonElement>('opt-share'),
    stepNum: $('opt-step-num'),
    stepMax: $('opt-step-max'),
    readout: $('opt-readout'),
    hint: $('opt-hint'),
    startOut: $('opt-start'),
    summary: $('opt-summary'),
    tileFinished: $('opt-tile-finished'),
    tileLeader: $('opt-tile-leader'),
    tileBest: $('opt-tile-best'),
    legend: $('opt-legend'),
    legendEmpty: $('opt-legend-empty'),
    chart: $<HTMLCanvasElement>('opt-chart'),
    exName: $('opt-ex-name'),
    exPaper: $('opt-ex-paper'),
    exSummary: $('opt-ex-summary'),
    exTex: $('opt-ex-tex'),
    exLand: $('opt-ex-land'),
    exTips: $('opt-ex-tips'),
    live: $('opt-live'),
  };

  /* ================= KaTeX (lazy) ================= */
  type Katex = typeof import('katex').default;
  let katex: Katex | null = null;
  let katexLoading: Promise<void> | null = null;
  const texQueue = new Map<HTMLElement, [string, boolean]>();
  function tex(target: HTMLElement, src: string, display = false) {
    target.dataset.tex = src;
    if (katex) {
      katex.render(src, target, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
      return;
    }
    target.textContent = src.replace(/\\[a-z]+|[{}]/gi, ' ').replace(/\s+/g, ' ');
    texQueue.set(target, [src, display]);
    katexLoading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
      .then(([m]) => {
        katex = m.default;
        for (const [t, [s, d]] of texQueue) if (t.dataset.tex === s) tex(t, s, d);
        texQueue.clear();
        root.dataset.katex = 'ready';
      })
      .catch(() => {
        root.dataset.katex = 'failed';
      });
  }

  /* ================= presets ================= */
  el.presets.innerHTML = PRESETS.map(
    (p, i) => `<button type="button" class="opt-preset" data-preset="${p.id}" aria-pressed="false">
      <span class="opt-preset-n">${String(i + 1).padStart(2, '0')}</span>
      <b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.short)}</small></button>`,
  ).join('');
  el.presets.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-preset]');
    const p = b && PRESETS.find((q) => q.id === b.dataset.preset);
    if (p) applyPreset(p);
  });

  function applyPreset(p: Preset) {
    const c = defaultsFor(p.landscape, p.kappa ?? DEFAULT_KAPPA);
    const l = getLandscape(p.landscape, c.kappa);
    Object.assign(cfg, c);
    cfg.start = [...p.start] as Vec2;
    cfg.enabled = new Set(Object.keys(p.optimizers) as OptimizerId[]);
    for (const [id, over] of Object.entries(p.optimizers) as [OptimizerId, Partial<Hyper>][]) {
      cfg.hyper[id] = { ...defaultHyper(id, l), ...over };
    }
    cfg.noise = p.noise;
    cfg.clip = p.clip;
    cfg.maxSteps = p.maxSteps;
    cfg.speed = p.speed;
    cfg.selected = p.select;
    cfg.preset = p.id;
    el.hint.hidden = true;
    syncAll();
    restart(!reduceMotion);
  }

  /* ================= landscape strip ================= */
  el.strip.innerHTML = LANDSCAPES.map(
    (l) => `<button type="button" class="opt-land" data-land="${l.id}" aria-pressed="false" title="${escapeHtml(l.name)}">
      <canvas aria-hidden="true"></canvas><span>${SHORT[l.id]}</span></button>`,
  ).join('');
  function renderThumbs() {
    el.strip.querySelectorAll<HTMLButtonElement>('[data-land]').forEach((b) => {
      const id = b.dataset.land as LandscapeId;
      renderThumb(b.querySelector('canvas')!, getLandscape(id, id === 'bowl' ? cfg.kappa : DEFAULT_KAPPA), pal);
    });
  }
  el.strip.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-land]');
    if (!b) return;
    setLandscape(b.dataset.land as LandscapeId);
  });
  function setLandscape(id: LandscapeId) {
    const keep = cfg.enabled;
    const sel = cfg.selected;
    Object.assign(cfg, defaultsFor(id, cfg.kappa));
    cfg.enabled = keep;
    cfg.selected = sel;
    syncAll();
    restart(playing || !reduceMotion);
  }

  el.kappa.addEventListener('input', () => {
    cfg.kappa = Math.round(Math.pow(10, +el.kappa.value) * 10) / 10;
    cfg.preset = null;
    syncLandscapeInfo();
    renderThumbs();
    restart(playing);
  });

  /* ================= racers (toggle + select) ================= */
  el.racers.innerHTML = OPTIMIZERS.map(
    (o) => `<div class="opt-racer" data-opt="${o.id}" style="--rc: var(${o.colorVar})">
      <label class="opt-switch" title="Race ${o.name}">
        <input type="checkbox" data-toggle="${o.id}" aria-label="Race ${o.name}" />
        <span class="opt-switch-box">${shapeSvg(o.id, 13)}</span>
      </label>
      <button type="button" class="opt-racer-btn" data-select="${o.id}" aria-pressed="false">
        <span class="opt-racer-name">${o.name}</span><span class="opt-racer-lr mono" data-lr></span>
      </button></div>`,
  ).join('');
  el.racers.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const id = t.dataset.toggle as OptimizerId | undefined;
    if (!id) return;
    if (t.checked) cfg.enabled.add(id);
    else cfg.enabled.delete(id);
    cfg.preset = null;
    if (t.checked) cfg.selected = id;
    syncRacers();
    syncPresetButtons();
    renderExplain();
    renderTune();
    restart(playing);
  });
  el.racers.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-select]');
    if (b) select(b.dataset.select as OptimizerId);
  });
  function select(id: OptimizerId) {
    if (cfg.selected === id) return;
    cfg.selected = id;
    syncRacers();
    renderTune();
    renderExplain();
    updateStandings(true);
    drawChartNow();
    scheduleHash();
    requestDraw();
  }

  /* ================= tune panel ================= */
  function renderTune() {
    const id = cfg.selected;
    const def = OPTIMIZER_BY_ID[id];
    el.tuneTitle.innerHTML = `${shapeSvg(id, 12)}<span>${def.name}</span>`;
    el.tune.innerHTML = def.params
      .map((p) => {
        const v = cfg.hyper[id][p.key] ?? 0;
        return `<div class="opt-field opt-hp" data-key="${p.key}">
          <div class="opt-lbl"><label for="opt-hp-${p.key}">${p.label} <span class="opt-sym">${p.sym}</span></label>
          <input type="number" class="input opt-num" id="opt-hp-${p.key}-num" step="any" min="${p.key === 'lr' ? 0 : p.min}" max="${p.max}" value="${v}" aria-label="${p.label} value" /></div>
          <input type="range" id="opt-hp-${p.key}" min="0" max="1000" step="1" value="${Math.round(toSlider(p, v) * 1000)}" />
        </div>`;
      })
      .join('');
    const off = !cfg.enabled.has(id);
    el.tune.classList.toggle('is-off', off);
  }
  el.tune.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const row = t.closest<HTMLElement>('[data-key]');
    if (!row) return;
    const p = OPTIMIZER_BY_ID[cfg.selected].params.find((q) => q.key === row.dataset.key)!;
    let v: number;
    if (t.type === 'range') {
      v = fromSlider(p, +t.value / 1000);
      row.querySelector<HTMLInputElement>('.opt-num')!.value = String(v);
    } else {
      v = +t.value;
      if (!Number.isFinite(v) || t.value === '') return;
      v = Math.min(p.max, Math.max(p.key === 'lr' ? 0 : p.min, v));
      row.querySelector<HTMLInputElement>('input[type=range]')!.value = String(Math.round(toSlider(p, v) * 1000));
    }
    cfg.hyper[cfg.selected] = { ...cfg.hyper[cfg.selected], [p.key]: v };
    cfg.preset = null;
    syncRacers();
    syncPresetButtons();
    restart(playing || race.finished);
  });
  el.tuneReset.addEventListener('click', () => {
    cfg.hyper[cfg.selected] = defaultHyper(cfg.selected, landscape());
    cfg.preset = null;
    renderTune();
    syncRacers();
    syncPresetButtons();
    restart(playing);
  });

  /* ================= gradient + run settings ================= */
  el.clip.innerHTML = CLIPS.map((c) => `<option value="${c}">${c ? `‖g‖ ≤ ${c}` : 'Off'}</option>`).join('');
  el.speed.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s} step${s > 1 ? 's' : ''} / frame</option>`).join('');
  function fillMaxSteps() {
    const vals = [...new Set([...MAX_STEPS, cfg.maxSteps])].sort((a, b) => a - b);
    el.maxSteps.innerHTML = vals.map((v) => `<option value="${v}">${v.toLocaleString('en-US')}</option>`).join('');
  }
  el.noise.addEventListener('input', () => {
    cfg.noise = +el.noise.value;
    cfg.preset = null;
    syncNoise();
    syncPresetButtons();
    restart(playing);
  });
  el.clip.addEventListener('change', () => {
    cfg.clip = +el.clip.value;
    cfg.preset = null;
    syncPresetButtons();
    restart(playing);
  });
  el.speed.addEventListener('change', () => {
    cfg.speed = +el.speed.value;
    scheduleHash();
  });
  el.maxSteps.addEventListener('change', () => {
    cfg.maxSteps = +el.maxSteps.value;
    cfg.preset = null;
    syncPresetButtons();
    restart(playing);
  });
  function syncNoise() {
    const sigma = noiseSigma(landscape(), cfg.noise);
    const l = landscape();
    el.noiseOut.textContent = sigma > 0 ? `σ = ${fmt(sigma, 2)}${l.intrinsicNoise ? ' incl. built-in' : ''}` : 'none';
  }

  /* ================= transport ================= */
  el.play.addEventListener('click', () => togglePlay());
  el.step.addEventListener('click', () => {
    setPlaying(false);
    if (race.finished) race.reset();
    race.advance(1);
    afterAdvance();
  });
  el.reset.addEventListener('click', () => restart(false));
  el.share.addEventListener('click', () => {
    writeHash();
    copyText(location.href, 'Link copied: it encodes this exact race');
  });

  function togglePlay() {
    if (playing) setPlaying(false);
    else {
      if (race.finished) restart(true);
      else setPlaying(true);
    }
  }
  function setPlaying(on: boolean) {
    playing = on;
    el.play.setAttribute('aria-pressed', String(on));
    el.play.querySelector('.opt-ico-play')?.toggleAttribute('hidden', on);
    el.play.querySelector('.opt-ico-pause')?.toggleAttribute('hidden', !on);
    el.play.querySelector('.opt-play-text')!.textContent = on ? 'Pause' : race.finished && race.step > 0 ? 'Replay' : 'Play';
    if (on) requestDraw();
  }

  /** Rebuild the race from the config; optionally start playing right away. */
  function restart(play: boolean) {
    race = makeRace();
    buildLegend();
    afterAdvance();
    scheduleHash();
    setPlaying(play && cfg.enabled.size > 0);
  }

  function afterAdvance() {
    updateStandings(true);
    drawChartNow();
    requestDraw();
    if (race.finished && playing) setPlaying(false);
    if (race.finished) announceFinish();
    else el.play.querySelector('.opt-play-text')!.textContent = playing ? 'Pause' : 'Play';
  }

  /* ================= canvas interaction ================= */
  let down: { x: number; y: number; t: number; id: number } | null = null;
  const offset = (e: PointerEvent | MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [x, y] = offset(e);
    down = { x, y, t: performance.now(), id: e.pointerId };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || down.id !== e.pointerId) return;
    const [x, y] = offset(e);
    const moved = Math.hypot(x - down.x, y - down.y);
    down = null;
    if (moved > 8) return;
    setStart(stage.toWorld(x, y));
    if (e.pointerType !== 'mouse') {
      hover = stage.toWorld(x, y);
      showReadout();
    }
  });
  canvas.addEventListener('pointercancel', () => (down = null));
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const [x, y] = offset(e);
    hover = stage.toWorld(x, y);
    showReadout();
    requestDraw();
  });
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    hover = null;
    showReadout();
    requestDraw();
  });
  canvas.addEventListener('keydown', (e) => {
    const v = stage.view;
    const dx = (v.xmax - v.xmin) / 50;
    const dy = (v.ymax - v.ymin) / 50;
    const moves: Record<string, Vec2> = { ArrowLeft: [-dx, 0], ArrowRight: [dx, 0], ArrowUp: [0, dy], ArrowDown: [0, -dy] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      const s: Vec2 = [cfg.start[0] + m[0] * (e.shiftKey ? 5 : 1), cfg.start[1] + m[1] * (e.shiftKey ? 5 : 1)];
      setStart(s, false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      restart(true);
    }
  });

  function setStart(p: Vec2, play = true) {
    const v = stage.view;
    const x = Math.min(v.xmax, Math.max(v.xmin, p[0]));
    const y = Math.min(v.ymax, Math.max(v.ymin, p[1]));
    const sx = (v.xmax - v.xmin) / 2000;
    const round = (n: number) => +(Math.round(n / sx) * sx).toPrecision(6);
    cfg.start = [round(x), round(y)];
    cfg.preset = null;
    launched = true;
    el.hint.hidden = true;
    syncPresetButtons();
    syncStart();
    restart(play);
  }

  function showReadout() {
    if (!hover) {
      el.readout.hidden = true;
      return;
    }
    const l = landscape();
    const f = l.f(hover[0], hover[1]);
    el.readout.hidden = false;
    el.readout.innerHTML = `<span>x <b>${fmt(hover[0], 4)}</b></span><span>y <b>${fmt(hover[1], 4)}</b></span><span>f <b>${fmt(f, 4)}</b></span>`;
  }

  /* ================= standings ================= */
  const rows = new Map<OptimizerId, HTMLElement>();
  function buildLegend() {
    rows.clear();
    el.legend.innerHTML = '';
    for (const r of race.runners) {
      const o = OPTIMIZER_BY_ID[r.id];
      const row = document.createElement('li');
      row.className = 'opt-row';
      row.dataset.opt = r.id;
      row.style.setProperty('--rc', `var(${o.colorVar})`);
      row.innerHTML = `<span class="opt-rank" data-field="rank"></span>
        <button type="button" class="opt-row-main" data-select="${r.id}">
          <span class="opt-row-name">${shapeSvg(r.id, 12)}${o.name}</span>
          <span class="opt-row-sub">step <b data-field="steps">0</b></span>
        </button>
        <span class="opt-row-right"><span class="opt-row-loss mono" data-field="loss"></span><span class="opt-pill" data-field="status"></span></span>`;
      el.legend.appendChild(row);
      rows.set(r.id, row);
    }
    el.legendEmpty.hidden = race.runners.length > 0;
  }
  el.legend.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-select]');
    if (b) select(b.dataset.select as OptimizerId);
  });

  function statusText(r: Runner) {
    if (r.status === 'ready') return 'ready';
    if (r.status === 'running') return 'running';
    if (r.status === 'max-steps') return STATUS_LABEL[r.status];
    return `${STATUS_LABEL[r.status]} @ ${r.doneAt}`;
  }
  function tone(r: Runner) {
    switch (r.status) {
      case 'converged': return 'ok';
      case 'diverged': return 'bad';
      case 'local-min': case 'saddle': case 'stationary': return 'warn';
      case 'max-steps': return 'muted';
      default: return 'run';
    }
  }
  /** Race order: podium first, then the field by loss, then stuck runs, then DNFs. */
  function orderKey(r: Runner) {
    const pod = race.podium.indexOf(r.id);
    if (pod >= 0) return pod;
    const f = r.losses[r.losses.length - 1];
    const group = r.status === 'running' || r.status === 'ready' ? 1 : r.status === 'diverged' ? 4 : r.status === 'max-steps' ? 2 : 3;
    return 100 * group + Math.min(99, Math.max(0, 50 + Math.log10(Math.max(1e-30, f - race.cfg.landscape.fmin + 1e-30))));
  }

  function updateStandings(force = false) {
    const now = performance.now();
    if (!force && now - lastUi < 90) return;
    lastUi = now;
    el.stepNum.textContent = String(race.step);
    el.stepMax.textContent = `/ ${race.cfg.maxSteps.toLocaleString('en-US')}`;
    const sorted = [...race.runners].sort((a, b) => orderKey(a) - orderKey(b));
    sorted.forEach((r, i) => {
      const row = rows.get(r.id);
      if (!row) return;
      row.style.order = String(i);
      const pod = race.podium.indexOf(r.id);
      const rank = row.querySelector<HTMLElement>('[data-field=rank]')!;
      rank.textContent = pod >= 0 ? String(pod + 1) : r.status === 'diverged' ? '✕' : '·';
      rank.dataset.place = pod >= 0 ? String(Math.min(pod + 1, 4)) : '';
      row.querySelector('[data-field=steps]')!.textContent = String(r.state.t);
      row.querySelector('[data-field=loss]')!.textContent = `f ${fmt(r.losses[r.losses.length - 1], 3)}`;
      const st = row.querySelector<HTMLElement>('[data-field=status]')!;
      const text = statusText(r);
      if (st.textContent !== text) st.textContent = text;
      st.dataset.tone = tone(r);
      st.dataset.status = r.status;
      row.classList.toggle('is-selected', r.id === cfg.selected);
      row.querySelector('[data-select]')!.setAttribute('aria-pressed', String(r.id === cfg.selected));
    });
    const n = race.runners.length;
    el.tileFinished.textContent = `${race.podium.length} / ${n}`;
    const leader = sorted[0];
    if (leader) {
      el.tileLeader.innerHTML = `${shapeSvg(leader.id, 12)}${OPTIMIZER_BY_ID[leader.id].name}`;
      const best = Math.min(...race.runners.map((r) => r.losses[r.losses.length - 1]));
      el.tileBest.textContent = fmt(best, 2);
    } else {
      el.tileLeader.textContent = '–';
      el.tileBest.textContent = '–';
    }
    el.summary.textContent = summaryText();
  }

  function summaryText() {
    const n = race.runners.length;
    if (!n) return 'Switch on at least one optimizer to race.';
    if (race.step === 0) return launched ? 'Ready. Press Play, or click the landscape to launch from somewhere else.' : 'Click anywhere on the landscape to launch every optimizer from that point.';
    const c = race.runners.filter((r) => r.status === 'converged').length;
    const d = race.runners.filter((r) => r.status === 'diverged').length;
    const stuck = race.runners.filter((r) => ['local-min', 'saddle', 'stationary'].includes(r.status)).length;
    const parts = [`${c} of ${n} reached a global minimum`];
    if (stuck) parts.push(`${stuck} stuck`);
    if (d) parts.push(`${d} diverged`);
    if (!race.finished) return parts.join(' · ');
    const win = race.podium[0];
    return (win ? `${OPTIMIZER_BY_ID[win].name} wins at step ${race.runners.find((r) => r.id === win)!.doneAt}. ` : 'Race over: nobody reached a global minimum. ') + parts.join(' · ') + '.';
  }

  let announced = '';
  function announceFinish() {
    const key = `${race.step}|${race.podium.join()}`;
    if (announced === key) return;
    announced = key;
    el.hint.hidden = true;
    el.live.textContent = summaryText();
    el.play.querySelector('.opt-play-text')!.textContent = 'Replay';
  }

  function drawChartNow() {
    const l = race.cfg.landscape;
    drawChart(
      el.chart,
      race.runners.map((r) => ({
        color: pal.colors[r.id],
        losses: r.losses,
        bold: r.id === cfg.selected,
        end: r.status === 'diverged' ? 'cross' : isFinished(r.status) ? 'dot' : undefined,
      })),
      { fmin: l.fmin, maxSteps: race.cfg.maxSteps, theme: { text: pal.text, muted: pal.faint, grid: pal.border, bg: pal.elev } },
    );
  }

  /* ================= explanation ================= */
  function renderExplain() {
    const id = cfg.selected;
    const o = OPTIMIZER_BY_ID[id];
    const l = landscape();
    el.exName.innerHTML = `${shapeSvg(id, 15)}<span>${o.name}</span>`;
    el.exName.closest<HTMLElement>('.opt-explain')!.style.setProperty('--rc', `var(${o.colorVar})`);
    el.exPaper.textContent = o.paper;
    el.exSummary.textContent = o.summary;
    tex(el.exTex, o.tex, true);
    el.exLand.textContent = l.name;
    const tips = [...l.tips].sort((a, b) => Number(!!b.ids?.includes(id)) - Number(!!a.ids?.includes(id)));
    el.exTips.innerHTML = tips
      .map((t) => {
        const mine = !!t.ids?.includes(id);
        const dots = (t.ids ?? []).map((i) => `<i style="background: var(${OPTIMIZER_BY_ID[i].colorVar})" title="${OPTIMIZER_BY_ID[i].name}"></i>`).join('');
        return `<li class="${mine ? 'is-mine' : ''}">${dots ? `<span class="opt-tip-dots">${dots}</span>` : ''}${escapeHtml(t.text)}</li>`;
      })
      .join('');
  }

  /* ================= sync helpers ================= */
  function syncLandscapeInfo() {
    const l = landscape();
    el.strip.querySelectorAll<HTMLButtonElement>('[data-land]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.land === cfg.landscape)));
    tex(el.formula, l.tex, false);
    el.kappaField.hidden = cfg.landscape !== 'bowl';
    el.kappa.value = String(Math.log10(cfg.kappa));
    el.kappaOut.textContent = `κ = ${cfg.kappa}`;
    const p = PRESETS.find((q) => q.id === cfg.preset);
    el.lessonTag.textContent = p ? 'Lesson' : 'Landscape';
    el.lessonTitle.textContent = p ? p.name : l.name;
    el.lessonText.textContent = p ? p.description : l.blurb;
    syncNoise();
  }
  function syncPresetButtons() {
    el.presets.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === cfg.preset)));
    const p = PRESETS.find((q) => q.id === cfg.preset);
    if (!p && el.lessonTag.textContent === 'Lesson') {
      el.lessonTag.textContent = 'Lesson · modified';
    }
  }
  function syncRacers() {
    el.racers.querySelectorAll<HTMLElement>('[data-opt]').forEach((row) => {
      const id = row.dataset.opt as OptimizerId;
      const on = cfg.enabled.has(id);
      row.querySelector<HTMLInputElement>('[data-toggle]')!.checked = on;
      row.classList.toggle('is-on', on);
      row.classList.toggle('is-selected', id === cfg.selected);
      row.querySelector('[data-select]')!.setAttribute('aria-pressed', String(id === cfg.selected));
      row.querySelector('[data-lr]')!.textContent = `η ${fmt(cfg.hyper[id].lr, 2)}`;
    });
  }
  function syncStart() {
    el.startOut.textContent = `(${fmt(cfg.start[0], 4)}, ${fmt(cfg.start[1], 4)})`;
    el.startOut.dataset.x = String(cfg.start[0]);
    el.startOut.dataset.y = String(cfg.start[1]);
  }
  function syncAll() {
    syncLandscapeInfo();
    syncPresetButtons();
    syncRacers();
    syncStart();
    renderTune();
    renderExplain();
    renderThumbs();
    el.noise.value = String(cfg.noise);
    syncNoise();
    el.clip.value = String(CLIPS.includes(cfg.clip) ? cfg.clip : 0);
    if (!CLIPS.includes(cfg.clip)) {
      el.clip.insertAdjacentHTML('beforeend', `<option value="${cfg.clip}">‖g‖ ≤ ${cfg.clip}</option>`);
      el.clip.value = String(cfg.clip);
    }
    if (!SPEEDS.includes(cfg.speed)) cfg.speed = SPEEDS.reduce((a, b) => (Math.abs(b - cfg.speed) < Math.abs(a - cfg.speed) ? b : a));
    el.speed.value = String(cfg.speed);
    fillMaxSteps();
    el.maxSteps.value = String(cfg.maxSteps);
    stage.invalidate();
    requestDraw();
  }

  /* ================= share hash ================= */
  let hashTimer = 0;
  let lastHash = '';
  function shareState() {
    return {
      landscape: cfg.landscape, kappa: cfg.kappa, start: cfg.start,
      enabled: OPTIMIZER_IDS.filter((id) => cfg.enabled.has(id)), hyper: cfg.hyper,
      noise: cfg.noise, clip: cfg.clip, maxSteps: cfg.maxSteps, speed: cfg.speed, selected: cfg.selected,
    };
  }
  function writeHash() {
    window.clearTimeout(hashTimer);
    const h = encodeHash(shareState());
    lastHash = h;
    if (location.hash.slice(1) !== h) history.replaceState(null, '', `${location.pathname}${location.search}#${h}`);
  }
  function scheduleHash() {
    window.clearTimeout(hashTimer);
    hashTimer = window.setTimeout(writeHash, 250);
  }
  function applyHash(hash: string) {
    const d = decodeHash(hash);
    if (!d.landscape) return false;
    Object.assign(cfg, defaultsFor(d.landscape, d.kappa ?? DEFAULT_KAPPA));
    if (d.start) cfg.start = d.start;
    if (d.enabled) cfg.enabled = new Set(d.enabled);
    if (d.hyper) for (const [id, h] of Object.entries(d.hyper) as [OptimizerId, Hyper][]) cfg.hyper[id] = { ...cfg.hyper[id], ...h };
    if (d.noise !== undefined) cfg.noise = d.noise;
    if (d.clip !== undefined) cfg.clip = d.clip;
    if (d.maxSteps !== undefined) cfg.maxSteps = d.maxSteps;
    if (d.speed !== undefined) cfg.speed = d.speed;
    if (d.selected) cfg.selected = d.selected;
    cfg.preset = null;
    launched = true;
    el.hint.hidden = true;
    return true;
  }
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    if (h === lastHash) return;
    if (applyHash(h)) {
      syncAll();
      restart(false);
    }
  });

  /* ================= keyboard ================= */
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t.closest('input, select, textarea, [contenteditable]')) return;
    if (t.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ' && (t === document.body || t === canvas)) {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'n' || e.key === 'N') el.step.click();
    else if (e.key === 'r' || e.key === 'R') el.reset.click();
  });

  /* ================= frame loop ================= */
  let raf = 0;
  function requestDraw() {
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function frame() {
    raf = 0;
    if (stage.resize()) stage.invalidate();
    const l = race.cfg.landscape;
    stage.prepare(l, pal, `${l.id}|${cfg.kappa}`);
    if (playing) {
      race.advance(cfg.speed);
      updateStandings();
      if (performance.now() - lastChart > 90) {
        lastChart = performance.now();
        drawChartNow();
      }
      if (race.finished) {
        setPlaying(false);
        updateStandings(true);
        drawChartNow();
        announceFinish();
      }
    }
    stage.draw({ race, start: cfg.start, selected: cfg.selected, hover, pal });
    if (playing) requestDraw();
  }
  let lastChart = 0;

  new ResizeObserver(() => {
    requestDraw();
    drawChartNow();
  }).observe(canvas.parentElement!);

  onThemeChange(() =>
    requestAnimationFrame(() => {
      pal = readPalette();
      stage.invalidate();
      renderThumbs();
      drawChartNow();
      requestDraw();
    }),
  );

  /* ================= boot ================= */
  if (window.matchMedia('(pointer: coarse)').matches) el.hint.lastChild!.textContent = 'Tap anywhere to launch from there';
  const fromHash = location.hash.length > 1 && applyHash(location.hash.slice(1));
  syncAll();
  restart(!reduceMotion);
  if (fromHash) writeHash();

  // Debug / test hook: the pure engine plus a read-only snapshot of the UI. Nothing is stored.
  (window as unknown as { __optviz: unknown }).__optviz = {
    ...engine,
    engine,
    fmt,
    get playing() { return playing; },
    get view() { return { ...stage.view }; },
    get race() { return race; },
    state() {
      return {
        landscape: cfg.landscape,
        kappa: cfg.kappa,
        start: [...cfg.start],
        enabled: OPTIMIZER_IDS.filter((id) => cfg.enabled.has(id)),
        selected: cfg.selected,
        preset: cfg.preset,
        noise: cfg.noise,
        clip: cfg.clip,
        maxSteps: cfg.maxSteps,
        speed: cfg.speed,
        hyper: JSON.parse(JSON.stringify(cfg.hyper)),
        step: race.step,
        playing,
        finished: race.finished,
        podium: [...race.podium],
        view: { ...stage.view },
        runners: race.runners.map((r) => ({
          id: r.id, status: r.status, steps: r.state.t, x: r.state.x, y: r.state.y,
          loss: r.losses[r.losses.length - 1], doneAt: r.doneAt, end: r.end,
        })),
      };
    },
  };
}
