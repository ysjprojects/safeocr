/**
 * What this browser and device can run. GLM-OCR needs WebGPU and roughly 2 GB in one tab (the
 * weights in memory while the session is built, then the GPU buffers); a device that cannot hold
 * that does not fail gracefully, the OS kills the page mid-load and the browser reloads it.
 */

export interface GlmSupport {
  /** null while WebGPU is still being probed. */
  ok: boolean | null;
  /** Why GLM-OCR is unavailable here, when `ok` is false. */
  reason: string | null;
  /** A caution worth showing when `ok` is true but memory is known to be tight. */
  warning: string | null;
}

export const GLM_UNKNOWN: GlmSupport = {ok: null, reason: null, warning: null};

const detectWebGpu = async (): Promise<boolean> => {
  if (!('gpu' in navigator)) return false;
  const gpu: unknown = navigator.gpu;
  if (
    typeof gpu !== 'object' ||
    gpu === null ||
    !('requestAdapter' in gpu) ||
    typeof gpu.requestAdapter !== 'function'
  ) {
    return false;
  }
  try {
    const adapter: unknown = await gpu.requestAdapter();
    return adapter !== null && adapter !== undefined;
  } catch {
    return false;
  }
};

/** iPhone and iPad (iPadOS presents itself as a Mac, but a Mac has no touch points). */
const appleMobile = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** `navigator.deviceMemory` in GB (Chromium only, capped at 8), or null. */
const reportedMemory = (): number | null =>
  'deviceMemory' in navigator && typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;

export async function probeGlmSupport(): Promise<GlmSupport> {
  if (!(await detectWebGpu())) {
    return {
      ok: false,
      reason:
        'This browser has no WebGPU. Use desktop Chrome or Edge (Safari 26+ and recent Firefox also work), or stay on PP-OCRv5.',
      warning: null,
    };
  }
  if (appleMobile()) {
    return {
      ok: false,
      reason:
        'GLM-OCR needs about 2 GB of memory in one tab, more than Safari on iPhone and iPad allows: the page would be killed while the model loads. PP-OCRv5 runs here.',
      warning: null,
    };
  }
  const memory = reportedMemory();
  if (memory !== null && memory < 4) {
    return {
      ok: false,
      reason: `This device reports ${memory} GB of memory; GLM-OCR needs about 2 GB in one tab and would not fit. PP-OCRv5 runs here.`,
      warning: null,
    };
  }
  return {
    ok: true,
    reason: null,
    warning:
      memory !== null && memory < 8
        ? `This device reports ${memory} GB of memory; GLM-OCR may run out of GPU memory. Try the low-memory detail setting.`
        : null,
  };
}
