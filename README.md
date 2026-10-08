# SafeOCR

OCR that never leaves your browser. Drop images or PDFs — one file or a whole batch — and get text back, processed entirely on your own machine: the models are downloaded once, cached by the browser, and every page is run in a Web Worker. Nothing is uploaded anywhere.

Three engines, chosen per run, from the fastest to the best — PP-OCRv6 is the default and the recommended one:

- **PP-OCRv5 mobile** (the converted bundle from [`x3zvawq/paddleocr-js-onnx`](https://huggingface.co/x3zvawq/paddleocr-js-onnx), ~21 MB): the previous generation, kept for the speed — about a third faster per page, but it misses small print and slips on the odd line.
- **PP-OCRv6 small** ([PaddlePaddle's ONNX export](https://huggingface.co/collections/PaddlePaddle/pp-ocrv6), ~31 MB, through [`paddleocr`](https://github.com/x3zvawq/paddleocr.js)) runs on the CPU through WebAssembly in every browser and returns plain text lines in reading order. Faithful rather than fluent, a few seconds per page, and the fallback when there is no WebGPU. Detects at full resolution, so it reads small print PP-OCRv5 misses.
- **GLM-OCR** ([`zai-org/GLM-OCR`](https://huggingface.co/zai-org/GLM-OCR), 0.9B, MIT) runs on the GPU through WebGPU via [Transformers.js](https://github.com/huggingface/transformers.js) v4 and the q4f16 export [`onnx-community/GLM-OCR-ONNX`](https://huggingface.co/onnx-community/GLM-OCR-ONNX) (~650 MB once, ~2 GB of GPU memory). It answers the model's three prompts — *Document → Markdown* (`Text Recognition:`, with `$…$` formulas and tables), *Table → HTML* (`Table Recognition:`) and *Formula → LaTeX* (`Formula Recognition:`) — streaming tokens as they are decoded, cancellable between decoder steps. Best quality; generative, so it can smooth over or invent text on poor scans.

Inputs: PNG, JPEG, WebP, GIF, BMP, AVIF (anything the browser decodes), pasted screenshots, and multi-page PDFs (rasterised with pdf.js at 150 dpi, including scanned PDFs with JBIG2/JPX streams). Pages can be rotated a quarter turn at a time before they run, and any rectangle of a page can be recognised on its own (a "region" page, handy for a single table or formula). Outputs: per page copy / download (`.md`, `.html`, `.tex`, `.txt`), tables also as CSV or a Markdown table and formulas as MathML, everything (or the selection) as a ZIP with one folder per document plus `all.md`, as **one combined file per document** (`.md` with an invisible comment marking each page where GLM-OCR read it, `.txt` with a dashed page line for PP-OCR; several documents come zipped), or as **searchable PDFs** — the scans with an invisible text layer, one PDF per document, written by hand in `src/lib/pdf.ts` with tesseract's glyphless font so Latin and CJK text alike is extractable.

## Browser support

- GLM-OCR needs WebGPU with `shader-f16` and about 2 GB of memory in one tab: desktop Chrome and Edge, Safari 26+, recent Firefox. iPhone and iPad have WebGPU but Safari kills a tab well before that, so GLM-OCR is not offered there (nor on devices reporting under 4 GB); the app probes this on start and falls back to PP-OCRv5 as the default engine.
- PP-OCR runs anywhere with WebAssembly. With the cross-origin-isolation headers below it uses a thread pool; without them it still works, single-threaded.

## Running it

```sh
yarn install   # yarn classic; .yarnrc ignores pdfjs-dist's node>=22.13 engine (only its browser build is used)
yarn dev       # syncs the runtimes into public/ocr-runtime/ and starts Next.js on :3000
yarn build && yarn start
```

Other scripts: `yarn compile` (tsc), `yarn lint` (prettier + eslint), `yarn ocr:sync` (run by `dev` and `build`; copies onnxruntime-web's WebAssembly runtime and pdf.js's worker, wasm decoders, CMaps and standard fonts from `node_modules` into `public/ocr-runtime/<lib>/<version>/`, git-ignored and served with immutable cache headers). `next build` and `next dev` share `.next/`: after a production build, `rm -rf .next` before going back to `yarn dev`, or the dev server can serve the build's server bundle (fonts and chunks then disagree). A production run also leaves a service worker on the origin; dev pages remove it on load.

Environment (see `.env.example`):

- `NEXT_PUBLIC_SITE_URL` — public origin, used for the canonical link. Optional.
- `NEXT_PUBLIC_SAFEOCR_MODEL_HOST` — where model files come from; `https://huggingface.co/` by default. To self-host, mirror the repos with the Hub's layout (`<host>/<repo>/resolve/main/<file>`) behind CORS and immutable caching: `onnx-community/GLM-OCR-ONNX`, `PaddlePaddle/PP-OCRv6_small_det_onnx`, `PaddlePaddle/PP-OCRv6_small_rec_onnx` and `x3zvawq/paddleocr-js-onnx` (the PP-OCRv5 bundle and the PP-OCRv6 dictionary).

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
src/lib/inputs.ts            images via createImageBitmap (<img> fallback), PDFs via pdf.js; downscale to the pixel budget; previews on their own
src/lib/client.ts            main-thread handle: the main worker plus a PP-OCR pool for batches, engine status, streaming, cancel, dispose on pagehide
src/lib/worker.ts            the worker: loads engines on demand, runs one request at a time
src/lib/engines/glm.ts       GLM-OCR through Transformers.js (WebGPU, q4f16, interruptable, loop guard); prefill via Transformers.js; the processor's patch flattening as plain loops
src/lib/engines/decode.ts    the decode loop: GPU-resident inputs, next token on the GPU, no readback on the critical path
src/lib/ortLoader.ts         wraps onnxruntime-web's WebAssembly loader to set WebGPU provider options its API cannot
src/lib/trim.ts              trims a page's uniform margins before GLM-OCR sees it (the encoder's cost grows with pixels²)
src/lib/engines/paddle.ts    PP-OCRv6 small and PP-OCRv5 mobile through paddleocr on the same onnxruntime-web instance (wasm); batches run one page per worker, one four-thread worker per four cores
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
scripts/patch-glm-graphs.py  derives public/models/glm-ocr/<tag>/ (vision + decoder graphs) from upstream's export (see below)
```

Pages are shown as soon as they are added: an image as dropped, a PDF page rendered by pdf.js right away (one page at a time on the main thread, the page on screen first), so a document can be browsed before anything runs; a run reuses that picture unless the page was rotated since. Every page is downscaled to the chosen detail budget (0.75 / 1.2 / 2.5 MP) before the RGBA buffer is transferred to the worker; vision tokens, GPU memory and latency all scale with it, and the GLM processor enforces the same cap. In the worker, GLM-OCR then trims the page's uniform margins (`src/lib/trim.ts`): the vision encoder attends across every patch, so its cost grows faster than the pixel count and a scan's margins are a quarter of it for nothing; the preview, exports and PP-OCRv5 still see the whole page. A run that starts repeating itself (a block of up to 64 tokens, over 200 tokens) is stopped and cut at the first repeat instead of running to the token cap. GLM output is rendered with `react-markdown` + GFM + KaTeX behind `rehype-sanitize` (HTML tables allowed, images dropped, so an OCR'd page can never trigger a network request); the stored and downloaded text is exactly what the model produced.

GLM-OCR's graphs are served from this origin (`public/models/glm-ocr/<tag>/`, made by `scripts/patch-glm-graphs.py` from upstream's export; only the two graphs differ, the weights still come from the Hub, so the worker checks their size against the one the patch was made for and falls back to upstream's graphs and Transformers.js's `generate()` if the Hub has moved on). The vision graph has the attention mask removed, which the export builds for batches of several images and which is all zeros for the one image a run sends — on an M1 Pro that alone took 42 % off the time to the first token. The decoder graph emits the next token itself (an ArgMax output), loses the mask-derived attention bias (zeros for one unpadded sequence), reads rotary positions from one shared offset instead of 32 per-token CPU computations, takes its lengths from Shape of float tensors, and runs its norms and rotary embeddings in fp16 without the export's fp32 casts and head transposes. `src/lib/engines/decode.ts` drives it after Transformers.js's prefill: the token, the embedding, the mask and the positions all live in GPU buffers, every decoder output is a GPU buffer, and the token is copied back one step late while the next pass runs — a step is three command buffers and no copy in either direction, where Transformers.js's loop read the logits back after every pass and onnxruntime uploaded 35 small CPU tensors per token, each with a command-buffer flush. Two provider options make that possible (`src/lib/ortLoader.ts`): int64 kernels, so the int64 inputs stay on the GPU, and one command buffer per pass instead of one per 16 kernels; onnxruntime-web's API cannot set either (the provider parses its options before `session_options.extra` is applied), so the loader of the WebAssembly runtime is wrapped to add them. Output is byte-identical to Transformers.js's greedy decoding on the test pages.

Run processes every page that has not succeeded yet. To process a subset, pick pages in the rail — click selects one, ⇧-click a range, ⌘/Ctrl-click adds or removes; on touch screens, **Select** in the rail header makes taps add and remove — and Run limits itself to the selection while a second button keeps "run everything" one click away; Esc or Deselect clears it. Plain Run never picks up pages that are done; on a selection the button processes every selected page, turning into Rerun where they all have results, and asks once before replacing results (each is kept until its new run succeeds). On phones the page list folds under its header and the scan arrows move between pages; the layout goes side by side from 1024 px.

Settings (the gear) are per browser: the theme follows the system until chosen, engine / output / detail are remembered as they change, and "load on open" preloads the engine so the first run does not wait. The same panel shows what the app stores on the device and can delete the downloaded models. Any page that has run can be rerun (with a confirmation); its current result stays in place until the new run succeeds and is dropped then, so a failed or stopped rerun loses nothing.

Reviewing: PP-OCR returns a box and a confidence per line, so the scan shows every line's box (coloured below 80 % and 60 % confidence) and hovering a line in either pane highlights it in the other; the text itself is tinted the same way. Any result can be edited in place (the page is marked *edited*; exports use the edited text), compared with the other engine (a word-level diff of both readings), and searched across pages from the rail. Keyboard: ←/→ pages, ⌘/Ctrl+⏎ run, ⌘/Ctrl+A select all, ⌫ remove the selected files (after confirming), Esc deselect.

Between visits the files and results are kept in IndexedDB (switchable off in Settings; nothing leaves the device) and offered back on the next start. In a production build a service worker (`public/sw.js`) caches the app shell and the runtimes, so once opened — and once an engine's models are cached — SafeOCR loads and runs with no connection, and can be installed from the browser as an app.

Both engines share one `onnxruntime-web` instance: `package.json` pins the exact version `@huggingface/transformers` depends on. Bump the two together.

## Caveats

- 650 MB is a real adoption tax; the first GLM-OCR run on a machine downloads it (progress is shown), later visits read it from the browser cache.
- A dense 1.2 MP page of body text takes about 14–16 s on an M1 Pro (2–4 s until the first token, then ~52–55 tokens per second; a page with little text takes 1–2 s). The remaining cost is onnxruntime-web's single-token MatMulNBits kernel, which reads the 290 MB of 4-bit weights a token needs at 15–35 GB/s on this GPU; its faster paths need four or more tokens per pass or symmetric weights. "High detail" costs several times that: the encoder's cost grows with the square of the pixel count. Use the low-memory setting on machines with little GPU memory.
- GLM-OCR is generative: when faithful beats fluent (IDs, amounts, low-quality scans), use PP-OCRv6.
- PP-OCRv6 takes ~4.5 s per dense page on an M1 Pro (PP-OCRv5 ~3.7 s); on synthetic pages with ground truth PP-OCRv6 small read every page at 0 % character error where PP-OCRv5 mobile lost 0.1–4 % per page and a third of a 6-pt page. PP-OCR peaks at four onnxruntime threads (eight is slower). A batch runs on one four-thread worker per four cores, up to eight: on that machine a second instance takes 21 % off a 14-page document and a third adds nothing, so that is where it stops; a lone page always has an instance to itself.

## Licences and credits

GLM-OCR is MIT-licensed (Zhipu AI); PP-OCRv6 and PP-OCRv5 are Apache-2.0 (PaddlePaddle); Transformers.js and onnxruntime-web are Apache-2.0 / MIT; paddleocr.js is MIT; pdf.js is Apache-2.0.
