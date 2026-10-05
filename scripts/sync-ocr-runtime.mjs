/* eslint-env node */
// Copies the runtimes SafeOCR needs at run time, outside the webpack graph, into
// public/ocr-runtime/<lib>/<version>/ so they are served from this origin:
//   - onnxruntime-web's WebAssembly runtime (its default is jsDelivr)
//   - pdf.js's worker plus the wasm decoders (JBIG2, JPX, ICC), CMaps and standard fonts that scanned
//     and CJK PDFs need to rasterise
// Directories are versioned so they can be served with immutable cache headers; stale versions are
// removed. The versions are read at run time from the packages themselves, so no manifest is needed.
import {cp, mkdir, readdir, readFile, rm, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outRoot = `${root}public/ocr-runtime/`;

async function version(pkg) {
  return JSON.parse(await readFile(`${root}node_modules/${pkg}/package.json`, 'utf8')).version;
}

async function syncVersionDir(lib, ver) {
  const libRoot = `${outRoot}${lib}/`;
  await mkdir(libRoot, {recursive: true});
  for (const entry of await readdir(libRoot, {withFileTypes: true})) {
    if (entry.isDirectory() && entry.name !== ver) await rm(`${libRoot}${entry.name}`, {recursive: true, force: true});
  }
  const dir = `${libRoot}${ver}/`;
  await mkdir(dir, {recursive: true});
  return dir;
}

/** Copies `src` (file or directory) to `dst` unless the destination is already as new and as large. */
async function copy(src, dst) {
  const srcStat = await stat(src);
  if (srcStat.isDirectory()) {
    await cp(src, dst, {recursive: true, force: false, errorOnExist: false});
    return 1;
  }
  const dstStat = await stat(dst).catch(() => null);
  if (dstStat && dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) return 0;
  await cp(src, dst);
  return 1;
}

// onnxruntime-web: the `onnxruntime-web/webgpu` bundle is built with asyncify and only ever asks for these two files.
const ortVersion = await version('onnxruntime-web');
const ortDir = await syncVersionDir('ort', ortVersion);
let copied = 0;
for (const name of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  copied += await copy(`${root}node_modules/onnxruntime-web/dist/${name}`, `${ortDir}${name}`);
}
console.log(`onnxruntime-web ${ortVersion}: ${copied} file(s) copied to public/ocr-runtime/ort/${ortVersion}/`);

// pdf.js
const pdfVersion = await version('pdfjs-dist');
const pdfDir = await syncVersionDir('pdfjs', pdfVersion);
copied = await copy(`${root}node_modules/pdfjs-dist/build/pdf.worker.min.mjs`, `${pdfDir}pdf.worker.min.mjs`);
for (const name of ['wasm', 'cmaps', 'standard_fonts']) {
  copied += await copy(`${root}node_modules/pdfjs-dist/${name}`, `${pdfDir}${name}`);
}
console.log(`pdfjs-dist ${pdfVersion}: ${copied} item(s) copied to public/ocr-runtime/pdfjs/${pdfVersion}/`);
