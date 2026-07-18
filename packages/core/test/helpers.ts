import type { FrameInput } from "../src/types.ts";

/** Build an RGBA frame filled with a single gray level. */
export function solidFrame(
  width: number,
  height: number,
  level: number,
  elapsedMs: number,
): FrameInput {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = level;
    data[p + 1] = level;
    data[p + 2] = level;
    data[p + 3] = 255;
  }
  return { data, width, height, elapsedMs };
}

/** Build an RGBA frame where the gray level is fn(x, y). */
export function frameOf(
  width: number,
  height: number,
  elapsedMs: number,
  fn: (x: number, y: number) => number,
): FrameInput {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const level = fn(x, y);
      const p = (y * width + x) * 4;
      data[p] = level;
      data[p + 1] = level;
      data[p + 2] = level;
      data[p + 3] = 255;
    }
  }
  return { data, width, height, elapsedMs };
}

/** Overwrite a rectangle of an existing frame with a gray level. */
export function paintRect(
  frame: FrameInput,
  x0: number,
  y0: number,
  w: number,
  h: number,
  level: number,
): FrameInput {
  const data = new Uint8ClampedArray(frame.data);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = (y * frame.width + x) * 4;
      data[p] = level;
      data[p + 1] = level;
      data[p + 2] = level;
      data[p + 3] = 255;
    }
  }
  return { ...frame, data };
}

/** Same pixels, new timestamp. */
export function at(frame: FrameInput, elapsedMs: number): FrameInput {
  return { ...frame, elapsedMs };
}
