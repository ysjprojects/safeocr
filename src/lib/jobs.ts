/**
 * The batch model of the page: documents (one per dropped file) made of pages (one per image, one
 * per PDF page), each carrying its own OCR state and output. Pure helpers; the component owns state.
 */
import type {Engine, Mode, OcrSegment} from './protocol';
import {MODE_SPEC} from './protocol';

export type PageState = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** Quarter turns applied to a page before it is shown or recognised. */
export type Rotation = 0 | 90 | 180 | 270;

/** A rectangle in fractions (0–1) of the rotated page: the part a region page covers. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 1-based number among the regions cut from the same source page, for labels. */
  n: number;
}

/** The other engine's reading of the same page, for the Compare tab. */
export interface CompareResult {
  state: 'running' | 'done' | 'error';
  engine: Engine;
  mode: Mode | null;
  text: string;
  ms: number | null;
  tokens: number | null;
  segments: OcrSegment[] | null;
  error: string | null;
}

export interface PageJob {
  id: string;
  docId: string;
  /** 0-based page index within the document (the source page, for a region page). */
  index: number;
  state: PageState;
  engine: Engine | null;
  mode: Mode | null;
  /** Output so far (streams in while running), or the user's edited text. */
  text: string;
  stage: string | null;
  /** `Date.now()` when the run in progress started (shown ticking next to the stage); null otherwise. */
  startedAt: number | null;
  ms: number | null;
  tokens: number | null;
  /** PP-OCR's segments (box + confidence) in `width × height` pixels; null for GLM-OCR. */
  segments: OcrSegment[] | null;
  /** The text was changed by hand after the run. */
  edited: boolean;
  /** Set once the page is rendered: right after it arrives, or by its run if that comes first. */
  previewUrl: string | null;
  /** Quarter turns baked into `previewUrl` (0 for an image shown as dropped); the pane rotates the rest. */
  previewRotation: Rotation;
  /** Why the page could not be rendered; a run tries again (and reports its own failure). */
  previewError: string | null;
  /** Size of the pixels the model saw (after rotation, region and the pixel budget). */
  width: number | null;
  height: number | null;
  /** Physical size in PDF points (1/72 in) of the rotated page or region; images are taken as 150 dpi. */
  pointWidth: number | null;
  pointHeight: number | null;
  rotation: Rotation;
  /** Set on a region page: the part of its source page it covers. */
  region: Region | null;
  compare: CompareResult | null;
  error: string | null;
  /**
   * The result that was in place when a rerun was requested. It is restored if the rerun fails or
   * is stopped and dropped once the rerun succeeds, so a rerun never loses what the page had.
   */
  previous: PageResult | null;
}

/** What one run produces on a page. */
export type PageResult = Pick<
  PageJob,
  'state' | 'engine' | 'mode' | 'text' | 'ms' | 'tokens' | 'segments' | 'edited' | 'error'
>;

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

export function newPage(docId: string, index: number, region: Region | null = null): PageJob {
  return {
    id: newId('p'),
    docId,
    index,
    state: 'idle',
    engine: null,
    mode: null,
    text: '',
    startedAt: null,
    stage: null,
    ms: null,
    tokens: null,
    segments: null,
    edited: false,
    previewUrl: null,
    previewRotation: 0,
    previewError: null,
    width: null,
    height: null,
    pointWidth: null,
    pointHeight: null,
    rotation: 0,
    region,
    compare: null,
    error: null,
    previous: null,
  };
}

/** The fields a run fills in; `text` and friends are reset when a run starts. */
export const RUN_START: Pick<
  PageJob,
  'text' | 'stage' | 'error' | 'previewError' | 'ms' | 'tokens' | 'segments' | 'edited'
> = {
  text: '',
  stage: 'preparing the image',
  error: null,
  previewError: null,
  ms: null,
  tokens: null,
  segments: null,
  edited: false,
};

