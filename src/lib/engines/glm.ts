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
  GLM_TOTAL_BYTES,
  MODE_SPEC,
  sum,
} from '../protocol';

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

/** The vision processor counts each pixel twice (temporal patch size 2) against `max_pixels`. */
const TEMPORAL_PATCH_SIZE = 2;

/** Removes the empty reasoning block the chat template reserves; GLM-OCR never fills it. */
const THINK_PREFIX = /^\s*<think>\s*<\/think>\s*/;

export class GlmEngine {
  private constructor(
    private readonly processor: Processor,
    private readonly tokenizer: PreTrainedTokenizer,
    private readonly model: PreTrainedModel,
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
    const engine = new GlmEngine(processor, processor.tokenizer, model);
    // Compiles the WebGPU shaders now, so the first real page does not pay for it.
    await engine.recognize(
      {width: 56, height: 56, data: new ArrayBuffer(56 * 56 * 4)},
      'text',
      56 * 56,
      () => undefined,
      () => false,
      1,
    );
    return engine;
  }

  /**
   * Runs one image through the model. `onToken` receives decoded text as words complete; `isCancelled`
   * is polled after every generated token. Resolves with the full text (partial when cancelled).
   */
  async recognize(
    image: PixelImage,
    mode: Mode,
    pixelBudget: number,
    onToken: (text: string) => void,
    isCancelled: () => boolean,
    maxNewTokens = MODE_SPEC[mode].maxNewTokens,
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

    const raw = new RawImage(new Uint8ClampedArray(image.data), image.width, image.height, 4);
    const inputs: {input_ids: Tensor} = await this.processor(prompt, raw);

    const stopper = new InterruptableStoppingCriteria();
    let tokens = 0;
    const streamer = new TextStreamer(this.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => onToken(text),
      token_callback_function: () => {
        tokens++;
        if (isCancelled()) stopper.interrupt();
      },
    });

    const outputs = await this.model.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      do_sample: false,
      streamer,
      stopping_criteria: stopper,
    });
    if (!(outputs instanceof Tensor)) throw new Error('expected generate() to return token ids');
    const promptLength = inputs.input_ids.dims[inputs.input_ids.dims.length - 1];
    const [decoded] = this.processor.batch_decode(outputs.slice(null, [promptLength, outputs.dims[1]]), {
      skip_special_tokens: true,
    });
    return {text: decoded.replace(THINK_PREFIX, '').trim(), tokens};
  }

  async dispose(): Promise<void> {
    await this.model.dispose();
  }
}
