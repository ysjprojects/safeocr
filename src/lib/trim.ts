/**
 * Trims a page's uniform margins before it reaches GLM-OCR. The vision encoder attends across every
 * patch of the image, so its cost grows faster than the pixel count, and the margins of a document
 * page are a quarter of its pixels for nothing. Pure function over RGBA pixels; runs in the worker.
 */
import type {PixelImage} from './protocol';

/** A pixel is content when a channel differs this much (0–255) from the background. */
const CONTRAST = 40;
/** A row or column is content when at least this many of its pixels are; dust stays margin. */
const MIN_CONTENT = 3;
/** Kept around the content on each side: one 28-px patch of context for the model. */
const PAD = 28;
/** Not worth a copy unless at least this share of the pixels goes. */
const MIN_SAVING = 0.1;
/** Border samples: every `BORDER_STEP`th pixel of the outermost `BORDER` rows and columns. */
const BORDER = 2;
const BORDER_STEP = 7;
/** Share of border samples allowed to differ from the border colour; more means no uniform margin. */
const BORDER_NOISE = 0.02;

/**
 * Returns the content area of `image` (plus padding) as a new image, or `image` itself when it has
 * no uniform margin to remove: a border that is not one colour (photos, dark frames, text touching
 * the edge), no content at all, or a crop that would save less than a tenth of the pixels.
 */
export function trimMargins(image: PixelImage): PixelImage {
  const {width, height} = image;
  if (width < 4 * PAD || height < 4 * PAD) return image;
  const px = new Uint8ClampedArray(image.data);

  // Background: the mean of the border samples, accepted only when nearly all of them agree.
  const border: number[] = [];
  for (let y = 0; y < height; y++) {
    if (y < BORDER || y >= height - BORDER) {
      for (let x = 0; x < width; x += BORDER_STEP) border.push((y * width + x) * 4);
    } else if (y % BORDER_STEP === 0) {
      for (let x = 0; x < BORDER; x++) border.push((y * width + x) * 4, (y * width + width - 1 - x) * 4);
    }
  }
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of border) {
    r += px[i];
    g += px[i + 1];
    b += px[i + 2];
  }
  r = Math.round(r / border.length);
  g = Math.round(g / border.length);
  b = Math.round(b / border.length);
  let noisy = 0;
  for (const i of border) {
    if (Math.abs(px[i] - r) > CONTRAST || Math.abs(px[i + 1] - g) > CONTRAST || Math.abs(px[i + 2] - b) > CONTRAST)
      noisy++;
  }
  if (noisy > border.length * BORDER_NOISE) return image;

  // One pass: how many content pixels each row and each column holds.
  const rows = new Uint32Array(height);
  const cols = new Uint32Array(width);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      if (Math.abs(px[i] - r) > CONTRAST || Math.abs(px[i + 1] - g) > CONTRAST || Math.abs(px[i + 2] - b) > CONTRAST) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  let top = 0;
  while (top < height && rows[top] < MIN_CONTENT) top++;
  if (top === height) return image;
  let bottom = height - 1;
  while (rows[bottom] < MIN_CONTENT) bottom--;
  let left = 0;
  while (cols[left] < MIN_CONTENT) left++;
  let right = width - 1;
  while (cols[right] < MIN_CONTENT) right--;

  const x0 = Math.max(0, left - PAD);
  const y0 = Math.max(0, top - PAD);
  const x1 = Math.min(width, right + 1 + PAD);
  const y1 = Math.min(height, bottom + 1 + PAD);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw * ch > width * height * (1 - MIN_SAVING)) return image;

  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const src = ((y0 + y) * width + x0) * 4;
    out.set(px.subarray(src, src + cw * 4), y * cw * 4);
  }
  return {width: cw, height: ch, data: out.buffer};
}
