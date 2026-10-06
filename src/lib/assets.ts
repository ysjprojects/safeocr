/**
 * Model and runtime asset locations, plus a Cache API-backed fetch for the files Transformers.js
 * does not manage (the PP-OCR ONNX models). Runs in the worker.
 */
import type {AssetHosts} from './protocol';

/**
 * Resolves model hosts on the main thread. `NEXT_PUBLIC_SAFEOCR_MODEL_HOST` (inlined at build time)
 * points both model sets at a self-hosted mirror laid out like huggingface.co
 * (`<host>/<repo>/resolve/main/<file>`). The onnxruntime-web runtime always comes from this origin
 * (`public/ort/<version>/`, synced by scripts/sync-ort-wasm.mjs); the worker resolves that itself.
 */
export function resolveAssetHosts(): AssetHosts {
  const configured = process.env.NEXT_PUBLIC_SAFEOCR_MODEL_HOST || 'https://huggingface.co/';
  const host = configured.endsWith('/') ? configured : `${configured}/`;
  return {glmHost: host, paddleHost: host};
}

const CACHE_NAME = 'safeocr-models';

/** Every Cache API bucket holding model files: ours (PP-OCR) and Transformers.js's (GLM-OCR). */
const MODEL_CACHES = [CACHE_NAME, 'transformers-cache'];

/** Deletes the downloaded models from this browser; the next load downloads them again. */
export async function deleteModelCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await Promise.all(MODEL_CACHES.map(name => caches.delete(name)));
}

/** Bytes this origin stores in the browser (models, mostly), where the browser reports it. */
export async function storageUsage(): Promise<number | null> {
  if (typeof navigator === 'undefined' || navigator.storage?.estimate === undefined) return null;
  const {usage} = await navigator.storage.estimate();
  return usage ?? null;
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/**
 * Fetches `url` once: the response body is stored in the Cache API so the next visit reads it
 * from disk. `onProgress` receives the bytes read so far (also while reading from the cache).
 */
export async function fetchCached(url: string, onProgress: (loaded: number) => void): Promise<ArrayBuffer> {
  const cache = await openCache();
  let response = (await cache?.match(url)) ?? null;
  const fromNetwork = response === null;
  if (response === null) {
    response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} while fetching ${url}`);
  }
  if (response.body === null) throw new Error(`empty response for ${url}`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded);
  }
  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (fromNetwork && cache !== null) {
    const headers = new Headers({
      'content-length': String(loaded),
      'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
    });
    // A full cache (or private mode) must not fail the load; the next visit just downloads again.
    await cache.put(url, new Response(buffer, {headers})).catch(() => undefined);
  }
  return buffer.buffer;
}
