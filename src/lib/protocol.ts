/**
 * Shared vocabulary of the OCR engine: engines, modes, pixel budgets, the model assets each engine
 * downloads, and the messages between the page and the inference worker.
 */

/**
 * `glm` = GLM-OCR (0.9B VLM, WebGPU); `paddle6` = PP-OCRv6 small and `paddle` = PP-OCRv5 mobile,
 * detection + recognition on the CPU (WebAssembly, any browser).
 */
export type Engine = 'glm' | 'paddle6' | 'paddle';

/** The PP-OCR engines: `paddle` is the older, faster one, kept for the speed. */
export type PaddleEngineId = Exclude<Engine, 'glm'>;

export function isPaddle(engine: Engine): engine is PaddleEngineId {
  return engine !== 'glm';
}

/** GLM-OCR answers exactly three prompts; PP-OCRv5 always returns plain text lines. */
export type Mode = 'text' | 'table' | 'formula';

export const MODES: Mode[] = ['text', 'table', 'formula'];

export interface ModeSpec {
  label: string;
  hint: string;
  prompt: string;
  /** Hard cap on generated tokens; a dense page is roughly 1.5–3k tokens. */
  maxNewTokens: number;
  /** File extension for downloads of raw GLM output in this mode. */
  extension: string;
}

export const MODE_SPEC: Record<Mode, ModeSpec> = {
  text: {
    label: 'Document → Markdown',
    hint: 'Headings, paragraphs, lists, inline formulas. The default for pages and screenshots.',
    prompt: 'Text Recognition:',
    maxNewTokens: 4096,
    extension: 'md',
  },
  table: {
    label: 'Table → HTML',
    hint: 'Best when the image is a single table; the output is an HTML <table>.',
    prompt: 'Table Recognition:',
    maxNewTokens: 4096,
    extension: 'html',
  },
  formula: {
    label: 'Formula → LaTeX',
    hint: 'Best when the image is one formula (or a few lines of them).',
    prompt: 'Formula Recognition:',
    maxNewTokens: 1024,
    extension: 'tex',
  },
};

/**
 * Pixel budget before the image reaches the model; it bounds vision tokens, GPU memory and latency.
 * The vision encoder attends across the whole page, so its cost grows faster than the pixel count:
 * measured on an M1 Pro, 1.5 → 1.2 MP cut the time to the first token by 29 % with no change in
 * the text read from 8-pt body copy, while 1.0 MP began to misread digits.
 */
export type Detail = 'low' | 'standard' | 'high';

export const DETAILS: Detail[] = ['low', 'standard', 'high'];

export const DETAIL_PIXELS: Record<Detail, number> = {
  low: 750_000,
  standard: 1_200_000,
  high: 2_500_000,
};

export const DETAIL_LABEL: Record<Detail, string> = {
  low: 'Low memory (0.75 MP)',
  standard: 'Standard (1.2 MP)',
  high: 'High detail (2.5 MP)',
};
/** Where model files come from. Both default to huggingface.co; override to serve them yourself. */
export interface AssetHosts {
  /** Transformers.js `env.remoteHost`: `<host>/<model>/resolve/<revision>/<file>` must resolve. */
  glmHost: string;
  /** Host (trailing slash) laid out like huggingface.co, where `PADDLE_MODELS` paths resolve. */
  paddleHost: string;
}

export const GLM_MODEL_ID = 'onnx-community/GLM-OCR-ONNX';

/** The graphs this origin serves in place of upstream's (scripts/patch-glm-graphs.py). */
export const GLM_PATCH_DIR = '/models/glm-ocr/aea46198-7';

/**
 * The three q4f16 sessions of the GLM-OCR export (plus the tokenizer) and the draft model's files,
 * sized for the download bar. The weights' sizes also pin the upstream revision the patched graphs
 * were made for.
 */
export const GLM_FILE_BYTES: Record<string, number> = {
  'onnx/vision_encoder_q4f16.onnx': 474_559,
  'onnx/vision_encoder_q4f16.onnx_data': 262_272_000,
  'onnx/embed_tokens_q4f16.onnx': 1_060,
  'onnx/embed_tokens_q4f16.onnx_data': 52_740_096,
  'onnx/decoder_model_merged_q4f16.onnx': 377_830,
  'onnx/decoder_model_merged_q4f16.onnx_data': 336_844_800,
  'tokenizer.json': 5_420_559,
};

export function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export const GLM_TOTAL_BYTES = sum(Object.values(GLM_FILE_BYTES));

export interface PaddleFile {
  /** Path under the host: `<repo>/resolve/main/<file>`. */
  path: string;
  bytes: number;
}

export interface PaddleModels {
  /** paddleocr.js's preset: detection thresholds and the dictionary layout. */
  preset: 'PP-OCRv5_mobile' | 'PP-OCRv6_small';
  det: PaddleFile;
  rec: PaddleFile;
  dict: PaddleFile;
}

