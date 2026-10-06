import {type FC, memo} from 'react';

import type {EngineStatus} from '@/lib/client';
import type {PageState} from '@/lib/jobs';
import {type Engine, ENGINE_LABEL} from '@/lib/protocol';

import Icon from './icons';
import {ENGINE_DOT, formatBytes, ghostButtonClass} from './paneShared';

interface Props {
  onCopyAll(): void;
  onExportAll(): void;
  onExportPdf(): void;
  engine: Engine;
  status: EngineStatus;
  counts: Record<PageState, number>;
  /** Pages Run would process. */
  pending: number;
  /** Pages with text to export, within the selection when there is one. */
  finished: number;
  /** Pages picked in the rail: exports are limited to them. */
  selectedCount: number;
  /** A PDF is being built. */
  exporting: boolean;
  isolated: boolean;
}

/** Engine state, batch progress and the export actions for everything (or the selection). */
const StatusBar: FC<Props> = memo(
  ({
    engine,
    status,
    counts,
    pending,
    finished,
    selectedCount,
    exporting,
    isolated,
    onCopyAll,
    onExportAll,
    onExportPdf,
  }) => {
    const scope = selectedCount > 0 ? 'selected' : 'all';
    const inProgress = counts.running + counts.queued;
    const progress =
      status.state === 'loading' && status.total > 0 ? Math.min(100, (100 * status.loaded) / status.total) : null;

    return (
      <footer className="border-surface0 bg-mantle text-subtext0 relative flex min-h-9 shrink-0 items-center gap-4 overflow-hidden border-t pb-[env(safe-area-inset-bottom)] pl-4 pr-2 text-xs">
        {progress !== null ? (
          <div className="bg-blue absolute left-0 top-0 h-0.5 transition-[width]" style={{width: `${progress}%`}} />
        ) : null}
        <span className="flex min-w-0 shrink items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ENGINE_DOT[status.state]}`} />
          <span className="text-subtext1 shrink-0 font-medium">{ENGINE_LABEL[engine]}</span>
          <span className="min-w-0 truncate">
            {status.state === 'ready'
              ? 'ready'
              : status.state === 'loading'
              ? status.total > 0 && status.loaded < status.total
                ? `downloading ${formatBytes(status.loaded)} / ${formatBytes(status.total)}`
                : status.total > 0
                ? 'initialising…'
                : 'starting…'
              : status.state === 'error'
              ? 'failed to load'
              : 'loads when you press Run'}
          </span>
        </span>
        <span className="hidden truncate sm:inline">
          {counts.done} done · {inProgress} in progress · {pending} pending
        </span>
        <span
          className="shrink-0 sm:hidden"
          title={`${counts.done} done · ${inProgress} in progress · ${pending} pending`}>
          {counts.done}/{counts.done + inProgress + pending} done
        </span>
        {!isolated ? (
          <span
            className="text-yellow hidden shrink-0 items-center gap-1 md:flex"
            title="No cross-origin isolation (COOP/COEP headers missing): WebAssembly runs on one thread">
            <Icon className="h-3.5 w-3.5" name="alert" />
            single-threaded
          </span>
        ) : null}
        <span className="ml-auto hidden shrink-0 items-center gap-1.5 lg:flex">
          <Icon className="h-3.5 w-3.5" name="shield" />
          Nothing leaves your browser
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1 lg:ml-0">
          <button
            aria-label={`Copy ${scope} results`}
            className={ghostButtonClass}
            disabled={finished === 0}
            onClick={onCopyAll}
            title={`Copy every ${scope === 'selected' ? 'selected ' : ''}result, one section per page`}
            type="button">
            <Icon className="h-3.5 w-3.5" name="copy" />
            <span className="hidden sm:inline">Copy {scope}</span>
          </button>
          <button
            aria-label={`Download ${scope} results as a zip`}
            className={ghostButtonClass}
            disabled={finished === 0}
            onClick={onExportAll}
            title={`One file per page${
              scope === 'selected' ? ' of the selection' : ''
            } plus all.md, zipped (one folder per document)`}
            type="button">
            <Icon className="h-3.5 w-3.5" name="download" />
            <span className="hidden sm:inline">Download {scope} (.zip)</span>
          </button>
          <button
            aria-label={`Download ${scope} pages as searchable PDF`}
            className={ghostButtonClass}
            disabled={finished === 0 || exporting}
            onClick={onExportPdf}
            title={`One PDF per document${
              scope === 'selected' ? ' (selected pages)' : ''
            }: the scans with an invisible, searchable text layer`}
            type="button">
            <Icon
              className={`h-3.5 w-3.5 ${exporting ? 'motion-safe:animate-spin' : ''}`}
              name={exporting ? 'loader' : 'file'}
            />
            <span className="hidden sm:inline">{exporting ? 'Building PDF…' : 'Searchable PDF'}</span>
          </button>
        </div>
      </footer>
    );
  },
);
StatusBar.displayName = 'StatusBar';

export default StatusBar;
