/**
 * The batch model of the page: documents (one per dropped file) made of pages (one per image, one
 * per PDF page), each carrying its own OCR state and output. Pure helpers; the component owns state.
 */
import type {Engine, Mode} from './protocol';
import {MODE_SPEC} from './protocol';

export type PageState = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface PageJob {
  id: string;
  docId: string;
  /** 0-based page index within the document. */
  index: number;
  state: PageState;
  engine: Engine | null;
  mode: Mode | null;
  /** Output so far (streams in while running). */
  text: string;
  stage: string | null;
  ms: number | null;
  tokens: number | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  error: string | null;
}

export interface DocJob {
  id: string;
  file: File;
  name: string;
  kind: 'image' | 'pdf';
  pages: PageJob[];
  /** Set when the file could not be opened at all. */
  error: string | null;
}

let nextId = 1;
export const newId = (prefix: string): string => `${prefix}${nextId++}`;

export function newPage(docId: string, index: number): PageJob {
  return {
    id: newId('p'),
    docId,
    index,
    state: 'idle',
    engine: null,
    mode: null,
    text: '',
    stage: null,
    ms: null,
    tokens: null,
    previewUrl: null,
    width: null,
    height: null,
    error: null,
  };
}

export function updatePage(
  docs: DocJob[],
  pageId: string,
  patch: Partial<PageJob> | ((page: PageJob) => Partial<PageJob>),
): DocJob[] {
  return docs.map(doc => {
    if (!doc.pages.some(p => p.id === pageId)) return doc;
    return {
      ...doc,
      pages: doc.pages.map(p => (p.id === pageId ? {...p, ...(typeof patch === 'function' ? patch(p) : patch)} : p)),
    };
  });
}

export function findPage(docs: DocJob[], pageId: string | null): PageJob | null {
  if (pageId === null) return null;
  for (const doc of docs) for (const page of doc.pages) if (page.id === pageId) return page;
  return null;
}

export function firstQueued(docs: DocJob[]): PageJob | null {
  for (const doc of docs) for (const page of doc.pages) if (page.state === 'queued') return page;
  return null;
}

/** Marks every page that has not succeeded as queued (what "Run" does). */
export function queueAll(docs: DocJob[]): DocJob[] {
  return docs.map(doc => ({
    ...doc,
    pages: doc.pages.map(p => (p.state === 'done' || p.state === 'running' ? p : {...p, state: 'queued', error: null})),
  }));
}

/** Puts queued pages back to idle (what "Stop" does; the running page is cancelled separately). */
export function unqueueAll(docs: DocJob[]): DocJob[] {
  return docs.map(doc => ({...doc, pages: doc.pages.map(p => (p.state === 'queued' ? {...p, state: 'idle'} : p))}));
}

export function countByState(docs: DocJob[]): Record<PageState, number> {
  const counts: Record<PageState, number> = {idle: 0, queued: 0, running: 0, done: 0, error: 0, cancelled: 0};
  for (const doc of docs) for (const page of doc.pages) counts[page.state]++;
  return counts;
}

/** Display label of a page: the file name, with the page number for PDFs. */
export function pageLabel(doc: DocJob, page: PageJob): string {
  return doc.kind === 'pdf' ? `${doc.name} · page ${page.index + 1}` : doc.name;
}

/** File extension for a finished page's output. */
export function pageExtension(page: PageJob): string {
  return page.engine === 'glm' && page.mode !== null ? MODE_SPEC[page.mode].extension : 'txt';
}

/** Stem used for downloads: `<file>` for images, `<file>-p<n>` for PDF pages. */
export function pageStem(doc: DocJob, page: PageJob): string {
  const stem = doc.name.replace(/\.[^.]+$/, '');
  return doc.kind === 'pdf' ? `${stem}-p${String(page.index + 1).padStart(3, '0')}` : stem;
}
