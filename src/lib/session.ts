/**
 * Keeps the working set in IndexedDB so a reload does not lose work. Everything stays on the
 * device: files, previews and results go into the browser's `safeocr` database and nowhere else.
 * Storage trouble (no IndexedDB, private mode, quota) is swallowed: persistence is a convenience,
 * never a reason to interrupt the user.
 */
import type {DocJob, PageJob} from './jobs';
import {newId, newPage} from './jobs';

const DB_NAME = 'safeocr';
/** 2: records keyed by document id (so a save rewrites only what changed) instead of position. */
const DB_VERSION = 2;
const DOCS_STORE = 'docs';
const META_STORE = 'meta';
const META_KEY = 'session';

export interface SessionSummary {
  savedAt: number;
  files: number;
  pages: number;
  /** Pages whose state is `done`. */
  recognised: number;
}

/** The serialisable part of a page; transient fields (`stage`, `compare`, `previous`, ids) are dropped. */
type StoredPage = Pick<
  PageJob,
  | 'index'
  | 'state'
  | 'engine'
  | 'mode'
  | 'text'
  | 'ms'
  | 'tokens'
  | 'segments'
  | 'edited'
  | 'previewRotation'
  | 'width'
  | 'height'
  | 'pointWidth'
  | 'pointHeight'
  | 'rotation'
  | 'region'
  | 'error'
> & {preview: Blob | null};