/**
 * Inserts a region page right after the last page cut from the same source page (or the source
 * page itself), numbering it after its siblings. Returns the new page so it can be queued.
 */
export function addRegion(
  docs: DocJob[],
  docId: string,
  index: number,
  rect: Omit<Region, 'n'>,
): {docs: DocJob[]; page: PageJob | null} {
  let page: PageJob | null = null;
  const next = docs.map(doc => {
    if (doc.id !== docId) return doc;
    let at = -1;
    let n = 0;
    doc.pages.forEach((p, i) => {
      if (p.index !== index) return;
      at = i;
      if (p.region !== null) n = Math.max(n, p.region.n);
    });
    if (at === -1) return doc;
    const source = doc.pages.find(p => p.index === index && p.region === null);
    page = {...newPage(docId, index, {...rect, n: n + 1}), rotation: source?.rotation ?? 0};
    return {...doc, pages: [...doc.pages.slice(0, at + 1), page, ...doc.pages.slice(at + 1)]};
  });
  return {docs: next, page};
}

export function removePage(docs: DocJob[], pageId: string): DocJob[] {
  return docs.map(doc =>
    doc.pages.some(p => p.id === pageId) ? {...doc, pages: doc.pages.filter(p => p.id !== pageId)} : doc,
  );
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

const NONE: ReadonlySet<string> = new Set();

/** The first page waiting to run, in document order; `exclude` skips pages already being started. */
export function firstQueued(docs: DocJob[], exclude: ReadonlySet<string> = NONE): PageJob | null {
  for (const doc of docs)
    for (const page of doc.pages) if (page.state === 'queued' && !exclude.has(page.id)) return page;
  return null;
}

/** Marks every page that has not succeeded as queued (plain Run); pages that are done stay as they are. */
export function queuePending(docs: DocJob[]): DocJob[] {
  return docs.map(doc => ({
    ...doc,
    pages: doc.pages.map(p => (isPending(p) ? {...p, state: 'queued', error: null} : p)),
  }));
}

/** Whether Run would process this page: it has never succeeded and is not in flight. */
export function isPending(page: PageJob): boolean {
  return page.state === 'idle' || page.state === 'error' || page.state === 'cancelled';
}

/**
 * Puts queued pages back (what "Stop" does; the running page is cancelled separately): to idle, or
 * to the result a pending rerun was about to replace.
 */
export function unqueueAll(docs: DocJob[]): DocJob[] {
  return docs.map(doc => ({
    ...doc,
    pages: doc.pages.map(p =>
      p.state !== 'queued' ? p : p.previous !== null ? {...p, ...p.previous, previous: null} : {...p, state: 'idle'},
    ),
  }));
}

/** Whether a page has run before, so the action offered is a rerun rather than a first run. */
export function hasRun(page: PageJob): boolean {
  return page.state === 'done' || page.state === 'error' || page.state === 'cancelled';
}

/**
 * Queues the pages `ids` names (Run or Rerun on a selection, Rerun on one page): a first run for
 * those that never ran, a rerun for those that have — their result is kept until the new run
 * succeeds. Pages in flight stay as they are.
 */
export function requeue(docs: DocJob[], ids: ReadonlySet<string>): DocJob[] {
  return docs.map(doc => ({
    ...doc,
    pages: doc.pages.map(p => {
      if (!ids.has(p.id) || p.state === 'queued' || p.state === 'running') return p;
      if (!hasRun(p)) return {...p, state: 'queued', error: null};
      return {
        ...p,
        state: 'queued',
        previous: {
          state: p.state,
          engine: p.engine,
          mode: p.mode,
          text: p.text,
          ms: p.ms,
          tokens: p.tokens,
          segments: p.segments,
          edited: p.edited,
          error: p.error,
        },
      };
    }),
  }));
}

/**
 * Settles a run that did not succeed. A rerun goes back to the result it was replacing (with a note
 * when it failed); a first run simply records the failure.
 */
export function failPage(
  docs: DocJob[],
  pageId: string,
  failure: {state: 'error'; error: string} | {state: 'cancelled'},
): DocJob[] {
  return updatePage(docs, pageId, p => {
    if (p.previous === null) return {...failure, stage: null};
    const error =
      failure.state === 'error' ? `Rerun failed: ${failure.error}. Showing the previous result.` : p.previous.error;
    return {...p.previous, error, stage: null, previous: null};
  });
}

/** Lines of a page's text, the unit segments, confidence and search hits refer to. */
export function textLines(page: PageJob): string[] {
  return page.text.length === 0 ? [] : page.text.split('\n');
}

/** Lowest confidence among a line's segments, or null when the page has no segments (GLM-OCR, edited). */
export function lineConfidence(page: PageJob, line: number): number | null {
  if (page.segments === null) return null;
  let lowest: number | null = null;
  for (const s of page.segments) {
    if (s.line === line && (lowest === null || s.confidence < lowest)) lowest = s.confidence;
  }
  return lowest;
}

/** Number of (case-insensitive) occurrences of `query` in the page's text; 0 for an empty query. */
export function countHits(page: PageJob, query: string): number {
  if (query.length === 0 || page.text.length === 0) return 0;
  const haystack = page.text.toLowerCase();
  const needle = query.toLowerCase();
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

export function countByState(docs: DocJob[]): Record<PageState, number> {
  const counts: Record<PageState, number> = {idle: 0, queued: 0, running: 0, done: 0, error: 0, cancelled: 0};
  for (const doc of docs) for (const page of doc.pages) counts[page.state]++;
  return counts;
}

/** The page within its document: `page 3`, `page 3 · region 1`, `region 1` for an image, '' for an image itself. */
export function pagePart(doc: DocJob, page: PageJob): string {
  const parts: string[] = [];
  if (doc.kind === 'pdf') parts.push(`page ${page.index + 1}`);
  if (page.region !== null) parts.push(`region ${page.region.n}`);
  return parts.join(' · ');
}

/** Display label of a page: the file name, with the page number for PDFs and the region number. */
export function pageLabel(doc: DocJob, page: PageJob): string {
  const part = pagePart(doc, page);
  return part === '' ? doc.name : `${doc.name} · ${part}`;
}

/** File extension for a finished page's output. */
export function pageExtension(page: PageJob): string {
  return page.engine === 'glm' && page.mode !== null ? MODE_SPEC[page.mode].extension : 'txt';
}

/** Stem used for downloads: `<file>` for images, `<file>-p<n>` for PDF pages, `-r<n>` for regions. */
export function pageStem(doc: DocJob, page: PageJob): string {
  const stem = doc.name.replace(/\.[^.]+$/, '');
  const base = doc.kind === 'pdf' ? `${stem}-p${String(page.index + 1).padStart(3, '0')}` : stem;
  return page.region === null ? base : `${base}-r${page.region.n}`;
}

/**
 * A document's finished pages as one file, in order: Markdown when any page is GLM-OCR's (its
 * output is Markdown, HTML or LaTeX, all at home there), plain text when every page is PP-OCR's.
 * Each page opens with a marker naming it — an HTML comment in Markdown, which does not render,
 * a dashed line in text — so the boundaries stay findable without getting in the way.
 */
export function combinedDocument(doc: DocJob, pages: PageJob[]): {extension: 'md' | 'txt'; text: string} {
  const markdown = pages.some(page => page.engine === 'glm');
  const extension = markdown ? 'md' : 'txt';
  const sections = pages.map(page => {
    const part = pagePart(doc, page);
    const marker = part === '' ? '' : markdown ? `<!-- ${part} -->\n\n` : `---- ${part} ----\n\n`;
    return `${marker}${page.text.replace(/\s+$/, '')}\n`;
  });
  return {extension, text: sections.join('\n')};
}
