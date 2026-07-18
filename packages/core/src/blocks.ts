import type { BlockChange } from "./types.ts";
import type { ResolvedOptions } from "./config.ts";
import type { ChangeMask } from "./diff.ts";

/**
 * Stage 2 + 3: block grid judgment and adaptive frequency mask.
 *
 * The working-resolution change mask is partitioned into a
 * gridCols x gridRows grid. A block counts as changed when at least
 * blockChangeRatio of its pixels changed. Each changed block
 * contributes its adaptive weight to the score:
 *
 *   weight(b) = 1 - changeFrequency(b, last windowSize frames)
 *
 * The frequency denominator is always windowSize (missing history
 * counts as unchanged), so a constantly-changing region converges to
 * weight 0 over the window instead of being zeroed after one frame,
 * and a region that goes quiet recovers weight at the same rate.
 */

export interface BlockJudgment {
  /** Sum of weights of changed blocks. */
  score: number;
  /** Row-major (row, then col) for deterministic ordering. */
  changedBlocks: BlockChange[];
}

export class BlockGrid {
  private readonly cols: number;
  private readonly rows: number;
  private readonly ratioThreshold: number;
  private readonly adaptive: boolean;
  private readonly windowSize: number;
  /** Ring buffer: history[block * windowSize + slot] = 0 | 1. */
  private history: Uint8Array;
  /** Per-block count of set entries, kept in sync with history. */
  private historySum: Uint32Array;
  private slot = 0;

  constructor(options: ResolvedOptions) {
    this.cols = options.blocks.gridCols;
    this.rows = options.blocks.gridRows;
    this.ratioThreshold = options.blocks.blockChangeRatio;
    this.adaptive = options.adaptiveMask.enabled;
    this.windowSize = options.adaptiveMask.windowSize;
    this.history = new Uint8Array(this.cols * this.rows * this.windowSize);
    this.historySum = new Uint32Array(this.cols * this.rows);
  }

  step(cm: ChangeMask): BlockJudgment {
    const { mask, w, h } = cm;
    const changedBlocks: BlockChange[] = [];
    let score = 0;
    for (let row = 0; row < this.rows; row++) {
      const y0 = Math.floor((row * h) / this.rows);
      const y1 = Math.floor(((row + 1) * h) / this.rows);
      for (let col = 0; col < this.cols; col++) {
        const x0 = Math.floor((col * w) / this.cols);
        const x1 = Math.floor(((col + 1) * w) / this.cols);
        const total = (x1 - x0) * (y1 - y0);
        let changed = 0;
        for (let y = y0; y < y1; y++) {
          const base = y * w;
          for (let x = x0; x < x1; x++) {
            changed += mask[base + x]!;
          }
        }
        const ratio = total === 0 ? 0 : changed / total;
        const isChanged = changed > 0 && ratio >= this.ratioThreshold;
        const block = row * this.cols + col;
        if (isChanged) {
          const weight = this.adaptive
            ? 1 - this.historySum[block]! / this.windowSize
            : 1;
          score += weight;
          changedBlocks.push({ col, row, ratio, weight });
        }
        // Update history after the weight for this frame is taken.
        const idx = block * this.windowSize + this.slot;
        this.historySum[block] =
          this.historySum[block]! - this.history[idx]! + (isChanged ? 1 : 0);
        this.history[idx] = isChanged ? 1 : 0;
      }
    }
    this.slot = (this.slot + 1) % this.windowSize;
    return { score, changedBlocks };
  }

  reset(): void {
    this.history.fill(0);
    this.historySum.fill(0);
    this.slot = 0;
  }
}
