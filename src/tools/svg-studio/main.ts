// SVG Studio: wires the editor, canvas, panels, toolbar, dialogs, keyboard and export.
import { Editor } from './editor';
import { Canvas, isTyping, type Background } from './canvas';
import { LayersPanel, PropsPanel, CodePanel, labelFor } from './panels';
import { extractFromReply, looksLikeSvg, type SvgCandidate } from './extract';
import { SAMPLES, AI_PROMPT } from './samples';
import { TEMPLATES } from './templates';
import { parseSvg, SvgParseError } from './sanitize';
import { serialize, num } from './xml';
import { copyText, downloadBlob, downloadText, toast, escapeHtml, formatBytes } from '../../lib/ui';

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function init() {
  const host = $('#svgs-host');
  if (!host) return;
  const editor = new Editor(host);
  const viewport = $('#svgs-viewport');
  const canvas = new Canvas(viewport, editor);
  const main = $('#svgs-main');
  let background: Background = 'checker';

  new LayersPanel($('#svgs-layers'), editor);
  const props = new PropsPanel($('#svgs-props'), editor, {
    getBackground: () => background,
    onBackground: (bg) => {
      background = bg as Background;
      canvas.setBackground(background);
    },
    onFit: () => canvas.fit(),
  });
  const code = new CodePanel($('#svgs-code'), editor);
  canvas.onEditText = () => {
    setTab('props');
    props.focusText();
  };

  // ------------------------------------------------------------ status / toolbar state
  const status = $('#svgs-status');
  const zoomLabel = $('#svgs-zoom');
  const animGroup = $('#svgs-anim');
  const playBtn = $('#svgs-play');
  const updateChrome = () => {
    if (!editor.root) return;
    zoomLabel.textContent = `${Math.round(canvas.zoom * 100)}%`;
    $<HTMLButtonElement>('[data-cmd="undo"]').disabled = !editor.canUndo();
    $<HTMLButtonElement>('[data-cmd="redo"]').disabled = !editor.canRedo();
    const sel = editor.selection;
    document.querySelectorAll<HTMLButtonElement>('[data-needs-selection] button').forEach((b) => {
      const cmd = b.dataset.cmd;
      b.disabled = !sel.length || (cmd === 'ungroup' && !sel.some((e) => e.localName === 'g' || e.localName === 'a'));
    });
    const size = editor.docSize();
    let left = `<span><strong>${num(size.w, 1)} × ${num(size.h, 1)}</strong> px</span>`;
    if (sel.length === 1) {
      const b = docBox(sel);
      left = `<span><strong>&lt;${sel[0].localName}&gt;</strong> ${escapeHtml(labelFor(sel[0]))}${b ? ` · x ${num(b.x, 1)}, y ${num(b.y, 1)} · ${num(b.w, 1)} × ${num(b.h, 1)}` : ''}</span>`;
    } else if (sel.length > 1) {
      const b = docBox(sel);
      left = `<span><strong>${sel.length} selected</strong>${b ? ` · ${num(b.w, 1)} × ${num(b.h, 1)}` : ''}</span>`;
    }
    status.innerHTML = `${left}<span class="faint svgs-hint">${sel.length ? 'Drag to move · handles resize/rotate · Esc: parent' : 'Click to select · double-click to enter groups'}</span>`;
  };
  const docBox = (els: Element[]) => {
    const r = editor.rootScreenCTM().inverse();
    const pts = els.flatMap((el) => editor.screenQuad(el) ?? []).map((p) => p.matrixTransform(r));
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  const updateAnim = () => {
    const has = editor.hasAnimation();
    animGroup.hidden = !has;
    playBtn.setAttribute('aria-pressed', String(canvas.paused));
    playBtn.querySelector('.svgs-play-label')!.textContent = canvas.paused ? 'Play' : 'Pause';
  };
  let chromeRaf = 0;
  editor.on((kind) => {
    if (kind === 'replace') updateAnim();
    cancelAnimationFrame(chromeRaf);
    if (kind === 'live' || kind === 'view') chromeRaf = requestAnimationFrame(updateChrome);
    else updateChrome();
  });

  // ------------------------------------------------------------ warnings
  const warnBox = $('#svgs-warnings');
  const showWarnings = (w: string[]) => {
    if (!w.length) {
      warnBox.hidden = true;
      return;
    }
    warnBox.innerHTML = `<ul>${w.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul><button type="button" class="btn btn-sm btn-ghost" aria-label="Dismiss">✕</button>`;
    warnBox.hidden = false;
    warnBox.querySelector('button')!.onclick = () => (warnBox.hidden = true);
  };

  // ------------------------------------------------------------ loading
  const load = (text: string, name: string, quiet = false) => {
    try {
      const w = editor.load(text, { name });
      showWarnings(w);
      requestAnimationFrame(() => canvas.fit());
      canvas.fit();
      if (!quiet) toast(w.length ? 'SVG loaded (with cleanups, see the notice)' : 'SVG loaded');
      return true;
    } catch (e) {
      const err = e as SvgParseError;
      toast(`Could not read that SVG${err.line ? ` (line ${err.line})` : ''}: ${err.message.slice(0, 120)}`, 'error', 5000);
      return false;
    }
  };

  const sampleSel = $<HTMLSelectElement>('#svgs-sample');
  sampleSel.innerHTML = `<option value="">Samples…</option>` + SAMPLES.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  sampleSel.addEventListener('change', () => {
    const s = SAMPLES.find((x) => x.id === sampleSel.value);
    if (s) load(s.code, s.id, true);
    sampleSel.value = '';
  });

  // ------------------------------------------------------------ tabs
  const desktop = window.matchMedia('(min-width: 1001px)');
  const setTab = (name: string) => {
    if (name === 'layers' && desktop.matches) name = 'props';
    main.dataset.tab = name;
    document.querySelectorAll<HTMLElement>('.svgs-tab').forEach((t) => {
      const on = t.dataset.pane === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    if (name === 'code') code.textarea.scrollTop = code.textarea.scrollTop;
  };
  document.querySelectorAll<HTMLElement>('.svgs-tab').forEach((t, i, all) => {
    t.addEventListener('click', () => setTab(t.dataset.pane!));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const visible = Array.from(all).filter((x) => x.offsetParent);
      const next = visible[(visible.indexOf(t) + d + visible.length) % visible.length];
      setTab(next.dataset.pane!);
      next.focus();
    });
  });
  desktop.addEventListener('change', () => setTab(main.dataset.tab || 'props'));

  // ------------------------------------------------------------ dialogs
  const dlgPaste = $<HTMLDialogElement>('#svgs-dlg-paste');
  const dlgMermaid = $<HTMLDialogElement>('#svgs-dlg-mermaid');
  const dlgExport = $<HTMLDialogElement>('#svgs-dlg-export');
  const pasteText = $<HTMLTextAreaElement>('#svgs-paste-text');
  const pasteErr = $('#svgs-paste-error');
  const cands = $('#svgs-candidates');
  $('#svgs-prompt-text').textContent = AI_PROMPT;

  const openPaste = (text = '') => {
    pasteText.value = text;
    pasteErr.hidden = true;
    cands.hidden = true;
    cands.innerHTML = '';
    if (!dlgPaste.open) dlgPaste.showModal();
    pasteText.focus();
  };

  const showCandidates = (list: SvgCandidate[]) => {
    const urls: string[] = [];
    cands.innerHTML =
      `<p class="small" style="grid-column:1/-1;margin:0"><strong>${list.length} SVGs found.</strong> Pick the one to edit:</p>` +
      list
        .map((c, i) => {
          let src = '';
          try {
            const { root } = parseSvg(c.code, { lenient: true });
            src = URL.createObjectURL(new Blob([serialize(root, { minify: true })], { type: 'image/svg+xml' }));
            urls.push(src);
          } catch {
            /* preview not possible */
          }
          return `<button type="button" class="svgs-cand" data-cand="${i}">${src ? `<img alt="" src="${src}"/>` : ''}<strong>${escapeHtml(c.label)}</strong><span>${escapeHtml(c.info)}</span></button>`;
        })
        .join('');
    cands.hidden = false;
    cands.onclick = (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-cand]');
      if (!b) return;
      const c = list[Number(b.dataset.cand)];
      if (load(c.code, 'ai-drawing')) {
        dlgPaste.close();
        urls.forEach((u) => URL.revokeObjectURL(u));
      }
    };
    cands.querySelector<HTMLElement>('[data-cand]')?.focus();
  };

  /** Handle text that may contain SVG or Mermaid (paste dialog, Ctrl+V). Returns true if handled. */
  const handleReply = (text: string, fromDialog: boolean) => {
    const res = extractFromReply(text);
    if (res.kind === 'svg') {
      if (res.candidates.length === 1) {
        if (load(res.candidates[0].code, 'ai-drawing') && dlgPaste.open) dlgPaste.close();
      } else {
        if (!fromDialog) openPaste(text);
        showCandidates(res.candidates);
      }
      return true;
    }
    if (res.kind === 'mermaid') {
      if (dlgPaste.open) dlgPaste.close();
      openMermaid(res.code, 'Found a Mermaid diagram in the reply. Press “Convert to editable SVG” to turn it into an editable drawing.');
      return true;
    }
    return false;
  };

  $('#svgs-paste-go').addEventListener('click', () => {
    const text = pasteText.value;
    pasteErr.hidden = true;
    if (!text.trim()) {
      pasteErr.textContent = 'Paste an AI reply (or SVG code) first.';
      pasteErr.hidden = false;
      return;
    }
    if (!handleReply(text, true)) {
      pasteErr.textContent = 'No SVG or Mermaid code found. Make sure the reply contains <svg …>…</svg> markup or a ```mermaid block.';
      pasteErr.hidden = false;
    }
  });

  // Mermaid
  const tplSel = $<HTMLSelectElement>('#svgs-template');
  const merText = $<HTMLTextAreaElement>('#svgs-mermaid-text');
  const merErr = $('#svgs-mermaid-error');
  const merInfo = $('#svgs-mermaid-info');
  const merStatus = $('#svgs-mermaid-status');
  const groups = Array.from(new Set(TEMPLATES.map((t) => t.group)));
  tplSel.innerHTML =
    `<option value="">Choose a template…</option>` +
    groups.map((g) => `<optgroup label="${escapeHtml(g)}">${TEMPLATES.filter((t) => t.group === g).map((t) => `<option value="${t.id}">${escapeHtml(t.name)} — ${escapeHtml(t.description)}</option>`).join('')}</optgroup>`).join('');
  tplSel.addEventListener('change', () => {
    const t = TEMPLATES.find((x) => x.id === tplSel.value);
    if (t) merText.value = t.code;
    merErr.hidden = true;
  });
  const openMermaid = (codeText?: string, info?: string) => {
    merErr.hidden = true;
    merStatus.textContent = '';
    if (codeText !== undefined) {
      merText.value = codeText;
      tplSel.value = '';
    } else if (!merText.value.trim()) {
      merText.value = TEMPLATES[0].code;
      tplSel.value = TEMPLATES[0].id;
    }
    merInfo.textContent = info || '';
    merInfo.hidden = !info;
    if (!dlgMermaid.open) dlgMermaid.showModal();
    merText.focus();
  };
  const merGo = $<HTMLButtonElement>('#svgs-mermaid-go');
  merGo.addEventListener('click', async () => {
    const src = merText.value;
    if (!src.trim()) {
      merErr.textContent = 'Enter some Mermaid code or pick a template.';
      merErr.hidden = false;
      return;
    }
    merGo.disabled = true;
    merErr.hidden = true;
    merStatus.textContent = 'Rendering…';
    try {
      const { renderMermaid, normalizeMermaidSvg } = await import('./mermaid');
      const { svg, fixes } = await renderMermaid(src);
      const { root } = parseSvg(svg, { lenient: true });
      normalizeMermaidSvg(root);
      const text = new XMLSerializer().serializeToString(root);
      if (load(text, 'diagram', true)) {
        dlgMermaid.close();
        toast(fixes.length ? `Diagram ready (auto-fixed: ${fixes[0]})` : 'Diagram ready: click any node or label to edit it');
      }
    } catch (e) {
      merErr.textContent = (e as Error).message;
      merErr.hidden = false;
    } finally {
      merGo.disabled = false;
      merStatus.textContent = '';
    }
  });

  // Export
  const nameInput = $<HTMLInputElement>('#svgs-export-name');
  const minify = $<HTMLInputElement>('#svgs-minify');
  let scale = 2;
  const exportName = () => (nameInput.value.trim() || editor.fileName || 'drawing').replace(/\.(svg|png)$/i, '').replace(/[\\/:*?"<>|]+/g, '-');
  const cleanSvg = () => editor.code({ clean: true, minify: minify.checked });
  const updateExportInfo = () => {
    const s = editor.docSize();
    $('#svgs-svg-size').textContent = `${formatBytes(new Blob([cleanSvg()]).size)}`;
    $('#svgs-png-size').textContent = `${Math.round(s.w * scale)} × ${Math.round(s.h * scale)} px`;
  };
  minify.addEventListener('change', updateExportInfo);
  $('#svgs-scale').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-scale]');
    if (!b) return;
    scale = Number(b.dataset.scale);
    $('#svgs-scale').querySelectorAll('[data-scale]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    updateExportInfo();
  });
  $('#svgs-png-color').addEventListener('input', () => ($<HTMLInputElement>('input[name="svgs-pngbg"][value="solid"]').checked = true));
  const openExport = () => {
    nameInput.value = editor.fileName;
    updateExportInfo();
    dlgExport.showModal();
  };
  $('#svgs-dl-svg').addEventListener('click', () => {
    downloadText(cleanSvg(), `${exportName()}.svg`, 'image/svg+xml');
    toast('SVG downloaded');
  });

  const renderPng = async (): Promise<Blob> => {
    const s = editor.docSize();
    const w = Math.max(1, Math.round(s.w * scale));
    const h = Math.max(1, Math.round(s.h * scale));
    if (w * h > 16384 * 16384 || w > 16384 || h > 16384) throw new Error('That image would be too large; choose a smaller scale.');
    const clone = editor.root.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    const url = URL.createObjectURL(new Blob([serialize(clone, { clean: true, minify: true })], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      const solid = ($<HTMLInputElement>('input[name="svgs-pngbg"]:checked')?.value ?? 'transparent') === 'solid';
      if (solid) {
        ctx.fillStyle = $<HTMLInputElement>('#svgs-png-color').value;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(img, 0, 0, w, h);
      return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  $('#svgs-dl-png').addEventListener('click', async () => {
    try {
      downloadBlob(await renderPng(), `${exportName()}.png`);
      toast(`PNG downloaded (${scale}×)`);
    } catch (e) {
      toast(`PNG export failed: ${(e as Error).message}`, 'error', 4000);
    }
  });
  $('#svgs-copy-png').addEventListener('click', async () => {
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('your browser cannot copy images; use Download PNG');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderPng() })]);
      toast('PNG copied to the clipboard');
    } catch (e) {
      toast(`Copy failed: ${(e as Error).message}`, 'error', 4000);
    }
  });

  // ------------------------------------------------------------ commands
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.svg,image/svg+xml,.txt,.md,.html,.xml';
  fileInput.hidden = true;
  fileInput.id = 'svgs-file';
  document.body.appendChild(fileInput);
  const openFile = async (f: File) => {
    if (f.size > 20 * 1024 * 1024) {
      toast('That file is too large (max 20 MB)', 'error');
      return;
    }
    const text = await f.text();
    if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') load(text, f.name);
    else if (!handleReply(text, false)) toast('No SVG found in that file', 'error');
  };
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) openFile(f);
  });
  // Drop a file anywhere on the page.
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      viewport.classList.add('is-drop');
    }
  });
  window.addEventListener('dragleave', () => viewport.classList.remove('is-drop'));
  window.addEventListener('drop', (e) => {
    viewport.classList.remove('is-drop');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    openFile(f);
  });

  const copyForAi = () => {
    const text = `Here is my edited SVG. Please keep its structure, ids and the changes I made, and [describe what you want next]:\n\n\`\`\`svg\n${editor.code({ clean: true })}\`\`\`\n`;
    copyText(text, 'Copied for AI: paste it into your chat and describe the next change');
  };

  const run = (cmd: string) => {
    switch (cmd) {
      case 'paste-ai': return openPaste();
      case 'open': return fileInput.click();
      case 'mermaid': return openMermaid();
      case 'undo': return editor.undo();
      case 'redo': return editor.redo();
      case 'duplicate': return editor.duplicateSelection();
      case 'delete': return editor.deleteSelection();
      case 'group': return editor.groupSelection();
      case 'ungroup': return editor.ungroupSelection();
      case 'front': case 'forward': case 'backward': case 'back': return editor.reorder(cmd);
      case 'zoom-in': return canvas.zoomBy(1.25);
      case 'zoom-out': return canvas.zoomBy(0.8);
      case 'zoom-100': return canvas.setZoom(1);
      case 'fit': return canvas.fit();
      case 'grid': {
        const b = $('[data-cmd="grid"]');
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        return canvas.setGrid(on);
      }
      case 'play':
        canvas.setPaused(!canvas.paused);
        return updateAnim();
      case 'restart': return canvas.restart();
      case 'copy-ai': return copyForAi();
      case 'export': return openExport();
      case 'format': return code.format();
      case 'copy-svg': case 'copy-svg-export': return copyText(editor.code({ clean: true, minify: cmd === 'copy-svg-export' && minify.checked }), 'SVG code copied');
      case 'copy-prompt': return copyText(AI_PROMPT, 'Prompt copied: paste it into your AI chat');
    }
  };
  document.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-cmd]');
    if (b && !(b as HTMLButtonElement).disabled) run(b.dataset.cmd!);
  });

  // ------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const typing = isTyping(e.target);
    if (mod && k === 'z' && !typing) {
      e.preventDefault();
      return e.shiftKey ? editor.redo() : editor.undo();
    }
    if (mod && k === 'y' && !typing) {
      e.preventDefault();
      return editor.redo();
    }
    if (typing) return;
    const sel = editor.selection.length > 0;
    if (mod && k === 'd' && sel) {
      e.preventDefault();
      return editor.duplicateSelection();
    }
    if (mod && k === 'g') {
      e.preventDefault();
      return e.shiftKey ? editor.ungroupSelection() : editor.groupSelection();
    }
    if (mod && k === 'a') {
      e.preventDefault();
      return editor.select(editor.layerChildren(editor.root).filter((x) => !editor.isLocked(x)));
    }
    if (mod && (e.key === ']' || e.key === '}')) {
      e.preventDefault();
      return editor.reorder(e.shiftKey ? 'front' : 'forward');
    }
    if (mod && (e.key === '[' || e.key === '{')) {
      e.preventDefault();
      return editor.reorder(e.shiftKey ? 'back' : 'backward');
    }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.preventDefault();
      return editor.deleteSelection();
    }
    if (e.key === 'Escape' && sel) {
      e.preventDefault();
      return editor.selectParent();
    }
    if (e.key.startsWith('Arrow') && sel) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      return editor.nudge(dx, dy);
    }
    if (e.key === '+' || e.key === '=') return canvas.zoomBy(1.25);
    if (e.key === '-' || e.key === '_') return canvas.zoomBy(0.8);
    if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) return canvas.fit();
    if (e.key === ')' || (e.shiftKey && e.code === 'Digit0')) return canvas.setZoom(1);
  });

  // Ctrl+V anywhere (outside text fields): SVG markup, an AI reply, or an .svg file.
  document.addEventListener('paste', (e) => {
    if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => /svg/.test(f.type) || /\.svg$/i.test(f.name));
    if (file) {
      e.preventDefault();
      openFile(file);
      return;
    }
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!text.trim()) return;
    e.preventDefault();
    if (!handleReply(text, false)) toast(looksLikeSvg(text) ? 'The pasted SVG is incomplete' : 'The clipboard has no SVG or Mermaid code', 'error');
  });

  // ------------------------------------------------------------ start
  const first = SAMPLES[0];
  load(first.code, first.id, true);
  setTab('props');
  updateAnim();
}