/**
 * The detection and recognition models of each PP-OCR engine. PP-OCRv6 comes as PaddlePaddle's own
 * ONNX exports (its dictionary from the paddleocr.js bundle); PP-OCRv5 mobile from that bundle.
 */
export const PADDLE_MODELS: Record<PaddleEngineId, PaddleModels> = {
  paddle6: {
    preset: 'PP-OCRv6_small',
    det: {path: 'PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/main/inference.onnx', bytes: 9_880_512},
    rec: {path: 'PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx', bytes: 21_159_378},
    dict: {path: 'x3zvawq/paddleocr-js-onnx/resolve/main/ppocr_v6_small/ppocrv6_dict.txt', bytes: 74_947},
  },
  paddle: {
    preset: 'PP-OCRv5_mobile',
    det: {
      path: 'x3zvawq/paddleocr-js-onnx/resolve/main/ppocr_v5_mobile/PP-OCRv5_mobile_det_infer.onnx',
      bytes: 4_819_576,
    },
    rec: {
      path: 'x3zvawq/paddleocr-js-onnx/resolve/main/ppocr_v5_mobile/PP-OCRv5_mobile_rec_infer.onnx',
      bytes: 16_533_929,
    },
    dict: {path: 'x3zvawq/paddleocr-js-onnx/resolve/main/ppocr_v5_mobile/ppocrv5_dict.txt', bytes: 74_013},
  },
};

export function paddleTotalBytes(engine: PaddleEngineId): number {
  const {det, rec, dict} = PADDLE_MODELS[engine];
  return det.bytes + rec.bytes + dict.bytes;
}

/**
 * PP-OCR runs on the CPU and is small (~150 MB of memory per instance), so a batch spreads its
 * pages over several workers, at most this many counting the main one.
 */
export const PADDLE_WORKERS = 8;
const PADDLE_WORKER_GB = 0.15;

/**
 * How many PP-OCR workers this device gets, and the onnxruntime threads each runs with: one
 * four-thread instance per four cores (fewer if memory is short). Four threads is where one
 * instance peaks — on an M1 Pro (8+2 cores) 8 threads is slower than 4 — and a second instance
 * then adds 17 % to a 14-page batch while a third, or eight single-threaded ones, add nothing:
 * the parallel sections wait for whatever lands on the slower cores. Pages take longer each while
 * sharing, so a lone page always has the main instance to itself.
 */
export function paddleWorkers(): {workers: number; threads: number} {
  const cores = Math.max(1, navigator.hardwareConcurrency || 1);
  const threads = Math.min(4, Math.ceil(cores / 2));
  const memoryGb = (navigator as Navigator & {deviceMemory?: number}).deviceMemory ?? 4;
  const byMemory = Math.floor(memoryGb / 4 / PADDLE_WORKER_GB); // a quarter of memory for the pool
  const workers = Math.max(1, Math.min(PADDLE_WORKERS, Math.floor(cores / 4), byMemory));
  return {workers, threads};
}

/** The engines as offered, best first. */
export const ENGINES: Engine[] = ['glm', 'paddle6', 'paddle'];

export const ENGINE_LABEL: Record<Engine, string> = {
  glm: 'GLM-OCR',
  paddle6: 'PP-OCRv6',
  paddle: 'PP-OCRv5',
};

// ---- worker messages --------------------------------------------------------------------------

/** RGBA pixels; the buffer is transferred, never copied. */
export interface PixelImage {
  width: number;
  height: number;
  data: ArrayBuffer;
}

/** An axis-aligned rectangle in the pixels of the image the model saw (`PixelImage` space). */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One recognised text segment from PP-OCRv5 (a detected box and what it reads). Segments on one
 * visual line share a `line`, the 0-based index into `text.split('\n')` of the page's output, so
 * text and scan can point at each other. GLM-OCR produces no segments.
 */
export interface OcrSegment {
  line: number;
  text: string;
  /** Recognition confidence, 0–1. */
  confidence: number;
  box: PixelBox;
}

export type WorkerRequest =
  /** `threads` sets onnxruntime's thread count for this worker; it must come before anything loads. */
  | {kind: 'load'; engine: Engine; hosts: AssetHosts; threads?: number}
  | {kind: 'run'; id: number; engine: Engine; mode: Mode; pixelBudget: number; image: PixelImage}
  | {kind: 'cancel'; id: number}
  | {kind: 'dispose'};

export type WorkerResponse =
  | {kind: 'load-progress'; engine: Engine; loaded: number; total: number; file: string}
  | {kind: 'load-done'; engine: Engine; loadMs: number}
  | {kind: 'load-error'; engine: Engine; message: string}
  | {kind: 'token'; id: number; text: string}
  | {kind: 'stage'; id: number; message: string}
  | {kind: 'done'; id: number; text: string; ms: number; tokens: number; segments: OcrSegment[] | null}
  | {kind: 'error'; id: number; message: string}
  | {kind: 'cancelled'; id: number};
