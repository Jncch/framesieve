import type {
  BlockChange,
  Decision,
  EmitEvent,
  EmitErrorEvent,
  EmitMeta,
  FrameGate,
  FrameGateOptions,
  FrameInput,
  GateStats,
} from "./types.ts";
import { resolveOptions, type ResolvedOptions } from "./config.ts";
import { DiffEngine, validateFrame } from "./diff.ts";
import { BlockGrid } from "./blocks.ts";
import { computeCrops } from "./crop.ts";

/**
 * The gate ties the three scoring stages to the policy layer.
 *
 * Policy state machine (all times from FrameInput.elapsedMs):
 * - A frame whose weighted score reaches minChangedBlocks opens (or
 *   refreshes) a pending change. The pending emit fires on the first
 *   frame that has been stable for debounceMs and clears
 *   minIntervalMs; that frame is the settled post-transition state.
 *   The emitted meta carries the score and blocks of the last frame
 *   that crossed the threshold, while the pixels are the settled
 *   frame's.
 * - While a pending change waits for stability the decision is
 *   "debounced"; once stable but inside minIntervalMs it is
 *   "throttled".
 * - If nothing was emitted for maxSilenceMs, the current frame goes
 *   out as a keepalive. A threshold emit on the same frame wins over
 *   keepalive.
 */

interface Pending {
  score: number;
  changedBlocks: BlockChange[];
  /** elapsedMs of the last frame that crossed the threshold. */
  sinceMs: number;
}

class Gate implements FrameGate {
  private readonly options: ResolvedOptions;
  private readonly diff: DiffEngine;
  private readonly grid: BlockGrid;
  private readonly listeners = new Set<(e: EmitEvent) => void>();
  private readonly errorListeners = new Set<(e: EmitErrorEvent) => void>();
  private readonly taps = new Set<(frame: FrameInput, decision: Decision) => void>();
  /** Serializes async transform results so emits arrive in order. */
  private delivery: Promise<void> = Promise.resolve();

  private seq = 0;
  private lastElapsedMs = -Infinity;
  private pending: Pending | null = null;
  /** Policy anchor: last emit DECISION time. Deterministic; not
   * affected by transform cancellation. */
  private lastEmitMs: number | null = null;
  /** Baseline for keepalive; session start until the first emit. */
  private silenceBaseMs: number | null = null;
  /** Stats: frames actually delivered (post-transform). */
  private delivered = 0;
  private lastDeliveredMs: number | null = null;
  /** This push's emit result (post-transform frame or null), for
   * pushForEmit. Set synchronously by recordEmit, cleared each push. */
  private lastEmitOut: Promise<FrameInput | null> | null = null;

  constructor(options: ResolvedOptions) {
    this.options = options;
    this.diff = new DiffEngine(options);
    this.grid = new BlockGrid(options);
  }

  push(frame: FrameInput): Decision {
    const decision = this.decide(frame);
    if (this.taps.size > 0) {
      // Observers see the frame at the elapsedMs the gate used (which
      // differs from the input only when onNonMonotonic clamped it).
      const observed =
        frame.elapsedMs === decision.elapsedMs
          ? frame
          : { ...frame, elapsedMs: decision.elapsedMs };
      for (const tap of this.taps) tap(observed, decision);
    }
    return decision;
  }

  /**
   * Register a synchronous observer, called at the end of every push
   * with the pushed frame and its Decision. Cannot affect decisions
   * (the decision sequence is identical with or without taps), so it
   * is the safe hook for recording/metrics. Returns an unsubscribe fn.
   */
  tap(observer: (frame: FrameInput, decision: Decision) => void): () => void {
    this.taps.add(observer);
    return () => {
      this.taps.delete(observer);
    };
  }

