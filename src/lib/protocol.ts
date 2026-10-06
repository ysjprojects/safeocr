/**
 * Shared vocabulary of the OCR engine: engines, modes, pixel budgets, the model assets each engine
 * downloads, and the messages between the page and the inference worker.
 */

/** `glm` = GLM-OCR (0.9B VLM, WebGPU); `paddle` = PP-OCRv5 mobile det+rec (WebAssembly, any browser). */
export type Engine = 'glm' | 'paddle';

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
  /** Directory URL (trailing slash) holding the PP-OCRv5 mobile files listed in `PADDLE_FILES`. */
  paddleBase: string;
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

export const PADDLE_FILES = {
  det: {name: 'PP-OCRv5_mobile_det_infer.onnx', bytes: 4_819_576},
  rec: {name: 'PP-OCRv5_mobile_rec_infer.onnx', bytes: 16_533_929},
  dict: {name: 'ppocrv5_dict.txt', bytes: 74_013},
};

export const PADDLE_TOTAL_BYTES = sum([PADDLE_FILES.det.bytes, PADDLE_FILES.rec.bytes, PADDLE_FILES.dict.bytes]);

export const ENGINE_LABEL: Record<Engine, string> = {
  glm: 'GLM-OCR',
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
  | {kind: 'load'; engine: Engine; hosts: AssetHosts}
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
