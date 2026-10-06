import {type ChangeEvent, type FC, type KeyboardEvent, type MouseEvent, memo, useCallback, useState} from 'react';

import {type DocJob, type PageJob, hasRun} from '@/lib/jobs';
import {type Mode} from '@/lib/protocol';

import {FilePicker} from './Dropzone';
import Icon from './icons';
import {formatSeconds, ghostButtonClass, iconButtonClass, StateBadge} from './paneShared';

export interface SelectModifiers {
  /** ⇧: select the range from the last plain click to this page. */
  range: boolean;
  /** ⌘ / Ctrl: add or remove this page without touching the rest. */
  toggle: boolean;
}

interface Props {
  onSelect(pageId: string, modifiers: SelectModifiers): void;
  onDeselect(): void;
  onRemoveDoc(docId: string): void;
  /** Remove one region page (whole documents are removed with onRemoveDoc). */
  onRemovePage(pageId: string): void;
  onRemoveAll(): void;
  onRerun(pageId: string): void;
  onFiles(files: File[]): void;
  /** Search across results: the query and its setter; `hits` has an entry per page with ≥1 hit. */
  onQuery(query: string): void;
  query: string;
  hits: Record<string, number>;
  docs: DocJob[];
  /** The page on screen. */
  current: string | null;
  /** Pages picked for Run. */
  selection: ReadonlySet<string>;
  total: number;
}

/** Short mode suffix for a row's engine line; text mode is the default and goes unsaid. */
const MODE_SUFFIX: Record<Mode, string> = {text: '', table: ' · Table', formula: ' · Formula'};

/** `GLM · Table` / `PP-OCRv5`: what ran on the page, for its second line. */
const engineLabel = (page: PageJob): string | null => {
  if (page.engine === null) return null;
  if (page.engine === 'paddle') return 'PP-OCRv5';
  return `GLM${page.mode === null ? '' : MODE_SUFFIX[page.mode]}`;
};

/** `Page 3 · region 2` for PDFs, `region 2` for images; the file name for an image's own page. */
const rowLabel = (doc: DocJob, page: PageJob): string => {
  const base = doc.kind === 'pdf' ? `Page ${page.index + 1}` : '';
  if (page.region === null) return base === '' ? doc.name : base;
  return base === '' ? `region ${page.region.n}` : `${base} · region ${page.region.n}`;
};

/**
 * The page navigator: every document and its pages as thumbnails with their OCR state. An image is
 * one page, so it is a single row; a PDF (or an image with regions cut from it) is a heading with
 * one row per page. Clicking shows a page and selects it; ⇧ and ⌘/Ctrl (or Select mode, for touch)
 * build a selection, which Run then limits itself to. A query dims the pages without hits and
 * counts the hits on the rest. Below the lg breakpoint the list folds away under its header so the
 * scan and the text get the screen.
 */
