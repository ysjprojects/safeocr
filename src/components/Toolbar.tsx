import {type ChangeEvent, type FC, memo, useCallback} from 'react';

import type {EngineStatus} from '@/lib/client';
import type {GlmSupport} from '@/lib/device';
import {
  type Detail,
  type Engine,
  type Mode,
  DETAIL_LABEL,
  DETAILS,
  ENGINE_LABEL,
  ENGINES,
  MODE_SPEC,
  MODES,
  RECOMMENDED_ENGINE,
} from '@/lib/protocol';

import {FilePicker} from './Dropzone';
import Icon from './icons';
import {dangerButtonClass, ENGINE_DOT, primaryButtonClass, secondaryButtonClass, selectClass} from './paneShared';

interface Props {
  onEngine(engine: Engine): void;
  onMode(mode: Mode): void;
  onDetail(detail: Detail): void;
  onFiles(files: File[]): void;
  onStart(): void;
  onStartSelected(): void;
  onStop(): void;
  engine: Engine;
  mode: Mode;
  detail: Detail;
  status: Record<Engine, EngineStatus>;
  glm: GlmSupport;
  running: boolean;
  /** Pages a plain Run would process. */
  pending: number;
  /** Pages picked in the rail: how many have not succeeded (a run) and how many have a result (a rerun). */
  selectedCount: number;
  selectedPending: number;
  selectedDone: number;
}

/**
 * Settings and the Run button: everything a run depends on, in one row. With pages selected, Run
 * is limited to them and running everything moves to a second button.
 */
