import {type FC, type MutableRefObject, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {deleteModelCaches} from '@/lib/assets';
import {getOcrClient} from '@/lib/client';
import {type GlmSupport, GLM_UNKNOWN, probeGlmSupport} from '@/lib/device';
import {download, outputName, zip} from '@/lib/export';
import {type Rasterized, closePdf, countPages, isPdf, rasterize, renderPreview} from '@/lib/inputs';
import {
  type DocJob,
  type PageJob,
  addRegion,
  countByState,
  countHits,
  failPage,
  findPage,
  firstQueued,
  hasRun,
  isPending,
  newId,
  newPage,
  pageExtension,
  pageLabel,
  pageStem,
  queuePending,
  removePage,
  requeue,
  RUN_START,
  textLines,
  unqueueAll,
  updatePage,
} from '@/lib/jobs';
import {type PdfPageInput, searchablePdf} from '@/lib/pdf';
import {
  type Detail,
  type Engine,
  type Mode,
  type OcrSegment,
  type PaddleEngineId,
  DETAIL_LABEL,
  DETAIL_PIXELS,
  ENGINE_LABEL,
  isPaddle,
  MODE_SPEC,
} from '@/lib/protocol';
import {type SessionSummary, clearSession, loadSession, peekSession, saveSession} from '@/lib/session';
import {useSettings} from '@/lib/settings';
import {useTheme} from '@/lib/theme';

import ConfirmDialog from './ConfirmDialog';
import {DropOverlay, useFileDrop} from './Dropzone';
import Icon from './icons';
import PageRail, {type SelectModifiers} from './PageRail';
import ResultPane from './ResultPane';
import SettingsMenu from './SettingsMenu';
import SourcePane, {SourceHandle} from './SourcePane';
import StatusBar from './StatusBar';
import Toolbar from './Toolbar';
import Welcome from './Welcome';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Where a run stopped: loading the engine (the batch stops), preparing the page, or recognising it. */
type OneRun =
  | {kind: 'done'; text: string; ms: number; tokens: number; segments: OcrSegment[] | null}
  | {kind: 'cancelled'}
  | {kind: 'error'; message: string; stage: 'load' | 'raster' | 'run'};

/** A request in flight, so Stop and page removal can cancel it. */
type Slot = MutableRefObject<{pageId: string; runId: number} | null>;

/** Keys that belong to a text field or a dialog are never shortcuts. */
const editingTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('dialog, input, select, textarea, [contenteditable="true"], [role="dialog"]') !== null;

/** What a page's pixels depend on: the page as rotated and cropped, and the pixel budget. */
const rasterKey = (page: PageJob, budget: number): string => {
  const r = page.region;
  return `${page.id}|${page.rotation}|${r === null ? '' : `${r.x},${r.y},${r.width},${r.height}`}|${budget}`;
};

const SafeOcrApp: FC = memo(() => {
  const client = useMemo(() => getOcrClient(), []);
  const [status, setStatus] = useState(client.getStatus());
  useEffect(() => client.subscribe(setStatus), [client]);

  /** Whether GLM-OCR can run here (WebGPU and enough memory); probed once on mount. */
  const [glm, setGlm] = useState<GlmSupport>(GLM_UNKNOWN);
  const [isolated, setIsolated] = useState(true);
  const [docs, setDocs] = useState<DocJob[]>([]);
  /** The page on screen. */
  const [selected, setSelected] = useState<string | null>(null);
  /** Pages picked in the rail (click, ⇧ range, ⌘/Ctrl toggle); Run works on these when there are any. */
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  /** Where a ⇧ range starts: the last page clicked without ⇧. */
  const anchor = useRef<string | null>(null);
  const [running, setRunning] = useState(false);
  /** A compare run (the other engine on one page) is in flight. */
  const [comparing, setComparing] = useState(false);
  /** The text line the pointer is on, in either pane. */
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  /** A saved session found on start, until it is restored or discarded. */
  const [session, setSession] = useState<SessionSummary | null>(null);

  // Engine, output, detail, theme and the scan toggle are the user's and persist across visits.
  const [settings, updateSettings] = useSettings();
  useTheme(settings.theme);
  const {mode, detail, sourceShown} = settings;
  // The stored engine preference, bounded by what this device can run; before a choice is made,
  // GLM-OCR where it can run, PP-OCRv6 otherwise (PP-OCRv5 only when chosen).
  const wantsGlm = settings.engine === 'glm' || (settings.engine === null && glm.ok === true);
  const cpuEngine: PaddleEngineId = settings.engine === 'paddle' ? 'paddle' : 'paddle6';
  const engine: Engine = wantsGlm && glm.ok !== false ? 'glm' : cpuEngine;
  const setEngine = useCallback((e: Engine) => updateSettings({engine: e}), [updateSettings]);
  const setMode = useCallback((m: Mode) => updateSettings({mode: m}), [updateSettings]);
  const setDetail = useCallback((d: Detail) => updateSettings({detail: d}), [updateSettings]);

  // The batch loop reads the latest values without re-subscribing to React state.
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const settingsRef = useRef({engine, mode, detail});
  settingsRef.current = {engine, mode, detail};
  /** The PP-OCR engine Compare runs against a GLM-OCR page: the one the user prefers. */
  const cpuEngineRef = useRef(cpuEngine);
  cpuEngineRef.current = cpuEngine;
  const runningRef = useRef(false);
  const loopActive = useRef(false);
  /** The runs of the batch, one slot per lane, so Stop and page removal can cancel them. */
  const lanes = useRef<Slot[]>([]);
  /** Pages a lane has picked but React has not yet marked running. */
  const claimed = useRef(new Set<string>());
  const compareRun: Slot = useRef(null);
  /** Whether the result pane follows the page being processed (until the user picks one). */
  const follow = useRef(true);

  useEffect(() => {
    probeGlmSupport().then(setGlm);
    setIsolated(crossOriginIsolated);
    peekSession().then(summary => {
      if (summary !== null && summary.pages > 0) setSession(summary);
    });
  }, []);

  // Opt-in preloading: once the device is probed (so the engine is the right one), load it so the
  // first Run does not wait. Also fires when the option is switched on mid-session.
  const preloaded = useRef(false);
  useEffect(() => {
    if (glm.ok === null || !settings.autoLoad || preloaded.current) return;
    preloaded.current = true;
    void client.load(engine).catch(() => undefined);
  }, [client, engine, glm.ok, settings.autoLoad]);

  // Models live in the worker; free them when the tab goes away or the user leaves the page.
  useEffect(() => {
    const onHide = () => client.dispose();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      client.dispose();
    };
  }, [client]);

  // The working set is saved to this browser so a reload can offer to pick it up: the moment a
  // batch or compare ends, and otherwise half a second after it last changed (saves are
  // incremental, so that is cheap even while pages stream). Only once the user has changed it in
  // this visit: a fresh page starts with no documents, and saving that would wipe what the last
  // visit left behind before it could be restored. Switching the option off removes what was saved.
  const touched = useRef(false);
  useEffect(() => {
    if (!settings.keepSession) {
      void clearSession();
      return;
    }
    if (!touched.current) return;
    const timer = window.setTimeout(() => void saveSession(docs), 500);
    return () => window.clearTimeout(timer);
  }, [docs, settings.keepSession]);
  useEffect(() => {
    if (running || comparing || !touched.current || !settings.keepSession) return;
    void saveSession(docsRef.current);
  }, [comparing, running, settings.keepSession]);
  useEffect(() => {
    const onHide = () => {
      if (touched.current && settings.keepSession) void saveSession(docsRef.current);
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [settings.keepSession]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    for (const lane of lanes.current) {
      const current = lane.current;
      if (current !== null) client.cancel(current.runId);
    }
    const compare = compareRun.current;
    if (compare !== null) client.cancel(compare.runId);
    setDocs(unqueueAll);
  }, [client]);

  /**
   * The next page's raster, prepared while the current one runs: pdf.js, the canvas and the JPEG
   * preview take a good part of a second per page, time the engine would otherwise sit idle. One
   * slot, taken only by the page it was made for as it still is (rotation, region, budget);
   * anything else is rasterised when its turn comes.
   */
  const prepared = useRef<{key: string; raster: Promise<Rasterized | null>} | null>(null);

  /** A run makes a page's preview only when it has none, or one made before it was rotated. */
  const needsPreview = (page: PageJob): boolean => page.previewUrl === null || page.previewRotation !== page.rotation;

  const rasterFor = useCallback(async (doc: DocJob, page: PageJob, budget: number): Promise<Rasterized> => {
    const key = rasterKey(page, budget);
    const ahead = prepared.current;
    if (ahead !== null && ahead.key === key) {
      prepared.current = null;
      const raster = await ahead.raster;
      if (raster !== null) return raster;
    }
    return rasterize(doc.file, page.index, budget, {rotation: page.rotation, region: page.region}, needsPreview(page));
  }, []);

  /** Starts rasterising the page that will run after `page`, if one is waiting (single-lane batches). */
  const prepareNext = useCallback((page: PageJob, budget: number) => {
    if (!runningRef.current || lanes.current.length !== 1) return;
    const next = firstQueued(docsRef.current, new Set([page.id, ...claimed.current]));
    const doc = next === null ? undefined : docsRef.current.find(d => d.id === next.docId);
    if (next === null || doc === undefined) return;
    prepared.current = {
      key: rasterKey(next, budget),
      // Not reported: a page that cannot be rasterised fails, for real, when its own turn comes.
      raster: rasterize(
        doc.file,
        next.index,
        budget,
        {rotation: next.rotation, region: next.region},
        needsPreview(next),
      ).catch(() => null),
    };
  }, []);

  /**
   * Pages are rendered as they arrive, not only when they run: PDF pages (an image is shown as
   * dropped), region pages, and whatever a restored session has no picture for. One at a time on
   * this thread, the page on screen first and then in document order, with a tick between pages so
   * the app stays responsive; a run meanwhile keeps the preview a page has.
   */
  const previewing = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const renderPreviews = useCallback(() => {
    if (previewing.current) return;
    const unrendered = (page: PageJob): boolean => page.previewUrl === null && page.previewError === null;
    const onScreen = findPage(docsRef.current, selectedRef.current);
    let page = onScreen !== null && unrendered(onScreen) ? onScreen : null;
    for (const doc of docsRef.current) {
      if (page !== null) break;
      if (doc.error === null) page = doc.pages.find(unrendered) ?? null;
    }
    if (page === null) return;
    const doc = docsRef.current.find(d => d.id === page.docId);
    if (doc === undefined) return;
    previewing.current = true;
    const {id, index, rotation, region} = page;
    renderPreview(doc.file, index, {rotation, region})
      .then(
        preview => {
          const previewUrl = URL.createObjectURL(preview.blob);
          setDocs(d => {
            const current = findPage(d, id);
            // Gone, or its run got there first (revoking twice, should React replay this, is harmless).
            if (current === null || current.previewUrl !== null) {
              URL.revokeObjectURL(previewUrl);
              return d;
            }
            return updatePage(d, id, {
              previewUrl,
              previewRotation: rotation,
              pointWidth: preview.pointWidth,
              pointHeight: preview.pointHeight,
            });
          });
        },
        error => setDocs(d => updatePage(d, id, {previewError: errorMessage(error)})),
      )
      .finally(() => {
        previewing.current = false;
        window.setTimeout(renderPreviews, 0);
      });
  }, []);
  useEffect(renderPreviews, [docs, selected, renderPreviews]);

  /**
   * One page through one engine: load it, rasterise the page as it is rotated and cropped (or take
   * the raster prepared for it), run. `onRaster` fires before recognition starts (the preview can
   * be shown while the model works).
   */
  const runOnce = useCallback(
    async (
      doc: DocJob,
      page: PageJob,
      eng: Engine,
      md: Mode,
      budget: number,
      slot: Slot,
      handlers: {onRaster(raster: Rasterized): void; onToken(text: string): void; onStage(stage: string): void},
    ): Promise<OneRun> => {
      try {
        await client.load(eng);
      } catch (error) {
        return {kind: 'error', message: errorMessage(error), stage: 'load'};
      }
      let raster: Rasterized;
      try {
        raster = await rasterFor(doc, page, budget);
      } catch (error) {
        return {kind: 'error', message: errorMessage(error), stage: 'raster'};
      }
      handlers.onRaster(raster);
      const {id, outcome} = client.run(eng, md, budget, raster.image, {
        onToken: handlers.onToken,
        onStage: handlers.onStage,
      });
      slot.current = {pageId: page.id, runId: id};
      const result = await outcome;
      slot.current = null;
      return result.kind === 'error' ? {...result, stage: 'run'} : result;
    },
    [client, rasterFor],
  );

  /**
   * Pages run through lanes: PP-OCR pages as many at a time as the client has workers for (each
   * page on its own core), GLM-OCR one at a time. Each lane runs the usual sequence for its page
   * and picks the next waiting one until none are left; the result pane follows the first lane.
   */
  const pump = useCallback(async () => {
    if (loopActive.current) return;
    loopActive.current = true;
    const lane = async (slot: Slot, first: boolean): Promise<void> => {
      while (runningRef.current) {
        const page = firstQueued(docsRef.current, claimed.current);
        if (page === null) break;
        const doc = docsRef.current.find(d => d.id === page.docId);
        if (doc === undefined) continue;
        claimed.current.add(page.id);
        const {engine: eng, mode: md, detail: dt} = settingsRef.current;
        const budget = DETAIL_PIXELS[dt];

        setDocs(d =>
          updatePage(d, page.id, {
            state: 'running',
            engine: eng,
            mode: eng === 'glm' ? md : null,
            ...RUN_START,
            startedAt: Date.now(),
          }),
        );
        if (follow.current && first) setSelected(page.id);

        let result: OneRun;
        try {
          result = await runOnce(doc, page, eng, md, budget, slot, {
            onRaster: raster => {
              prepareNext(page, budget);
              const previewUrl = raster.preview === null ? null : URL.createObjectURL(raster.preview);
              setDocs(d =>
                updatePage(d, page.id, p => {
                  const sizes = {
                    width: raster.width,
                    height: raster.height,
                    pointWidth: raster.pointWidth,
                    pointHeight: raster.pointHeight,
                    stage: eng === 'glm' ? 'encoding the image' : null,
                  };
                  if (previewUrl === null) return sizes;
                  if (p.previewUrl !== null) URL.revokeObjectURL(p.previewUrl);
                  return {...sizes, previewUrl, previewRotation: page.rotation};
                }),
              );
            },
            onToken: text => setDocs(d => updatePage(d, page.id, p => ({text: p.text + text, stage: null}))),
            onStage: stage => setDocs(d => updatePage(d, page.id, {stage})),
          });
        } finally {
          claimed.current.delete(page.id);
        }
        // Success replaces whatever the page had (a rerun's kept result included); anything else
        // puts a rerun back to that result.
        setDocs(d =>
          result.kind === 'done'
            ? updatePage(d, page.id, {
                state: 'done',
                text: result.text,
                ms: result.ms,
                tokens: result.tokens,
                segments: result.segments,
                edited: false,
                stage: null,
                error: null,
                previous: null,
              })
            : failPage(
                d,
                page.id,
                result.kind === 'cancelled' ? {state: 'cancelled'} : {state: 'error', error: result.message},
              ),
        );
        // Without an engine nothing else will run either.
        if (result.kind === 'error' && result.stage === 'load') {
          runningRef.current = false;
          break;
        }
        // A PDF's parsed state can go once none of its pages are waiting; a rerun reopens it.
        if (isPdf(doc.file) && !docsRef.current.some(d => d.id === doc.id && d.pages.some(p => p.state === 'queued'))) {
          await closePdf(doc.file);
        }
      }
    };
    try {
      const count = isPaddle(settingsRef.current.engine) ? client.paddleLanes : 1;
      lanes.current = Array.from({length: count}, () => ({current: null}));
      await Promise.all(lanes.current.map((slot, i) => lane(slot, i === 0)));
    } finally {
      lanes.current = [];
      claimed.current.clear();
      loopActive.current = false;
      prepared.current = null;
      runningRef.current = false;
      setRunning(false);
      setDocs(unqueueAll);
    }
  }, [client, prepareNext, runOnce]);

  const launch = useCallback(() => {
    follow.current = true;
    runningRef.current = true;
    setRunning(true);
    // The loop reads docsRef, which the render after setDocs refreshes; start it on the next tick.
    window.setTimeout(() => void pump(), 0);
  }, [pump]);
  const start = useCallback(() => {
    setDocs(queuePending);
    launch();
  }, [launch]);

  const addFiles = useCallback((files: File[]) => {
    const added: DocJob[] = files.map(file => ({
      id: newId('d'),
      file,
      name: file.name,
      kind: isPdf(file) ? 'pdf' : 'image',
      pages: [],
      error: null,
    }));
    touched.current = true;
    setDocs(d => [...d, ...added]);
    for (const doc of added) {
      countPages(doc.file).then(
        pages => {
          if (!docsRef.current.some(x => x.id === doc.id)) return; // removed while it was being opened
          // An image is shown as dropped; PDF pages are rendered next (renderPreviews).
          const previewUrl = doc.kind === 'image' ? URL.createObjectURL(doc.file) : null;
          setDocs(d =>
            d.map(x =>
              x.id === doc.id
                ? {...x, pages: Array.from({length: pages}, (_, i) => ({...newPage(doc.id, i), previewUrl}))}
                : x,
            ),
          );
        },
        error => setDocs(d => d.map(x => (x.id === doc.id ? {...x, error: errorMessage(error)} : x))),
      );
    }
  }, []);

  /** Cancels whichever request is working on one of `pageIds`. */
  const cancelRuns = useCallback(
    (pageIds: ReadonlySet<string>) => {
      for (const slot of [...lanes.current, compareRun]) {
        const run = slot.current;
        if (run !== null && pageIds.has(run.pageId)) client.cancel(run.runId);
      }
    },
    [client],
  );

  const forgetPages = useCallback((pages: PageJob[]) => {
    for (const page of pages) if (page.previewUrl !== null) URL.revokeObjectURL(page.previewUrl);
    const ids = new Set(pages.map(p => p.id));
    setSelected(s => (s !== null && ids.has(s) ? null : s));
    setSelection(s => {
      if (![...s].some(id => ids.has(id))) return s;
      const next = new Set(s);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const removeDoc = useCallback(
    (docId: string) => {
      const doc = docsRef.current.find(d => d.id === docId);
      if (doc === undefined) return;
      cancelRuns(new Set(doc.pages.map(p => p.id)));
      forgetPages(doc.pages);
      void closePdf(doc.file);
      touched.current = true;
      setDocs(d => d.filter(x => x.id !== docId));
    },
    [cancelRuns, forgetPages],
  );

  const removeRegionPage = useCallback(
    (pageId: string) => {
      const page = findPage(docsRef.current, pageId);
      if (page === null) return;
      cancelRuns(new Set([pageId]));
      forgetPages([page]);
      touched.current = true;
      setDocs(d => removePage(d, pageId));
    },
    [cancelRuns, forgetPages],
  );

  const clearAll = useCallback(() => {
    stop();
    touched.current = true;
    for (const doc of docsRef.current) {
      forgetPages(doc.pages);
      void closePdf(doc.file);
    }
    setDocs([]);
    setSelected(null);
    setSelection(new Set());
  }, [forgetPages, stop]);

  // Pages in rail order, for the selection, ⇧ ranges and the previous/next arrows. With nothing
  // picked yet (or the pick removed) the first page is shown.
  const flat = useMemo(() => docs.flatMap(doc => doc.pages.map(page => ({doc, page}))), [docs]);
  const flatRef = useRef(flat);
  flatRef.current = flat;

  const select = useCallback((pageId: string, modifiers: SelectModifiers) => {
    follow.current = false;
    setSelected(pageId);
    const order = flatRef.current.map(x => x.page.id);
    const from = anchor.current === null ? -1 : order.indexOf(anchor.current);
    const to = order.indexOf(pageId);
    if (modifiers.range && from !== -1 && to !== -1) {
      setSelection(new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1)));
      return;
    }
    anchor.current = pageId;
    if (modifiers.toggle) {
      setSelection(s => {
        const next = new Set(s);
        if (next.has(pageId)) next.delete(pageId);
        else next.add(pageId);
        return next;
      });
    } else {
      setSelection(new Set([pageId]));
    }
  }, []);
  const deselect = useCallback(() => setSelection(new Set()), []);

  /** Pages waiting for the user to confirm a rerun (one from its Rerun button, or a selection). */
  const [rerunTargets, setRerunTargets] = useState<ReadonlySet<string> | null>(null);
  const requestRerun = useCallback((pageId: string) => setRerunTargets(new Set([pageId])), []);
  const cancelRerun = useCallback(() => setRerunTargets(null), []);
  const confirmRerun = useCallback(() => {
    const targets = rerunTargets;
    setRerunTargets(null);
    if (targets === null) return;
    setDocs(d => requeue(d, targets));
    if (!runningRef.current) launch();
  }, [launch, rerunTargets]);
  /** What the confirmation is about: the pages with a result to replace, and the rest. */
  const rerunPlan = useMemo(() => {
    if (rerunTargets === null) return null;
    const again: {doc: DocJob; page: PageJob}[] = [];
    let fresh = 0;
    for (const x of flat) {
      if (!rerunTargets.has(x.page.id)) continue;
      if (x.page.state === 'done') again.push(x);
      else if (isPending(x.page)) fresh++;
    }
    return {again, fresh};
  }, [flat, rerunTargets]);

  /** Run on a selection: every selected page, after confirmation when any of them has a result. */
  const startSelected = useCallback(() => {
    if (flatRef.current.some(x => selection.has(x.page.id) && x.page.state === 'done')) {
      setRerunTargets(selection);
      return;
    }
    setDocs(d => requeue(d, selection));
    launch();
  }, [launch, selection]);

  /** Documents waiting for the user to confirm their removal (⌫ on a selection). */
  const [removeTargets, setRemoveTargets] = useState<string[] | null>(null);
  const cancelRemove = useCallback(() => setRemoveTargets(null), []);
  const confirmRemove = useCallback(() => {
    const targets = removeTargets;
    setRemoveTargets(null);
    for (const docId of targets ?? []) removeDoc(docId);
  }, [removeDoc, removeTargets]);

  const cancelPage = useCallback((pageId: string) => cancelRuns(new Set([pageId])), [cancelRuns]);

  const loadEngine = useCallback((eng: Engine) => void client.load(eng).catch(() => undefined), [client]);
  // Stops any run, unloads the engines (dispose resets their status) and removes the model files.
  const deleteModels = useCallback(async () => {
    stop();
    client.dispose();
    await deleteModelCaches();
  }, [client, stop]);

  const rotate = useCallback(
    (pageId: string) =>
      setDocs(d => updatePage(d, pageId, p => ({rotation: ((p.rotation + 90) % 360) as PageJob['rotation']}))),
    [],
  );

  const edit = useCallback(
    (pageId: string, text: string) => setDocs(d => updatePage(d, pageId, {text, edited: true})),
    [],
  );

  /** Cuts a region page from the page on screen and recognises it right away. */
  const recognizeRegion = useCallback(
    (docId: string, index: number, rect: {x: number; y: number; width: number; height: number}) => {
      const {docs: next, page} = addRegion(docsRef.current, docId, index, rect);
      if (page === null) return;
      touched.current = true;
      setDocs(requeue(next, new Set([page.id])));
      setSelected(page.id);
      if (!runningRef.current) launch();
      // The region is what the user is looking at; keep it on screen while it runs.
      follow.current = false;
    },
    [launch],
  );

  /** Runs the other engine on one page and keeps its reading beside the page's own. */
  const compare = useCallback(
    async (pageId: string) => {
      const page = findPage(docsRef.current, pageId);
      const doc = page === null ? null : docsRef.current.find(d => d.id === page.docId) ?? null;
      if (page === null || doc === null || page.engine === null || compareRun.current !== null) return;
      const other: Engine = page.engine === 'glm' ? cpuEngineRef.current : 'glm';
      const md = settingsRef.current.mode;
      const budget = DETAIL_PIXELS[settingsRef.current.detail];
      setComparing(true);
      setDocs(d =>
        updatePage(d, pageId, {
          compare: {
            state: 'running',
            engine: other,
            mode: other === 'glm' ? md : null,
            text: '',
            ms: null,
            tokens: null,
            segments: null,
            error: null,
          },
        }),
      );
      const patchCompare = (patch: Partial<NonNullable<PageJob['compare']>>) =>
        setDocs(d => updatePage(d, pageId, p => (p.compare === null ? {} : {compare: {...p.compare, ...patch}})));
      const result = await runOnce(doc, page, other, md, budget, compareRun, {
        onRaster: () => undefined,
        onToken: text =>
          setDocs(d =>
            updatePage(d, pageId, p =>
              p.compare === null ? {} : {compare: {...p.compare, text: p.compare.text + text}},
            ),
          ),
        onStage: () => undefined,
      });
      setComparing(false);
      if (result.kind === 'done') {
        patchCompare({
          state: 'done',
          text: result.text,
          ms: result.ms,
          tokens: result.tokens,
          segments: result.segments,
        });
      } else if (result.kind === 'error') {
        patchCompare({state: 'error', error: result.message});
      } else {
        setDocs(d => updatePage(d, pageId, {compare: null}));
      }
    },
    [runOnce],
  );

  const restoreSession = useCallback(async () => {
    setSession(null);
    const restored = await loadSession();
    if (restored === null || restored.length === 0) return;
    touched.current = true;
    setDocs(d => [...d, ...restored]);
  }, []);
  const discardSession = useCallback(() => {
    setSession(null);
    void clearSession();
  }, []);

  const counts = useMemo(() => countByState(docs), [docs]);
  const pending = counts.idle + counts.error + counts.cancelled;
  /** Selected pages that have not succeeded, and selected pages with a result (a rerun); the rest are in flight. */
  const picked = useMemo(() => {
    let pending = 0;
    let done = 0;
    for (const x of flat) {
      if (!selection.has(x.page.id)) continue;
      if (isPending(x.page)) pending++;
      else if (x.page.state === 'done') done++;
    }
    return {pending, done};
  }, [flat, selection]);

  /** Finished pages in scope: the selection when there is one, else everything. */
  const finished = useMemo(() => {
    const entries: {doc: DocJob; page: PageJob; name: string; label: string}[] = [];
    for (const {doc, page} of flat) {
      if (page.state !== 'done' || page.text.length === 0) continue;
      if (selection.size > 0 && !selection.has(page.id)) continue;
      entries.push({
        doc,
        page,
        name: outputName(pageStem(doc, page), pageExtension(page)),
        label: pageLabel(doc, page),
      });
    }
    return entries;
  }, [flat, selection]);

  const combined = useCallback(() => finished.map(e => `# ${e.label}\n\n${e.page.text}\n`).join('\n'), [finished]);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const exportAll = useCallback(() => {
    // One folder per document when there are several; PDF pages keep their order.
    const multi = new Set(finished.map(e => e.doc.id)).size > 1;
    download(
      zip([
        ...finished.map(e => ({
          name: multi ? `${e.doc.name.replace(/\.[^.]+$/, '')}/${e.name}` : e.name,
          text: e.page.text,
        })),
        {name: 'all.md', text: combined()},
      ]),
      `safeocr-${stamp()}.zip`,
    );
  }, [combined, finished]);
  const copyAll = useCallback(() => void navigator.clipboard.writeText(combined()), [combined]);

  /** One searchable PDF per document in scope (zipped when there are several). */
  const exportPdf = useCallback(async () => {
    setExporting(true);
    try {
      const byDoc = new Map<string, {doc: DocJob; pages: PdfPageInput[]}>();
      for (const {doc, page} of finished) {
        if (page.previewUrl === null) continue;
        const jpeg = await (await fetch(page.previewUrl)).arrayBuffer();
        const bitmap = await createImageBitmap(new Blob([jpeg], {type: 'image/jpeg'}));
        const width = page.width ?? bitmap.width;
        const height = page.height ?? bitmap.height;
        const lines =
          page.segments !== null && !page.edited
            ? page.segments.map(s => ({
                text: s.text,
                box: {
                  x: s.box.x / width,
                  y: s.box.y / height,
                  width: s.box.width / width,
                  height: s.box.height / height,
                },
              }))
            : textLines(page).map(text => ({text, box: null}));
        const entry = byDoc.get(doc.id) ?? {doc, pages: []};
        entry.pages.push({
          jpeg,
          width: bitmap.width,
          height: bitmap.height,
          pointWidth: page.pointWidth ?? (bitmap.width / 150) * 72,
          pointHeight: page.pointHeight ?? (bitmap.height / 150) * 72,
          lines,
        });
        byDoc.set(doc.id, entry);
        bitmap.close();
      }
      const pdfs: {name: string; blob: Blob}[] = [];
      for (const {doc, pages} of byDoc.values()) {
        pdfs.push({
          name: outputName(doc.name, 'pdf', '-searchable'),
          blob: await searchablePdf(pages, {title: doc.name}),
        });
      }
      if (pdfs.length === 1) download(pdfs[0].blob, pdfs[0].name);
      else if (pdfs.length > 1) {
        download(
          zip(
            await Promise.all(pdfs.map(async p => ({name: p.name, bytes: new Uint8Array(await p.blob.arrayBuffer())}))),
          ),
          `safeocr-${stamp()}-pdf.zip`,
        );
      }
    } finally {
      setExporting(false);
    }
  }, [finished]);

  const hits = useMemo(() => {
    const result: Record<string, number> = {};
    if (query.length === 0) return result;
    for (const {page} of flat) {
      const n = countHits(page, query);
      if (n > 0) result[page.id] = n;
    }
    return result;
  }, [flat, query]);

  const position = useMemo(() => {
    if (flat.length === 0) return -1;
    const index = selected === null ? -1 : flat.findIndex(x => x.page.id === selected);
    return index === -1 ? 0 : index;
  }, [flat, selected]);
  const current = position === -1 ? null : flat[position];
  const prev = useCallback(() => {
    if (position > 0) select(flat[position - 1].page.id, {range: false, toggle: false});
  }, [flat, position, select]);
  const next = useCallback(() => {
    if (position >= 0 && position < flat.length - 1) select(flat[position + 1].page.id, {range: false, toggle: false});
  }, [flat, position, select]);

  const rotateCurrent = useCallback(() => {
    if (current !== null) rotate(current.page.id);
  }, [current, rotate]);
  const regionOnCurrent = useCallback(
    (rect: {x: number; y: number; width: number; height: number}) => {
      if (current !== null) recognizeRegion(current.doc.id, current.page.index, rect);
    },
    [current, recognizeRegion],
  );
  const otherEngine: Engine | null =
    current === null || current.page.engine === null ? null : current.page.engine === 'glm' ? cpuEngine : 'glm';
  const canCompare =
    !comparing &&
    !running &&
    otherEngine !== null &&
    (otherEngine !== 'glm' || glm.ok === true) &&
    current !== null &&
    hasRun(current.page);

  // Keyboard: ←/→ pages, ⌘/Ctrl+⏎ runs, ⌘/Ctrl+A selects every page, ⌫ removes the selected files
  // (after confirming), Escape clears the selection. Text fields and dialogs keep their keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (editingTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (event.key === 'Escape') {
        setSelection(s => (s.size === 0 ? s : new Set()));
      } else if (event.key === 'ArrowLeft' && !meta) {
        prev();
      } else if (event.key === 'ArrowRight' && !meta) {
        next();
      } else if (event.key === 'Enter' && meta) {
        if (runningRef.current) return;
        if (selection.size > 0 ? picked.pending + picked.done > 0 : pending > 0) {
          event.preventDefault();
          if (selection.size > 0) startSelected();
          else start();
        }
      } else if ((event.key === 'a' || event.key === 'A') && meta) {
        if (flatRef.current.length === 0) return;
        event.preventDefault();
        setSelection(new Set(flatRef.current.map(x => x.page.id)));
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && selection.size > 0) {
        event.preventDefault();
        const docIds = new Set<string>();
        for (const {doc, page} of flatRef.current) if (selection.has(page.id)) docIds.add(doc.id);
        setRemoveTargets([...docIds]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [next, pending, picked, prev, selection, start, startSelected]);

  const hideSource = useCallback(() => updateSettings({sourceShown: false}), [updateSettings]);
  const showSource = useCallback(() => updateSettings({sourceShown: true}), [updateSettings]);
  const {dragging, handlers} = useFileDrop(addFiles);

  const removeNames = (removeTargets ?? []).map(id => docs.find(d => d.id === id)?.name ?? '').filter(n => n !== '');

  return (
    <div className="safeocr bg-base text-text flex h-dvh flex-col overflow-hidden" {...handlers}>
      <DropOverlay active={dragging} />
      <header className="border-surface0 bg-mantle flex min-h-12 shrink-0 items-center gap-3 border-b px-4 pt-[env(safe-area-inset-top)]">
        <span className="bg-blue text-crust flex h-6 w-6 items-center justify-center rounded-md">
          <Icon className="h-3.5 w-3.5" name="file" />
        </span>
        <span className="text-text text-sm font-bold tracking-tight">SafeOCR</span>
        <span className="text-subtext0 hidden text-xs sm:inline">
          Private OCR for images and PDFs — everything runs in this tab, nothing is uploaded
        </span>
        <div className="ml-auto">
          <SettingsMenu engine={engine} onChange={updateSettings} onDeleteModels={deleteModels} settings={settings} />
        </div>
      </header>

      <Toolbar
        detail={detail}
        engine={engine}
        glm={glm}
        mode={mode}
        onDetail={setDetail}
        onEngine={setEngine}
        onFiles={addFiles}
        onMode={setMode}
        onStart={start}
        onStartSelected={startSelected}
        onStop={stop}
        pending={pending}
        running={running}
        selectedCount={selection.size}
        selectedDone={picked.done}
        selectedPending={picked.pending}
        status={status}
      />

      {docs.length === 0 ? (
        <Welcome
          dragging={dragging}
          engine={engine}
          glm={glm}
          isolated={isolated}
          onDiscardSession={discardSession}
          onEngine={setEngine}
          onFiles={addFiles}
          onLoad={loadEngine}
          onRestoreSession={restoreSession}
          session={session}
          status={status}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <PageRail
            current={current?.page.id ?? null}
            docs={docs}
            hits={hits}
            onDeselect={deselect}
            onFiles={addFiles}
            onQuery={setQuery}
            onRemoveAll={clearAll}
            onRemoveDoc={removeDoc}
            onRemovePage={removeRegionPage}
            onRerun={requestRerun}
            onSelect={select}
            query={query}
            selection={selection}
            total={flat.length}
          />
          {/* Below lg the panes stack and the area scrolls as one; at lg each pane scrolls on its own. */}
          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
            {current === null ? null : sourceShown ? (
              <SourcePane
                activeLine={activeLine}
                doc={current.doc}
                onActiveLine={setActiveLine}
                onHide={hideSource}
                onNext={next}
                onPrev={prev}
                onRegion={regionOnCurrent}
                onRotate={rotateCurrent}
                page={current.page}
                position={position}
                total={flat.length}
              />
            ) : (
              <SourceHandle onShow={showSource} />
            )}
            <ResultPane
              activeLine={activeLine}
              canCompare={canCompare}
              doc={current?.doc ?? null}
              onActiveLine={setActiveLine}
              onCancel={cancelPage}
              onCompare={compare}
              onEdit={edit}
              onRerun={requestRerun}
              page={current?.page ?? null}
              query={query}
            />
          </main>
        </div>
      )}

      <StatusBar
        counts={counts}
        engine={engine}
        exporting={exporting}
        finished={finished.length}
        isolated={isolated}
        onCopyAll={copyAll}
        onExportAll={exportAll}
        onExportPdf={exportPdf}
        pending={pending}
        selectedCount={selection.size}
        status={status[engine]}
      />

      <ConfirmDialog
        confirmLabel={
          rerunPlan === null
            ? 'Rerun page'
            : rerunPlan.fresh > 0
            ? `Run ${rerunPlan.again.length + rerunPlan.fresh} pages`
            : rerunPlan.again.length === 1
            ? 'Rerun page'
            : `Rerun ${rerunPlan.again.length} pages`
        }
        onCancel={cancelRerun}
        onConfirm={confirmRerun}
        open={rerunPlan !== null && rerunPlan.again.length > 0}
        title={
          rerunPlan === null
            ? 'Rerun this page?'
            : rerunPlan.fresh > 0
            ? `Rerun ${rerunPlan.again.length === 1 ? 'one' : rerunPlan.again.length} of the ${
                rerunPlan.again.length + rerunPlan.fresh
              } selected pages?`
            : rerunPlan.again.length === 1
            ? 'Rerun this page?'
            : `Rerun ${rerunPlan.again.length} pages?`
        }>
        {rerunPlan !== null && rerunPlan.again.length > 0 ? (
          <>
            <p>
              {rerunPlan.again.length === 1 ? (
                <>
                  <span className="text-text font-medium">
                    {pageLabel(rerunPlan.again[0].doc, rerunPlan.again[0].page)}
                  </span>{' '}
                  is processed again
                </>
              ) : (
                <>
                  <span className="text-text font-medium">{rerunPlan.again.length} pages</span> that have a result are
                  processed again
                </>
              )}
              {rerunPlan.fresh > 0
                ? `, along with the ${rerunPlan.fresh === 1 ? 'one' : rerunPlan.fresh} selected ${
                    rerunPlan.fresh === 1 ? 'page' : 'pages'
                  } that ${rerunPlan.fresh === 1 ? 'has' : 'have'} none,`
                : ''}{' '}
              with {ENGINE_LABEL[engine]}
              {engine === 'glm' ? ` · ${MODE_SPEC[mode].label}` : ''} · {DETAIL_LABEL[detail]}
              {running ? ', after the pages already queued' : ''}.
            </p>
            <p className="mt-2">
              {rerunPlan.again.length === 1 ? 'Its current result is' : 'Current results are'} replaced once the new run
              succeeds.{' '}
              {rerunPlan.again.length === 1
                ? 'If the run fails or is stopped, the current result'
                : 'A page whose run fails or is stopped keeps the result it'}{' '}
              {rerunPlan.again.length === 1 ? 'is kept' : 'had'}.
            </p>
          </>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        confirmLabel={`Remove ${removeNames.length === 1 ? 'file' : `${removeNames.length} files`}`}
        onCancel={cancelRemove}
        onConfirm={confirmRemove}
        open={removeTargets !== null}
        title={removeNames.length === 1 ? 'Remove this file?' : `Remove ${removeNames.length} files?`}>
        <p>
          <span className="text-text font-medium">{removeNames.join(', ')}</span>
          {removeNames.length === 1 ? ' and its results are' : ' and their results are'} removed from this session. Any
          run on them stops.
        </p>
      </ConfirmDialog>
    </div>
  );
});
SafeOcrApp.displayName = 'SafeOcrApp';

export default SafeOcrApp;
