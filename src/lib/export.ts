/**
 * Download helpers: single results as text files, batches as a ZIP (store-only, so no dependency;
 * OCR output is small and the browser's download path does not care about compression).
 */

export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // Revoking synchronously races the download in Safari; a tick later is safe everywhere.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name safe on every OS: the stem of `name` with its extension replaced. */
export function outputName(name: string, extension: string, suffix = ''): string {
  const stem =
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim() || 'ocr';
  return `${stem}${suffix}.${extension}`;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A text member (UTF-8) or a binary one (a PDF, for instance); both are stored uncompressed. */
export type ZipEntry = {name: string; text: string} | {name: string; bytes: Uint8Array};

/** Builds a ZIP archive with one stored (uncompressed) member per entry. */
export function zip(entries: ZipEntry[], date = new Date()): Blob {
  const encoder = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const used = new Set<string>();

  for (const entry of entries) {
    // Duplicate names are legal in ZIP but confuse every extractor; number them.
    let name = entry.name;
    for (let n = 2; used.has(name); n++) name = entry.name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
    used.add(name);

    const nameBytes = encoder.encode(name);
    const data = 'bytes' in entry ? entry.bytes : encoder.encode(entry.text);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true); // version made by
    header.setUint16(6, 20, true); // version needed
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, dosTime, true);
    header.setUint16(14, dosDate, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, data.length, true);
    header.setUint32(24, data.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint16(30, 0, true); // extra
    header.setUint16(32, 0, true); // comment
    header.setUint16(34, 0, true); // disk
    header.setUint16(36, 0, true); // internal attributes
    header.setUint32(38, 0, true); // external attributes
    header.setUint32(42, offset, true);

    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(header.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  let centralSize = 0;
  for (const part of central) centralSize += part.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], {type: 'application/zip'});
}
