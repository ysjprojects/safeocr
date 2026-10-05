# SafeOCR

OCR that never leaves your browser. Drop images or PDFs — one file or a whole batch — and get text back, processed entirely on your own machine: the models are downloaded once, cached by the browser, and every page is run in a Web Worker. Nothing is uploaded anywhere.

Two engines, chosen per run:

- **GLM-OCR** ([`zai-org/GLM-OCR`](https://huggingface.co/zai-org/GLM-OCR), 0.9B, MIT) runs on the GPU through WebGPU via [Transformers.js](https://github.com/huggingface/transformers.js) v4 and the q4f16 export [`onnx-community/GLM-OCR-ONNX`](https://huggingface.co/onnx-community/GLM-OCR-ONNX) (~650 MB once, ~2 GB of GPU memory). It answers the model's three prompts — *Document → Markdown* (`Text Recognition:`, with `$…$` formulas and tables), *Table → HTML* (`Table Recognition:`) and *Formula → LaTeX* (`Formula Recognition:`) — streaming tokens as they are decoded, cancellable between decoder steps. Best quality; generative, so it can smooth over or invent text on poor scans.
- **PP-OCRv5 mobile** ([`paddleocr`](https://github.com/x3zvawq/paddleocr.js) + the converted ONNX bundle from [`x3zvawq/paddleocr-js-onnx`](https://huggingface.co/x3zvawq/paddleocr-js-onnx), ~21 MB) runs on the CPU through WebAssembly in every browser and returns plain text lines in reading order. Faithful rather than fluent, a few seconds per page, and the fallback when there is no WebGPU.

Inputs: PNG, JPEG, WebP, GIF, BMP, AVIF (anything the browser decodes), pasted screenshots, and multi-page PDFs (rasterised with pdf.js at 150 dpi, including scanned PDFs with JBIG2/JPX streams). Outputs: per page copy / download (`.md`, `.html`, `.tex`, `.txt`), or everything at once as a ZIP (one file per page plus `all.md`).

## Browser support

- GLM-OCR needs WebGPU with `shader-f16`: desktop Chrome and Edge, Safari 26+, recent Firefox. Phones are marginal (memory). The app detects support and falls back to PP-OCRv5 as the default engine.
- PP-OCRv5 runs anywhere with WebAssembly. With the cross-origin-isolation headers below it uses a thread pool; without them it still works, single-threaded.

## Running it

```sh
yarn install   # yarn classic; .yarnrc ignores pdfjs-dist's node>=22.13 engine (only its browser build is used)
yarn dev       # syncs the runtimes into public/ocr-runtime/ and starts Next.js on :3000
yarn build && yarn start
```

Other scripts: `yarn compile` (tsc), `yarn lint` (prettier + eslint), `yarn ocr:sync` (run by `dev` and `build`; copies onnxruntime-web's WebAssembly runtime and pdf.js's worker, wasm decoders, CMaps and standard fonts from `node_modules` into `public/ocr-runtime/<lib>/<version>/`, git-ignored and served with immutable cache headers).

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
src/components/              SafeOcrApp (batch runner + layout), EngineCard, Dropzone, QueueList, ResultPane, OcrMarkdown
src/lib/protocol.ts          engines, modes, pixel budgets, model files, worker messages
src/lib/inputs.ts            images via createImageBitmap (<img> fallback), PDFs via pdf.js; downscale to the pixel budget
src/lib/client.ts            main-thread handle: one worker per tab, engine status, streaming, cancel, dispose on pagehide
src/lib/worker.ts            the worker: loads engines on demand, runs one request at a time
src/lib/engines/glm.ts       GLM-OCR through Transformers.js (WebGPU, q4f16, TextStreamer, interruptable)
src/lib/engines/paddle.ts    PP-OCRv5 through paddleocr on the same onnxruntime-web instance (wasm)
src/lib/jobs.ts              documents → pages → OCR state
src/lib/export.ts            downloads and a store-only ZIP writer
scripts/sync-ocr-runtime.mjs copies the runtimes into public/ocr-runtime/
```

Every page is downscaled to the chosen detail budget (0.75 / 1.5 / 2.5 MP) before the RGBA buffer is transferred to the worker; vision tokens, GPU memory and latency all scale with it, and the GLM processor enforces the same cap. GLM output is rendered with `react-markdown` + GFM + KaTeX behind `rehype-sanitize` (HTML tables allowed, images dropped, so an OCR'd page can never trigger a network request); the stored and downloaded text is exactly what the model produced.

Both engines share one `onnxruntime-web` instance: `package.json` pins the exact version `@huggingface/transformers` depends on. Bump the two together.

## Caveats

- 650 MB is a real adoption tax; the first GLM-OCR run on a machine downloads it (progress is shown), later visits read it from the browser cache.
- A dense 1.5 MP page takes roughly 10–30 s on a laptop GPU (vision prefill dominates; decoding runs at tens of tokens per second). Use the low-memory detail setting on machines with little GPU memory.
- GLM-OCR is generative: when faithful beats fluent (IDs, amounts, low-quality scans), use PP-OCRv5.

## Licences and credits

GLM-OCR is MIT-licensed (Zhipu AI); PP-OCRv5 is Apache-2.0 (PaddlePaddle); Transformers.js and onnxruntime-web are Apache-2.0 / MIT; paddleocr.js is MIT; pdf.js is Apache-2.0.
