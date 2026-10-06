# SafeOCR

OCR that never leaves your browser. Drop images or PDFs — one file or a whole batch — and get text back, processed entirely on your own machine: the models are downloaded once, cached by the browser, and every page is run in a Web Worker. Nothing is uploaded anywhere.

Two engines, chosen per run:

- **GLM-OCR** ([`zai-org/GLM-OCR`](https://huggingface.co/zai-org/GLM-OCR), 0.9B, MIT) runs on the GPU through WebGPU via [Transformers.js](https://github.com/huggingface/transformers.js) v4 and the q4f16 export [`onnx-community/GLM-OCR-ONNX`](https://huggingface.co/onnx-community/GLM-OCR-ONNX) (~650 MB once, ~2 GB of GPU memory). It answers the model's three prompts — *Document → Markdown* (`Text Recognition:`, with `$…$` formulas and tables), *Table → HTML* (`Table Recognition:`) and *Formula → LaTeX* (`Formula Recognition:`) — streaming tokens as they are decoded, cancellable between decoder steps. Best quality; generative, so it can smooth over or invent text on poor scans.
- **PP-OCRv5 mobile** ([`paddleocr`](https://github.com/x3zvawq/paddleocr.js) + the converted ONNX bundle from [`x3zvawq/paddleocr-js-onnx`](https://huggingface.co/x3zvawq/paddleocr-js-onnx), ~21 MB) runs on the CPU through WebAssembly in every browser and returns plain text lines in reading order. Faithful rather than fluent, a few seconds per page, and the fallback when there is no WebGPU.

Inputs: PNG, JPEG, WebP, GIF, BMP, AVIF (anything the browser decodes), pasted screenshots, and multi-page PDFs (rasterised with pdf.js at 150 dpi, including scanned PDFs with JBIG2/JPX streams). Pages can be rotated a quarter turn at a time before they run, and any rectangle of a page can be recognised on its own (a "region" page, handy for a single table or formula). Outputs: per page copy / download (`.md`, `.html`, `.tex`, `.txt`), tables also as CSV or a Markdown table and formulas as MathML, everything (or the selection) as a ZIP with one folder per document plus `all.md`, or as **searchable PDFs** — the scans with an invisible text layer, one PDF per document, written by hand in `src/lib/pdf.ts` with tesseract's glyphless font so Latin and CJK text alike is extractable.

## Browser support

- GLM-OCR needs WebGPU with `shader-f16`: desktop Chrome and Edge, Safari 26+, recent Firefox. Phones are marginal (memory). The app detects support and falls back to PP-OCRv5 as the default engine.
- PP-OCRv5 runs anywhere with WebAssembly. With the cross-origin-isolation headers below it uses a thread pool; without them it still works, single-threaded.

## Running it

```sh
yarn install   # yarn classic; .yarnrc ignores pdfjs-dist's node>=22.13 engine (only its browser build is used)
yarn dev       # syncs the runtimes into public/ocr-runtime/ and starts Next.js on :3000
yarn build && yarn start
```

Other scripts: `yarn compile` (tsc), `yarn lint` (prettier + eslint), `yarn ocr:sync` (run by `dev` and `build`; copies onnxruntime-web's WebAssembly runtime and pdf.js's worker, wasm decoders, CMaps and standard fonts from `node_modules` into `public/ocr-runtime/<lib>/<version>/`, git-ignored and served with immutable cache headers). `next build` and `next dev` share `.next/`: after a production build, `rm -rf .next` before going back to `yarn dev`, or the dev server can serve the build's server bundle (fonts and chunks then disagree). A production run also leaves a service worker on the origin; dev pages remove it on load.

Environment (see `.env.example`):

- `NEXT_PUBLIC_SITE_URL` — public origin, used for the canonical link. Optional.
- `NEXT_PUBLIC_SAFEOCR_MODEL_HOST` — where model files come from; `https://huggingface.co/` by default. To self-host, mirror the two repos with the Hub's layout (`<host>/<repo>/resolve/main/<file>`) behind CORS and immutable caching.

## Deploying

A static-friendly Next.js 14 (pages router) app with no API routes; Vercel works out of the box (`yarn build` runs the runtime sync). Two things the host must preserve:

- The `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: require-corp` headers from `next.config.js`, on every response. They give the page SharedArrayBuffer, and Chrome only starts a dedicated worker from an isolated document when the worker script (the webpack chunk, onnxruntime-web's thread-pool script, pdf.js's worker) carries COEP as well. If a proxy strips them the app still runs, single-threaded, and says so.
- `public/ocr-runtime/` is generated at build time, so it must be built where it is served (it is not committed).

## How it works

```
src/pages/index.tsx          page shell; the app is loaded client-side only
src/components/              SafeOcrApp (batch runner + layout), Toolbar, Welcome, Dropzone (drop/paste/picker), EngineCard,
                             PageRail, SourcePane, ResultPane, StatusBar, SettingsMenu, ConfirmDialog, OcrMarkdown, icons
src/lib/protocol.ts          engines, modes, pixel budgets, model files, worker messages
src/lib/inputs.ts            images via createImageBitmap (<img> fallback), PDFs via pdf.js; downscale to the pixel budget
src/lib/client.ts            main-thread handle: one worker per tab, engine status, streaming, cancel, dispose on pagehide
src/lib/worker.ts            the worker: loads engines on demand, runs one request at a time
src/lib/engines/glm.ts       GLM-OCR through Transformers.js (WebGPU, q4f16, TextStreamer, interruptable)
src/lib/engines/paddle.ts    PP-OCRv5 through paddleocr on the same onnxruntime-web instance (wasm)
src/lib/jobs.ts              documents → pages → OCR state; a rerun keeps the old result until the new run succeeds
src/lib/export.ts            downloads and a store-only ZIP writer (text and binary members)
src/lib/pdf.ts               searchable PDF writer: JPEG pages + invisible Identity-H text layer, no dependencies
src/lib/diff.ts              word-level Myers diff for the engine comparison (components/DiffView renders it)
src/lib/convert.ts           HTML table → CSV / Markdown, LaTeX → MathML
src/lib/session.ts           IndexedDB persistence of files, results and previews between visits
src/lib/pwa.ts               service-worker registration (public/sw.js, manifest.webmanifest, icon.svg)
src/lib/settings.ts          per-user settings in localStorage (theme, engine, output, detail, scan toggle, load on open, keep session)
src/styles/palette.ts        Catppuccin Latte (light) and Mocha (dark); lib/theme.ts applies the theme setting
scripts/sync-ocr-runtime.mjs copies the runtimes into public/ocr-runtime/
```

Every page is downscaled to the chosen detail budget (0.75 / 1.5 / 2.5 MP) before the RGBA buffer is transferred to the worker; vision tokens, GPU memory and latency all scale with it, and the GLM processor enforces the same cap. GLM output is rendered with `react-markdown` + GFM + KaTeX behind `rehype-sanitize` (HTML tables allowed, images dropped, so an OCR'd page can never trigger a network request); the stored and downloaded text is exactly what the model produced.

Run processes every page that has not succeeded yet. To process a subset, pick pages in the rail — click selects one, ⇧-click a range, ⌘/Ctrl-click adds or removes; on touch screens, **Select** in the rail header makes taps add and remove — and Run limits itself to the selection while a second button keeps "run everything" one click away; Esc or Deselect clears it. Pages that are done are never picked up by Run; they go through Rerun. On phones the page list folds under its header and the scan arrows move between pages; the layout goes side by side from 1024 px.

Settings (the gear) are per browser: the theme follows the system until chosen, engine / output / detail are remembered as they change, and "load on open" preloads the engine so the first run does not wait. The same panel shows what the app stores on the device and can delete the downloaded models. Any page that has run can be rerun (with a confirmation); its current result stays in place until the new run succeeds and is dropped then, so a failed or stopped rerun loses nothing.

Reviewing: PP-OCRv5 returns a box and a confidence per line, so the scan shows every line's box (coloured below 80 % and 60 % confidence) and hovering a line in either pane highlights it in the other; the text itself is tinted the same way. Any result can be edited in place (the page is marked *edited*; exports use the edited text), compared with the other engine (a word-level diff of both readings), and searched across pages from the rail. Keyboard: ←/→ pages, ⌘/Ctrl+⏎ run, ⌘/Ctrl+A select all, ⌫ remove the selected files (after confirming), Esc deselect.

Between visits the files and results are kept in IndexedDB (switchable off in Settings; nothing leaves the device) and offered back on the next start. In a production build a service worker (`public/sw.js`) caches the app shell and the runtimes, so once opened — and once an engine's models are cached — SafeOCR loads and runs with no connection, and can be installed from the browser as an app.

Both engines share one `onnxruntime-web` instance: `package.json` pins the exact version `@huggingface/transformers` depends on. Bump the two together.

## Caveats

- 650 MB is a real adoption tax; the first GLM-OCR run on a machine downloads it (progress is shown), later visits read it from the browser cache.
- A dense 1.5 MP page takes roughly 10–30 s on a laptop GPU (vision prefill dominates; decoding runs at tens of tokens per second). Use the low-memory detail setting on machines with little GPU memory.
- GLM-OCR is generative: when faithful beats fluent (IDs, amounts, low-quality scans), use PP-OCRv5.

## Licences and credits

GLM-OCR is MIT-licensed (Zhipu AI); PP-OCRv5 is Apache-2.0 (PaddlePaddle); Transformers.js and onnxruntime-web are Apache-2.0 / MIT; paddleocr.js is MIT; pdf.js is Apache-2.0.
