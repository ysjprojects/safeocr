/**
 * Turns user files into RGBA pixels for the worker, on the main thread (decoders and pdf.js need
 * the DOM). Every page is downscaled to the active pixel budget before it leaves this module, which
 * bounds vision tokens, GPU memory and the transfer size; a small JPEG preview is produced alongside,
 * or on its own for pages that are shown before they run.
 */
import type * as PdfJs from 'pdfjs-dist';

import type {PixelImage} from './protocol';

/** What the file picker and the drop zone accept. Images go through the browser's own decoders. */
export const ACCEPT = 'image/*,.pdf,application/pdf';

/** Long side of the JPEG preview shown beside the recognised text; legible at fit-to-width in a half-window pane. */
export const PREVIEW_MAX = 1200;

/** Rasterise PDF pages at 150 dpi (pdf.js units are 72 dpi) before the pixel budget applies. */
const PDF_SCALE = 150 / 72;

export interface Rasterized {
  image: PixelImage;
  /** Size of the pixels sent to the model (after the budget). */
  width: number;
  height: number;
  /** Physical size of the rotated page or region in PDF points (images are taken as 150 dpi). */
  pointWidth: number;
  pointHeight: number;
  /** JPEG, at most `PREVIEW_MAX` on the long side; null when none was asked for. */
  preview: Blob | null;
}

export interface Preview {
  /** JPEG, at most `PREVIEW_MAX` on the long side. */
  blob: Blob;
  pointWidth: number;
  pointHeight: number;
}

let pdfModule: Promise<typeof PdfJs> | null = null;

/** pdf.js is loaded on first use; its worker and decoders come from public/ocr-runtime/pdfjs/<version>/. */
function loadPdfJs(): Promise<typeof PdfJs> {
  pdfModule ??= import('pdfjs-dist').then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = `${location.origin}/ocr-runtime/pdfjs/${pdfjs.version}/pdf.worker.min.mjs`;
    return pdfjs;
  });
  return pdfModule;
}

const documents = new WeakMap<File, Promise<PdfJs.PDFDocumentProxy>>();
/** Pages of a PDF being rendered right now; a close asked for meanwhile waits for them. */
const rendering = new WeakMap<File, number>();
const closeWhenIdle = new WeakSet<File>();

async function openPdf(file: File): Promise<PdfJs.PDFDocumentProxy> {
  let doc = documents.get(file);
  if (doc === undefined) {
    closeWhenIdle.delete(file);
    doc = (async () => {
      const pdfjs = await loadPdfJs();
      const base = `${location.origin}/ocr-runtime/pdfjs/${pdfjs.version}/`;
      return pdfjs.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        cMapUrl: `${base}cmaps/`,
        standardFontDataUrl: `${base}standard_fonts/`,
        wasmUrl: `${base}wasm/`,
      }).promise;
    })();
    documents.set(file, doc);
  }
  return doc;
}

/** Number of pages in a PDF (1 for an image). Rejects when the file cannot be opened at all. */
export async function countPages(file: File): Promise<number> {
  if (!isPdf(file)) return 1;
  return (await openPdf(file)).numPages;
}

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/**
 * Releases a PDF's parsed state (its worker-side document); a later use opens it again. Deferred
 * until the pages being rendered are done (previews are made while runs go on).
 */
export async function closePdf(file: File): Promise<void> {
  if ((rendering.get(file) ?? 0) > 0) {
    closeWhenIdle.add(file);
    return;
  }
  closeWhenIdle.delete(file);
  const doc = documents.get(file);
  if (doc === undefined) return;
  documents.delete(file);
  await (await doc).destroy();
}

