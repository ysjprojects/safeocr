import {type FC, type KeyboardEvent, memo, useCallback} from 'react';

import type {EngineStatus} from '@/lib/client';
import type {GlmSupport} from '@/lib/device';
import {type Engine, ENGINE_LABEL, GLM_TOTAL_BYTES, paddleTotalBytes} from '@/lib/protocol';

import Icon from './icons';
import {ENGINE_DOT, formatBytes, formatSeconds, ghostButtonClass} from './paneShared';

interface Props {
  onSelect(engine: Engine): void;
  onLoad(engine: Engine): void;
  engine: Engine;
  selected: boolean;
  status: EngineStatus;
  /** Whether GLM-OCR can run on this device, with the reason or caution to show. */
  glm: GlmSupport;
}

const BLURB: Record<Engine, {tagline: string; summary: string; runtime: string; size: string}> = {
  glm: {
    tagline: 'Best quality',
    summary:
      'A 0.9B vision-language model that returns Markdown with headings, lists, HTML tables and LaTeX formulas. Generative: it can smooth over or invent text on poor scans.',
    runtime: 'GPU via WebGPU · desktop Chrome or Edge first',
    size: `${formatBytes(GLM_TOTAL_BYTES)} download, once`,
  },
  paddle6: {
    tagline: 'Faithful, reads small print',
    summary:
      'Classic detection + recognition: plain text lines in reading order, nothing invented. No layout: tables flatten into lines, formulas come out as symbols. Detects at full resolution.',
    runtime: 'CPU via WebAssembly · every browser · a few seconds per page',
    size: `${formatBytes(paddleTotalBytes('paddle6'))} of models + 27 MB runtime, once`,
  },
  paddle: {
    tagline: 'Fastest',
    summary:
      'The previous generation: the same plain lines, a third faster, but it misses small print (6-pt text is largely lost) and slips on the odd line.',
    runtime: 'CPU via WebAssembly · every browser · a few seconds per page',
    size: `${formatBytes(paddleTotalBytes('paddle'))} of models + 27 MB runtime, once`,
  },
};

const STATUS_LABEL: Record<EngineStatus['state'], string> = {
  idle: 'not loaded',
  loading: 'loading',
  ready: 'ready',
  error: 'error',
};

const EngineCard: FC<Props> = memo(({engine, selected, status, glm, onSelect, onLoad}) => {
  const unsupported = engine === 'glm' && glm.ok === false;
  const note = engine === 'glm' ? (unsupported ? glm.reason : glm.warning) : null;
  const blurb = BLURB[engine];

  const select = useCallback(() => {
    if (!unsupported) onSelect(engine);
  }, [engine, onSelect, unsupported]);
  // Space/Enter on the card itself; the inner download button keeps its own keyboard activation.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || (event.key !== ' ' && event.key !== 'Enter')) return;
      event.preventDefault();
      select();
    },
    [select],
  );
  const load = useCallback(() => {
    onSelect(engine);
    onLoad(engine);
  }, [engine, onLoad, onSelect]);

  return (
    <div
      aria-checked={selected}
      aria-disabled={unsupported}
      className={`flex flex-col gap-2 rounded-xl border p-4 text-left transition ${
        selected ? 'border-blue bg-blue/5 ring-blue ring-1' : 'border-surface1 bg-base'
      } ${unsupported ? 'opacity-60' : 'hover:border-blue/60 cursor-pointer'}`}
      onClick={select}
      onKeyDown={onKeyDown}
      role="radio"
      tabIndex={unsupported ? -1 : 0}>
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
            selected ? 'border-blue bg-blue text-crust' : 'border-surface2'
          }`}>
          {selected ? <Icon className="h-2.5 w-2.5" name="check" /> : null}
        </span>
        <span className="text-text whitespace-nowrap text-sm font-semibold">{ENGINE_LABEL[engine]}</span>
        <span className="text-subtext0 ml-auto inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium">
          <span className={`h-1.5 w-1.5 rounded-full ${unsupported ? 'bg-overlay0' : ENGINE_DOT[status.state]}`} />
          {unsupported ? 'unavailable' : STATUS_LABEL[status.state]}
        </span>
      </div>
      <p className="text-subtext0 text-xs font-medium">{blurb.tagline}</p>
      <p className="text-subtext1 text-xs leading-relaxed">{blurb.summary}</p>
      <p className="text-subtext0 text-[11px]">
        {blurb.runtime} · {blurb.size}
      </p>
      {note !== null ? (
        <p className="text-yellow flex items-start gap-1.5 text-xs">
          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" name="alert" />
          {note}
        </p>
      ) : null}
      {status.state === 'loading' ? (
        <div>
          <div className="bg-surface0 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-blue h-full rounded-full transition-[width]"
              style={{width: `${status.total > 0 ? Math.min(100, (100 * status.loaded) / status.total) : 0}%`}}
            />
          </div>
          <p className="font-code text-subtext0 mt-1.5 text-[11px]">
            {status.total > 0 ? `${formatBytes(status.loaded)} / ${formatBytes(status.total)}` : 'starting…'}
            {status.file ? ` · ${status.file.replace(/^onnx\//, '')}` : ''}
            {status.loaded >= status.total && status.total > 0 ? ' · initialising…' : ''}
          </p>
        </div>
      ) : null}
      {status.state === 'error' ? <p className="font-code text-red break-words text-[11px]">{status.message}</p> : null}
      {status.state === 'idle' || status.state === 'error' ? (
        <div className="-mb-1 -ml-2">
          <button className={ghostButtonClass} disabled={unsupported} onClick={load} type="button">
            <Icon className="h-3.5 w-3.5" name="download" />
            {status.state === 'error' ? 'Retry download' : 'Download now'}
          </button>
        </div>
      ) : null}
      {status.state === 'ready' && status.loadMs !== null ? (
        <p className="font-code text-green text-[11px]">loaded in {formatSeconds(status.loadMs)}</p>
      ) : null}
    </div>
  );
});
EngineCard.displayName = 'EngineCard';

export default EngineCard;
