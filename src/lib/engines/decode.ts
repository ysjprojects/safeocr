/**
 * Greedy decoding for GLM-OCR without a GPU→CPU round trip per token.
 *
 * Transformers.js's generate() reads the logits back to the CPU after every decoder pass to pick the
 * next token; on this stack that readback costs as much as the pass itself. Here the decoder graph
 * (scripts/patch-glm-graphs.py) emits the argmax into a GPU buffer, the embedding gather reads it
 * from there, and the decoder pass that follows reads the embedding from another GPU buffer. Every
 * other input lives on the GPU too, so a step is three command buffers and no copy in either
 * direction; the token is copied back one step late, overlapping the next pass, for streaming and
 * the stop checks. The pass after EOS is wasted, nothing else is.
 *
 * Transformers.js still does the prefill (vision encoding, image-feature merge, M-RoPE positions).
 */
import {type PreTrainedModel, type PreTrainedTokenizer, Tensor, TextStreamer} from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';

const HIDDEN = 1536;
const LAYERS = 16;

/** The Transformers.js internals the loop drives (public in JS, absent from the published types). */
interface ModelInternals {
  _prepare_generation_config(config: null, kwargs: Record<string, unknown>): unknown;
  prepare_inputs_for_generation(
    input_ids: null,
    model_inputs: Record<string, unknown>,
    generation_config: unknown,
  ): Record<string, unknown> & {rope_deltas: Tensor};
  forward(model_inputs: Record<string, unknown>): Promise<Record<string, Tensor>>;
  sessions: Record<string, ort.InferenceSession>;
}

export interface DecodeOptions {
  onToken(text: string): void;
  /** Polled after every token with the ids so far; a non-null index cuts the text there and stops. */
  stopAt(ids: number[]): number | null;
  model: PreTrainedModel;
  tokenizer: PreTrainedTokenizer;
  /** The processor's output for the prompt and image. */
  inputs: Record<string, Tensor>;
  eosIds: number[];
  maxNewTokens: number;
  /** EOS is not accepted before this many tokens (the warm-up needs real decode steps). */
  minNewTokens: number;
}

export interface DecodeResult {
  /** Generated token ids, without EOS, cut where `stopAt` said. */
  ids: number[];
  /** Tokens generated, cut or not. */
  generated: number;
}

const PRESENT = Array.from({length: LAYERS}, (_, i) => [`present.${i}.key`, `present.${i}.value`]).flat();

/** A GPU buffer ORT can read and write, viewed as tensors, plus a way to copy it back. */
class GpuBuffer {
  readonly buffer: GPUBuffer;