async function withPdfPage<T>(
  file: File,
  pageIndex: number,
  body: (page: PdfJs.PDFPageProxy) => Promise<T>,
): Promise<T> {
  rendering.set(file, (rendering.get(file) ?? 0) + 1);
  try {
    const page = await (await openPdf(file)).getPage(pageIndex + 1);
    try {
      return await body(page);
    } finally {
      page.cleanup();
    }
  } finally {
    const left = (rendering.get(file) ?? 1) - 1;
    rendering.set(file, left);
    if (left === 0 && closeWhenIdle.has(file)) void closePdf(file);
  }
}

/** Scale factor that fits `width × height` within `pixelBudget` pixels (never upscales). */
function fit(width: number, height: number, pixelBudget: number): number {
  return Math.min(1, Math.sqrt(pixelBudget / (width * height)));
}

function canvasOf(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  if (ctx === null) throw new Error('2D canvas is unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return [canvas, ctx];
}

/** Quarter turns and an optional crop, both applied before the pixel budget. */
export interface Transform {
  rotation: 0 | 90 | 180 | 270;
  /** Fractions (0–1) of the rotated page; null for the whole page. */
  region: {x: number; y: number; width: number; height: number} | null;
}

export const WHOLE_PAGE: Transform = {rotation: 0, region: null};

/** Images carry no physical size; a scan at 150 dpi is the convention for exports. */
const IMAGE_DPI = 150;

/** The part of the rotated source a transform keeps, in source pixels. */
function cropOf(sourceWidth: number, sourceHeight: number, transform: Transform) {
  const turned = transform.rotation === 90 || transform.rotation === 270;
  const rotatedWidth = turned ? sourceHeight : sourceWidth;
  const rotatedHeight = turned ? sourceWidth : sourceHeight;
  const region = transform.region ?? {x: 0, y: 0, width: 1, height: 1};
  return {
    rotatedWidth,
    rotatedHeight,
    x: region.x * rotatedWidth,
    y: region.y * rotatedHeight,
    width: Math.max(1, region.width * rotatedWidth),
    height: Math.max(1, region.height * rotatedHeight),
  };
}

type Crop = ReturnType<typeof cropOf>;

/** Draws the rotated, cropped source at `scale` on a fresh white canvas. */
function draw(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  crop: Crop,
  rotation: Transform['rotation'],
  scale: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const width = Math.max(1, Math.round(crop.width * scale));
  const height = Math.max(1, Math.round(crop.height * scale));
  const [canvas, ctx] = canvasOf(width, height);
  ctx.fillStyle = '#fff'; // transparent PNG/PDF backgrounds become paper, not black
  ctx.fillRect(0, 0, width, height);
  // Output pixels ← scale ← crop offset ← rotation of the source onto the rotated frame.
  ctx.scale(scale, scale);
  ctx.translate(-crop.x, -crop.y);
  if (rotation === 90) {
    ctx.translate(crop.rotatedWidth, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    ctx.translate(crop.rotatedWidth, crop.rotatedHeight);
    ctx.rotate(Math.PI);
  } else if (rotation === 270) {
    ctx.translate(0, crop.rotatedHeight);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return [canvas, ctx];
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      blob => (blob === null ? reject(new Error('preview encoding failed')) : resolve(blob)),
      'image/jpeg',
      0.8,
    ),
  );
}

async function decodeImage(file: File): Promise<[CanvasImageSource, number, number, () => void]> {
  // createImageBitmap honours EXIF orientation and is the fast path; browsers that cannot decode a
  // format this way (SVG in Chrome, HEIC outside Safari…) get a second chance through <img>.
  try {
    const bitmap = await createImageBitmap(file);
    return [bitmap, bitmap.width, bitmap.height, () => bitmap.close()];
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (img.naturalWidth === 0) throw new Error('zero-sized image');
      return [img, img.naturalWidth, img.naturalHeight, () => URL.revokeObjectURL(url)];
    } catch (error) {
      URL.revokeObjectURL(url);
      throw new Error(`cannot decode ${file.name} (${file.type || 'unknown type'}) in this browser`, {cause: error});
    }
  }
}

