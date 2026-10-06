/**
 * GLM-OCR (zai-org/GLM-OCR, 0.9B) through Transformers.js on WebGPU: the q4f16 export of
 * onnx-community/GLM-OCR-ONNX (vision encoder + embeddings + merged decoder, ~650 MB once, then
 * served from the browser cache). One instance per worker; generation streams words out and can be
 * interrupted between decoder steps.
 */
import {
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Processor,
  AutoModelForImageTextToText,
  AutoProcessor,
  env,
  InterruptableStoppingCriteria,
  ModelRegistry,
  RawImage,
  Tensor,
  TextStreamer,
} from '@huggingface/transformers';

import {
  type AssetHosts,
  type Mode,
  type PixelImage,
  GLM_FILE_BYTES,
  GLM_MODEL_ID,
  GLM_PATCH_DIR,
  GLM_TOTAL_BYTES,
  MODE_SPEC,
  sum,
} from '../protocol';
import {trimMargins} from '../trim';
import {decodeGreedy} from './decode';

export interface LoadProgress {
  loaded: number;
  total: number;
  file: string;
}

interface ProgressEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

/** Transformers.js resolves `<fileName><suffix>.onnx`; its config only maps the fp32/fp16 names. */
const EXTERNAL_DATA: Record<string, number> = {
  'vision_encoder_q4f16.onnx': 1,
  'embed_tokens_q4f16.onnx': 1,
  'decoder_model_merged_q4f16.onnx': 1,
};

/**
 * Two of the graphs come from this origin instead of the Hub (scripts/patch-glm-graphs.py): the
 * vision graph with the attention mask removed (all zeros for a single image), and the decoder
 * graph with its final hidden state exposed for the draft model. Only the graphs are swapped — the
 * weights they reference still come from the Hub — so they are tied to one upstream revision;
 * `load` keeps upstream's graphs, and plain decoding, when the weights are no longer the size they
 * were patched against.
 */
const PATCHED_GRAPHS: Record<string, string> = {
  '/onnx/vision_encoder_q4f16.onnx': `${GLM_PATCH_DIR}/vision_encoder_q4f16.onnx`,
  '/onnx/decoder_model_merged_q4f16.onnx': `${GLM_PATCH_DIR}/decoder_model_merged_q4f16.onnx`,
};
const WEIGHTS = ['onnx/vision_encoder_q4f16.onnx_data', 'onnx/decoder_model_merged_q4f16.onnx_data'];

/**
 * Routes Transformers.js's requests for the patched graphs to the copies on this origin — the
 * fetch and the browser-cache key alike, so a graph cached under the upstream URL on an earlier
 * visit is not reused and a new patch (new directory) is picked up. Everything else passes through.
 */
async function serveGraphs(patched: boolean): Promise<void> {
  const route = (url: string) => {
    const suffix = patched ? Object.keys(PATCHED_GRAPHS).find(key => url.endsWith(key)) : undefined;
    return suffix === undefined ? url : new URL(PATCHED_GRAPHS[suffix], self.location.origin).href;
  };
  env.fetch = (input, init) => fetch(route(String(input)), init);
  const cache = typeof caches === 'undefined' ? null : await caches.open(env.cacheKey).catch(() => null);
  env.useCustomCache = cache !== null;
  env.customCache =
    cache === null
      ? null
      : {
          match: key => cache.match(route(key)),
          put: (key, response) => cache.put(route(key), response),
        };
}

/** The vision processor counts each pixel twice (temporal patch size 2) against `max_pixels`. */
const TEMPORAL_PATCH_SIZE = 2;

/** Removes the empty reasoning block the chat template reserves; GLM-OCR never fills it. */
const THINK_PREFIX = /^\s*<think>\s*<\/think>\s*/;

/**
 * The warm-up page: 448 px (a multiple of the 28-px patch grid) gives 1024 patches, enough rows to
 * reach the prefill kernels (tiled MatMulNBits, flash attention over the whole image) that a tiny
 * image never compiles. Three tokens, with EOS suppressed, add two decode steps so the per-token
 * kernels (single-row GEMV, GQA with a KV cache) are compiled now as well.
 */