const Toolbar: FC<Props> = memo(
  ({
    engine,
    mode,
    detail,
    status,
    glm,
    running,
    pending,
    selectedCount,
    selectedPending,
    selectedDone,
    onEngine,
    onMode,
    onDetail,
    onFiles,
    onStart,
    onStartSelected,
    onStop,
  }) => {
    const changeMode = useCallback(
      (event: ChangeEvent<HTMLSelectElement>) => onMode(event.target.value as Mode),
      [onMode],
    );
    const changeDetail = useCallback(
      (event: ChangeEvent<HTMLSelectElement>) => onDetail(event.target.value as Detail),
      [onDetail],
    );
    const ready = status[engine].state === 'ready';

    return (
      <div className="border-surface0 bg-mantle flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-subtext0 text-xs">Engine</span>
          {/* Fastest on the left, best on the right; the recommended one is marked. */}
          <span className="text-overlay1 hidden text-[10px] uppercase tracking-wider sm:inline">fastest</span>
          <div aria-label="Engine" className="border-surface1 bg-base flex rounded-md border p-0.5" role="radiogroup">
            {ENGINES.map(e => (
              <EngineOption
                engine={e}
                key={e}
                onSelect={onEngine}
                recommended={e === RECOMMENDED_ENGINE}
                running={running}
                selected={engine === e}
                status={status[e]}
                unavailable={e === 'glm' && glm.ok === false ? glm.reason : null}
              />
            ))}
          </div>
          <span className="text-overlay1 hidden text-[10px] uppercase tracking-wider sm:inline">best quality</span>
        </div>
        {/* On phones the two selects share a row and stretch; from sm up the wrapper dissolves. */}
        <div className="flex w-full items-center gap-3 sm:contents">
          <label className="text-subtext0 flex min-w-0 flex-1 items-center gap-2 text-xs sm:flex-none">
            <span className="hidden sm:inline">Output</span>
            <select
              className={`${selectClass} min-w-0 flex-1 sm:flex-none`}
              disabled={engine !== 'glm' || running}
              onChange={changeMode}
              title={engine === 'glm' ? MODE_SPEC[mode].hint : 'PP-OCR always returns plain text'}
              value={engine === 'glm' ? mode : 'text'}>
              {engine === 'glm' ? (
                MODES.map(m => (
                  <option key={m} value={m}>
                    {MODE_SPEC[m].label}
                  </option>
                ))
              ) : (
                <option value="text">Plain text</option>
              )}
            </select>
          </label>
          <label className="text-subtext0 flex min-w-0 flex-1 items-center gap-2 text-xs sm:flex-none">
            <span className="hidden sm:inline">Detail</span>
            <select
              className={`${selectClass} min-w-0 flex-1 sm:flex-none`}
              disabled={running}
              onChange={changeDetail}
              title="Pixel budget per page: lower is faster and needs less GPU memory"
              value={detail}>
              {DETAILS.map(d => (
                <option key={d} value={d}>
                  {DETAIL_LABEL[d]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <FilePicker
            className={secondaryButtonClass}
            onFiles={onFiles}
            title="Add images or PDFs (or drop them anywhere)">
            <Icon className="h-3.5 w-3.5" name="plus" />
            Add files
          </FilePicker>
          {running ? (
            <button className={dangerButtonClass} onClick={onStop} type="button">
              <Icon className="h-3.5 w-3.5" name="stop" />
              Stop
            </button>
          ) : selectedCount > 0 ? (
            <>
              {pending > selectedPending ? (
                <button
                  className={secondaryButtonClass}
                  onClick={onStart}
                  title={`Run every page that has not succeeded yet, not just the ${selectedCount} selected`}
                  type="button">
                  Run all ({pending})
                </button>
              ) : null}
              <button
                className={primaryButtonClass}
                disabled={selectedPending + selectedDone === 0}
                onClick={onStartSelected}
                title={
                  selectedPending + selectedDone === 0
                    ? 'The selected pages are being processed'
                    : selectedDone === 0
                    ? `Run ${ENGINE_LABEL[engine]} on the selected page${selectedCount === 1 ? '' : 's'} (⌘⏎)`
                    : selectedPending === 0
                    ? `Process the selected page${selectedDone === 1 ? '' : 's'} again with ${
                        ENGINE_LABEL[engine]
                      }; each result is replaced once its new run succeeds (⌘⏎)`
                    : `Run ${ENGINE_LABEL[engine]} on the selected pages: ${selectedDone} of them again, ${
                        selectedPending === 1 ? 'one' : selectedPending
                      } for the first time (⌘⏎)`
                }
                type="button">
                <Icon className="h-3.5 w-3.5" name={selectedDone > 0 && selectedPending === 0 ? 'refresh' : 'play'} />
                {selectedDone > 0 && selectedPending === 0
                  ? `Rerun ${selectedDone} selected`
                  : `Run ${selectedPending + selectedDone} selected`}
              </button>
            </>
          ) : (
            <button
              className={primaryButtonClass}
              disabled={pending === 0}
              onClick={onStart}
              title={
                pending === 0
                  ? 'Add files first'
                  : ready
                  ? `Run ${ENGINE_LABEL[engine]} on every page that has not succeeded yet (⌘⏎)`
                  : `${ENGINE_LABEL[engine]} is downloaded first (once), then every page runs`
              }
              type="button">
              <Icon className="h-3.5 w-3.5" name="play" />
              {pending > 0 ? `Run ${pending} page${pending === 1 ? '' : 's'}` : 'Run'}
            </button>
          )}
        </div>
      </div>
    );
  },
);
Toolbar.displayName = 'Toolbar';

const EngineOption: FC<{
  onSelect(engine: Engine): void;
  engine: Engine;
  selected: boolean;
  recommended: boolean;
  running: boolean;
  /** Why the engine cannot run here, when it cannot. */
  unavailable: string | null;
  status: EngineStatus;
}> = memo(({engine, selected, recommended, running, unavailable, status, onSelect}) => {
  const select = useCallback(() => onSelect(engine), [engine, onSelect]);
  return (
    <button
      aria-checked={selected}
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
        selected ? 'bg-surface0 text-text shadow-sm' : 'text-subtext0 hover:text-text'
      }`}
      disabled={running || unavailable !== null}
      onClick={select}
      role="radio"
      title={
        unavailable ??
        `${ENGINE_LABEL[engine]}${recommended ? ' (recommended)' : ''}: ${
          status.state === 'idle' ? 'not loaded' : status.state
        }`
      }
      type="button">
      <span className={`h-1.5 w-1.5 rounded-full ${ENGINE_DOT[status.state]}`} />
      {ENGINE_LABEL[engine]}
      {recommended ? (
        <span className="bg-blue/15 text-blue hidden rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wider sm:inline">
          recommended
        </span>
      ) : null}
    </button>
  );
});
EngineOption.displayName = 'EngineOption';

export default Toolbar;
