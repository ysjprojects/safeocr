/**
 * PP-OCR (text detection + recognition; v6 small at ~31 MB, v5 mobile at ~21 MB) through
 * paddleocr.js on the WebAssembly backend of the same onnxruntime-web instance Transformers.js
 * uses. Deterministic and faithful: it reads what is printed, line by line, and never invents
 * text. Runs in every browser.
 */
import * as ort from 'onnxruntime-web/webgpu';
import {type OrtModule, type RecognitionResult, PaddleOcrService} from 'paddleocr';

import {fetchCached} from '../assets';
import {
  type AssetHosts,
  type OcrSegment,
  type PaddleEngineId,
  type PixelImage,
  PADDLE_MODELS,
  paddleTotalBytes,
  sum,
} from '../protocol';
import type {LoadProgress} from './glm';

/**
 * paddleocr.js only needs `Tensor` and a session factory; this one pins the CPU (wasm) provider.
 * paddleocr.js types the session structurally with just the members it uses, while onnxruntime-web's
 * session type carries a metadata union it cannot name; at run time they are the same objects.
 */
const ortModule = {
  Tensor: ort.Tensor,
  InferenceSession: {
    create: (modelBuffer: ArrayBuffer) =>
      ort.InferenceSession.create(modelBuffer, {executionProviders: ['wasm'], graphOptimizationLevel: 'all'}),
  },
} as unknown as OrtModule;

export class PaddleEngine {
  private constructor(private readonly service: PaddleOcrService) {}

  static async load(
    hosts: AssetHosts,
    engine: PaddleEngineId,
    onProgress: (progress: LoadProgress) => void,
  ): Promise<PaddleEngine> {
    const models = PADDLE_MODELS[engine];
    const totalBytes = paddleTotalBytes(engine);
    const loadedByFile: Record<string, number> = {};
    const fetchFile = (file: {path: string}) => {
      const name = file.path.slice(file.path.lastIndexOf('/') + 1);
      return fetchCached(`${hosts.paddleHost}${file.path}`, loaded => {
        loadedByFile[file.path] = loaded;
        const total = sum(Object.values(loadedByFile));
        onProgress({loaded: Math.min(total, totalBytes), total: totalBytes, file: name});
      });
    };
    const [det, rec, dict] = await Promise.all([fetchFile(models.det), fetchFile(models.rec), fetchFile(models.dict)]);
    // PaddleOCR's CTC layout: the blank (the dictionaries start with an empty line), the
    // characters, then the space the recogniser's last output class stands for. paddleocr.js maps
    // output indices straight onto this array, so the length must match the model's classes
    // (18 385 for v5, 18 710 for v6).
    const characters = new TextDecoder().decode(dict).split(/\r?\n/);
    if (characters[characters.length - 1] === '') characters.pop();
    characters.push(' ');
    const service = await PaddleOcrService.createInstance({
      ort: ortModule,
      modelPreset: models.preset,
      detection: {modelBuffer: det},
      recognition: {modelBuffer: rec, charactersDictionary: characters},
    });
    return new PaddleEngine(service);
  }

  /**
   * Detects text boxes, recognises each, and returns the lines in reading order, plus every
   * segment with its box and confidence (`line` is its index in `text.split('\n')`).
   */
  async recognize(
    image: PixelImage,
    onStage: (message: string) => void,
  ): Promise<{text: string; lines: number; segments: OcrSegment[]}> {
    const results: RecognitionResult[] = await this.service.recognize(
      {width: image.width, height: image.height, data: new Uint8Array(image.data)},
      {
        onProgress: event => {
          if (event.type === 'det') onStage(`detecting text (${event.stage})`);
          else if (event.stage === 'item') onStage(`reading line ${event.progress.current} of ${event.progress.total}`);
        },
      },
    );
    const {text, lines} = this.service.processRecognition(results);
    const segments: OcrSegment[] = [];
    lines.forEach((line, index) => {
      for (const r of line) {
        segments.push({
          line: index,
          text: r.text,
          confidence: r.confidence,
          box: {x: r.box.x, y: r.box.y, width: r.box.width, height: r.box.height},
        });
      }
    });
    return {text, lines: lines.length, segments};
  }

  async dispose(): Promise<void> {
    await this.service.destroy();
  }
}
