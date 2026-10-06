import {type FC, memo, useEffect, useState} from 'react';

import type {EngineStatus} from '@/lib/client';
import type {PageState} from '@/lib/jobs';

const button =
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40';

export const primaryButtonClass = `${button} bg-blue px-3 py-1.5 text-crust hover:bg-blue/90 disabled:hover:bg-blue`;

export const dangerButtonClass = `${button} border border-red/40 bg-red/10 px-3 py-1.5 text-red hover:bg-red/20`;

export const secondaryButtonClass = `${button} border border-surface1 bg-base px-3 py-1.5 text-text hover:bg-surface0 disabled:hover:bg-base`;

export const ghostButtonClass = `${button} px-2.5 py-1.5 text-subtext1 hover:bg-surface0 hover:text-text disabled:hover:bg-transparent`;

export const iconButtonClass = `${button} h-7 w-7 text-subtext0 hover:bg-surface0 hover:text-text disabled:hover:bg-transparent`;

/**
 * A pane's header row. It wraps rather than clips: on a phone the action group drops to a second,
 * right-aligned row (every button stays reachable); on wider screens it is the usual single row.
 */
export const paneHeaderClass =
  'border-surface0 bg-mantle flex min-h-10 shrink-0 flex-wrap items-center gap-y-1 overflow-hidden border-b py-1 pl-4 pr-2';

/** Form controls: 16px on touch screens, where anything smaller makes iOS zoom the page on focus. */
export const selectClass =
  'rounded-md border-surface1 bg-base py-1 pl-2 pr-7 text-xs font-medium text-text focus:border-blue focus:ring-0 disabled:cursor-not-allowed disabled:opacity-50 touch:text-md';

export const STATE_LABEL: Record<PageState, string> = {
  idle: 'ready to run',
  queued: 'queued',
  running: 'running',
  done: 'done',
  error: 'failed',
  cancelled: 'stopped',
};

/** The dot carries the state colour; labels stay neutral except for the two that need attention. */
const STATE_DOT: Record<PageState, string> = {
  idle: 'bg-overlay0',
  queued: 'bg-overlay2',
  running: 'bg-blue motion-safe:animate-pulse',
  done: 'bg-green',
  error: 'bg-red',
  cancelled: 'bg-yellow',
};

const STATE_TEXT: Record<PageState, string> = {
  idle: 'text-subtext0',
  queued: 'text-subtext0',
  running: 'text-blue',
  done: 'text-subtext0',
  error: 'text-red',
  cancelled: 'text-subtext0',
};

export const StateBadge: FC<{state: PageState}> = memo(({state}) => (
  <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${STATE_TEXT[state]}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[state]}`} />
    {STATE_LABEL[state]}
  </span>
));
StateBadge.displayName = 'StateBadge';

/** Dot colour per engine load state, shared by the toolbar, the engine cards and the status bar. */
export const ENGINE_DOT: Record<EngineStatus['state'], string> = {
  idle: 'bg-overlay0',
  loading: 'bg-blue motion-safe:animate-pulse',
  ready: 'bg-green',
  error: 'bg-red',
};

/**
 * Confidence bands for PP-OCR lines: below `LOW` is worth a glance, below `VERY_LOW` a check.
 * The same thresholds colour text lines and the boxes on the scan.
 */
export const CONFIDENCE = {LOW: 0.8, VERY_LOW: 0.6} as const;

export type ConfidenceBand = 'ok' | 'low' | 'veryLow';

export function confidenceBand(confidence: number | null): ConfidenceBand {
  if (confidence === null || confidence >= CONFIDENCE.LOW) return 'ok';
  return confidence >= CONFIDENCE.VERY_LOW ? 'low' : 'veryLow';
}

/** Background tint for a text line; `ok` lines stay plain. */
export const CONFIDENCE_TEXT: Record<ConfidenceBand, string> = {
  ok: '',
  low: 'bg-yellow/20',
  veryLow: 'bg-red/20',
};

/** Stroke / fill colour tokens for a box on the scan (SVG `stroke`/`fill` via currentColor classes). */
export const CONFIDENCE_BOX: Record<ConfidenceBand, string> = {
  ok: 'text-blue',
  low: 'text-yellow',
  veryLow: 'text-red',
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/** `4.0s` under ten seconds, whole seconds (`12s`) above: the unit sits tight, a full cell apart reads as a hole in code fonts. */
export function formatSeconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

/** Whole seconds since `since` (a `Date.now()` stamp), ticking on the stamp's own second boundaries. */
export const Elapsed: FC<{since: number}> = memo(({since}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, 1000 - ((Date.now() - since) % 1000));
    };
    timer = window.setTimeout(tick, 1000 - ((Date.now() - since) % 1000));
    return () => window.clearTimeout(timer);
  }, [since]);
  return <span className="text-subtext0 tabular-nums">{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
});
Elapsed.displayName = 'Elapsed';
