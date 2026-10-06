/**
 * Turns user files into RGBA pixels for the worker, on the main thread (decoders and pdf.js need
 * the DOM). Every page is downscaled to the active pixel budget before it leaves this module, which
 * bounds vision tokens, GPU memory and the transfer size; a small JPEG preview is produced alongside.
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
  /** JPEG, at most `PREVIEW_MAX` on the long side. */
  preview: Blob;
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

async function openPdf(file: File): Promise<PdfJs.PDFDocumentProxy> {
  let doc = documents.get(file);
  if (doc === undefined) {
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

/** Releases a PDF's parsed state (its worker-side document) once all of its pages are done. */
export async function closePdf(file: File): Promise<void> {
  const doc = documents.get(file);
  if (doc === undefined) return;
  documents.delete(file);
  await (await doc).destroy();
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

async function finish(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  dpi: number,
  pixelBudget: number,
  transform: Transform,
): Promise<Rasterized> {
  const turned = transform.rotation === 90 || transform.rotation === 270;
  const rotatedWidth = turned ? sourceHeight : sourceWidth;
  const rotatedHeight = turned ? sourceWidth : sourceHeight;
  const region = transform.region ?? {x: 0, y: 0, width: 1, height: 1};
  const cropX = region.x * rotatedWidth;
  const cropY = region.y * rotatedHeight;
  const cropWidth = Math.max(1, region.width * rotatedWidth);
  const cropHeight = Math.max(1, region.height * rotatedHeight);

  const scale = fit(cropWidth, cropHeight, pixelBudget);
  const width = Math.max(1, Math.round(cropWidth * scale));
  const height = Math.max(1, Math.round(cropHeight * scale));
  const [canvas, ctx] = canvasOf(width, height);
  ctx.fillStyle = '#fff'; // transparent PNG/PDF backgrounds become paper, not black
  ctx.fillRect(0, 0, width, height);
  // Output pixels ← budget scale ← crop offset ← rotation of the source onto the rotated frame.
  ctx.scale(scale, scale);
  ctx.translate(-cropX, -cropY);
  if (transform.rotation === 90) {
    ctx.translate(rotatedWidth, 0);
    ctx.rotate(Math.PI / 2);
  } else if (transform.rotation === 180) {
    ctx.translate(rotatedWidth, rotatedHeight);
    ctx.rotate(Math.PI);
  } else if (transform.rotation === 270) {
    ctx.translate(0, rotatedHeight);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);

  const previewScale = Math.min(1, PREVIEW_MAX / Math.max(width, height));
  const [previewCanvas, previewCtx] = canvasOf(
    Math.max(1, Math.round(width * previewScale)),
    Math.max(1, Math.round(height * previewScale)),
  );
  previewCtx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
  const preview = await new Promise<Blob>((resolve, reject) =>
    previewCanvas.toBlob(
      blob => (blob === null ? reject(new Error('preview encoding failed')) : resolve(blob)),
      'image/jpeg',
      0.8,
    ),
  );
  canvas.width = canvas.height = 0;
  previewCanvas.width = previewCanvas.height = 0;

  return {
    image: {width, height, data: pixels.data.buffer},
    width,
    height,
    pointWidth: (cropWidth / dpi) * 72,
    pointHeight: (cropHeight / dpi) * 72,
    preview,
  };
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
 * Rasterises page `pageIndex` (0-based; always 0 for images) within `pixelBudget` pixels, after
 * rotating and cropping it as `transform` says.
 */
export async function rasterize(
  file: File,
  pageIndex: number,
  pixelBudget: number,
  transform: Transform = WHOLE_PAGE,
): Promise<Rasterized> {
  if (!isPdf(file)) {
    const [source, width, height, release] = await decodeImage(file);
    try {
      return await finish(source, width, height, IMAGE_DPI, pixelBudget, transform);
    } finally {
      release();
    }
  }
  const doc = await openPdf(file);
  const page = await doc.getPage(pageIndex + 1);
  try {
    const base = page.getViewport({scale: 1});
    // Render at 150 dpi, or less when the budget would shrink it anyway: no point drawing pixels we
    // would immediately throw away. A region only needs its own share of the page to fit.
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
      return await finish(canvas, width, height, scale * 72, pixelBudget, transform);
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    page.cleanup();
  }
}