  private decide(frame: FrameInput): Decision {
    validateFrame(frame);
    if (frame.elapsedMs < this.lastElapsedMs) {
      if (this.options.policy.onNonMonotonic === "throw") {
        throw new RangeError(
          `elapsedMs must not decrease (got ${frame.elapsedMs} after ${this.lastElapsedMs})`,
        );
      }
      // clamp: pin to the last seen time so a backwards wall clock
      // (e.g. an NTP correction) does not crash a long capture.
      // Deterministic: depends only on lastElapsedMs.
      frame = { ...frame, elapsedMs: this.lastElapsedMs };
    }
    this.lastElapsedMs = frame.elapsedMs;
    this.seq += 1;
    this.lastEmitOut = null;
    if (this.silenceBaseMs === null) this.silenceBaseMs = frame.elapsedMs;

    const diffResult = this.diff.step(frame);
    const judgment = this.grid.step(diffResult, diffResult.motion);
    const { score, changedBlocks } = judgment;
    const crossed =
      changedBlocks.length > 0 && score >= this.options.blocks.minChangedBlocks;
    if (this.options.diff.mode === "reference") {
      // Persistence semantics: sinceMs marks when the divergence from
      // the last emitted frame first appeared and is NOT refreshed while
      // it persists, so stableFor measures how long it has lasted. A
      // frame that no longer crosses (reverted to the baseline, or a
      // chronically moving region the adaptive weight decayed) drops the
      // pending change as transient.
      if (crossed) {
        if (this.pending === null) {
          this.pending = { score, changedBlocks, sinceMs: frame.elapsedMs };
        } else {
          this.pending.score = score;
          this.pending.changedBlocks = changedBlocks;
        }
      } else {
        this.pending = null;
      }
    } else if (crossed) {
      this.pending = { score, changedBlocks, sinceMs: frame.elapsedMs };
    }

    const decision: Decision = {
      seq: this.seq,
      elapsedMs: frame.elapsedMs,
      score,
      decision: "skip",
    };

    // Prime: force the very first frame out so an observer gets the
    // current state immediately, without waiting for debounce. Bypasses
    // pending/keepalive entirely; those govern later frames.
    if (this.options.policy.primeOnFirstFrame && this.seq === 1) {
      const meta: EmitMeta = {
        seq: this.seq,
        elapsedMs: frame.elapsedMs,
        reason: "prime",
        score,
        changedBlocks,
      };
      this.recordEmit(frame, meta);
      this.pending = null;
      decision.decision = "emit";
      decision.reason = "prime";
      return decision;
    }

    if (this.pending !== null) {
      const stableFor = frame.elapsedMs - this.pending.sinceMs;
      // In reference mode the wait is the persistence window; in the
      // default previous mode it is the settle-after-motion debounce.
      const settleWindow =
        this.options.diff.mode === "reference"
          ? this.options.policy.referencePersistMs
          : this.options.policy.debounceMs;
      const debounced = stableFor < settleWindow;
      const throttled =
        this.lastEmitMs !== null &&
        frame.elapsedMs - this.lastEmitMs < this.options.policy.minIntervalMs;
      if (!debounced && !throttled) {
        const meta: EmitMeta = {
          seq: this.seq,
          elapsedMs: frame.elapsedMs,
          reason: "threshold",
          score: this.pending.score,
          changedBlocks: this.pending.changedBlocks,
        };
        this.recordEmit(frame, meta);
        this.pending = null;
        decision.decision = "emit";
        decision.reason = "threshold";
        return decision;
      }
      if (this.keepaliveDue(frame.elapsedMs)) {
        this.emitKeepalive(frame, decision);
        return decision;
      }
      decision.decision = debounced ? "debounced" : "throttled";
      return decision;
    }

    if (this.keepaliveDue(frame.elapsedMs)) {
      this.emitKeepalive(frame, decision);
    }
    return decision;
  }

  async pushForEmit(frame: FrameInput): Promise<FrameInput | null> {
    const decision = this.push(frame);
    if (decision.decision !== "emit") return null;
    // recordEmit set lastEmitOut synchronously during push(); capture it
    // before any await so a concurrent push cannot swap it out.
    const out = this.lastEmitOut;
    return out === null ? null : out;
  }

  private keepaliveDue(elapsedMs: number): boolean {
    return (
      this.options.policy.maxSilenceMs > 0 &&
      this.silenceBaseMs !== null &&
      elapsedMs - this.silenceBaseMs >= this.options.policy.maxSilenceMs
    );
  }

  private emitKeepalive(frame: FrameInput, decision: Decision): void {
    const meta: EmitMeta = {
      seq: this.seq,
      elapsedMs: frame.elapsedMs,
      reason: "keepalive",
      score: 0,
      changedBlocks: [],
    };
    this.recordEmit(frame, meta);
    decision.decision = "emit";
    decision.reason = "keepalive";
  }

