/**
 * Inference worker: owns the engines (loaded on demand, once per tab) and runs every OCR request
 * off the UI thread, one at a time. Tokens stream back as they are decoded; a cancel flips a flag
 * the running job polls. Nothing here touches the network except for model downloads.
 */
import {env} from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';

import {GlmEngine} from './engines/glm';
import {PaddleEngine} from './engines/paddle';
import type {AssetHosts, Engine, WorkerRequest, WorkerResponse} from './protocol';

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
const paddle: Slot<PaddleEngine> = {engine: null, pending: null};

/** One request at a time: the WebAssembly/WebGPU runtime does not run sessions concurrently. */
let chain: Promise<void> = Promise.resolve();
let runtimeConfigured = false;
/** Ids of queued or running jobs; a cancel for anything else is a no-op. */
const active = new Set<number>();
const cancelled = new Set<number>();

/** Errors after which the GPU session is unusable; the next request rebuilds the engine. */
const FATAL = /device lost|out of memory|OOM|destroyed|webgpu/i;

function configureRuntime(): void {
  if (runtimeConfigured) return;
  runtimeConfigured = true;
  // Both engines share this onnxruntime-web instance (Transformers.js imports the same module), so
  // one path setting serves both; it points at public/ocr-runtime/ort/<version>/ (synced from
  // node_modules at build time) instead of the jsDelivr default.
  const base = `${self.location.origin}/ocr-runtime/ort/${ort.env.versions.web}/`;
  const wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded.asyncify.mjs`,
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

async function load(engine: Engine, hosts: AssetHosts): Promise<void> {
  configureRuntime();
  const onProgress = (p: {loaded: number; total: number; file: string}) =>
    scope.postMessage({kind: 'load-progress', engine, loaded: p.loaded, total: p.total, file: p.file});
  try {
    if (engine === 'glm') await loadSlot(glm, engine, () => GlmEngine.load(hosts, onProgress));
    else await loadSlot(paddle, engine, () => PaddleEngine.load(hosts, onProgress));
  } catch (error) {
    scope.postMessage({kind: 'load-error', engine, message: error instanceof Error ? error.message : String(error)});
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
    if (engine === 'glm') {
      if (glm.engine === null) throw new Error('GLM-OCR is not loaded');
      ({text, tokens} = await glm.engine.recognize(
        image,
        mode,
        pixelBudget,
        chunk => scope.postMessage({kind: 'token', id, text: chunk}),
        () => cancelled.has(id),
      ));
    } else {
      if (paddle.engine === null) throw new Error('PP-OCRv5 is not loaded');
      const result = await paddle.engine.recognize(image, message => scope.postMessage({kind: 'stage', id, message}));
      text = result.text;
      tokens = result.lines;
    }
    if (cancelled.has(id)) scope.postMessage({kind: 'cancelled', id});
    else scope.postMessage({kind: 'done', id, text, ms: performance.now() - t0, tokens});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (engine === 'glm' && FATAL.test(message)) {
      const broken = glm.engine;
      glm.engine = null;
      await broken?.dispose().catch(() => undefined);
    }
    scope.postMessage({kind: 'error', id, message});
  } finally {
    cancelled.delete(id);
    active.delete(id);
  }
}

async function dispose(): Promise<void> {
  const engines = [glm.engine, paddle.engine];
  glm.engine = null;
  paddle.engine = null;
  await Promise.all(engines.map(engine => engine?.dispose().catch(() => undefined)));
}

scope.onmessage = event => {
  const request = event.data;
  switch (request.kind) {
    case 'load':
      chain = chain.then(() => load(request.engine, request.hosts));
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
