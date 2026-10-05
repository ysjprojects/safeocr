import {type ChangeEvent, type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {getOcrClient} from '@/lib/client';
import {download, outputName, zip} from '@/lib/export';
import {closePdf, countPages, isPdf, rasterize} from '@/lib/inputs';
import {
  type DocJob,
  countByState,
  findPage,
  firstQueued,
  newId,
  newPage,
  pageExtension,
  pageLabel,
  pageStem,
  queueAll,
  unqueueAll,
  updatePage,
} from '@/lib/jobs';
import {
  type Detail,
  type Engine,
  type Mode,
  DETAIL_LABEL,
  DETAIL_PIXELS,
  ENGINE_LABEL,
  MODE_SPEC,
  MODES,
} from '@/lib/protocol';

import Dropzone from './Dropzone';
import EngineCard, {type WebGpuSupport} from './EngineCard';
import {ghostButtonClass, primaryButtonClass, selectClass} from './paneShared';
import QueueList from './QueueList';
import ResultPane from './ResultPane';

const DETAILS: Detail[] = ['low', 'standard', 'high'];

const detectWebGpu = async (): Promise<boolean> => {
  if (!('gpu' in navigator)) return false;
  const gpu: unknown = navigator.gpu;
  if (
    typeof gpu !== 'object' ||
    gpu === null ||
    !('requestAdapter' in gpu) ||
    typeof gpu.requestAdapter !== 'function'
  ) {
    return false;
  }
  try {
    const adapter: unknown = await gpu.requestAdapter();
    return adapter !== null && adapter !== undefined;
  } catch {
    return false;
  }
};

const SafeOcrApp: FC = memo(() => {
  const client = useMemo(() => getOcrClient(), []);
  const [status, setStatus] = useState(client.getStatus());
  useEffect(() => client.subscribe(setStatus), [client]);

  const [webgpu, setWebgpu] = useState<WebGpuSupport>('checking');
  const [deviceMemory, setDeviceMemory] = useState<number | null>(null);
  const [isolated, setIsolated] = useState(true);
  const [engine, setEngine] = useState<Engine>('paddle');
  const [mode, setMode] = useState<Mode>('text');
  const [detail, setDetail] = useState<Detail>('standard');
  const [docs, setDocs] = useState<DocJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // The batch loop reads the latest values without re-subscribing to React state.
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const settingsRef = useRef({engine, mode, detail});
  settingsRef.current = {engine, mode, detail};
  const runningRef = useRef(false);
  const loopActive = useRef(false);
  const currentRun = useRef<{pageId: string; runId: number} | null>(null);
  /** Whether the result pane follows the page being processed (until the user picks one). */
  const follow = useRef(true);

  useEffect(() => {
    detectWebGpu().then(ok => {
      setWebgpu(ok ? 'yes' : 'no');
      if (ok) setEngine('glm');
    });
    if ('deviceMemory' in navigator && typeof navigator.deviceMemory === 'number')
      setDeviceMemory(navigator.deviceMemory);
    setIsolated(crossOriginIsolated);
  }, []);

  // Models live in the worker; free them when the tab goes away or the user leaves the page.
  useEffect(() => {
    const onHide = () => client.dispose();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      client.dispose();
    };
  }, [client]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    const current = currentRun.current;
    if (current !== null) client.cancel(current.runId);
    setDocs(unqueueAll);
  }, [client]);

  const pump = useCallback(async () => {
    if (loopActive.current) return;
    loopActive.current = true;
    try {
      while (runningRef.current) {
        const page = firstQueued(docsRef.current);
        if (page === null) break;
        const doc = docsRef.current.find(d => d.id === page.docId);
        if (doc === undefined) continue;
        const {engine: eng, mode: md, detail: dt} = settingsRef.current;
        const budget = DETAIL_PIXELS[dt];

        try {
          await client.load(eng);
        } catch (error) {
          setDocs(d =>
            updatePage(d, page.id, {state: 'error', error: error instanceof Error ? error.message : String(error)}),
          );
          break;
        }
        if (!runningRef.current) break;

        setDocs(d =>
          updatePage(d, page.id, {
            state: 'running',
            engine: eng,
            mode: eng === 'glm' ? md : null,
            text: '',
            stage: 'preparing the image',
            error: null,
            ms: null,
            tokens: null,
          }),
        );
        if (follow.current) setSelected(page.id);

        let raster;
        try {
          raster = await rasterize(doc.file, page.index, budget);
        } catch (error) {
          setDocs(d =>
            updatePage(d, page.id, {
              state: 'error',
              stage: null,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          continue;
        }
        const previewUrl = URL.createObjectURL(raster.preview);
        setDocs(d =>
          updatePage(d, page.id, p => {
            if (p.previewUrl !== null) URL.revokeObjectURL(p.previewUrl);
            return {
              previewUrl,
              width: raster.width,
              height: raster.height,
              stage: eng === 'glm' ? 'encoding the image' : null,
            };
          }),
        );

        const {id, outcome} = client.run(eng, md, budget, raster.image, {
          onToken: text => setDocs(d => updatePage(d, page.id, p => ({text: p.text + text, stage: null}))),
          onStage: stage => setDocs(d => updatePage(d, page.id, {stage})),
        });
        currentRun.current = {pageId: page.id, runId: id};
        const result = await outcome;
        currentRun.current = null;
        setDocs(d =>
          updatePage(
            d,
            page.id,
            result.kind === 'done'
              ? {state: 'done', text: result.text, ms: result.ms, tokens: result.tokens, stage: null}
              : result.kind === 'cancelled'
              ? {state: 'cancelled', stage: null}
              : {state: 'error', error: result.message, stage: null},
          ),
        );
        // A PDF's parsed state can go once none of its pages are waiting; a retry reopens it.
        if (isPdf(doc.file) && !docsRef.current.some(d => d.id === doc.id && d.pages.some(p => p.state === 'queued'))) {
          await closePdf(doc.file);
        }
      }
    } finally {
      loopActive.current = false;
      runningRef.current = false;
      setRunning(false);
      setDocs(unqueueAll);
    }
  }, [client]);

  const start = useCallback(() => {
    follow.current = true;
    setDocs(queueAll);
    runningRef.current = true;
    setRunning(true);
    // The loop reads docsRef, which the render after setDocs refreshes; start it on the next tick.
    window.setTimeout(() => void pump(), 0);
  }, [pump]);

  const addFiles = useCallback((files: File[]) => {
    const added: DocJob[] = files.map(file => ({
      id: newId('d'),
      file,
      name: file.name,
      kind: isPdf(file) ? 'pdf' : 'image',
      pages: [],
      error: null,
    }));
    setDocs(d => [...d, ...added]);
    for (const doc of added) {
      countPages(doc.file).then(
        pages =>
          setDocs(d =>
            d.map(x =>
              x.id === doc.id ? {...x, pages: Array.from({length: pages}, (_, i) => newPage(doc.id, i))} : x,
            ),
          ),
        error =>
          setDocs(d =>
            d.map(x => (x.id === doc.id ? {...x, error: error instanceof Error ? error.message : String(error)} : x)),
          ),
      );
    }
  }, []);

  const removeDoc = useCallback(
    (docId: string) => {
      const current = currentRun.current;
      if (current !== null && docsRef.current.some(d => d.id === docId && d.pages.some(p => p.id === current.pageId))) {
        client.cancel(current.runId);
      }
      setDocs(d => {
        const doc = d.find(x => x.id === docId);
        if (doc !== undefined) {
          for (const page of doc.pages) if (page.previewUrl !== null) URL.revokeObjectURL(page.previewUrl);
          void closePdf(doc.file);
        }
        return d.filter(x => x.id !== docId);
      });
      setSelected(s => (docsRef.current.some(d => d.id === docId && d.pages.some(p => p.id === s)) ? null : s));
    },
    [client],
  );

  const clearAll = useCallback(() => {
    stop();
    for (const doc of docsRef.current) {
      for (const page of doc.pages) if (page.previewUrl !== null) URL.revokeObjectURL(page.previewUrl);
      void closePdf(doc.file);
    }
    setDocs([]);
    setSelected(null);
  }, [stop]);

  const select = useCallback((pageId: string) => {
    follow.current = false;
    setSelected(pageId);
  }, []);

  const retry = useCallback(
    (pageId: string) => {
      setDocs(d => updatePage(d, pageId, {state: 'queued', error: null}));
      if (!runningRef.current) {
        runningRef.current = true;
        setRunning(true);
        window.setTimeout(() => void pump(), 0);
      }
    },
    [pump],
  );

  const cancelPage = useCallback(
    (pageId: string) => {
      const current = currentRun.current;
      if (current !== null && current.pageId === pageId) client.cancel(current.runId);
    },
    [client],
  );

  const loadEngine = useCallback((eng: Engine) => void client.load(eng).catch(() => undefined), [client]);
  const onMode = useCallback((event: ChangeEvent<HTMLSelectElement>) => setMode(event.target.value as Mode), []);
  const onDetail = useCallback((event: ChangeEvent<HTMLSelectElement>) => setDetail(event.target.value as Detail), []);

  const finished = useMemo(() => {
    const entries: {name: string; text: string; label: string}[] = [];
    for (const doc of docs) {
      for (const page of doc.pages) {
        if (page.state !== 'done' || page.text.length === 0) continue;
        entries.push({
          name: outputName(pageStem(doc, page), pageExtension(page)),
          text: page.text,
          label: pageLabel(doc, page),
        });
      }
    }
    return entries;
  }, [docs]);

  const combined = useCallback(() => finished.map(e => `# ${e.label}\n\n${e.text}\n`).join('\n'), [finished]);
  const exportAll = useCallback(() => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    download(
      zip([...finished.map(e => ({name: e.name, text: e.text})), {name: 'all.md', text: combined()}]),
      `safeocr-${stamp}.zip`,
    );
  }, [combined, finished]);
  const copyAll = useCallback(() => void navigator.clipboard.writeText(combined()), [combined]);

  const counts = useMemo(() => countByState(docs), [docs]);
  const pending = counts.idle + counts.error + counts.cancelled;
  const selectedPage = findPage(docs, selected);
  const selectedDoc = selectedPage === null ? null : docs.find(d => d.id === selectedPage.docId) ?? null;
  const engineReady = status[engine].state === 'ready';

  return (
    <div className="safeocr bg-plum-900 text-cream flex h-dvh flex-col overflow-hidden">
      <header className="border-plum-600/60 bg-plum-950/60 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="from-candy-400 bg-gradient-to-r to-white bg-clip-text text-lg font-extrabold tracking-tight text-transparent">
            SafeOCR
          </span>
          <span className="text-plum-300 hidden text-[11px] sm:inline">
            OCR that never leaves your browser · images &amp; PDFs · Markdown, tables, formulas
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-plum-200 flex items-center gap-1 text-[11px]">
            Output
            <select
              className={selectClass}
              disabled={engine !== 'glm' || running}
              onChange={onMode}
              title={MODE_SPEC[mode].hint}
              value={mode}>
              {MODES.map(m => (
                <option key={m} value={m}>
                  {MODE_SPEC[m].label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-plum-200 flex items-center gap-1 text-[11px]">
            Detail
            <select className={selectClass} disabled={running} onChange={onDetail} value={detail}>
              {DETAILS.map(d => (
                <option key={d} value={d}>
                  {DETAIL_LABEL[d]}
                </option>
              ))}
            </select>
          </label>
          {running ? (
            <button className={ghostButtonClass} onClick={stop} type="button">
              Stop
            </button>
          ) : (
            <button className={primaryButtonClass} disabled={pending === 0} onClick={start} type="button">
              Run {pending > 0 ? `(${pending} page${pending === 1 ? '' : 's'})` : ''} with {ENGINE_LABEL[engine]}
            </button>
          )}
          <button
            className={ghostButtonClass}
            disabled={finished.length === 0}
            onClick={copyAll}
            title="Copy every result"
            type="button">
            Copy all
          </button>
          <button
            className={ghostButtonClass}
            disabled={finished.length === 0}
            onClick={exportAll}
            title="One file per page plus all.md, zipped"
            type="button">
            Download all (.zip)
          </button>
          <button className={ghostButtonClass} disabled={docs.length === 0} onClick={clearAll} type="button">
            Clear
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="border-plum-600/60 flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-b p-3 lg:w-[400px] lg:border-b-0 lg:border-r">
          <div className="flex flex-col gap-2" role="radiogroup">
            <EngineCard
              deviceMemory={deviceMemory}
              engine="glm"
              onLoad={loadEngine}
              onSelect={setEngine}
              selected={engine === 'glm'}
              status={status.glm}
              webgpu={webgpu}
            />
            <EngineCard
              deviceMemory={deviceMemory}
              engine="paddle"
              onLoad={loadEngine}
              onSelect={setEngine}
              selected={engine === 'paddle'}
              status={status.paddle}
              webgpu={webgpu}
            />
          </div>
          {!isolated ? (
            <p className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
              This page is not cross-origin isolated (the server did not send the COOP/COEP headers from
              next.config.js), so WebAssembly runs on one thread and PP-OCRv5 is slower than it could be.
            </p>
          ) : null}
          <Dropzone compact={docs.length > 0} onFiles={addFiles} />
          {docs.length > 0 ? (
            <>
              <p className="font-code text-plum-300 text-[10.5px]">
                {counts.done} done · {counts.running + counts.queued} in progress · {pending} pending
                {engineReady ? '' : ` · ${ENGINE_LABEL[engine]} loads when you press Run`}
              </p>
              <QueueList docs={docs} onRemoveDoc={removeDoc} onRetry={retry} onSelect={select} selected={selected} />
            </>
          ) : null}
          <p className="text-plum-400 mt-auto pt-2 text-[10.5px] leading-relaxed">
            Nothing is uploaded: models are downloaded once from huggingface.co and cached by your browser, then every
            page is processed on your own machine. GLM-OCR is MIT-licensed; PP-OCRv5 is Apache-2.0.
          </p>
        </aside>
        <main className="min-h-0 flex-1">
          <ResultPane doc={selectedDoc} onCancel={cancelPage} page={selectedPage} />
        </main>
      </div>
    </div>
  );
});
SafeOcrApp.displayName = 'SafeOcrApp';

export default SafeOcrApp;