  private recordEmit(frame: FrameInput, meta: EmitMeta): void {
    this.lastEmitMs = meta.elapsedMs;
    this.silenceBaseMs = meta.elapsedMs;
    // Advance the reference-mode baseline to this frame (no-op in
    // previous mode). Must run synchronously here, not in the async
    // delivery below: diff.step() overwrites its lastWork on every push,
    // so a deferred commit could promote the wrong frame. Keepalive does
    // NOT commit - moving the baseline mid-pending would misread the next
    // (unchanged) frame as a revert and cancel a real persistence check.
    if (meta.reason !== "keepalive") this.diff.commit();
    const { transform } = this.options;
    const { crop } = this.options;
    const { gridCols, gridRows } = this.options.blocks;
    // Copy the frame so later caller-side mutation of the pushed
    // buffer cannot leak into an async delivery. copyFrameOnEmit=false
    // opts out (the delivered frame then aliases the caller's buffer).
    const snapshot: FrameInput = {
      data: this.options.copyFrameOnEmit
        ? new Uint8ClampedArray(frame.data)
        : frame.data,
      width: frame.width,
      height: frame.height,
      elapsedMs: frame.elapsedMs,
    };
    // Surface this emit's post-transform result so pushForEmit can
    // await exactly the frame this push produced, in delivery order.
    let resolveOut!: (out: FrameInput | null) => void;
    this.lastEmitOut = new Promise<FrameInput | null>((r) => {
      resolveOut = r;
    });
    this.delivery = this.delivery.then(async () => {
      let out: FrameInput | null = snapshot;
      if (transform !== null) {
        try {
          out = await transform(snapshot, meta);
        } catch (error) {
          // Fail closed: a broken transform must not leak the frame.
          // Surface the error to on("error") observers; the emit stays
          // cancelled and uncounted regardless.
          out = null;
          this.emitError(error, meta);
        }
      }
      if (out === null) {
        resolveOut(null);
        return;
      }
      // Only frames that survive the transform count as emitted:
      // stats answer "what actually left the machine".
      this.delivered += 1;
      this.lastDeliveredMs = meta.elapsedMs;
      const event: EmitEvent = { ...meta, frame: out };
      if (crop.enabled) {
        // Crops are cut from the transformed frame so redaction
        // applies to them as well.
        event.crops = computeCrops(
          out,
          meta.changedBlocks,
          gridCols,
          gridRows,
          crop.paddingPx,
        );
      }
      for (const listener of this.listeners) {
        listener(event);
      }
      resolveOut(out);
    });
  }

  on(event: "emit", listener: (e: EmitEvent) => void): () => void;
  on(event: "error", listener: (e: EmitErrorEvent) => void): () => void;
  on(event: "emit" | "error", listener: unknown): () => void {
    if (event === "emit") {
      const l = listener as (e: EmitEvent) => void;
      this.listeners.add(l);
      return () => {
        this.listeners.delete(l);
      };
    }
    if (event === "error") {
      const l = listener as (e: EmitErrorEvent) => void;
      this.errorListeners.add(l);
      return () => {
        this.errorListeners.delete(l);
      };
    }
    throw new RangeError(`unknown event: ${String(event)}`);
  }

  off(event: "emit", listener: (e: EmitEvent) => void): void;
  off(event: "error", listener: (e: EmitErrorEvent) => void): void;
  off(event: "emit" | "error", listener: unknown): void {
    if (event === "emit") {
      this.listeners.delete(listener as (e: EmitEvent) => void);
    } else if (event === "error") {
      this.errorListeners.delete(listener as (e: EmitErrorEvent) => void);
    } else {
      throw new RangeError(`unknown event: ${String(event)}`);
    }
  }

  private emitError(error: unknown, meta: EmitMeta): void {
    if (this.errorListeners.size === 0) return;
    const event: EmitErrorEvent = { ...meta, error };
    for (const listener of this.errorListeners) listener(event);
  }

  stats(): GateStats {
    return {
      framesSeen: this.seq,
      framesEmitted: this.delivered,
      emitRatio: this.seq === 0 ? 0 : this.delivered / this.seq,
      lastEmitElapsedMs: this.lastDeliveredMs,
    };
  }

  flush(): Promise<void> {
    return this.delivery;
  }

  reset(): void {
    this.diff.reset();
    this.grid.reset();
    this.seq = 0;
    this.lastElapsedMs = -Infinity;
    this.pending = null;
    this.lastEmitMs = null;
    this.silenceBaseMs = null;
    this.delivered = 0;
    this.lastDeliveredMs = null;
    this.lastEmitOut = null;
  }
}

export function createFrameGate(options?: FrameGateOptions): FrameGate {
  return new Gate(resolveOptions(options));
}
