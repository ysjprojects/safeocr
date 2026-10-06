/**
 * Inference worker: owns the engines (loaded on demand, once per tab) and runs every OCR request
 * off the UI thread, one at a time. Tokens stream back as they are decoded; a cancel flips a flag
 * the running job polls. Nothing here touches the network except for model downloads. The client
 * runs several of these for PP-OCR batches (the extra ones load that engine only).
 */
import {env} from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';

import {GlmEngine} from './engines/glm';
import {PaddleEngine} from './engines/paddle';
import {webgpuLoaderUrl} from './ortLoader';
import {
  type AssetHosts,
  type Engine,
  type OcrSegment,
  type PaddleEngineId,
  type WorkerRequest,
  type WorkerResponse,
  ENGINE_LABEL,
} from './protocol';

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

interface Slot<E> {
  engine: E | null;
  pending: Promise<E> | null;
}

const glm: Slot<GlmEngine> = {engine: null, pending: null};
const paddles: Record<PaddleEngineId, Slot<PaddleEngine>> = {
  paddle6: {engine: null, pending: null},
  paddle: {engine: null, pending: null},
};

/** One request at a time: the WebAssembly/WebGPU runtime does not run sessions concurrently. */
let chain: Promise<void> = Promise.resolve();
let runtimeConfigured = false;
/** Ids of queued or running jobs; a cancel for anything else is a no-op. */
const active = new Set<number>();
const cancelled = new Set<number>();

/** Errors after which the GPU session is unusable; the next request rebuilds the engine. */
const FATAL = /device lost|out of memory|OOM|destroyed|webgpu/i;

function configureRuntime(threads: number | undefined): void {
  if (runtimeConfigured) return;
  runtimeConfigured = true;
  // onnxruntime's thread pool is sized once, when its WebAssembly module initialises.
  if (threads !== undefined) ort.env.wasm.numThreads = threads;
  // Both engines share this onnxruntime-web instance (Transformers.js imports the same module), so
  // one path setting serves both; it points at public/ocr-runtime/ort/<version>/ (synced from
  // node_modules at build time) instead of the jsDelivr default. The loader goes through
  // webgpuLoaderUrl, which sets the WebGPU provider options the API cannot.
  const base = `${self.location.origin}/ocr-runtime/ort/${ort.env.versions.web}/`;
  const wasmPaths = {
    mjs: webgpuLoaderUrl(`${base}ort-wasm-simd-threaded.asyncify.mjs`),
    wasm: `${base}ort-wasm-simd-threaded.asyncify.wasm`,
  };
  ort.env.wasm.wasmPaths = wasmPaths;
  if (env.backends.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = wasmPaths;
}

function loadSlot<E>(slot: Slot<E>, engine: Engine, start: () => Promise<E>): Promise<E> {
  if (slot.engine !== null) return Promise.resolve(slot.engine);
  if (slot.pending === null) {
    const t0 = performance.now();
    slot.pending = start()
      .then(loaded => {
        slot.engine = loaded;
        scope.postMessage({kind: 'load-done', engine, loadMs: performance.now() - t0});
        return loaded;
      })
      .finally(() => {
        slot.pending = null;
      });
  }
  return slot.pending;
}

/** Why the last load of an engine failed, for the runs that then find it missing. */
const loadErrors: Record<Engine, string | null> = {glm: null, paddle6: null, paddle: null};

async function load(engine: Engine, hosts: AssetHosts, threads: number | undefined): Promise<void> {
  configureRuntime(threads);
  const onProgress = (p: {loaded: number; total: number; file: string}) =>
    scope.postMessage({kind: 'load-progress', engine, loaded: p.loaded, total: p.total, file: p.file});
  try {
    if (engine === 'glm') await loadSlot(glm, engine, () => GlmEngine.load(hosts, onProgress));
    else await loadSlot(paddles[engine], engine, () => PaddleEngine.load(hosts, engine, onProgress));
    loadErrors[engine] = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loadErrors[engine] = message;
    scope.postMessage({kind: 'load-error', engine, message});
  }
}

async function run(request: Extract<WorkerRequest, {kind: 'run'}>): Promise<void> {
  const {id, engine, mode, pixelBudget, image} = request;
  const t0 = performance.now();
  try {
    if (cancelled.has(id)) {
      scope.postMessage({kind: 'cancelled', id});
      return;
    }
    let text: string;
    let tokens: number;
    let segments: OcrSegment[] | null = null;
    if (engine === 'glm') {
      if (glm.engine === null) throw new Error(loadErrors.glm ?? 'GLM-OCR is not loaded');
      ({text, tokens} = await glm.engine.recognize(
        image,
        mode,
        pixelBudget,
        chunk => scope.postMessage({kind: 'token', id, text: chunk}),
        () => cancelled.has(id),
      ));
    } else {
      const paddle = paddles[engine].engine;
      if (paddle === null) throw new Error(loadErrors[engine] ?? `${ENGINE_LABEL[engine]} is not loaded`);
      const result = await paddle.recognize(image, message => scope.postMessage({kind: 'stage', id, message}));
      text = result.text;
      tokens = result.lines;
      segments = result.segments;
    }
    if (cancelled.has(id)) scope.postMessage({kind: 'cancelled', id});
    else scope.postMessage({kind: 'done', id, text, ms: performance.now() - t0, tokens, segments});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (engine === 'glm' && FATAL.test(message)) {
      // The page keeps the engine marked ready otherwise, and every later run would fail.
      const broken = glm.engine;
      glm.engine = null;
      scope.postMessage({kind: 'load-error', engine, message});
      await broken?.dispose().catch(() => undefined);
    }
    scope.postMessage({kind: 'error', id, message});
  } finally {
    cancelled.delete(id);
    active.delete(id);
  }
}

async function dispose(): Promise<void> {
  const engines = [glm.engine, ...Object.values(paddles).map(slot => slot.engine)];
  glm.engine = null;
  for (const slot of Object.values(paddles)) slot.engine = null;
  await Promise.all(engines.map(engine => engine?.dispose().catch(() => undefined)));
}

scope.onmessage = event => {
  const request = event.data;
  switch (request.kind) {
    case 'load':
      chain = chain.then(() => load(request.engine, request.hosts, request.threads));
      break;
    case 'run':
      active.add(request.id);
      chain = chain.then(() => run(request));
      break;
    case 'cancel':
      // Takes effect immediately for a queued job and at the next decoded token for a running one.
      if (active.has(request.id)) cancelled.add(request.id);
      break;
    case 'dispose':
      chain = chain.then(dispose);
      break;
  }
};
