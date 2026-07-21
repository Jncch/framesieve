import type { FrameInput } from "./types.ts";

/**
 * The subset of the DOM `ImageData` shape this helper needs. Declared
 * structurally so core stays free of the DOM lib: a browser
 * `ImageData`, an Electron `nativeImage`-derived buffer, a node PNG
 * decode result, or any `{ data, width, height }` object all satisfy
 * it. `data` accepts `Uint8Array` too (e.g. `Buffer`), so callers do
 * not have to convert first.
 */
export interface ImageDataLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * Wrap decoded RGBA pixels as a FrameInput. This is the one-liner
 * entry point for the common case where you already hold a still
 * image (a browser `ImageData`, a decoded PNG, a canvas readback)
 * rather than a live stream. `elapsedMs` is the caller-supplied
 * monotonic timestamp the gate uses for all temporal policy.
 *
 * The pixel buffer is reused, not copied, when it is already a
 * `Uint8ClampedArray`; the gate snapshots it on emit, so a later
 * mutation cannot leak into a delivered frame regardless.
 */
export function frameFromImageData(
  image: ImageDataLike,
  elapsedMs: number,
): FrameInput {
  const { width, height } = image;
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError(`image.width must be a positive integer, got ${width}`);
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new RangeError(
      `image.height must be a positive integer, got ${height}`,
    );
  }
  const expected = width * height * 4;
  if (image.data.length !== expected) {
    throw new RangeError(
      `image.data length ${image.data.length} does not match ` +
        `width * height * 4 = ${expected}`,
    );
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError(`elapsedMs must be a finite number >= 0, got ${elapsedMs}`);
  }
  const data =
    image.data instanceof Uint8ClampedArray
      ? image.data
      : new Uint8ClampedArray(image.data);
  return { data, width, height, elapsedMs };
}
