# Browser Tools

A collection of everyday tools that run **entirely in your browser**. No uploads, no accounts, no tracking, no storage.
Built with [Astro](https://astro.build) as a fully static site, so it can be hosted anywhere.

See [PRINCIPLES.md](./PRINCIPLES.md) for the ground rules every tool follows.

## Tools

| Category | Tool | What it does |
| --- | --- | --- |
| Documents | **Markdown → PDF** | Live Markdown editor (GFM, code highlighting, math, Mermaid) with clean PDF/HTML export |
| Documents | **Diagram Studio** | Mermaid editor for flowcharts, sequence diagrams, mind maps and more. Paste AI output directly; export SVG/PNG |
| Documents | **PDF Toolkit** | Merge, split, reorder, rotate and delete pages; images → PDF |
| Developer | **JSON Studio** | Validate/format/repair JSON, tree explorer, JSON ↔ YAML ↔ CSV, JSON → TypeScript |
| Developer | **Text Diff** | Side-by-side or unified diff with word/char highlights and patch export |
| Developer | **Regex Lab** | Live regex testing, groups, replace, plain-English explanation, safe against catastrophic backtracking |
| Developer | **Dev Toolkit** | Base64, URL, HTML entities, JWT, hashes, UUID v4/v7, timestamps, passwords, number bases |
| Media | **Image Studio** | Batch compress/resize/convert, target file size, EXIF/GPS stripping, SVG → PNG |
| Media | **QR Studio** | Styled QR codes (URL, Wi-Fi, vCard, …) and scanning from image or camera |
| Media | **Color Lab** | Color conversion, WCAG/APCA contrast, palettes, gradients, palette from image, color-blindness check |
| Data | **Data Explorer** | CSV/JSON table with filters, column profiling, charts and SQL |
| AI & ML | **LLM Token Counter** | Token visualization for GPT tokenizers, context-window usage and cost estimates |
| AI & ML | **Optimizer Race** | SGD, Momentum, Adam and others racing across loss landscapes |
| AI & ML | **ML Lab** | Interactive k-means and a from-scratch neural network learning decision boundaries |

## Develop

```bash
npm install
npm run dev          # http://localhost:4321/tools/
npm run build        # static output in dist/
npm run preview      # serve dist/ on http://localhost:4321
```

### Tests

Each tool has an end-to-end Playwright test in `tests/<slug>.test.mjs`. The shared harness (`tests/harness.mjs`)
fails a test if the page makes **any request to another origin**, throws an error, or leaves **anything in browser
storage** (localStorage, sessionStorage, IndexedDB, cookies).

```bash
npm run build && npm run preview &   # or npm run dev
npm test                             # all tools
node tests/json-studio.test.mjs      # one tool
```

Tests need Playwright with Chromium available (`npm i -D playwright && npx playwright install chromium`
if your machine doesn't have it).

## Add to your existing Astro site

The tools are self-contained. To move them into another Astro project:

1. Copy `src/tools/`, `src/lib/ui.ts`, `src/styles/global.css`, `src/data/tools.ts`, `src/components/ToolHub.astro`,
   `src/layouts/` and `src/pages/tools/` into the same paths.
2. Install the dependencies from `package.json`.
3. Wrap `src/layouts/Base.astro` in your own site layout, or replace its header/footer with yours. Keep the
   Content-Security-Policy `<meta>` tag: it is what guarantees no data leaves the browser.
   If your site needs third-party scripts (analytics etc.), don't add them to tool pages.
4. Tools are served under `/tools/<slug>/`, and the hub at `/tools/`.

## Add a new tool

1. Add an entry to `src/data/tools.ts`.
2. Create `src/pages/tools/<slug>.astro` using `ToolLayout`, with client code in `src/tools/<slug>/`.
3. Write `tests/<slug>.test.mjs` with `runToolTest`.

## Ideas backlog

Tools that fit the same in-browser, no-storage model and could come next:

- **Local AI chat**: small open models (Llama/Qwen/Phi) on WebGPU via WebLLM or Transformers.js. Weights download once and prompts never leave the device.
- **Speech to text**: Whisper running in the browser (Transformers.js) for transcribing voice notes and meetings.
- **Background remover**: segmentation model in the browser.
- **OCR**: extract text from images and scanned PDFs (Tesseract.js).
- **Embeddings playground**: embed sentences locally and visualize similarity / 2D projection.
- **Attention visualizer**: step through a tiny transformer's attention patterns.
- **Prompt diff & templating**: compare prompt versions and fill variables.
- **Cron expression builder**, **time-zone meeting planner**, **unit converter**.
- **SQL formatter**, **code formatter** (Prettier in the browser), **Markdown table generator**.
- **Audio/video trimmer** with ffmpeg.wasm; **GIF maker**.
- **Image to ASCII / pixel art**, **favicon generator**, **SVG optimizer** (SVGO in the browser).
- **CSV ↔ Excel** (SheetJS), **Excalidraw-style whiteboard** export to PNG/SVG.
- **Pomodoro / focus timer**, **typing speed test**.
