/**
 * Main-thread handle on the inference worker. One worker per tab (it holds the models, which must
 * survive React remounts); engines load on demand and their status is observable; runs resolve
 * with the recognised text while streaming partial text to the caller.
 */
import {resolveAssetHosts} from './assets';
import type {Engine, Mode, OcrSegment, PixelImage, WorkerRequest, WorkerResponse} from './protocol';

export interface EngineStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  loaded: number;
  total: number;
  file: string | null;
  loadMs: number | null;
  message: string | null;
}

export type RunOutcome =
  | {kind: 'done'; text: string; ms: number; tokens: number; segments: OcrSegment[] | null}
  | {kind: 'cancelled'}
  | {kind: 'error'; message: string};

export interface RunHandlers {
  /** A decoded chunk of text (GLM-OCR streams words; PP-OCRv5 delivers everything at the end). */
  onToken?(text: string): void;
  /** Human-readable progress ("reading line 4 of 12"). */
  onStage?(message: string): void;
}

interface Pending {
  resolve(outcome: RunOutcome): void;
  handlers: RunHandlers;
}

type Listener = (status: Record<Engine, EngineStatus>) => void;

const IDLE: EngineStatus = {state: 'idle', loaded: 0, total: 0, file: null, loadMs: null, message: null};

export class OcrClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private status: Record<Engine, EngineStatus> = {glm: IDLE, paddle: IDLE};
  private listeners = new Set<Listener>();
  private loadWaiters: Record<Engine, {resolve(): void; reject(error: Error): void}[]> = {glm: [], paddle: []};

  getStatus(): Record<Engine, EngineStatus> {
    return this.status;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Loads an engine (no-op when ready); resolves once it can take requests. */
  load(engine: Engine): Promise<void> {
    const current = this.status[engine];
    if (current.state === 'ready') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.loadWaiters[engine].push({resolve, reject});
      if (current.state === 'loading') return;
      this.update(engine, {...IDLE, state: 'loading'});
      this.post({kind: 'load', engine, hosts: resolveAssetHosts()});
    });
  }

  /** Queues one image. The pixel buffer is transferred to the worker. */
  run(
    engine: Engine,
    mode: Mode,
    pixelBudget: number,
    image: PixelImage,
    handlers: RunHandlers = {},
  ): {
    id: number;
    outcome: Promise<RunOutcome>;
  } {
    const id = this.nextId++;
    const outcome = new Promise<RunOutcome>(resolve => {
      this.pending.set(id, {handlers, resolve});
      this.post({kind: 'run', id, engine, mode, pixelBudget, image}, [image.data]);
    });
    return {id, outcome};
  }

  cancel(id: number): void {
    if (!this.pending.has(id)) return;
    this.post({kind: 'cancel', id});
  }

  /** Frees the models and the worker; the next call starts fresh. */
  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve({kind: 'cancelled'});
    }
    this.status = {glm: IDLE, paddle: IDLE};
    this.emit();
    if (worker === null) return;
    worker.postMessage({kind: 'dispose'} satisfies WorkerRequest);
    // Give the engines a moment to release GPU buffers before the worker goes away for good.
    window.setTimeout(() => worker.terminate(), 1500);
  }

  private post(request: WorkerRequest, transfer: Transferable[] = []): void {
    this.spawn().postMessage(request, transfer);
  }

  private spawn(): Worker {
    if (this.worker !== null) return this.worker;
    // Named so the chunk is recognisable in the network panel and stable across builds.
    const worker = new Worker(new URL(/* webpackChunkName: "ocr-worker" */ './worker.ts', import.meta.url));
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data);
    worker.onerror = event => {
      // A script that could not be fetched (offline, stale deploy) reports no message at all.
      const message = `the OCR worker crashed: ${event.message || 'its script could not be loaded'}`;
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.resolve({kind: 'error', message});
      }
      for (const engine of ['glm', 'paddle'] as const) {
        this.update(engine, {...IDLE, state: 'error', message});
        this.settleLoad(engine, new Error(message));
      }
      worker.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private onMessage(message: WorkerResponse): void {
    switch (message.kind) {
      case 'load-progress':
        this.update(message.engine, {
          ...this.status[message.engine],
          state: 'loading',
          loaded: message.loaded,
          total: message.total,
          file: message.file,
        });
        return;
      case 'load-done':
        this.update(message.engine, {
          ...this.status[message.engine],
          state: 'ready',
          loadMs: message.loadMs,
          file: null,
        });
        this.settleLoad(message.engine, null);
        return;
      case 'load-error':
        this.update(message.engine, {...IDLE, state: 'error', message: message.message});
        this.settleLoad(message.engine, new Error(message.message));
        return;
    }
    const p = this.pending.get(message.id);
    if (p === undefined) return;
    switch (message.kind) {
      case 'token':
        p.handlers.onToken?.(message.text);
        return;
      case 'stage':
        p.handlers.onStage?.(message.message);
        return;
      case 'done':
        this.pending.delete(message.id);
        p.resolve({
          kind: 'done',
          text: message.text,
          ms: message.ms,
          tokens: message.tokens,
          segments: message.segments,
        });
        return;
      case 'error':
        this.pending.delete(message.id);
        p.resolve({kind: 'error', message: message.message});
        return;
      case 'cancelled':
        this.pending.delete(message.id);
        p.resolve({kind: 'cancelled'});
        return;
    }
  }

  private settleLoad(engine: Engine, error: Error | null): void {
    const waiters = this.loadWaiters[engine];
    this.loadWaiters[engine] = [];
    for (const w of waiters) error === null ? w.resolve() : w.reject(error);
  }

  private update(engine: Engine, status: EngineStatus): void {
    this.status = {...this.status, [engine]: status};
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.status);
  }
}

let singleton: OcrClient | null = null;

/** One client per page: the worker holds up to ~2 GB of model and must survive React remounts. */
export function getOcrClient(): OcrClient {
  singleton ??= new OcrClient();
  return singleton;
}