const WARMUP_SIDE = 448;
const WARMUP_TOKENS = 3;

/**
 * Cap on generated tokens as a function of the image: `OUTPUT_PER_VISION_TOKEN` per 28-px patch
 * plus `OUTPUT_BASE`, within the mode's own limit. Dense body text runs about 0.5 output tokens per
 * vision token and an HTML table about 2, so a small crop cannot run on for thousands of tokens.
 */
const OUTPUT_PER_VISION_TOKEN = 2.5;
const OUTPUT_BASE = 256;
const MERGE_SIZE = 2;

/**
 * A generation that has started repeating itself: a block of at most `LOOP_MAX_PERIOD` tokens
 * repeated back to back over at least `LOOP_SPAN` tokens. Legitimate repetition (empty table cells,
 * dotted leaders) stays far below that span; a model stuck in a cycle would otherwise run to the cap.
 */
const LOOP_MAX_PERIOD = 64;
const LOOP_SPAN = 200;

/** Index into `ids` where the repetition's second copy begins, or -1 when nothing repeats. */
function loopStart(ids: number[]): number {
  const n = ids.length;
  for (let period = 1; period <= LOOP_MAX_PERIOD; period++) {
    const span = period * Math.max(3, Math.ceil(LOOP_SPAN / period));
    if (span > n) continue;
    let same = true;
    for (let i = n - span; i < n - period; i++) {
      if (ids[i] !== ids[i + period]) {
        same = false;
        break;
      }
    }
    if (same) return n - span + period;
  }
  return -1;
}

export class GlmEngine {
  private constructor(
    private readonly processor: Processor,
    private readonly tokenizer: PreTrainedTokenizer,
    private readonly model: PreTrainedModel,
    /** The patched decoder graph is in use: it emits the next token, which the pipelined loop needs. */
    private readonly pipelined: boolean,
  ) {}

