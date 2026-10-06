/**
 * PP-OCRv5 mobile (text detection + recognition, ~21 MB) through paddleocr.js on the WebAssembly
 * backend of the same onnxruntime-web instance Transformers.js uses. Deterministic and faithful:
 * it reads what is printed, line by line, and never invents text. Runs in every browser.
 */
import * as ort from 'onnxruntime-web/webgpu';
import {type OrtModule, type RecognitionResult, PaddleOcrService} from 'paddleocr';

import {fetchCached} from '../assets';
import {type AssetHosts, type OcrSegment, type PixelImage, PADDLE_FILES, PADDLE_TOTAL_BYTES, sum} from '../protocol';
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

  static async load(hosts: AssetHosts, onProgress: (progress: LoadProgress) => void): Promise<PaddleEngine> {
    const loadedByFile: Record<string, number> = {};
    const report = (name: string) => (loaded: number) => {
      loadedByFile[name] = loaded;
      const total = sum(Object.values(loadedByFile));
      onProgress({loaded: Math.min(total, PADDLE_TOTAL_BYTES), total: PADDLE_TOTAL_BYTES, file: name});
    };
    const [det, rec, dict] = await Promise.all([
      fetchCached(`${hosts.paddleBase}${PADDLE_FILES.det.name}`, report(PADDLE_FILES.det.name)),
      fetchCached(`${hosts.paddleBase}${PADDLE_FILES.rec.name}`, report(PADDLE_FILES.rec.name)),
      fetchCached(`${hosts.paddleBase}${PADDLE_FILES.dict.name}`, report(PADDLE_FILES.dict.name)),
    ]);
    // PaddleOCR's CTC layout: the blank (this bundle's dictionary starts with an empty line), the
    // characters, then the space the recogniser's last output class stands for. paddleocr.js maps
    // output indices straight onto this array, so the length must match the model's 18 385 classes.
    const characters = new TextDecoder().decode(dict).split(/\r?\n/);
    if (characters[characters.length - 1] === '') characters.pop();
    characters.push(' ');
    const service = await PaddleOcrService.createInstance({
      ort: ortModule,
      modelPreset: 'PP-OCRv5_mobile',
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