const PageRail: FC<Props> = memo(
  ({
    docs,
    current,
    selection,
    total,
    query,
    hits,
    onSelect,
    onDeselect,
    onRemoveDoc,
    onRemovePage,
    onRemoveAll,
    onRerun,
    onFiles,
    onQuery,
  }) => {
    /** Below lg the body is folded by default; the scan arrows still move between pages. */
    const [open, setOpen] = useState(false);
    const toggleOpen = useCallback(() => setOpen(v => !v), []);
    /** Taps add to or remove from the selection, for screens without ⌘/Ctrl. */
    const [selectMode, setSelectMode] = useState(false);
    const toggleSelectMode = useCallback(() => setSelectMode(v => !v), []);
    const pick = useCallback(
      (pageId: string, modifiers: SelectModifiers) => {
        onSelect(pageId, {range: modifiers.range, toggle: modifiers.toggle || selectMode});
        // A plain tap on a small screen is navigation: fold the list to show the page.
        if (!modifiers.range && !modifiers.toggle && !selectMode) setOpen(false);
      },
      [onSelect, selectMode],
    );
    const changeQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => onQuery(event.target.value), [onQuery]);
    const keyQuery = useCallback(
      (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Escape' || event.currentTarget.value === '') return;
        event.stopPropagation();
        onQuery('');
      },
      [onQuery],
    );
    const searching = query !== '';
    let hitCount = 0;
    let hitPages = 0;
    if (searching) {
      for (const n of Object.values(hits)) {
        if (n <= 0) continue;
        hitCount += n;
        hitPages += 1;
      }
    }
    const rowHits = (page: PageJob): number | null => (searching ? hits[page.id] ?? 0 : null);
    return (
      <aside className="border-surface0 bg-mantle flex shrink-0 select-none flex-col border-b lg:w-64 lg:border-b-0 lg:border-r">
        <div className="flex h-10 shrink-0 items-center gap-1 pl-4 pr-2">
          <span className="text-subtext0 min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider">
            {selection.size > 0 ? `${selection.size} of ${total} selected` : `${total} page${total === 1 ? '' : 's'}`}
          </span>
          {total > 1 ? (
            <button
              aria-pressed={selectMode}
              className={`${ghostButtonClass} ${open ? '' : 'hidden lg:inline-flex'} ${
                selectMode ? 'bg-surface0 text-text' : ''
              }`}
              onClick={toggleSelectMode}
              title={selectMode ? 'Stop picking pages' : 'Pick several pages by tapping them'}
              type="button">
              {selectMode ? 'Done' : 'Select'}
            </button>
          ) : null}
          {selection.size > 0 ? (
            <button
              className={`${ghostButtonClass} ${open ? '' : 'hidden lg:inline-flex'}`}
              onClick={onDeselect}
              title="Clear the selection (Esc)"
              type="button">
              Deselect
            </button>
          ) : null}
          <button
            aria-expanded={open}
            aria-label={open ? 'Hide the page list' : 'Show the page list'}
            className={`${iconButtonClass} lg:hidden`}
            onClick={toggleOpen}
            title={open ? 'Hide the page list' : 'Show the page list'}
            type="button">
            <Icon className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} name="chevronRight" />
          </button>
        </div>
        <div className={`${open ? 'flex' : 'hidden lg:flex'} min-h-0 flex-col lg:flex-1`}>
          {total > 0 ? (
            <div className="shrink-0 px-2 pb-2">
              <div className="relative">
                <Icon
                  className="text-overlay1 pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                  name="search"
                />
                <input
                  aria-label="Find in results"
                  className="border-surface1 bg-base text-text placeholder:text-overlay1 focus:border-blue touch:text-md w-full rounded-md py-1 pl-7 text-xs focus:ring-0"
                  onChange={changeQuery}
                  onKeyDown={keyQuery}
                  placeholder="Find in results"
                  type="search"
                  value={query}
                />
              </div>
              {searching ? (
                <p className="text-subtext0 pt-1 text-right text-[11px]">
                  {hitCount === 0
                    ? 'No matches'
                    : `${hitCount} hit${hitCount === 1 ? '' : 's'} on ${hitPages} page${hitPages === 1 ? '' : 's'}`}
                </p>
              ) : null}
            </div>
          ) : null}
          <ul className="flex max-h-56 min-h-0 flex-col gap-3 overflow-y-auto px-2 pb-2 lg:max-h-none lg:flex-1">
            {docs.map(doc => (
              <li key={doc.id}>
                {doc.kind === 'image' && doc.pages.length === 1 ? (
                  <PageRow
                    current={doc.pages[0].id === current}
                    hits={rowHits(doc.pages[0])}
                    label={doc.name}
                    onRemove={onRemoveDoc}
                    onRemovePage={onRemovePage}
                    onRerun={onRerun}
                    onSelect={pick}
                    page={doc.pages[0]}
                    selected={selection.has(doc.pages[0].id)}
                  />
                ) : (
                  <>
                    <div className="flex h-7 items-center gap-2 pl-2 pr-0.5">
                      <Icon
                        className="text-subtext0 h-3.5 w-3.5 shrink-0"
                        name={doc.kind === 'pdf' ? 'file' : 'image'}
                      />
                      <span className="text-text min-w-0 flex-1 truncate text-xs font-semibold" title={doc.name}>
                        {doc.name}
                      </span>
                      {doc.pages.length > 0 ? (
                        <span className="text-subtext0 shrink-0 text-[11px]">
                          {doc.pages.length} page{doc.pages.length === 1 ? '' : 's'}
                        </span>
                      ) : null}
                      <RemoveButton id={doc.id} onRemove={onRemoveDoc} title="Remove" />
                    </div>
                    {doc.error !== null ? (
                      <p className="font-code text-red break-words px-2 pb-1 text-[11px]">{doc.error}</p>
                    ) : null}
                    {doc.pages.length === 0 && doc.error === null ? (
                      <p className="text-subtext0 px-2 pb-1 text-[11px]">opening…</p>
                    ) : null}
                    {doc.pages.length > 0 ? (
                      <ul className="flex flex-col gap-0.5">
                        {doc.pages.map(page => (
                          <li key={page.id}>
                            <PageRow
                              current={page.id === current}
                              hits={rowHits(page)}
                              label={rowLabel(doc, page)}
                              onRemovePage={onRemovePage}
                              onRerun={onRerun}
                              onSelect={pick}
                              page={page}
                              selected={selection.has(page.id)}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
          {total > 1 && selection.size === 0 && !selectMode ? (
            <p className="text-subtext0 px-4 pb-2 text-[11px] leading-relaxed">
              <span className="touch:hidden">
                Click a page to run just that one; ⇧-click for a range, ⌘/Ctrl-click to add or remove.
              </span>
              <span className="touch:inline hidden">Tap a page to run just that one; Select picks several.</span>
            </p>
          ) : null}
          {selectMode ? (
            <p className="text-subtext0 px-4 pb-2 text-[11px] leading-relaxed">Tap pages to add or remove them.</p>
          ) : null}
          <div className="border-surface0 flex shrink-0 items-center gap-1 border-t p-2">
            <FilePicker className={`${ghostButtonClass} flex-1`} onFiles={onFiles} title="Or drop files anywhere">
              <Icon className="h-3.5 w-3.5" name="plus" />
              Add files
            </FilePicker>
            <button
              aria-label="Remove all files"
              className={iconButtonClass}
              onClick={onRemoveAll}
              title="Remove every file"
              type="button">
              <Icon className="h-3.5 w-3.5" name="trash" />
            </button>
          </div>
        </div>
      </aside>
    );
  },
);
PageRail.displayName = 'PageRail';

const RemoveButton: FC<{onRemove(id: string): void; id: string; title: string}> = memo(({id, onRemove, title}) => {
  const remove = useCallback(() => onRemove(id), [id, onRemove]);
  return (
    <button aria-label={title} className={iconButtonClass} onClick={remove} title={title} type="button">
      <Icon className="h-3.5 w-3.5" name="x" />
    </button>
  );
});
RemoveButton.displayName = 'RemoveButton';

const PageRow: FC<{
  onSelect(pageId: string, modifiers: SelectModifiers): void;
  onRerun(pageId: string): void;
  /** Present when the row stands for its whole document (an image), which the button removes. */
  onRemove?(docId: string): void;
  /** Removes the page when it is a region. */
  onRemovePage(pageId: string): void;
  page: PageJob;
  label: string;
  /** Hits of the query on this page; null while there is no query. */
  hits: number | null;
  current: boolean;
  selected: boolean;
}> = memo(({page, label, hits, current, selected, onSelect, onRerun, onRemove, onRemovePage}) => {
  const select = useCallback(
    (event: MouseEvent<HTMLButtonElement>) =>
      onSelect(page.id, {range: event.shiftKey, toggle: event.metaKey || event.ctrlKey}),
    [onSelect, page.id],
  );
  const rerun = useCallback(() => onRerun(page.id), [onRerun, page.id]);
  const engine = engineLabel(page);
  const turn = (page.rotation - page.previewRotation + 360) % 360;
  return (
    <div
      className={`flex items-center gap-1 rounded-lg pr-1 transition ${
        current ? 'bg-blue/10 ring-blue/40 ring-1' : 'hover:bg-surface0/60'
      } ${page.region !== null ? 'ml-3' : ''} ${hits === 0 ? 'opacity-50' : ''}`}>
      <button
        aria-current={current ? 'true' : undefined}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2 text-left"
        onClick={select}
        title={label}
        type="button">
        <span className="relative shrink-0">
          <span
            className={`block h-12 w-9 overflow-hidden rounded ${selected ? 'ring-blue ring-2' : ''} ${
              page.previewUrl !== null ? `border ${selected ? 'border-blue' : 'border-surface1'}` : ''
            }`}>
            {page.previewUrl !== null ? (
              // Plain <img>: the preview is a local blob URL and the site-wide image rules fit it fine.
              <img
                alt=""
                className="h-full w-full bg-white object-cover object-top"
                src={page.previewUrl}
                style={{transform: `rotate(${turn}deg)`}}
              />
            ) : (
              <span
                className="bg-surface0 text-subtext0 flex h-full w-full items-center justify-center text-[11px] font-semibold"
                style={{transform: `rotate(${turn}deg)`}}>
                {page.index + 1}
              </span>
            )}
          </span>
          {selected ? (
            <span className="bg-blue text-crust absolute -left-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full">
              <Icon className="h-2.5 w-2.5" name="check" />
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span
              className={`min-w-0 flex-1 truncate text-xs font-medium ${
                current || selected ? 'text-text' : 'text-subtext1'
              }`}>
              {label}
            </span>
            {hits !== null && hits > 0 ? (
              <span className="bg-yellow/30 text-text shrink-0 rounded-full px-1.5 text-[10px] font-semibold">
                {hits}
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            <StateBadge state={page.state} />
            {page.state === 'done' && page.ms !== null ? (
              <span className="font-code text-subtext0 shrink-0 text-[10px]">{formatSeconds(page.ms)}</span>
            ) : null}
            {engine !== null ? (
              <span className="text-subtext0 min-w-0 truncate text-[10px]" title={engine}>
                · {engine}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {hasRun(page) ? (
        <button aria-label="Rerun" className={iconButtonClass} onClick={rerun} title="Rerun this page" type="button">
          <Icon className="h-3.5 w-3.5" name="refresh" />
        </button>
      ) : null}
      {page.region !== null ? <RemoveButton id={page.id} onRemove={onRemovePage} title="Remove this region" /> : null}
      {onRemove !== undefined ? <RemoveButton id={page.docId} onRemove={onRemove} title="Remove" /> : null}
    </div>
  );
});
PageRow.displayName = 'PageRow';

export default PageRail;
