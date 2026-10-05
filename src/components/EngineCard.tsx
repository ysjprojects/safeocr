import {type FC, memo, useCallback} from 'react';

import type {EngineStatus} from '@/lib/client';
import {type Engine, GLM_TOTAL_BYTES, PADDLE_TOTAL_BYTES} from '@/lib/protocol';

import {formatBytes, formatSeconds, primaryButtonClass} from './paneShared';

export type WebGpuSupport = 'checking' | 'yes' | 'no';

interface Props {
  onSelect(engine: Engine): void;
  onLoad(engine: Engine): void;
  engine: Engine;
  selected: boolean;
  status: EngineStatus;
  webgpu: WebGpuSupport;
  /** `navigator.deviceMemory` in GB where the browser reports it. */
  deviceMemory: number | null;
}

const BLURB: Record<Engine, {title: string; points: string[]; size: string}> = {
  glm: {
    title: 'GLM-OCR · best quality',
    points: [
      '0.9B vision-language model: Markdown with headings, lists, tables (HTML) and formulas (LaTeX).',
      'Runs on your GPU through WebGPU; needs about 2 GB of GPU memory. Desktop Chrome or Edge first.',
      'Generative: it can smooth over or invent text on poor scans. Prefer PP-OCRv5 when faithful beats fluent.',
    ],
    size: `${formatBytes(GLM_TOTAL_BYTES)} download, once`,
  },
  paddle: {
    title: 'PP-OCRv5 · fast and faithful',
    points: [
      'Classic detection + recognition: plain text lines in reading order, nothing invented.',
      'Runs on the CPU through WebAssembly, in every browser, a few seconds per page.',
      'No layout: tables flatten into lines, formulas come out as symbols.',
    ],
    size: `${formatBytes(PADDLE_TOTAL_BYTES)} of models + 27 MB runtime, once`,
  },
};

const EngineCard: FC<Props> = memo(({engine, selected, status, webgpu, deviceMemory, onSelect, onLoad}) => {
  const unsupported = engine === 'glm' && webgpu === 'no';
  const lowMemory = engine === 'glm' && deviceMemory !== null && deviceMemory < 8;
  const blurb = BLURB[engine];

  const select = useCallback(() => {
    if (!unsupported) onSelect(engine);
  }, [engine, onSelect, unsupported]);
  const load = useCallback(() => {
    onSelect(engine);
    onLoad(engine);
  }, [engine, onLoad, onSelect]);

  return (
    <div
      aria-checked={selected}
      className={`flex flex-col gap-2 rounded-xl border p-3 text-left transition ${
        selected
          ? 'border-candy-400/70 bg-plum-950/70 shadow-[0_0_24px_rgba(255,63,166,0.2)]'
          : 'border-plum-600/60 bg-plum-900/50'
      } ${unsupported ? 'opacity-60' : 'hover:border-candy-500/60 cursor-pointer'}`}
      onClick={select}
      role="radio"
      tabIndex={0}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-cream text-[13px] font-bold">{blurb.title}</span>
        <StatusChip status={status} unsupported={unsupported} />
      </div>
      <ul className="text-plum-200 list-disc space-y-0.5 pl-4 text-[11.5px] leading-snug">
        {blurb.points.map(point => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {unsupported ? (
        <p className="text-[11px] text-amber-300">
          This browser has no WebGPU. Use desktop Chrome or Edge (Safari 26+ and recent Firefox also work), or stay on
          PP-OCRv5.
        </p>
      ) : null}
      {lowMemory && !unsupported ? (
        <p className="text-[11px] text-amber-300">
          This device reports {deviceMemory} GB of memory; GLM-OCR may run out of GPU memory. Try the low-memory detail
          setting.
        </p>
      ) : null}
      {status.state === 'loading' ? (
        <div>
          <div className="bg-plum-700 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-candy-500 h-full rounded-full transition-[width]"
              style={{width: `${status.total > 0 ? Math.min(100, (100 * status.loaded) / status.total) : 0}%`}}
            />
          </div>
          <p className="font-code text-plum-200 mt-1 text-[10.5px]">
            {status.total > 0 ? `${formatBytes(status.loaded)} / ${formatBytes(status.total)}` : 'starting…'}
            {status.file ? ` · ${status.file.replace(/^onnx\//, '')}` : ''}
            {status.loaded >= status.total && status.total > 0 ? ' · initialising…' : ''}
          </p>
        </div>
      ) : null}
      {status.state === 'error' ? (
        <p className="font-code break-words text-[10.5px] text-rose-300">{status.message}</p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-plum-300 text-[10.5px]">{blurb.size}</span>
        {status.state === 'idle' || status.state === 'error' ? (
          <button className={primaryButtonClass} disabled={unsupported} onClick={load} type="button">
            {status.state === 'error' ? 'Retry' : 'Download & enable'}
          </button>
        ) : null}
        {status.state === 'ready' && status.loadMs !== null ? (
          <span className="font-code text-[10.5px] text-emerald-300">loaded in {formatSeconds(status.loadMs)}</span>
        ) : null}
      </div>
    </div>
  );
});
EngineCard.displayName = 'EngineCard';

const StatusChip: FC<{status: EngineStatus; unsupported: boolean}> = memo(({status, unsupported}) => {
  const [label, cls] = unsupported
    ? ['unavailable', 'border-plum-500/60 text-plum-300']
    : status.state === 'ready'
    ? ['ready', 'border-emerald-400/50 bg-emerald-500/10 text-emerald-300']
    : status.state === 'loading'
    ? ['loading', 'border-candy-400/60 bg-candy-500/10 text-candy-200']
    : status.state === 'error'
    ? ['error', 'border-rose-400/50 bg-rose-500/10 text-rose-300']
    : ['not loaded', 'border-plum-500/60 text-plum-300'];
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{label}</span>;
});
StatusChip.displayName = 'StatusChip';

export default EngineCard;
