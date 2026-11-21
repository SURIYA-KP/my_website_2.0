// Pointer-event drag and drop for the page grid. Mouse/pen drags start after a few pixels;
// touch drags start with a long press so normal swipes still scroll the page.

export interface DragOptions {
  grid: HTMLElement;
  indicator: HTMLElement;
  tileSelector: string;
  /** uids that move when the tile `uid` is dragged (the selection if it includes uid). */
  dragSet(uid: string): string[];
  onDrop(uids: string[], insertBefore: number): void;
  onStart?(uids: string[]): void;
}

interface Rect { uid: string; x: number; y: number; w: number; h: number }

export function setupDrag(o: DragOptions) {
  let pending: { id: number; uid: string; x: number; y: number; cx: number; cy: number; type: string; timer?: number; tile: HTMLElement } | null = null;
  let drag: { id: number; uids: string[]; rects: Rect[]; ghost: HTMLElement; target: number; cx: number; cy: number; raf: number } | null = null;
  let suppressClick = false;

  const tiles = () => Array.from(o.grid.querySelectorAll<HTMLElement>(o.tileSelector));

  o.grid.addEventListener('pointerdown', (e) => {
    if (drag || pending) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const t = e.target as HTMLElement;
    if (t.closest('button, input, a')) return;
    const tile = t.closest<HTMLElement>(o.tileSelector);
    if (!tile) return;
    pending = { id: e.pointerId, uid: tile.dataset.uid!, x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, type: e.pointerType, tile };
    if (e.pointerType === 'touch') {
      pending.timer = window.setTimeout(() => {
        if (pending) {
          navigator.vibrate?.(15);
          start(pending.cx, pending.cy);
        }
      }, 380);
      tile.classList.add('pt-pressing');
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (pending && e.pointerId === pending.id) {
      const dx = e.clientX - pending.x;
      const dy = e.clientY - pending.y;
      const dist = Math.hypot(dx, dy);
      pending.cx = e.clientX;
      pending.cy = e.clientY;
      if (pending.type === 'touch') {
        if (dist > 10) cancelPending();
      } else if (dist > 6) {
        start(e.clientX, e.clientY);
      }
    }
    if (drag && e.pointerId === drag.id) {
      e.preventDefault();
      drag.cx = e.clientX;
      drag.cy = e.clientY;
      update();
    }
  }, { passive: false });

  // Stop the browser from scrolling once a touch drag is active.
  window.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  o.grid.addEventListener('contextmenu', (e) => { if (drag || pending?.type === 'touch') e.preventDefault(); });

  const finish = (e: PointerEvent, commit: boolean) => {
    if (pending && e.pointerId === pending.id) cancelPending();
    if (drag && e.pointerId === drag.id) end(commit);
  };
  window.addEventListener('pointerup', (e) => finish(e, true));
  window.addEventListener('pointercancel', (e) => finish(e, false));
  window.addEventListener('keydown', (e) => { if (drag && e.key === 'Escape') { e.preventDefault(); end(false); } });
  o.grid.addEventListener('click', (e) => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);

  function cancelPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.tile.classList.remove('pt-pressing');
    pending = null;
  }

  function start(cx: number, cy: number) {
    if (!pending) return;
    const { id, uid, tile } = pending;
    cancelPending();
    const uids = o.dragSet(uid);
    o.onStart?.(uids);
    const sx = window.scrollX, sy = window.scrollY;
    const rects = tiles().map((t) => {
      const r = t.getBoundingClientRect();
      return { uid: t.dataset.uid!, x: r.left + sx, y: r.top + sy, w: r.width, h: r.height };
    });
    const ghost = document.createElement('div');
    ghost.className = 'pt-ghost';
    const img = tile.querySelector('img');
    if (img?.src) {
      const g = document.createElement('img');
      g.src = img.src;
      g.alt = '';
      ghost.appendChild(g);
    } else {
      ghost.appendChild(document.createElement('span'));
    }
    if (uids.length > 1) {
      const c = document.createElement('b');
      c.textContent = String(uids.length);
      ghost.appendChild(c);
    }
    document.body.appendChild(ghost);
    const set = new Set(uids);
    tiles().forEach((t) => t.classList.toggle('pt-dragging', set.has(t.dataset.uid!)));
    document.documentElement.classList.add('pt-drag-active');
    drag = { id, uids, rects, ghost, target: -1, cx, cy, raf: 0 };
    try { o.grid.setPointerCapture(id); } catch { /* not all pointers can be captured */ }
    update();
    const loop = () => {
      if (!drag) return;
      const edge = 70;
      let dy = 0;
      if (drag.cy < edge) dy = -Math.ceil((edge - drag.cy) / 4);
      else if (drag.cy > window.innerHeight - edge) dy = Math.ceil((drag.cy - (window.innerHeight - edge)) / 4);
      if (dy) { window.scrollBy(0, dy); update(); }
      drag.raf = requestAnimationFrame(loop);
    };
    drag.raf = requestAnimationFrame(loop);
  }

  function update() {
    if (!drag) return;
    const { ghost, rects, cx, cy } = drag;
    ghost.style.transform = `translate(${cx - 34}px, ${cy - 44}px)`;
    if (!rects.length) return;
    const px = cx + window.scrollX, py = cy + window.scrollY;
    let best = 0, bestD = Infinity;
    rects.forEach((r, i) => {
      const dx = px < r.x ? r.x - px : px > r.x + r.w ? px - r.x - r.w : 0;
      const dy = py < r.y ? r.y - py : py > r.y + r.h ? py - r.y - r.h : 0;
      const d = dy * 3 + dx; // prefer the row under the pointer
      if (d < bestD) { bestD = d; best = i; }
    });
    const r = rects[best];
    const after = px > r.x + r.w / 2;
    drag.target = best + (after ? 1 : 0);
    // Draw the insertion bar relative to the grid.
    const g = o.grid.getBoundingClientRect();
    const gx = g.left + window.scrollX, gy = g.top + window.scrollY;
    const gap = parseFloat(getComputedStyle(o.grid).columnGap) || 12;
    const x = (after ? r.x + r.w + gap / 2 : r.x - gap / 2) - gx;
    o.indicator.hidden = false;
    o.indicator.style.transform = `translate(${x - 2}px, ${r.y - gy}px)`;
    o.indicator.style.height = `${r.h}px`;
  }

  function end(commit: boolean) {
    if (!drag) return;
    const { uids, target, ghost, raf, id } = drag;
    cancelAnimationFrame(raf);
    ghost.remove();
    try { o.grid.releasePointerCapture(id); } catch { /* ignore */ }
    drag = null;
    o.indicator.hidden = true;
    document.documentElement.classList.remove('pt-drag-active');
    tiles().forEach((t) => t.classList.remove('pt-dragging'));
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (commit && target >= 0) o.onDrop(uids, target);
  }

  return { isDragging: () => !!drag };
}