  static async load(hosts: AssetHosts, onProgress: (progress: LoadProgress) => void): Promise<GlmEngine> {
    env.allowLocalModels = false;
    env.remoteHost = hosts.glmHost;

    const loadedByFile = new Map<string, number>();
    const progress_callback = (event: ProgressEvent) => {
      if (event.file === undefined) return;
      if (event.status === 'progress' && event.loaded !== undefined) {
        loadedByFile.set(event.file, event.loaded);
      } else if (event.status === 'done') {
        loadedByFile.set(event.file, GLM_FILE_BYTES[event.file] ?? event.total ?? 0);
      } else {
        return;
      }
      const loaded = sum(loadedByFile.values());
      onProgress({loaded: Math.min(loaded, GLM_TOTAL_BYTES), total: GLM_TOTAL_BYTES, file: event.file});
    };

    // A mirror that ignores Range requests reports no size; it is deployed with the app, so trust it.
    const sizes = await Promise.all(WEIGHTS.map(file => ModelRegistry.get_file_metadata(GLM_MODEL_ID, file)));
    const patched = sizes.every(({size}, i) => size === undefined || size === GLM_FILE_BYTES[WEIGHTS[i]]);
    if (!patched) console.warn('GLM-OCR: the weights on the Hub changed; using the upstream graphs and plain decoding');
    await serveGraphs(patched);

    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(GLM_MODEL_ID, {progress_callback}),
      AutoModelForImageTextToText.from_pretrained(GLM_MODEL_ID, {
        device: 'webgpu',
        dtype: 'q4f16',
        use_external_data_format: EXTERNAL_DATA,
        progress_callback,
      }),
    ]);
    if (processor.tokenizer === undefined) throw new Error('the GLM-OCR processor has no tokenizer');
    const engine = new GlmEngine(processor, processor.tokenizer, model, patched);
    // Compiles the WebGPU shaders now, so the first real page does not pay for it.
    await engine.recognize(
      {width: WARMUP_SIDE, height: WARMUP_SIDE, data: new ArrayBuffer(WARMUP_SIDE * WARMUP_SIDE * 4)},
      'text',
      WARMUP_SIDE * WARMUP_SIDE,
      () => undefined,
      () => false,
      WARMUP_TOKENS,
      WARMUP_TOKENS,
    );
    return engine;
  }

  /**
   * Runs one image through the model. `onToken` receives decoded text as words complete; `isCancelled`
   * is polled after every generated token. Resolves with the full text (partial when cancelled, cut at
   * the first repeat when the model fell into a loop). `minNewTokens` keeps EOS out of the first
   * tokens (the warm-up needs real decode steps).
   */
  async recognize(
    image: PixelImage,
    mode: Mode,
    pixelBudget: number,
    onToken: (text: string) => void,
    isCancelled: () => boolean,
    maxNewTokens = MODE_SPEC[mode].maxNewTokens,
    minNewTokens = 0,
  ): Promise<{text: string; tokens: number}> {
    const prompt = this.processor.apply_chat_template(
      [{role: 'user', content: [{type: 'image'}, {type: 'text', text: MODE_SPEC[mode].prompt}]}],
      {add_generation_prompt: true},
    );
    if (typeof prompt !== 'string') throw new Error('expected the chat template to render text');

    // Final say on the pixel budget: the page already downscaled, the processor rounds to the
    // 28-px patch grid and shrinks anything still above budget. Qwen2VLImageProcessor assigns
    // `max_pixels` in its constructor; the published types omit it.
    const imageProcessor = this.processor.image_processor as unknown as {max_pixels: number};
    imageProcessor.max_pixels = pixelBudget * TEMPORAL_PATCH_SIZE;

    const trimmed = trimMargins(image);
    const raw = new RawImage(new Uint8ClampedArray(trimmed.data), trimmed.width, trimmed.height, 4);
    const inputs: Record<string, Tensor> & {input_ids: Tensor; image_grid_thw: Tensor} = await this.processor(
      prompt,
      raw,
    );
    const [t, h, w] = inputs.image_grid_thw.data as BigInt64Array;
    const visionTokens = Number(t * h * w) / (MERGE_SIZE * MERGE_SIZE);
    const cap = Math.min(maxNewTokens, Math.round(OUTPUT_BASE + OUTPUT_PER_VISION_TOKEN * visionTokens));

    if (this.pipelined) {
      const eos = this.model._prepare_generation_config(null, {}).eos_token_id;
      const {ids} = await decodeGreedy({
        model: this.model,
        tokenizer: this.tokenizer,
        inputs,
        eosIds: Array.isArray(eos) ? eos : [eos],
        maxNewTokens: cap,
        minNewTokens,
        onToken,
        stopAt: soFar => (isCancelled() ? soFar.length : loopStart(soFar) === -1 ? null : loopStart(soFar)),
      });
      const text = this.tokenizer.decode(ids, {skip_special_tokens: true});
      return {text: text.replace(THINK_PREFIX, '').trim(), tokens: ids.length};
    }

    const stopper = new InterruptableStoppingCriteria();
    let tokens = 0;
    const generated: number[] = [];
    let loop = -1;
    const streamer = new TextStreamer(this.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => onToken(text),
      token_callback_function: (ids: bigint[]) => {
        tokens++;
        for (const id of ids) generated.push(Number(id));
        loop = loopStart(generated);
        if (loop !== -1 || isCancelled()) stopper.interrupt();
      },
    });

    const outputs = await this.model.generate({
      ...inputs,
      max_new_tokens: cap,
      min_new_tokens: minNewTokens,
      do_sample: false,
      streamer,
      stopping_criteria: stopper,
    });
    if (!(outputs instanceof Tensor)) throw new Error('expected generate() to return token ids');
    const promptLength = inputs.input_ids.dims[inputs.input_ids.dims.length - 1];
    const end = loop === -1 ? outputs.dims[1] : promptLength + loop;
    const [decoded] = this.processor.batch_decode(outputs.slice(null, [promptLength, end]), {
      skip_special_tokens: true,
    });
    return {text: decoded.replace(THINK_PREFIX, '').trim(), tokens};
  }

  async dispose(): Promise<void> {
    await this.model.dispose();
  }
}
