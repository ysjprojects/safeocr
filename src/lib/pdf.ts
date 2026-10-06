/**
 * Searchable PDF writer: one JPEG per page plus an invisible text layer (text rendering mode 3) so
 * the result is searchable and selectable. Hand-written like the ZIP in `export.ts` — no dependency.
 *
 * The text layer follows tesseract's PDF renderer: a Type0 font with Identity-H encoding over a
 * glyphless CIDFontType2 whose every CID maps to the single empty glyph, with a ToUnicode CMap that
 * maps each 2-byte code to itself. Text is therefore written as UTF-16BE code units and extracts
 * verbatim (Latin and CJK alike), while nothing is drawn.
 */

export interface PdfPageInput {
  /** JPEG bytes of the page image. */
  jpeg: ArrayBuffer;
  /** Pixel size of the JPEG. */
  width: number;
  height: number;
  /** Page size in PDF points (1/72 in). */
  pointWidth: number;
  pointHeight: number;
  /**
   * Text to place invisibly. With a box (fractions 0–1 of the page, origin top-left, y down),
   * the line is placed and stretched to its box; lines without a box are stacked from the top-left
   * in a small font so the page is still searchable.
   */
  lines: {text: string; box: {x: number; y: number; width: number; height: number} | null}[];
}

/**
 * tesseract's `tessdata/pdf.ttf` (Apache-2.0, 572 bytes): a TrueType font with one empty glyph,
 * referenced by every CID through the CIDToGIDMap so the text layer renders nothing.
 */
const GLYPHLESS_FONT =
  'AAEAAAAKAIAAAwAgT1MvMlbeyJQAAAEoAAAAYGNtYXAACgA0AAABkAAAAB5nbHlmFSJBJAAAAbgAAAAYaGVhZAt48WUAAACsAAAANmhoZWEMAgQCAAAA5AAAACRobXR4BAAAAAAAAYgAAAAIbG9jYQAMAAAAAAGwAAAABm1heHAABAAFAAABCAAAACBuYW1l8usW2gAAAdAAAABLcG9zdAABAAEAAAIcAAAAIAABAAAAAQAAsJRxEF8PPPUEBwgAAAAAAM+a/G4AAAAA1MOn8gAAAAAEAAgAAAAAEAACAAAAAAAAAAEAAAgA//8AAAQAAAAAAAQAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAQAAQAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAwAAAZAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAR09PRwBAAAAAAAAB//8AAAABAAGAAAAAAAAAAAAAAAAAAAABAAAAAAAABAAAAAAAAAIAAQAAAAAAFAADAAAAAAAUAAYACgAAAAAAAAAAAAAAAAAMAAAAAQAAAAAEAAgAAAMAADEhESEEAPwACAAAAAADACoAAAADAAAABQAWAAAAAQAAAAAABQALABYAAwABBAkABQAWAAAAVgBlAHIAcwBpAG8AbgAgADEALgAwVmVyc2lvbiAxLjAAAAEAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=';

const TO_UNICODE_CMAP = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

/** Glyph advance in 1/1000 em (`/DW`); every CID is this wide. */
const GLYPH_WIDTH = 0.5;
const UNBOXED_SIZE = 8;
const UNBOXED_STEP = 10;
const UNBOXED_MARGIN = 36;

const encoder = new TextEncoder();

/** A PDF number: at most 3 decimals, no exponent, no trailing zeros. */
function num(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 0.0005) return '0';
  return String(Number(n.toFixed(3)));
}

/** A literal text string: ASCII only (non-ASCII becomes `?`), delimiters escaped. */
function textString(s: string): string {
  // eslint-disable-next-line no-control-regex
  return `(${s.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, c => `\\${c}`)})`;
}

/** UTF-16BE code units as a PDF hex string; surrogate pairs become two codes, like tesseract. */
function hexString(text: string): string {
  let hex = '<';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  return hex + '>';
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A stream object body: `dict` is the dictionary's inner entries, `/Length` is appended. */
function stream(dict: string, data: Uint8Array): Uint8Array {
  return concat([
    encoder.encode(`<< ${dict} /Length ${data.length} >>\nstream\n`),
    data,
    encoder.encode('\nendstream'),
  ]);
}

/** zlib-wrapped deflate (what `/FlateDecode` expects), or `null` when the runtime lacks CompressionStream. */
async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') return null;
  const compressor = new CompressionStream('deflate');
  const writer = compressor.writable.getWriter();
  const [, compressed] = await Promise.all([
    writer.write(data).then(() => writer.close()),
    new Response(compressor.readable).arrayBuffer(),
  ]);
  return new Uint8Array(compressed);
}

/** Collects indirect objects by number and serialises them with a classic xref table. */
class ObjectTable {
  private readonly bodies: (Uint8Array | null)[] = [];

  /** Allocates an object number whose body is supplied later with `set`. */
  reserve(): number {
    this.bodies.push(null);
    return this.bodies.length;
  }

  set(id: number, body: string | Uint8Array): void {
    this.bodies[id - 1] = typeof body === 'string' ? encoder.encode(body) : body;
  }

