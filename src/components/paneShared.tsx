import type {PageState} from '@/lib/jobs';

export const ghostButtonClass =
  'rounded-lg px-3 py-1.5 text-[12px] font-semibold text-plum-200 transition hover:bg-plum-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30';

export const primaryButtonClass =
  'rounded-lg bg-candy-500 px-3 py-1.5 text-[12px] font-semibold text-white shadow transition hover:bg-candy-400 disabled:cursor-not-allowed disabled:opacity-30';

export const selectClass =
  'rounded-md border border-plum-600 bg-plum-900/80 px-2 py-1 font-code text-[11px] text-cream focus:border-candy-500 focus:outline-none focus:ring-0 disabled:opacity-40';

export const STATE_CLASS: Record<PageState, string> = {
  idle: 'border-plum-500/60 bg-plum-800/40 text-plum-200',
  queued: 'border-plum-300/50 bg-plum-400/20 text-plum-200',
  running: 'border-candy-400/60 bg-candy-500/10 text-candy-200',
  done: 'border-emerald-400/50 bg-emerald-500/10 text-emerald-300',
  error: 'border-rose-400/50 bg-rose-500/10 text-rose-300',
  cancelled: 'border-amber-400/50 bg-amber-500/10 text-amber-300',
};

export const STATE_LABEL: Record<PageState, string> = {
  idle: 'ready to run',
  queued: 'queued',
  running: 'running',
  done: 'done',
  error: 'failed',
  cancelled: 'stopped',
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

export function formatSeconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}
