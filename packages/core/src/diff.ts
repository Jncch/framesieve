import type { DiffAlgorithm, DiffMode, FrameInput, Region } from "./types.ts";
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

/**
 * A step's result. `mask/w/h` is the SCORE mask (vs the comparison
 * baseline: the previous frame in "previous" mode, the last committed
 * frame in "reference" mode). `motion` is always vs the immediately
 * previous frame; the block grid uses it to drive the adaptive mask so
 * chronically moving regions are down-weighted regardless of mode. In
 * "previous" mode the two are the same buffer.
 */
export interface DiffResult extends ChangeMask {
  motion: ChangeMask;
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
 * Sobel edge magnitude over a grayscale buffer, |gx| + |gy| clamped to
 * 255 (integer, so results stay bit-identical across platforms).
 * Borders clamp to the edge pixel. Comparing edge maps instead of luma
 * makes a uniform brightness shift (unchanged gradients) a non-event.
 */
export function sobel(gray: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < w - 1 ? x + 1 : w - 1;
      const tl = gray[y0 * w + x0]!;
      const tc = gray[y0 * w + x]!;
      const tr = gray[y0 * w + x1]!;
      const ml = gray[y * w + x0]!;
      const mr = gray[y * w + x1]!;
      const bl = gray[y1 * w + x0]!;
      const bc = gray[y1 * w + x]!;
      const br = gray[y1 * w + x1]!;
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      const m = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
      out[y * w + x] = m > 255 ? 255 : m;
    }
  }
  return out;
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
 * Stateful stage-1 engine. Holds two working buffers:
 *  - prevFrame: the immediately previous frame; advances every step.
 *    The motion mask is computed against it.
 *  - baseline: the comparison target for the score mask. In "previous"
 *    mode it tracks prevFrame (advances every step), so score == motion.
 *    In "reference" mode it only advances when the gate calls commit()
 *    (i.e. on emit), so a change that reverts before commit produces a
 *    zero score mask and is dropped as transient.
 * Both start as all-zero (black) buffers, so the first frame registers
 * as "everything with content changed" without special casing. A change
 * in frame dimensions resets both the same way.
 */
export class DiffEngine {
  private prevFrame: Uint8Array | null = null;
  private baseline: Uint8Array | null = null;
  /** Current step's working buffer, promoted to baseline by commit(). */
  private lastWork: Uint8Array | null = null;
  private prevW = 0;
  private prevH = 0;
  private ignoreMask: Uint8Array | null = null;
  private readonly algorithm: DiffAlgorithm;
  private readonly mode: DiffMode;
  private readonly factor: number;
  private readonly threshold: number;
  private readonly ignoreRegions: Region[];

  constructor(options: ResolvedOptions) {
    this.algorithm = options.diff.algorithm;
    this.mode = options.diff.mode;
    this.factor =
      options.diff.algorithm === "pixel" ? 1 : options.diff.downsampleFactor;
    // A threshold of 0 would mark identical pixels as changed
    // (|delta| >= 0 always holds); clamp so 0 means "any real change".
    this.threshold = Math.max(1, options.diff.luminanceThreshold);
    this.ignoreRegions = options.policy.ignoreRegions;
  }

  /** Changed-pixel mask of work vs ref, honoring the ignore mask. */
  private diffMask(
    work: Uint8Array,
    ref: Uint8Array,
    ignore: Uint8Array | null,
  ): Uint8Array {
    const mask = new Uint8Array(work.length);
    const threshold = this.threshold;
    for (let i = 0; i < mask.length; i++) {
      if (ignore !== null && ignore[i] === 1) continue;
      const d = work[i]! - ref[i]!;
      if ((d >= 0 ? d : -d) >= threshold) mask[i] = 1;
    }
    return mask;
  }

  step(frame: FrameInput): DiffResult {
    // "edge" downsamples like "downsample", then compares Sobel maps.
    const grayAlg: "downsample" | "pixel" =
      this.algorithm === "pixel" ? "pixel" : "downsample";
    const { gray, w, h } = toGray(frame, grayAlg, this.factor);
    const work = this.algorithm === "edge" ? sobel(gray, w, h) : gray;
    if (this.prevFrame === null || this.prevW !== w || this.prevH !== h) {
      this.prevFrame = new Uint8Array(w * h);
      this.baseline = new Uint8Array(w * h);
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
    const ignore = this.ignoreMask;
    if (this.mode === "previous") {
      // Single comparison vs the previous frame; motion is the same
      // buffer as the score mask, so the grid behaves exactly as before.
      const mask = this.diffMask(work, this.prevFrame, ignore);
      this.prevFrame = work;
      const cm: ChangeMask = { mask, w, h };
      return { mask, w, h, motion: cm };
    }
    // reference: score vs the committed baseline, motion vs prev frame.
    const scoreMask = this.diffMask(work, this.baseline!, ignore);
    const motionMask = this.diffMask(work, this.prevFrame, ignore);
    this.prevFrame = work; // motion baseline advances every step
    this.lastWork = work; // score baseline advances only on commit()
    return { mask: scoreMask, w, h, motion: { mask: motionMask, w, h } };
  }

  /**
   * Promote the current frame to the comparison baseline. The gate
   * calls this on emit in "reference" mode; in "previous" mode the
   * baseline already tracks every frame, so this is a no-op.
   */
  commit(): void {
    if (this.mode === "reference" && this.lastWork !== null) {
      this.baseline = this.lastWork;
    }
  }

  reset(): void {
    this.prevFrame = null;
    this.baseline = null;
    this.lastWork = null;
    this.prevW = 0;
    this.prevH = 0;
    this.ignoreMask = null;
  }
}