  add(body: string | Uint8Array): number {
    const id = this.reserve();
    this.set(id, body);
    return id;
  }

  serialise(root: number, info: number): Uint8Array[] {
    const parts: Uint8Array[] = [
      concat([encoder.encode('%PDF-1.5\n%'), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]),
    ];
    let offset = parts[0].length;
    let xref = `xref\n0 ${this.bodies.length + 1}\n0000000000 65535 f \n`;
    this.bodies.forEach((body, i) => {
      if (!body) throw new Error(`PDF object ${i + 1} was reserved but never set`);
      xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
      const part = concat([encoder.encode(`${i + 1} 0 obj\n`), body, encoder.encode('\nendobj\n')]);
      parts.push(part);
      offset += part.length;
    });
    parts.push(
      encoder.encode(
        `${xref}trailer\n<< /Size ${
          this.bodies.length + 1
        } /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
      ),
    );
    return parts;
  }
}

/** The shared Type0 font (tesseract's GlyphLessFont); returns the font object number. */
async function addGlyphlessFont(objects: ObjectTable): Promise<number> {
  const fontFile = Uint8Array.from(atob(GLYPHLESS_FONT), c => c.charCodeAt(0));
  const fileId = objects.add(stream(`/Length1 ${fontFile.length}`, fontFile));

  // Every CID → glyph 1 (the empty glyph): 65536 big-endian uint16 ones.
  const cidToGid = new Uint8Array(2 * 65536);
  for (let i = 1; i < cidToGid.length; i += 2) cidToGid[i] = 1;
  const compressed = await deflate(cidToGid);
  const mapId = objects.add(compressed ? stream('/Filter /FlateDecode', compressed) : stream('', cidToGid));

  const descriptorId = objects.add(
    '<< /Type /FontDescriptor /FontName /GlyphLessFont /FontBBox [0 0 500 1000] /Flags 4 /Ascent 1000 /Descent 0 ' +
      `/CapHeight 1000 /ItalicAngle 0 /StemV 80 /FontFile2 ${fileId} 0 R >>`,
  );
  const cidFontId = objects.add(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GlyphLessFont /CIDToGIDMap ${mapId} 0 R ` +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
      `/FontDescriptor ${descriptorId} 0 R /DW ${GLYPH_WIDTH * 1000} >>`,
  );
  const toUnicodeId = objects.add(stream('', encoder.encode(TO_UNICODE_CMAP)));
  return objects.add(
    '<< /Type /Font /Subtype /Type0 /BaseFont /GlyphLessFont /Encoding /Identity-H ' +
      `/DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`,
  );
}

/** The page's content stream: the image over the whole page, then every line in invisible text. */
function pageContent(page: PdfPageInput): string {
  const {pointWidth, pointHeight} = page;
  let content = `q ${num(pointWidth)} 0 0 ${num(pointHeight)} 0 0 cm /Im1 Do Q\nBT 3 Tr\n`;
  let unboxedY = pointHeight - UNBOXED_MARGIN;
  for (const {text, box} of page.lines) {
    if (text.length === 0) continue;
    let size = UNBOXED_SIZE;
    let scale = 100;
    let x = UNBOXED_MARGIN;
    let y: number;
    if (box) {
      size = Math.max(1, box.height * pointHeight);
      const natural = GLYPH_WIDTH * size * text.length;
      scale = Math.min(500, Math.max(10, ((box.width * pointWidth) / natural) * 100));
      x = box.x * pointWidth;
      y = pointHeight - (box.y + box.height) * pointHeight;
    } else {
      y = unboxedY;
      unboxedY -= UNBOXED_STEP;
    }
    content += `/F1 ${num(size)} Tf ${num(scale)} Tz 1 0 0 1 ${num(x)} ${num(y)} Tm ${hexString(text)} Tj\n`;
  }
  return content + 'ET';
}

/** Builds the PDF; resolves with an `application/pdf` Blob. */
export async function searchablePdf(pages: PdfPageInput[], options: {title?: string} = {}): Promise<Blob> {
  const objects = new ObjectTable();
  const catalogId = objects.reserve();
  const pagesId = objects.reserve();
  const infoId = objects.add(
    `<< /Producer (SafeOCR)${options.title === undefined ? '' : ` /Title ${textString(options.title)}`} >>`,
  );
  const fontId = await addGlyphlessFont(objects);

  const pageIds: number[] = [];
  for (const page of pages) {
    const imageId = objects.add(
      stream(
        `/Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB ` +
          '/BitsPerComponent 8 /Filter /DCTDecode',
        new Uint8Array(page.jpeg),
      ),
    );
    const contentId = objects.add(stream('', encoder.encode(pageContent(page))));
    pageIds.push(
      objects.add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.pointWidth)} ${num(page.pointHeight)}] ` +
          `/Resources << /XObject << /Im1 ${imageId} 0 R >> /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }

  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objects.set(
    pagesId,
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`,
  );
  return new Blob(objects.serialise(catalogId, infoId), {type: 'application/pdf'});
}
