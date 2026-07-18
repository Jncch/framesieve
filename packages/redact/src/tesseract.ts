import type { FrameInput } from "framesieve";
import type { OcrEngine, OcrWord } from "./index.ts";

/**
 * OCR adapter for tesseract.js. tesseract.js is an optional peer
 * dependency: this module only loads it when the engine is first
 * used, and importing this file without tesseract.js installed is
 * fine as long as recognize() is never called.
 *
 * The usual redaction caveat applies twice here: tesseract reads
 * screen text notably worse than frontier VLMs, so pattern and
 * dictionary masks built on it are best-effort defense in depth.
 */

// Structural slices of the tesseract.js API; kept minimal so no type
// dependency on the package is needed.
interface TessBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TessWord {
  text: string;
  bbox: TessBBox;
}
interface TessResult {
  data: { words?: TessWord[] };
}
interface TessWorker {
  recognize(image: unknown): Promise<TessResult>;
  terminate(): Promise<unknown>;
}
interface TessModule {
  createWorker(lang?: string): Promise<TessWorker>;
}

export interface TesseractAdapterOptions {
  /** Language(s) passed to createWorker. Default: "eng+jpn". */
  lang?: string;
  /**
   * Converts a frame into something tesseract.js can consume (encoded
   * image bytes, ImageData, ...). The default uses the DOM ImageData
   * constructor; in node, pass e.g. the PNG encoder from
   * "@framesieve/adapters/node":
   *
   *   toImage: (f) => Buffer.from(encodePng(f))
   */
  toImage?: (frame: FrameInput) => unknown;
}

interface ImageDataCtor {
  new (data: Uint8ClampedArray, width: number, height: number): unknown;
}

function defaultToImage(frame: FrameInput): unknown {
  const ctor = (globalThis as Record<string, unknown>)["ImageData"];
  if (typeof ctor !== "function") {
    throw new TypeError(
      "no ImageData in this environment; pass TesseractAdapterOptions.toImage " +
        "(for node: encode the frame to PNG bytes first)",
    );
  }
  return new (ctor as ImageDataCtor)(
    new Uint8ClampedArray(frame.data),
    frame.width,
    frame.height,
  );
}

export function tesseractAdapter(
  options: TesseractAdapterOptions = {},
): OcrEngine & { terminate(): Promise<void> } {
  const lang = options.lang ?? "eng+jpn";
  const toImage = options.toImage ?? defaultToImage;
  let workerPromise: Promise<TessWorker> | null = null;

  async function worker(): Promise<TessWorker> {
    if (workerPromise === null) {
      const specifier = "tesseract.js";
      workerPromise = (async () => {
        let mod: unknown;
        try {
          mod = await import(specifier);
        } catch (cause) {
          throw new Error(
            'tesseract.js is not installed; "npm install tesseract.js" to use ' +
              "this adapter, or plug in another OcrEngine",
            { cause },
          );
        }
        return (mod as TessModule).createWorker(lang);
      })();
    }
    return workerPromise;
  }

  return {
    async recognize(frame: FrameInput): Promise<OcrWord[]> {
      const w = await worker();
      const result = await w.recognize(toImage(frame));
      return (result.data.words ?? []).map((word) => ({
        text: word.text,
        region: {
          x: word.bbox.x0,
          y: word.bbox.y0,
          width: Math.max(1, word.bbox.x1 - word.bbox.x0),
          height: Math.max(1, word.bbox.y1 - word.bbox.y0),
        },
      }));
    },
    async terminate(): Promise<void> {
      if (workerPromise !== null) {
        const w = await workerPromise;
        await w.terminate();
        workerPromise = null;
      }
    },
  };
}
