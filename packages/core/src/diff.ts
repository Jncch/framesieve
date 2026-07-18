import type { FrameInput, Region } from "./types.ts";
import type { ResolvedOptions } from "./config.ts";

/**
 * Stage 1: downsample + grayscale + luminance floor.
 *
 * Produces a per-pixel change mask over a working-resolution grayscale
 * buffer. Everything here is integer math; no floating point creeps
 * into the comparison, which keeps results bit-identical across
 * platforms.
 */

export interface ChangeMask {
  /** 1 = changed, 0 = unchanged or ignored. Row-major, w * h. */
  mask: Uint8Array;
  w: number;
  h: number;
}

export function validateFrame(frame: FrameInput): void {
  if (!Number.isInteger(frame.width) || frame.width < 1) {
    throw new RangeError(`frame.width must be a positive integer`);
  }
  if (!Number.isInteger(frame.height) || frame.height < 1) {
    throw new RangeError(`frame.height must be a positive integer`);
  }
  if (frame.data.length !== frame.width * frame.height * 4) {
    throw new RangeError(
      `frame.data length ${frame.data.length} does not match ` +
        `width * height * 4 = ${frame.width * frame.height * 4}`,
    );
  }
  if (!Number.isFinite(frame.elapsedMs) || frame.elapsedMs < 0) {
    throw new RangeError(`frame.elapsedMs must be a finite number >= 0`);
  }
}

/** Fixed-point Rec.601 luma; deterministic across platforms. */
function luma(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

/**
 * Grayscale at working resolution. For "downsample", each output pixel
 * is the integer-average luma of a factor x factor source block;
 * remainder rows/columns beyond the last full block are dropped.
 */
export function toGray(
  frame: FrameInput,
  algorithm: "downsample" | "pixel",
  factor: number,
): { gray: Uint8Array; w: number; h: number } {
  const { data, width, height } = frame;
  if (algorithm === "pixel" || factor === 1) {
    const gray = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = luma(data[p]!, data[p + 1]!, data[p + 2]!);
    }
    return { gray, w: width, h: height };
  }
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const fx = Math.min(factor, width);
  const fy = Math.min(factor, height);
  const count = fx * fy;
  const gray = new Uint8Array(w * h);
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      let sum = 0;
      for (let y = by * fy; y < by * fy + fy; y++) {
        let p = (y * width + bx * fx) * 4;
        for (let x = 0; x < fx; x++, p += 4) {
          sum += luma(data[p]!, data[p + 1]!, data[p + 2]!);
        }
      }
      gray[by * w + bx] = Math.floor(sum / count);
    }
  }
  return { gray, w, h };
}

/**
 * Ignore mask at working resolution: 1 where the working pixel's
 * source footprint intersects any ignore region (in source pixels).
 */
export function buildIgnoreMask(
  w: number,
  h: number,
  scaleX: number,
  scaleY: number,
  regions: Region[],
): Uint8Array | null {
  if (regions.length === 0) return null;
  const mask = new Uint8Array(w * h);
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x / scaleX));
    const y0 = Math.max(0, Math.floor(r.y / scaleY));
    const x1 = Math.min(w - 1, Math.ceil((r.x + r.width) / scaleX) - 1);
    const y1 = Math.min(h - 1, Math.ceil((r.y + r.height) / scaleY) - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}

/**
 * Stateful stage-1 engine. Holds the previous working buffer. The
 * baseline starts as an all-zero (black) buffer, so the first frame
 * registers as "everything with content changed" without any special
 * casing. A change in frame dimensions resets the baseline the same
 * way.
 */
export class DiffEngine {
  private prev: Uint8Array | null = null;
  private prevW = 0;
  private prevH = 0;
  private ignoreMask: Uint8Array | null = null;
  private readonly algorithm: "downsample" | "pixel";
  private readonly factor: number;
  private readonly threshold: number;
  private readonly ignoreRegions: Region[];

  constructor(options: ResolvedOptions) {
    this.algorithm = options.diff.algorithm;
    this.factor =
      options.diff.algorithm === "pixel" ? 1 : options.diff.downsampleFactor;
    // A threshold of 0 would mark identical pixels as changed
    // (|delta| >= 0 always holds); clamp so 0 means "any real change".
    this.threshold = Math.max(1, options.diff.luminanceThreshold);
    this.ignoreRegions = options.policy.ignoreRegions;
  }

  step(frame: FrameInput): ChangeMask {
    const { gray, w, h } = toGray(frame, this.algorithm, this.factor);
    if (this.prev === null || this.prevW !== w || this.prevH !== h) {
      this.prev = new Uint8Array(w * h);
      this.prevW = w;
      this.prevH = h;
      this.ignoreMask = buildIgnoreMask(
        w,
        h,
        frame.width / w,
        frame.height / h,
        this.ignoreRegions,
      );
    }
    const prev = this.prev;
    const ignore = this.ignoreMask;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) {
      if (ignore !== null && ignore[i] === 1) continue;
      const d = gray[i]! - prev[i]!;
      if ((d >= 0 ? d : -d) >= this.threshold) mask[i] = 1;
    }
    this.prev = gray;
    return { mask, w, h };
  }

  reset(): void {
    this.prev = null;
    this.prevW = 0;
    this.prevH = 0;
    this.ignoreMask = null;
  }
}
