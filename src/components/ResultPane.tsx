import {type FC, memo, useCallback, useEffect, useState} from 'react';

import {download, outputName} from '@/lib/export';
import {type DocJob, type PageJob, pageExtension, pageLabel, pageStem} from '@/lib/jobs';
import {ENGINE_LABEL, MODE_SPEC} from '@/lib/protocol';

import OcrMarkdown from './OcrMarkdown';
import {formatSeconds, ghostButtonClass, primaryButtonClass, STATE_CLASS, STATE_LABEL} from './paneShared';

interface Props {
  onCancel(pageId: string): void;
  doc: DocJob | null;
  page: PageJob | null;
}

type Tab = 'rendered' | 'source';

const MIME: Record<string, string> = {
  md: 'text/markdown',
  html: 'text/html',
  tex: 'application/x-tex',
  txt: 'text/plain',
};

const ResultPane: FC<Props> = memo(({doc, page, onCancel}) => {
  const [tab, setTab] = useState<Tab>('rendered');
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const pageId = page?.id ?? null;
  const pageState = page?.state ?? null;
  // Streaming output is shown as source (re-rendering Markdown per token is wasteful); the rendered
  // view comes back once the page finishes.
  useEffect(() => {
    setTab(pageState === 'running' ? 'source' : 'rendered');
    setCopied(false);
  }, [pageId, pageState]);

  const showRendered = useCallback(() => setTab('rendered'), []);
  const showSource = useCallback(() => setTab('source'), []);
  const togglePreview = useCallback(() => setShowPreview(v => !v), []);
  const cancel = useCallback(() => {
    if (pageId !== null) onCancel(pageId);
  }, [onCancel, pageId]);

  const copy = useCallback(async () => {
    if (page === null) return;
    await navigator.clipboard.writeText(page.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [page]);

  const save = useCallback(() => {
    if (doc === null || page === null) return;
    const extension = pageExtension(page);
    download(
      new Blob([page.text], {type: `${MIME[extension] ?? 'text/plain'};charset=utf-8`}),
      outputName(pageStem(doc, page), extension),
    );
  }, [doc, page]);

  if (doc === null || page === null) {
    return (
      <div className="text-plum-300 flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-plum-200 text-[13px] font-semibold">Nothing selected</p>
        <p className="max-w-sm text-[11.5px]">
          Add a file, enable an engine and press Run. Results appear here as they stream in; click any page on the left
          to review it.
        </p>
      </div>
    );
  }

  const plain = page.engine === 'paddle';
  const hasText = page.text.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-plum-600/60 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
        <span className="text-cream truncate text-[12.5px] font-bold" title={pageLabel(doc, page)}>
          {pageLabel(doc, page)}
        </span>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATE_CLASS[page.state]}`}>
          {STATE_LABEL[page.state]}
        </span>
        {page.engine !== null ? (
          <span className="font-code text-plum-300 text-[10.5px]">
            {ENGINE_LABEL[page.engine]}
            {page.engine === 'glm' && page.mode !== null ? ` · ${MODE_SPEC[page.mode].label}` : ''}
            {page.width !== null && page.height !== null ? ` · ${page.width}×${page.height}px` : ''}
            {page.ms !== null ? ` · ${formatSeconds(page.ms)}` : ''}
            {page.tokens !== null ? ` · ${page.tokens} ${page.engine === 'glm' ? 'tokens' : 'lines'}` : ''}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {page.state === 'running' ? (
            <button className={ghostButtonClass} onClick={cancel} type="button">
              Cancel
            </button>
          ) : null}
          <button className={ghostButtonClass} disabled={!hasText} onClick={copy} type="button">
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className={primaryButtonClass} disabled={!hasText} onClick={save} type="button">
            Download .{pageExtension(page)}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 lg:flex-row">
        {page.previewUrl !== null ? (
          <div className={`shrink-0 ${showPreview ? 'lg:w-56' : ''}`}>
            <button
              className="text-plum-300 mb-1 text-[10.5px] font-semibold hover:text-white"
              onClick={togglePreview}
              type="button">
              {showPreview ? 'hide preview' : 'show preview'}
            </button>
            {showPreview ? (
              <img
                alt={pageLabel(doc, page)}
                className="border-plum-600/60 max-h-48 w-auto rounded-lg border bg-white lg:max-h-none lg:w-full"
                src={page.previewUrl}
              />
            ) : null}
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          {!plain ? (
            <div className="mb-2 flex items-center gap-1">
              <TabButton active={tab === 'rendered'} label="Rendered" onClick={showRendered} />
              <TabButton active={tab === 'source'} label="Source" onClick={showSource} />
            </div>
          ) : null}
          {page.state === 'error' ? (
            <p className="font-code mb-2 rounded-lg border border-rose-400/50 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
              {page.error}
            </p>
          ) : null}
          {page.state === 'running' && page.stage !== null ? (
            <p className="font-code text-candy-200 mb-2 animate-pulse text-[10.5px]">{page.stage}</p>
          ) : null}
          {hasText ? (
            tab === 'rendered' && !plain && page.mode !== null ? (
              <OcrMarkdown mode={page.mode} text={page.text} />
            ) : (
              <pre className="text-plum-100 border-plum-600/60 bg-plum-950/60 font-code whitespace-pre-wrap break-words rounded-lg border p-3 text-[11.5px] leading-relaxed">
                {page.text}
                {page.state === 'running' ? <span className="text-candy-300 animate-pulse">▌</span> : null}
              </pre>
            )
          ) : page.state === 'running' ? (
            <p className="text-plum-300 animate-pulse text-[12px]">
              {page.engine === 'glm' ? 'encoding the image…' : 'working…'}
            </p>
          ) : page.state === 'done' ? (
            <p className="text-plum-300 text-[12px]">No text was found on this page.</p>
          ) : (
            <p className="text-plum-300 text-[12px]">Not processed yet.</p>
          )}
        </div>
      </div>
    </div>
  );
});
ResultPane.displayName = 'ResultPane';

const TabButton: FC<{onClick(): void; active: boolean; label: string}> = memo(({active, label, onClick}) => (
  <button
    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
      active ? 'bg-plum-700 text-white' : 'text-plum-300 hover:bg-plum-800 hover:text-white'
    }`}
    onClick={onClick}
    type="button">
    {label}
  </button>
));
TabButton.displayName = 'TabButton';

export default ResultPane;