/**
 * Decodes an image, or renders page `pageIndex` of a PDF at 150 dpi (or less when `pixelBudget`
 * would shrink it anyway: no point drawing pixels we would immediately throw away; a region only
 * needs its own share of the page), and hands the source to `body` with its size and dpi.
 */
async function withSource<T>(
  file: File,
  pageIndex: number,
  pixelBudget: number,
  transform: Transform,
  body: (source: CanvasImageSource, width: number, height: number, dpi: number) => Promise<T>,
): Promise<T> {
  if (!isPdf(file)) {
    const [source, width, height, release] = await decodeImage(file);
    try {
      return await body(source, width, height, IMAGE_DPI);
    } finally {
      release();
    }
  }
  return withPdfPage(file, pageIndex, async page => {
    const base = page.getViewport({scale: 1});
    const share = Math.sqrt(transform.region === null ? 1 : transform.region.width * transform.region.height);
    const scale = Math.min(
      PDF_SCALE,
      PDF_SCALE * fit(base.width * PDF_SCALE * share, base.height * PDF_SCALE * share, pixelBudget),
    );
    const viewport = page.getViewport({scale});
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const [canvas] = canvasOf(width, height);
    await page.render({canvas, viewport, intent: 'print'}).promise;
    try {
      return await body(canvas, width, height, scale * 72);
    } finally {
      canvas.width = canvas.height = 0;
    }
  });
}

/**
 * Rasterises page `pageIndex` (0-based; always 0 for images) within `pixelBudget` pixels, after
 * rotating and cropping it as `transform` says; with a preview unless the page has one already.
 */
export async function rasterize(
  file: File,
  pageIndex: number,
  pixelBudget: number,
  transform: Transform = WHOLE_PAGE,
  withPreview = true,
): Promise<Rasterized> {
  return withSource(file, pageIndex, pixelBudget, transform, async (source, sourceWidth, sourceHeight, dpi) => {
    const crop = cropOf(sourceWidth, sourceHeight, transform);
    const [canvas, ctx] = draw(
      source,
      sourceWidth,
      sourceHeight,
      crop,
      transform.rotation,
      fit(crop.width, crop.height, pixelBudget),
    );
    const {width, height} = canvas;
    const pixels = ctx.getImageData(0, 0, width, height);
    let preview: Blob | null = null;
    if (withPreview) {
      const previewScale = Math.min(1, PREVIEW_MAX / Math.max(width, height));
      const [previewCanvas, previewCtx] = canvasOf(
        Math.max(1, Math.round(width * previewScale)),
        Math.max(1, Math.round(height * previewScale)),
      );
      previewCtx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
      preview = await toJpeg(previewCanvas);
      previewCanvas.width = previewCanvas.height = 0;
    }
    canvas.width = canvas.height = 0;
    return {
      image: {width, height, data: pixels.data.buffer},
      width,
      height,
      pointWidth: (crop.width / dpi) * 72,
      pointHeight: (crop.height / dpi) * 72,
      preview,
    };
  });
}

/** The preview alone, for a page shown before it runs: the same picture `rasterize` makes beside the pixels. */
export async function renderPreview(
  file: File,
  pageIndex: number,
  transform: Transform = WHOLE_PAGE,
): Promise<Preview> {
  return withSource(
    file,
    pageIndex,
    PREVIEW_MAX * PREVIEW_MAX,
    transform,
    async (source, sourceWidth, sourceHeight, dpi) => {
      const crop = cropOf(sourceWidth, sourceHeight, transform);
      const [canvas] = draw(
        source,
        sourceWidth,
        sourceHeight,
        crop,
        transform.rotation,
        Math.min(1, PREVIEW_MAX / Math.max(crop.width, crop.height)),
      );
      try {
        return {blob: await toJpeg(canvas), pointWidth: (crop.width / dpi) * 72, pointHeight: (crop.height / dpi) * 72};
      } finally {
        canvas.width = canvas.height = 0;
      }
    },
  );
}
