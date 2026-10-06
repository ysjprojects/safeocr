import {type ChangeEvent, type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {formulaToMathML, tableToCsv, tableToMarkdown} from '@/lib/convert';
import {download, outputName} from '@/lib/export';
import {
  type CompareResult,
  type DocJob,
  type PageJob,
  hasRun,
  lineConfidence,
  pageExtension,
  pageLabel,
  pageStem,
  textLines,
} from '@/lib/jobs';
import {ENGINE_LABEL, MODE_SPEC} from '@/lib/protocol';

import DiffView from './DiffView';
import Icon from './icons';
import OcrMarkdown from './OcrMarkdown';
import {
  CONFIDENCE,
  CONFIDENCE_TEXT,
  confidenceBand,
  formatSeconds,
  ghostButtonClass,
  iconButtonClass,
  primaryButtonClass,
  StateBadge,
} from './paneShared';

interface Props {
  onCancel(pageId: string): void;
  onRerun(pageId: string): void;
  onShowSource(): void;
  /** The user changed the text by hand (the app stores it and marks the page edited). */
  onEdit(pageId: string, text: string): void;
  /** Run the other engine on this page, for the Compare tab. */
  onCompare(pageId: string): void;
  /** Pointer is over a text line (or left); mirrors the scan's boxes. */
  onActiveLine(line: number | null): void;
  doc: DocJob | null;
  page: PageJob | null;
  sourceShown: boolean;
  /** Line highlighted from the scan pane. */
  activeLine: number | null;
  /** Search query to highlight (case-insensitive); '' for none. */
  query: string;
  /** Whether Compare is possible right now (other engine usable, nothing running). */
  canCompare: boolean;
}

type Tab = 'rendered' | 'source' | 'compare';

const MIME: Record<string, string> = {
  md: 'text/markdown',
  html: 'text/html',
  tex: 'application/x-tex',
  txt: 'text/plain',
};

const COPIED_MS = 1500;

/** Which button shows "Copied": the page text or its conversion (table/formula). */
type Copied = 'text' | 'converted';

/** The recognised text of the selected page: rendered Markdown, confidence-tinted lines or a diff; copy, download, edit. */
const ResultPane: FC<Props> = memo(
  ({
    activeLine,
    canCompare,
    doc,
    page,
    query,
    sourceShown,
    onActiveLine,
    onCancel,
    onCompare,
    onEdit,
    onRerun,
    onShowSource,
  }) => {
    const [tab, setTab] = useState<Tab>('rendered');
    const [editing, setEditing] = useState(false);
    const [copied, setCopied] = useState<Copied | null>(null);

    const pageId = page?.id ?? null;
    const pageState = page?.state ?? null;
    const compare = page?.compare ?? null;
    const compareState = compare?.state ?? null;

    // Streaming output is shown as source (re-rendering Markdown per token is wasteful); the rendered
    // view comes back once the page finishes. Hand edits end with the page they were made on.
    useEffect(() => {
      setTab(pageState === 'running' ? 'source' : 'rendered');
      setEditing(false);
      setCopied(null);
    }, [pageId, pageState]);

    // Jump to the diff when a compare run on this very page finishes.
    const lastCompare = useRef<{pageId: string | null; state: CompareResult['state'] | null}>({pageId, state: null});
    useEffect(() => {
      const was = lastCompare.current;
      lastCompare.current = {pageId, state: compareState};
      if (was.pageId === pageId && was.state === 'running' && compareState === 'done') setTab('compare');
    }, [compareState, pageId]);

    const showRendered = useCallback(() => setTab('rendered'), []);
    const showSource = useCallback(() => setTab('source'), []);
    const showCompare = useCallback(() => setTab('compare'), []);
    const toggleEditing = useCallback(() => setEditing(on => !on), []);
    const cancel = useCallback(() => {
      if (pageId !== null) onCancel(pageId);
    }, [onCancel, pageId]);
    const rerun = useCallback(() => {
      if (pageId !== null) onRerun(pageId);
    }, [onRerun, pageId]);
    const runCompare = useCallback(() => {
      if (pageId !== null) onCompare(pageId);
    }, [onCompare, pageId]);
    const edit = useCallback(
      (event: ChangeEvent<HTMLTextAreaElement>) => {
        if (pageId !== null) onEdit(pageId, event.target.value);
      },
      [onEdit, pageId],
    );

    const text = page?.text ?? '';
    const copy = useCallback(async (value: string, what: Copied) => {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied(null), COPIED_MS);
    }, []);
    const copyText = useCallback(() => copy(text, 'text'), [copy, text]);
    const copyMarkdownTable = useCallback(() => copy(tableToMarkdown(text), 'converted'), [copy, text]);
    const copyMathML = useCallback(() => copy(formulaToMathML(text), 'converted'), [copy, text]);

    const save = useCallback(() => {
      if (doc === null || page === null) return;
      const extension = pageExtension(page);
      download(
        new Blob([page.text], {type: `${MIME[extension] ?? 'text/plain'};charset=utf-8`}),
        outputName(pageStem(doc, page), extension),
      );
    }, [doc, page]);
    const saveCsv = useCallback(() => {
      if (doc === null || page === null) return;
      download(
        new Blob([tableToCsv(page.text)], {type: 'text/csv;charset=utf-8'}),
        outputName(pageStem(doc, page), 'csv'),
      );
    }, [doc, page]);

    const glm = page?.engine === 'glm';
    const hasText = text.length > 0;
    const streaming = pageState === 'running';
    // Segments index the model's lines; once the text is edited by hand they no longer line up.
    const linked = page !== null && page.segments !== null && !page.edited;
    const lines = useMemo(() => (page === null ? [] : textLines(page)), [page]);
    const tints = useMemo(
      () =>
        linked && page !== null ? lines.map((_, i) => CONFIDENCE_TEXT[confidenceBand(lineConfidence(page, i))]) : null,
      [linked, lines, page],
    );
    const pattern = useMemo(
      () => (query.length === 0 ? null : new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')),
      [query],
    );

    // The Compare tab exists only while the page carries a compare result.
    const view: Tab = tab === 'compare' && compare === null ? 'rendered' : tab;
    const showTabs = page !== null && (glm || compare !== null);
    const conversion = glm && hasText ? page?.mode ?? null : null;
    const showExtras = linked || conversion === 'table' || conversion === 'formula';

    return (
      <section className="bg-base flex shrink-0 flex-col lg:min-h-0 lg:min-w-0 lg:flex-1">
        <div className="border-surface0 bg-mantle flex h-10 shrink-0 items-center gap-3 overflow-hidden border-b pl-4 pr-2">
          <span className="text-subtext0 text-xs font-semibold uppercase tracking-wider">Text</span>
          {showTabs ? (
            <div className="border-surface1 bg-base flex rounded-md border p-0.5">
              {glm ? (
                <>
                  <TabButton active={view === 'rendered'} label="Rendered" onClick={showRendered} />
                  <TabButton active={view === 'source'} label="Source" onClick={showSource} />
                </>
              ) : (
                <TabButton active={view !== 'compare'} label="Lines" onClick={showSource} />
              )}
              {compare !== null ? (
                <TabButton active={view === 'compare'} label="Compare" onClick={showCompare} />
              ) : null}
            </div>
          ) : null}
          {page !== null ? <StateBadge state={page.state} /> : null}
          {page !== null && page.engine !== null ? (
            <span className="font-code text-subtext0 min-w-0 flex-1 truncate text-[11px]">
              {ENGINE_LABEL[page.engine]}
              {glm && page.mode !== null ? ` · ${MODE_SPEC[page.mode].label}` : ''}
              {page.ms !== null ? ` · ${formatSeconds(page.ms)}` : ''}
              {page.tokens !== null ? ` · ${page.tokens} ${glm ? 'tokens' : 'lines'}` : ''}
              {page.edited ? (
                <>
                  {' · '}
                  <span className="text-peach">edited</span>
                </>
              ) : null}
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {streaming ? (
              <button className={ghostButtonClass} onClick={cancel} type="button">
                Cancel
              </button>
            ) : null}
            {page !== null && hasRun(page) ? (
              <>
                <button
                  aria-label="Rerun"
                  className={ghostButtonClass}
                  onClick={rerun}
                  title="Process this page again with the current engine and settings"
                  type="button">
                  <Icon className="h-3.5 w-3.5" name="refresh" />
                  <span className="hidden 2xl:inline">Rerun</span>
                </button>
                {canCompare && compareState !== 'running' ? (
                  <button
                    aria-label="Compare"
                    className={ghostButtonClass}
                    onClick={runCompare}
                    title="Compare with the other engine"
                    type="button">
                    <Icon className="h-3.5 w-3.5" name="columns" />
                    <span className="hidden 2xl:inline">Compare</span>
                  </button>
                ) : null}
                <button
                  aria-label={editing ? 'Finish editing' : 'Edit'}
                  className={editing ? primaryButtonClass : ghostButtonClass}
                  onClick={toggleEditing}
                  title={editing ? 'Finish editing' : 'Correct the text by hand'}
                  type="button">
                  <Icon className="h-3.5 w-3.5" name={editing ? 'check' : 'edit'} />
                  <span className={editing ? '' : 'hidden 2xl:inline'}>{editing ? 'Done' : 'Edit'}</span>
                </button>
              </>
            ) : null}
            {!sourceShown ? (
              <button
                aria-label="Show scan"
                className={iconButtonClass}
                onClick={onShowSource}
                title="Show the scan beside the text"
                type="button">
                <Icon name="image" />
              </button>
            ) : null}
            <button
              aria-label="Copy"
              className={ghostButtonClass}
              disabled={!hasText}
              onClick={copyText}
              title="Copy the text"
              type="button">
              <Icon className="h-3.5 w-3.5" name={copied === 'text' ? 'check' : 'copy'} />
              <span className="hidden 2xl:inline">{copied === 'text' ? 'Copied' : 'Copy'}</span>
            </button>
            <button className={primaryButtonClass} disabled={!hasText} onClick={save} type="button">
              <Icon className="h-3.5 w-3.5" name="download" />
              {hasText && page !== null ? `.${pageExtension(page)}` : 'Download'}
            </button>
          </div>
        </div>

        {showExtras ? (
          <div className="border-surface0 flex flex-wrap items-center gap-1 border-b px-4 py-1.5">
            {conversion === 'table' ? (
              <>
                <button className={ghostButtonClass} onClick={saveCsv} title="Download the table as CSV" type="button">
                  <Icon className="h-3.5 w-3.5" name="download" />
                  CSV
                </button>
                <button
                  className={ghostButtonClass}
                  onClick={copyMarkdownTable}
                  title="Copy the table as Markdown"
                  type="button">
                  <Icon className="h-3.5 w-3.5" name={copied === 'converted' ? 'check' : 'copy'} />
                  {copied === 'converted' ? 'Copied' : 'Markdown table'}
                </button>
              </>
            ) : null}
            {conversion === 'formula' ? (
              <button
                className={ghostButtonClass}
                onClick={copyMathML}
                title="Copy the formula as MathML"
                type="button">
                <Icon className="h-3.5 w-3.5" name={copied === 'converted' ? 'check' : 'copy'} />
                {copied === 'converted' ? 'Copied' : 'MathML'}
              </button>
            ) : null}
            {linked ? (
              <span className="text-subtext0 ml-auto flex items-center gap-3 text-[11px]">
                <span className="flex items-center gap-1">
                  <span className="bg-yellow/20 h-3 w-3 rounded-sm" />
                  {`< ${CONFIDENCE.LOW * 100} %`}
                </span>
                <span className="flex items-center gap-1">
                  <span className="bg-red/20 h-3 w-3 rounded-sm" />
                  {`< ${CONFIDENCE.VERY_LOW * 100} %`}
                </span>
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
          {doc === null || page === null ? (
            <div className="text-subtext0 flex h-full flex-col items-center justify-center gap-2 text-center">
              <Icon className="h-6 w-6" name="file" />
              <p className="text-text text-sm font-medium">No page selected</p>
              <p className="max-w-xs text-xs leading-relaxed">
                Pick a page on the left. Results stream in here while a run is in progress.
              </p>
            </div>
          ) : (
            <>
              <p className="text-text mb-3 truncate text-xs font-medium" title={pageLabel(doc, page)}>
                {pageLabel(doc, page)}
              </p>
              {page.error !== null ? (
                <p className="font-code border-red/40 bg-red/10 text-red mb-3 break-words rounded-lg border px-3 py-2 text-xs">
                  {page.error}
                </p>
              ) : null}
              {page.previous !== null ? (
                <p className="text-subtext0 mb-3 text-[11px]">
                  Rerunning. The previous result is kept until this run succeeds.
                </p>
              ) : null}
              {streaming && page.stage !== null ? (
                <p className="font-code text-blue mb-3 flex items-center gap-2 text-[11px]">
                  <Icon className="h-3.5 w-3.5 motion-safe:animate-spin" name="loader" />
                  {page.stage}
                </p>
              ) : null}
              {editing ? (
                <textarea
                  aria-label="Edit the recognised text"
                  className="font-code border-surface1 bg-mantle text-text focus:border-blue touch:text-md min-h-[16rem] w-full rounded-md border p-3 text-xs leading-relaxed focus:ring-0"
                  onChange={edit}
                  spellCheck={false}
                  value={page.text}
                />
              ) : view === 'compare' && compare !== null ? (
                <CompareView
                  base={page.text}
                  baseLabel={page.engine === null ? '' : ENGINE_LABEL[page.engine]}
                  compare={compare}
                />
              ) : hasText ? (
                view === 'rendered' && glm && page.mode !== null ? (
                  <OcrMarkdown mode={page.mode} text={page.text} />
                ) : (
                  <div className="font-code text-text text-xs leading-relaxed">
                    {lines.map((line, i) => (
                      <Line
                        active={i === activeLine}
                        cursor={streaming && i === lines.length - 1}
                        index={i}
                        key={i}
                        onActiveLine={linked ? onActiveLine : null}
                        pattern={pattern}
                        text={line}
                        tint={tints?.[i] ?? ''}
                      />
                    ))}
                  </div>
                )
              ) : streaming ? (
                <p className="text-subtext0 text-xs motion-safe:animate-pulse">
                  {glm ? 'encoding the image…' : 'working…'}
                </p>
              ) : page.state === 'done' ? (
                <p className="text-subtext0 text-xs">No text was found on this page.</p>
              ) : (
                <p className="text-subtext0 text-xs">Not processed yet. Press Run to recognise every pending page.</p>
              )}
            </>
          )}
        </div>
      </section>
    );
  },
);
ResultPane.displayName = 'ResultPane';

interface LineProps {
  /** null when the page's segments do not line up with its text (GLM-OCR, hand-edited). */
  onActiveLine: ((line: number | null) => void) | null;
  active: boolean;
  /** Streaming cursor after the text. */
  cursor: boolean;
  index: number;
  /** Case-insensitive search pattern with one capture group, or null for no search. */
  pattern: RegExp | null;
  text: string;
  /** Confidence tint class ('' for a confident line). */
  tint: string;
}

/** One line of plain output: confidence tint, search highlight, hover link to the scan. */
const Line: FC<LineProps> = memo(({active, cursor, index, onActiveLine, pattern, text, tint}) => {
  const enter = useCallback(() => onActiveLine?.(index), [index, onActiveLine]);
  const leave = useCallback(() => onActiveLine?.(null), [onActiveLine]);
  const content = useMemo(() => {
    if (text.length === 0) return '\u00a0';
    if (pattern === null) return text;
    return text.split(pattern).map((part, i) =>
      i % 2 === 1 ? (
        <mark className="bg-yellow/40 text-text rounded-sm" key={i}>
          {part}
        </mark>
      ) : (
        part
      ),
    );
  }, [pattern, text]);
  return (
    <div
      className={`-mx-1 whitespace-pre-wrap break-words rounded px-1 ${active ? 'ring-blue bg-blue/10 ring-1' : tint}`}
      onPointerEnter={onActiveLine === null ? undefined : enter}
      onPointerLeave={onActiveLine === null ? undefined : leave}>
      {content}
      {cursor ? <span className="text-blue motion-safe:animate-pulse">▌</span> : null}
    </div>
  );
});
Line.displayName = 'Line';

/** The other engine's run of the page: progress, failure, or a word diff against the page's text. */
const CompareView: FC<{compare: CompareResult; base: string; baseLabel: string}> = memo(
  ({base, baseLabel, compare}) => {
    if (compare.state === 'running') {
      return (
        <p className="font-code text-blue flex items-center gap-2 text-[11px]">
          <Icon className="h-3.5 w-3.5 motion-safe:animate-spin" name="loader" />
          Running {ENGINE_LABEL[compare.engine]}…
        </p>
      );
    }
    if (compare.state === 'error') {
      return (
        <p className="font-code border-red/40 bg-red/10 text-red break-words rounded-lg border px-3 py-2 text-xs">
          {compare.error ?? 'The comparison failed.'}
        </p>
      );
    }
    return (
      <>
        <p className="font-code text-subtext0 mb-3 text-[11px]">
          {ENGINE_LABEL[compare.engine]}
          {compare.engine === 'glm' && compare.mode !== null ? ` · ${MODE_SPEC[compare.mode].label}` : ''}
          {compare.ms !== null ? ` · ${formatSeconds(compare.ms)}` : ''}
          {compare.tokens !== null ? ` · ${compare.tokens} ${compare.engine === 'glm' ? 'tokens' : 'lines'}` : ''}
        </p>
        <DiffView base={base} baseLabel={baseLabel} other={compare.text} otherLabel={ENGINE_LABEL[compare.engine]} />
      </>
    );
  },
);
CompareView.displayName = 'CompareView';

const TabButton: FC<{onClick(): void; active: boolean; label: string}> = memo(({active, label, onClick}) => (
  <button
    aria-pressed={active}
    className={`rounded px-2.5 py-0.5 text-xs font-semibold transition ${
      active ? 'bg-surface0 text-text shadow-sm' : 'text-subtext0 hover:text-text'
    }`}
    onClick={onClick}
    type="button">
    {label}
  </button>
));
TabButton.displayName = 'TabButton';

export default ResultPane;
