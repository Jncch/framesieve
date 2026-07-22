/**
 * framesieve - core public API (v0.1)
 *
 * Design principles:
 * - Zero dependencies, fully deterministic: same frame sequence in,
 *   same decision sequence out. No timers, no wall clock.
 * - Push model: the caller controls capture cadence and calls push().
 * - The library never talks to any LLM/VLM. It only decides and
 *   transforms. Sending is the caller's job.
 *
 * Recording and replay live in @framesieve/adapters (node entry); the
 * core performs no I/O.
 */

// ---------------------------------------------------------------------------
// Frame input
// ---------------------------------------------------------------------------

/**
 * A single captured frame. Structurally this is a DOM `ImageData`
 * (`data`/`width`/`height`) plus a caller-supplied `elapsedMs`. If you
 * already hold an `ImageData`, a decoded PNG, or a canvas readback, use
 * `frameFromImageData(image, elapsedMs)` instead of hand-building this.
 */
export interface FrameInput {
  /** Raw RGBA pixels, row-major. Length must be width * height * 4. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * Milliseconds since the session started, supplied by the caller.
   * All temporal policies (debounce, minInterval, maxSilence) are
   * evaluated against this value, never against the wall clock.
   */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type DiffAlgorithm =
  /** Downsample to a small grayscale buffer, then compare. Default. */
  | "downsample"
  /** Full-resolution per-pixel compare. Slower; for small sources. */
  | "pixel"
  /**
   * Downsample, then compare Sobel edge maps instead of luma. A uniform
   * brightness / theme color shift leaves gradients unchanged, so it is
   * ignored; text and contour changes still register. luminanceThreshold
   * applies to the edge-magnitude delta. Opt-in.
   */
  | "edge";

export type DiffMode =
  /**
   * Compare each frame against the immediately preceding frame.
   * Default. Any frame-to-frame delta counts, so a transient overlay
   * registers both when it appears and again when it disappears.
   */
  | "previous"
  /**
   * Compare each frame against the last emitted frame (the committed
   * baseline). A change that appears and then reverts to the baseline
   * before it persists is dropped as transient; a change that persists
   * for policy.referencePersistMs is emitted and becomes the new
   * baseline. adaptiveMask still down-weights chronically moving
   * regions (it keys off frame-to-frame motion, not baseline
   * divergence). This is a temporal filter, not a semantic one:
   * whether a persistent change matters is the caller's/VLM's call.
   * Opt-in.
   */
  | "reference";

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffOptions {
  /** Diff algorithm. Default: "downsample". */
  algorithm?: DiffAlgorithm;
  /**
   * Diff comparison baseline. "previous" (default) compares consecutive
   * frames; "reference" compares against the last emitted frame, so a
   * transient change that reverts is dropped and only a change that
   * persists (see policy.referencePersistMs) is emitted. Default:
   * "previous".
   */
  mode?: DiffMode;
  /**
   * Downsample factor for "downsample" algorithm. The frame is reduced
   * to (width/factor) x (height/factor) grayscale. Default: 8.
   */
  downsampleFactor?: number;
  /**
   * Minimum per-pixel luminance delta (0-255) to count a pixel as
   * changed. Filters compression/rendering noise. Default: 10.
   */
  luminanceThreshold?: number;
}

export interface BlockOptions {
  /** Grid dimensions for block-level judgment. Default: 16 x 9. */
  gridCols?: number;
  gridRows?: number;
  /**
   * Fraction (0-1) of changed pixels within a block for the block to
   * count as changed. Default: 0.2.
   */
  blockChangeRatio?: number;
  /**
   * Minimum weighted changed-block score to trigger emit. With the
   * adaptive mask disabled every changed block weighs 1, so this is
   * simply the minimum number of changed blocks. Default: 3.
   */
  minChangedBlocks?: number;
}

export interface AdaptiveMaskOptions {
  /** Enable frequency-based block weighting. Default: true. */
  enabled?: boolean;
  /**
   * Number of recent frames per block used to compute change
   * frequency. Blocks that change on (almost) every frame are
   * down-weighted. Default: 20.
   */
  windowSize?: number;
}

export interface PolicyOptions {
  /**
   * After a change is detected, wait until the screen has been stable
   * for this long before emitting (captures the "settled" state of an
   * animation/transition instead of a mid-transition frame).
   * Evaluated against elapsedMs. Default: 800.
   */
  debounceMs?: number;
  /** Minimum interval between two emits. Default: 2000. */
  minIntervalMs?: number;
  /**
   * Emit a keepalive frame if nothing was emitted for this long,
   * even without changes. Set to 0 to disable. Default: 60000.
   */
  maxSilenceMs?: number;
  /**
   * Emit the very first frame immediately (reason "prime"), bypassing
   * debounce and minInterval, so an observer gets the current state
   * right away instead of waiting for the stream to settle. Applies
   * only to the first frame after construction/reset. Default: false.
   */
  primeOnFirstFrame?: boolean;
  /**
   * Only used when diff.mode is "reference": the minimum time a
   * divergence from the last emitted frame must persist before it is
   * emitted. A change that reverts to the baseline sooner is dropped as
   * transient. This is the reference-mode analog of debounceMs (which
   * keeps its "settle after motion" meaning in the default "previous"
   * mode). Ignored in "previous" mode. Evaluated against elapsedMs.
   * Default: 3000.
   */
  referencePersistMs?: number;
  /**
   * What to do when a frame's elapsedMs is less than the previous
   * frame's. "throw" (default) rejects it with a RangeError; "clamp"
   * pins it to the last seen time and continues. Use "clamp" only if
   * you cannot guarantee a monotonic clock: a plain wall clock can move
   * backwards when an NTP correction fires, whereas a monotonic timer
   * never triggers either path. Default: "throw".
   */
  onNonMonotonic?: "throw" | "clamp";
  /** Static regions to exclude from diff entirely (e.g. a clock). */
  ignoreRegions?: Region[];
}

export interface CropOptions {
  /**
   * When true, emit events include crops of the changed area
   * (bounding boxes of connected changed blocks) in addition to the
   * full frame. Crops are cut from the transformed frame, so
   * redaction applies to them as well. Default: false.
   */
  enabled?: boolean;
  /** Padding in source pixels added around each crop box. Default: 16. */
  paddingPx?: number;
}

/**
 * Transform hook applied to the outgoing frame right before emit.
 * This is where @framesieve/redact plugs in. Returning null cancels
 * the emit (fail-closed usage); a thrown error also cancels it, so a
 * broken transform can never leak an untransformed frame. The
 * per-frame Decision is made before the transform runs and is not
 * affected by cancellation.
 */
export type EmitTransform = (
  frame: FrameInput,
  meta: EmitMeta,
) => FrameInput | null | Promise<FrameInput | null>;

export interface FrameGateOptions {
  diff?: DiffOptions;
  blocks?: BlockOptions;
  adaptiveMask?: AdaptiveMaskOptions;
  policy?: PolicyOptions;
  crop?: CropOptions;
  transform?: EmitTransform;
  /**
   * Copy each frame's pixel buffer before (async) delivery. Default
   * true: the copy protects the delivered/transformed frame from a
   * caller that reuses its capture buffer before delivery settles. Set
   * false ONLY if you allocate a fresh buffer per frame (or never
   * mutate after push) to save one full-frame copy per emit; a
   * delivered frame then aliases your buffer until gate.flush()
   * settles.
   */
  copyFrameOnEmit?: boolean;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type EmitReason =
  /** Change score exceeded the configured gate. */
  | "threshold"
  /** maxSilenceMs elapsed without an emit. */
  | "keepalive"
  /** First frame, forced out by policy.primeOnFirstFrame. */
  | "prime";

export interface BlockChange {
  col: number;
  row: number;
  /** Fraction of changed pixels in this block (0-1). */
  ratio: number;
  /** Adaptive weight applied (1 = full weight). */
  weight: number;
}

export interface EmitMeta {
  /** 1-based sequence number of the input frame. */
  seq: number;
  elapsedMs: number;
  reason: EmitReason;
  /** Weighted change score that triggered the emit (0 for keepalive). */
  score: number;
  changedBlocks: BlockChange[];
}

export interface Crop {
  region: Region;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface EmitEvent extends EmitMeta {
  frame: FrameInput;
  /** Present when crop.enabled is true. */
  crops?: Crop[];
}

/**
 * Delivered to on("error") when a transform throws. Purely
 * observational: the emit is still cancelled (fail-closed) and not
 * counted in stats. Lets you log/alert on a broken transform instead
 * of losing the error silently.
 */
export interface EmitErrorEvent extends EmitMeta {
  error: unknown;
}

/** Per-frame decision record; mirrors one line of timeline.jsonl. */
export interface Decision {
  seq: number;
  elapsedMs: number;
  score: number;
  decision: "emit" | "skip" | "debounced" | "throttled";
  reason?: EmitReason;
}

export interface GateStats {
  framesSeen: number;
  /**
   * Frames actually delivered to listeners, after the transform hook
   * ran. Emits cancelled by the transform (null return or throw) are
   * NOT counted: with fail-closed redaction this is the number of
   * frames that really left the machine, and emitRatio stays honest
   * as "fraction of captured frames actually sent". The decision
   * timeline still records cancelled emits as "emit" - decisions are
   * deterministic and independent of the transform. With an async
   * transform these counters trail push(); await flush() before
   * reading stats if you need them settled.
   */
  framesEmitted: number;
  /** framesEmitted / framesSeen. */
  emitRatio: number;
  /** elapsedMs of the last delivered frame; null before the first. */
  lastEmitElapsedMs: number | null;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export interface FrameGate {
  /**
   * Feed the next frame. Returns the decision for this frame
   * synchronously; "emit" events also fire the listener (after the
   * transform hook resolves).
   */
  push(frame: FrameInput): Decision;
  /**
   * Push a frame and resolve with the frame an "emit" listener would
   * receive: the post-transform frame when this frame emits, or null
   * when it does not emit (or the transform cancelled it). A
   * convenience for single-consumer loops that would otherwise register
   * a listener and correlate by seq. The returned Decision sequence is
   * identical to push(); only the delivery is surfaced inline.
   */
  pushForEmit(frame: FrameInput): Promise<FrameInput | null>;
  /**
   * Register a synchronous observer called at the end of every push
   * with the pushed frame (at the elapsedMs the gate used) and its
   * Decision. Observers cannot change decisions - the decision sequence
   * is identical whether or not any tap is attached - so this is the
   * safe hook for recording, metrics, or logging without the recorder
   * having to wrap push(). Returns a function that removes the
   * observer. A throwing tap propagates out of push().
   */
  tap(observer: (frame: FrameInput, decision: Decision) => void): () => void;
  /**
   * Subscribe to "emit" (delivered frames) or "error" (a transform
   * threw; the emit was cancelled fail-closed). Returns a function that
   * removes the listener; off() with the same reference also works.
   */
  on(event: "emit", listener: (e: EmitEvent) => void): () => void;
  on(event: "error", listener: (e: EmitErrorEvent) => void): () => void;
  off(event: "emit", listener: (e: EmitEvent) => void): void;
  off(event: "error", listener: (e: EmitErrorEvent) => void): void;
  stats(): GateStats;
  /**
   * Resolves when every delivery for frames pushed so far has
   * settled: transforms resolved and listeners called (or the emit
   * cancelled). Await this before reading stats() when a transform
   * is asynchronous, and before tearing the gate down.
   */
  flush(): Promise<void>;
  /** Reset all internal state (adaptive weights, timers, stats). */
  reset(): void;
}
