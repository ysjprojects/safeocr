/**
 * Main-thread handle on the inference workers. One main worker per tab (it holds the models, which
 * must survive React remounts); engines load on demand and their status is observable; runs
 * resolve with the recognised text while streaming partial text to the caller. PP-OCR runs are
 * spread over extra workers (spawned on demand, up to `paddleWorkers()`), so a batch of pages runs
 * in parallel on the CPU's cores; the main worker's instance takes the first of them.
 */
import {resolveAssetHosts} from './assets';
import {
  type Engine,
  type Mode,
  type OcrSegment,
  type PaddleEngineId,
  type PixelImage,
  type WorkerRequest,
  type WorkerResponse,
  isPaddle,
  paddleWorkers,
} from './protocol';

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
  /** A decoded chunk of text (GLM-OCR streams words; PP-OCR delivers everything at the end). */
  onToken?(text: string): void;
  /** Human-readable progress ("reading line 4 of 12"). */
  onStage?(message: string): void;
}

interface Pending {
  resolve(outcome: RunOutcome): void;
  handlers: RunHandlers;
}

/** A worker and the runs it has in flight. */
interface Lane {
  worker: Worker;
  pending: Map<number, Pending>;
  /** Engines this worker has been told to load (a pool worker loads on its first run). */
  loading: Set<Engine>;
}

type Listener = (status: Record<Engine, EngineStatus>) => void;

const IDLE: EngineStatus = {state: 'idle', loaded: 0, total: 0, file: null, loadMs: null, message: null};

export class OcrClient {
  /** The main worker: every engine, the status the page shows. */
  private main: Lane | null = null;
  /** The PP-OCR-only workers a batch spreads over. */
  private pool: Lane[] = [];
  private readonly sizing = paddleWorkers();
  private nextId = 1;
  private status: Record<Engine, EngineStatus> = {glm: IDLE, paddle6: IDLE, paddle: IDLE};
  private listeners = new Set<Listener>();
  private loadWaiters: Record<Engine, {resolve(): void; reject(error: Error): void}[]> = {
    glm: [],
    paddle6: [],
    paddle: [],
  };

  /** How many PP-OCR runs can go on at once. */
  get paddleLanes(): number {
    return this.sizing.workers;
  }

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
      this.mainLane().loading.add(engine);
      this.post({kind: 'load', engine, hosts: resolveAssetHosts()});
    });
  }

  /**
   * Queues one image. The pixel buffer is transferred to the worker. A PP-OCR run goes to a
   * worker with nothing in flight — the main one first, then the pool, growing it up to the
   * device's share — and otherwise queues on the least busy.
   */
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
    const lane = isPaddle(engine) ? this.paddleLane(engine) : this.mainLane();
    const outcome = new Promise<RunOutcome>(resolve => {
      lane.pending.set(id, {handlers, resolve});
      lane.worker.postMessage({kind: 'run', id, engine, mode, pixelBudget, image} satisfies WorkerRequest, [
        image.data,
      ]);
    });
    return {id, outcome};
  }

  cancel(id: number): void {
    for (const lane of this.lanes()) {
      if (lane.pending.has(id)) lane.worker.postMessage({kind: 'cancel', id} satisfies WorkerRequest);
    }
  }

  /** Frees the models and the workers; the next call starts fresh. */
  dispose(): void {
    const lanes = this.lanes();
    this.main = null;
    this.pool = [];
    for (const lane of lanes) {
      for (const [id, p] of lane.pending) {
        lane.pending.delete(id);
        p.resolve({kind: 'cancelled'});
      }
    }
    this.status = {glm: IDLE, paddle6: IDLE, paddle: IDLE};
    this.emit();
    for (const {worker} of lanes) {
      worker.postMessage({kind: 'dispose'} satisfies WorkerRequest);
      // Give the engines a moment to release GPU buffers before the worker goes away for good.
      window.setTimeout(() => worker.terminate(), 1500);
    }
  }

  private lanes(): Lane[] {
    return this.main === null ? this.pool : [this.main, ...this.pool];
  }

  private post(request: WorkerRequest): void {
    this.mainLane().worker.postMessage(request);
  }

  private mainLane(): Lane {
    this.main ??= this.spawn();
    return this.main;
  }

  private paddleLane(engine: PaddleEngineId): Lane {
    const main = this.mainLane();
    let lane = main.pending.size === 0 ? main : this.pool.find(l => l.pending.size === 0);
    if (lane === undefined && this.pool.length < this.sizing.workers - 1) {
      lane = this.spawn();
      this.pool.push(lane);
    }
    lane ??= this.lanes().reduce((best, l) => (l.pending.size < best.pending.size ? l : best));
    // A pool worker loads the engine on its first run of it, quietly (the files are cached by then).
    if (!lane.loading.has(engine)) {
      lane.loading.add(engine);
      lane.worker.postMessage({
        kind: 'load',
        engine,
        hosts: resolveAssetHosts(),
        threads: this.sizing.threads,
      } satisfies WorkerRequest);
    }
    return lane;
  }

  private spawn(): Lane {
    // Named so the chunk is recognisable in the network panel and stable across builds.
    const worker = new Worker(new URL(/* webpackChunkName: "ocr-worker" */ './worker.ts', import.meta.url));
    const lane: Lane = {worker, pending: new Map(), loading: new Set()};
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(lane, event.data);
    worker.onerror = event => {
      // A script that could not be fetched (offline, stale deploy) reports no message at all.
      const message = `the OCR worker crashed: ${event.message || 'its script could not be loaded'}`;
      for (const [id, p] of lane.pending) {
        lane.pending.delete(id);
        p.resolve({kind: 'error', message});
      }
      worker.terminate();
      if (lane === this.main) {
        this.main = null;
        for (const engine of ['glm', 'paddle6', 'paddle'] as const) {
          this.update(engine, {...IDLE, state: 'error', message});
          this.settleLoad(engine, new Error(message));
        }
      } else {
        this.pool = this.pool.filter(l => l !== lane);
      }
    };
    return lane;
  }

  private onMessage(lane: Lane, message: WorkerResponse): void {
    switch (message.kind) {
      // The engine status is the main worker's; a pool worker loads quietly (from the cache) and
      // a failure there surfaces in its runs.
      case 'load-progress':
        if (lane !== this.main) return;
        this.update(message.engine, {
          ...this.status[message.engine],
          state: 'loading',
          loaded: message.loaded,
          total: message.total,
          file: message.file,
        });
        return;
      case 'load-done':
        if (lane !== this.main) return;
        this.update(message.engine, {
          ...this.status[message.engine],
          state: 'ready',
          loadMs: message.loadMs,
          file: null,
        });
        this.settleLoad(message.engine, null);
        return;
      case 'load-error':
        if (lane !== this.main) return;
        this.update(message.engine, {...IDLE, state: 'error', message: message.message});
        this.settleLoad(message.engine, new Error(message.message));
        return;
    }
    const p = lane.pending.get(message.id);
    if (p === undefined) return;
    switch (message.kind) {
      case 'token':
        p.handlers.onToken?.(message.text);
        return;
      case 'stage':
        p.handlers.onStage?.(message.message);
        return;
      case 'done':
        lane.pending.delete(message.id);
        p.resolve({
          kind: 'done',
          text: message.text,
          ms: message.ms,
          tokens: message.tokens,
          segments: message.segments,
        });
        return;
      case 'error':
        lane.pending.delete(message.id);
        p.resolve({kind: 'error', message: message.message});
        return;
      case 'cancelled':
        lane.pending.delete(message.id);
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