interface StoredDoc extends Pick<DocJob, 'id' | 'name' | 'kind' | 'file' | 'error'> {
  /** Position in the list. */
  order: number;
  pages: StoredPage[];
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Opens (creating on first use) the database; null when IndexedDB is missing or refuses. */
function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // Version 1 keyed documents by position; start over with id keys (nothing worth migrating).
      if (db.objectStoreNames.contains(DOCS_STORE)) db.deleteObjectStore(DOCS_STORE);
      db.createObjectStore(DOCS_STORE, {keyPath: 'id'});
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** Runs `body` in one transaction on a fresh connection, closing it afterwards; null without a database. */
async function withDb<T>(mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T | null> {
  const db = await openDb();
  if (db === null) return null;
  try {
    return await body(db.transaction([DOCS_STORE, META_STORE], mode));
  } finally {
    db.close();
  }
}

async function fetchPreview(url: string | null): Promise<Blob | null> {
  if (url === null) return null;
  try {
    return await (await fetch(url)).blob();
  } catch {
    // A revoked or otherwise unreadable preview is simply not saved; the page keeps its result.
    return null;
  }
}

async function storePage(page: PageJob): Promise<StoredPage> {
  return {
    index: page.index,
    // A page that was waiting or in flight is back to the start after a reload; its text so far is kept.
    state: page.state === 'queued' || page.state === 'running' ? 'idle' : page.state,
    engine: page.engine,
    mode: page.mode,
    text: page.text,
    ms: page.ms,
    tokens: page.tokens,
    segments: page.segments,
    edited: page.edited,
    previewRotation: page.previewRotation,
    width: page.width,
    height: page.height,
    pointWidth: page.pointWidth,
    pointHeight: page.pointHeight,
    rotation: page.rotation,
    region: page.region,
    error: page.error,
    preview: await fetchPreview(page.previewUrl),
  };
}

async function storeDoc(doc: DocJob, order: number): Promise<StoredDoc> {
  return {
    id: doc.id,
    order,
    name: doc.name,
    kind: doc.kind,
    file: doc.file,
    error: doc.error,
    pages: await Promise.all(doc.pages.map(storePage)),
  };
}

function restoreDoc(record: StoredDoc): DocJob {
  const id = newId('d');
  return {
    id,
    file: record.file,
    name: record.name,
    kind: record.kind,
    error: record.error,
    // newPage supplies the fresh id and the transient fields (stage, compare, previous) as null.
    pages: record.pages.map(({preview, ...fields}) => ({
      ...newPage(id, fields.index, fields.region),
      ...fields,
      previewUrl: preview === null ? null : URL.createObjectURL(preview),
    })),
  };
}

/**
 * Writes are chained so two saves (or a save and a clear) land in call order even when the earlier
 * one is still gathering previews; each link swallows its own failure so the chain never breaks.
 */
let writes: Promise<void> = Promise.resolve();

/** The document objects behind the last write, by id: an unchanged reference needs no rewrite. */
const lastSaved = new Map<string, DocJob>();

/** Replaces the saved session with `records`, or clears it when `summary` is null. */
function writeAll(records: StoredDoc[], summary: SessionSummary | null): Promise<void> {
  writes = writes
    .then(() =>
      withDb('readwrite', tx => {
        const docs = tx.objectStore(DOCS_STORE);
        const meta = tx.objectStore(META_STORE);
        docs.clear();
        meta.clear();
        for (const record of records) docs.put(record);
        if (summary !== null) meta.put(summary, META_KEY);
        return settled(tx);
      }),
    )
    .then(
      () => undefined,
      () => undefined,
    );
  return writes;
}

/** Puts the changed records, drops records of documents that are gone, and refreshes the summary. */
function writeChanged(changed: StoredDoc[], keep: ReadonlySet<string>, summary: SessionSummary): Promise<void> {
  writes = writes
    .then(() =>
      withDb('readwrite', tx => {
        const docs = tx.objectStore(DOCS_STORE);
        for (const record of changed) docs.put(record);
        // Deleting inside the request's callback keeps the transaction alive: no await in between.
        docs.getAllKeys().onsuccess = event => {
          for (const key of (event.target as IDBRequest<IDBValidKey[]>).result) {
            if (typeof key === 'string' && !keep.has(key)) docs.delete(key);
          }
        };
        tx.objectStore(META_STORE).put(summary, META_KEY);
        return settled(tx);
      }),
    )
    .then(
      () => undefined,
      () => undefined,
    );
  return writes;
}

/**
 * Saves `docs` (an empty list clears the session). Only documents whose object changed since the
 * last save are rewritten, so saving often is cheap. Never throws: storage trouble is swallowed.
 */
export async function saveSession(docs: DocJob[]): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  if (docs.length === 0) {
    lastSaved.clear();
    return writeAll([], null);
  }
  const changed: {doc: DocJob; order: number}[] = [];
  docs.forEach((doc, order) => {
    if (lastSaved.get(doc.id) !== doc) changed.push({doc, order});
  });
  let records: StoredDoc[];
  try {
    // Previews are gathered before the transaction opens: an IndexedDB transaction commits as soon
    // as nothing is pending on it, so no other await may sit between its requests.
    records = await Promise.all(changed.map(({doc, order}) => storeDoc(doc, order)));
  } catch {
    return;
  }
  let pages = 0;
  let recognised = 0;
  for (const doc of docs) {
    pages += doc.pages.length;
    for (const page of doc.pages) if (page.state === 'done') recognised++;
  }
  for (const {doc} of changed) lastSaved.set(doc.id, doc);
  for (const id of [...lastSaved.keys()]) if (!docs.some(d => d.id === id)) lastSaved.delete(id);
  return writeChanged(records, new Set(docs.map(d => d.id)), {
    savedAt: Date.now(),
    files: docs.length,
    pages,
    recognised,
  });
}

/** What is saved, without loading it; null when nothing is. */
export async function peekSession(): Promise<SessionSummary | null> {
  try {
    const summary = await withDb('readonly', tx =>
      request<SessionSummary | undefined>(tx.objectStore(META_STORE).get(META_KEY)),
    );
    return summary ?? null;
  } catch {
    return null;
  }
}

/** Rebuilds the documents with fresh ids and object URLs; null when nothing is saved. */
export async function loadSession(): Promise<DocJob[] | null> {
  try {
    const records = await withDb('readonly', tx => request<StoredDoc[]>(tx.objectStore(DOCS_STORE).getAll()));
    if (records === null || records.length === 0) return null;
    // The restored documents get new ids, so the next save rewrites everything under those.
    lastSaved.clear();
    return records.sort((a, b) => a.order - b.order).map(restoreDoc);
  } catch {
    return null;
  }
}

export function clearSession(): Promise<void> {
  lastSaved.clear();
  return writeAll([], null);
}
