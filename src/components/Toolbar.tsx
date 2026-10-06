import {type ChangeEvent, type FC, memo, useCallback} from 'react';

import type {EngineStatus} from '@/lib/client';
import {
  type Detail,
  type Engine,
  type Mode,
  DETAIL_LABEL,
  DETAILS,
  ENGINE_LABEL,
  MODE_SPEC,
  MODES,
} from '@/lib/protocol';

import {FilePicker} from './Dropzone';
import type {WebGpuSupport} from './EngineCard';
import Icon from './icons';
import {dangerButtonClass, ENGINE_DOT, primaryButtonClass, secondaryButtonClass, selectClass} from './paneShared';

const ENGINES: Engine[] = ['glm', 'paddle'];

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
  webgpu: WebGpuSupport;
  running: boolean;
  /** Pages a plain Run would process. */
  pending: number;
  /** Pages picked in the rail, and how many of those Run would process. */
  selectedCount: number;
  selectedPending: number;
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
    webgpu,
    running,
    pending,
    selectedCount,
    selectedPending,
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
          <div aria-label="Engine" className="border-surface1 bg-base flex rounded-md border p-0.5" role="radiogroup">
            {ENGINES.map(e => (
              <EngineOption
                engine={e}
                key={e}
                onSelect={onEngine}
                running={running}
                selected={engine === e}
                status={status[e]}
                unsupported={e === 'glm' && webgpu === 'no'}
              />
            ))}
          </div>
        </div>
        <label className="text-subtext0 flex items-center gap-2 text-xs">
          Output
          <select
            className={selectClass}
            disabled={engine !== 'glm' || running}
            onChange={changeMode}
            title={engine === 'glm' ? MODE_SPEC[mode].hint : 'PP-OCRv5 always returns plain text'}
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
        <label className="text-subtext0 flex items-center gap-2 text-xs">
          Detail
          <select
            className={selectClass}
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
                disabled={selectedPending === 0}
                onClick={onStartSelected}
                title={
                  selectedPending === 0
                    ? 'The selected pages are done; use Rerun to process them again'
                    : selectedPending < selectedCount
                    ? `Run the ${selectedPending} selected page${
                        selectedPending === 1 ? '' : 's'
                      } that have not succeeded yet (the rest are done; use Rerun for those)`
                    : `Run ${ENGINE_LABEL[engine]} on the selected page${selectedCount === 1 ? '' : 's'} (⌘⏎)`
                }
                type="button">
                <Icon className="h-3.5 w-3.5" name="play" />
                {selectedPending > 0 ? `Run ${selectedPending} selected` : 'Run selected'}
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
  running: boolean;
  unsupported: boolean;
  status: EngineStatus;
}> = memo(({engine, selected, running, unsupported, status, onSelect}) => {
  const select = useCallback(() => onSelect(engine), [engine, onSelect]);
  return (
    <button
      aria-checked={selected}
      className={`inline-flex items-center gap-2 rounded px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
        selected ? 'bg-surface0 text-text shadow-sm' : 'text-subtext0 hover:text-text'
      }`}
      disabled={running || unsupported}
      onClick={select}
      role="radio"
      title={
        unsupported
          ? 'GLM-OCR needs WebGPU, which this browser does not have'
          : `${ENGINE_LABEL[engine]}: ${status.state === 'idle' ? 'not loaded' : status.state}`
      }
      type="button">
      <span className={`h-1.5 w-1.5 rounded-full ${ENGINE_DOT[status.state]}`} />
      {ENGINE_LABEL[engine]}
    </button>
  );
});
EngineOption.displayName = 'EngineOption';

export default Toolbar;