  constructor(private readonly device: GPUDevice, bytes: number) {
    this.buffer = device.createBuffer({
      size: Math.ceil(bytes / 16) * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  }

  /** A tensor over the start of the buffer; `dims` may cover less than the whole buffer. */
  tensor(dataType: 'int64' | 'float32', dims: number[]): ort.Tensor {
    return ort.Tensor.fromGpuBuffer(this.buffer, {dataType, dims});
  }

  /** Queue-ordered: lands before any command buffer submitted afterwards. */
  write(data: BigInt64Array): void {
    this.device.queue.writeBuffer(this.buffer, 0, data);
  }

  /** Copies the first 8 bytes back through a staging buffer; resolves once the GPU has passed this point. */
  async readInt64(): Promise<bigint> {
    const staging = this.device.createBuffer({size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.buffer, 0, staging, 0, 8);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const value = new BigInt64Array(staging.getMappedRange().slice(0, 8))[0];
    staging.unmap();
    staging.destroy();
    return value;
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

/** The decoder's position ids, [3, 1, 1]: every M-RoPE axis at `position` for a text token. */
const position = (value: bigint) => BigInt64Array.from([value, value, value]);

export async function decodeGreedy(options: DecodeOptions): Promise<DecodeResult> {
  const {eosIds, maxNewTokens, minNewTokens, onToken, stopAt} = options;
  const model = options.model as unknown as ModelInternals;
  const decoder = model.sessions.decoder_model_merged;
  const embed = model.sessions.embed_tokens;
  const device = await ort.env.webgpu.device;
  const streamer = new TextStreamer(options.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: onToken,
  });
  streamer.put([[]]); // the prompt, which the streamer skips

  // Prefill through Transformers.js: vision encoding, image-feature merge, M-RoPE positions, one
  // decoder pass over the prompt. Its outputs seed the loop.
  const generationConfig = model._prepare_generation_config(null, {});
  const modelInputs = model.prepare_inputs_for_generation(null, {...options.inputs}, generationConfig);
  const prefill = await model.forward(modelInputs);
  const promptLength = (options.inputs.input_ids.dims as number[])[1];
  const delta = (modelInputs.rope_deltas.data as BigInt64Array)[0];

  let past: Record<string, ort.Tensor> = Object.fromEntries(
    PRESENT.map(name => [name.replace('present', 'past_key_values'), prefill[name].ort_tensor]),
  );
  let length = promptLength;
  const first = Number((prefill.next_token.data as BigInt64Array)[0]);

  // Two token buffers alternate: one is read by the embedding gather and copied back while the
  // decoder writes the next token into the other. The mask is all ones (one unpadded sequence);
  // the graph only takes its length, so one buffer sized for the longest possible run is viewed
  // one element longer each step. The pass after the last token is submitted before that token is
  // read, hence the slack.
  const tokens = [new GpuBuffer(device, 8), new GpuBuffer(device, 8)];
  const tokenTensors = tokens.map(buffer => buffer.tensor('int64', [1, 1]));
  const embeds = new GpuBuffer(device, HIDDEN * 4);
  const embedsTensor = embeds.tensor('float32', [1, 1, HIDDEN]);
  const positions = new GpuBuffer(device, 3 * 8);
  const positionsTensor = positions.tensor('int64', [3, 1, 1]);
  const capacity = promptLength + maxNewTokens + 2;
  const mask = new GpuBuffer(device, capacity * 8);
  mask.write(new BigInt64Array(capacity).fill(1n));
  tokens[0].write(BigInt64Array.from([BigInt(first)]));

  const ids: number[] = [];
  let cut: number | null = null;
  const emit = (id: number): boolean => {
    if (eosIds.includes(id) && ids.length >= minNewTokens) return false;
    ids.push(id);
    streamer.put([[BigInt(id)]]);
    const stop = stopAt(ids);
    if (stop !== null) {
      cut = stop;
      return false;
    }
    return ids.length < maxNewTokens;
  };

  try {
    let going = emit(first);
    let step = 0;
    let pendingRead: Promise<bigint> | null = null;
    while (going) {
      const current = step % 2;
      const next = (step + 1) % 2;
      positions.write(position(BigInt(length) + delta));
      await embed.run({input_ids: tokenTensors[current]}, {inputs_embeds: embedsTensor});
      const out = await decoder.run(
        {
          inputs_embeds: embedsTensor,
          attention_mask: mask.tensor('int64', [1, length + 1]),
          position_ids: positionsTensor,
          ...past,
        },
        {next_token: tokenTensors[next], ...Object.fromEntries(PRESENT.map(name => [name, null]))},
      );
      for (const tensor of Object.values(past)) tensor.dispose();
      past = Object.fromEntries(
        PRESENT.map(name => [name.replace('present', 'past_key_values'), out[name] as ort.Tensor]),
      );
      length++;
      // The token this pass produced is copied back while the next pass runs; the previous pass's
      // token is what the loop can act on now.
      const read = tokens[next].readInt64();
      if (pendingRead !== null) going = emit(Number(await pendingRead));
      pendingRead = read;
      step++;
    }
    // The pass after the last emitted token has been submitted already; let its copy-back finish
    // before the buffers go.
    if (pendingRead !== null) await pendingRead;
  } finally {
    for (const tensor of Object.values(past)) tensor.dispose();
    for (const buffer of [...tokens, embeds, positions, mask]) buffer.destroy();
  }
  streamer.end();
  return {ids: cut === null ? ids : ids.slice(0, cut), generated: ids.length};
}
