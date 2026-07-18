import { test } from "node:test";
import assert from "node:assert/strict";

import { BlockGrid } from "../src/blocks.ts";
import { resolveOptions } from "../src/config.ts";
import type { ChangeMask } from "../src/diff.ts";

function grid(overrides: Parameters<typeof resolveOptions>[0] = {}) {
  return new BlockGrid(resolveOptions(overrides));
}

/** Build a ChangeMask from a function over working pixels. */
function maskOf(
  w: number,
  h: number,
  fn: (x: number, y: number) => boolean,
): ChangeMask {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (fn(x, y)) mask[y * w + x] = 1;
    }
  }
  return { mask, w, h };
}

const empty = (w: number, h: number) => maskOf(w, h, () => false);

test("no changed pixels yields score 0 and no blocks", () => {
  const g = grid({ blocks: { gridCols: 4, gridRows: 4 } });
  const r = g.step(empty(16, 16));
  assert.equal(r.score, 0);
  assert.deepEqual(r.changedBlocks, []);
});

test("fully changed block reports ratio 1 and weight 1", () => {
  const g = grid({ blocks: { gridCols: 4, gridRows: 4 } });
  // 16x16 working, 4x4 grid: block (0,0) covers x,y in [0,4).
  const r = g.step(maskOf(16, 16, (x, y) => x < 4 && y < 4));
  assert.equal(r.score, 1);
  assert.deepEqual(r.changedBlocks, [{ col: 0, row: 0, ratio: 1, weight: 1 }]);
});

test("blockChangeRatio boundary: exactly at threshold counts, below does not", () => {
  // Block is 4x4 = 16 pixels; threshold 0.25 = 4 pixels.
  const g = grid({
    blocks: { gridCols: 4, gridRows: 4, blockChangeRatio: 0.25 },
  });
  const below = g.step(maskOf(16, 16, (x, y) => y === 0 && x < 3));
  assert.equal(below.changedBlocks.length, 0);
  const at = g.step(maskOf(16, 16, (x, y) => y === 0 && x < 4));
  assert.equal(at.changedBlocks.length, 1);
  assert.equal(at.changedBlocks[0]!.ratio, 0.25);
});

test("non-divisible dims: floor boundaries partition all pixels", () => {
  // 10 working pixels over 3 cols: [0,3) [3,6) [6,10).
  const g = grid({
    blocks: { gridCols: 3, gridRows: 1, blockChangeRatio: 0.5 },
    adaptiveMask: { enabled: false },
  });
  const r = g.step(maskOf(10, 1, (x) => x >= 6));
  assert.equal(r.changedBlocks.length, 1);
  assert.deepEqual(r.changedBlocks[0], { col: 2, row: 0, ratio: 1, weight: 1 });
});

test("changedBlocks are ordered row-major", () => {
  const g = grid({
    blocks: { gridCols: 2, gridRows: 2 },
    adaptiveMask: { enabled: false },
  });
  const r = g.step(maskOf(8, 8, () => true));
  assert.deepEqual(
    r.changedBlocks.map((b) => [b.row, b.col]),
    [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ],
  );
  assert.equal(r.score, 4);
});

test("adaptive weight decays linearly for a block changing every frame", () => {
  const g = grid({
    blocks: { gridCols: 1, gridRows: 1, blockChangeRatio: 0.5 },
    adaptiveMask: { windowSize: 4 },
  });
  const full = maskOf(4, 4, () => true);
  const weights: number[] = [];
  for (let i = 0; i < 6; i++) {
    weights.push(g.step(full).changedBlocks[0]!.weight);
  }
  // History before each frame: 0,1,2,3,4,4 changes in a window of 4.
  assert.deepEqual(weights, [1, 0.75, 0.5, 0.25, 0, 0]);
});

test("a busy block that goes quiet recovers weight", () => {
  const g = grid({
    blocks: { gridCols: 1, gridRows: 1, blockChangeRatio: 0.5 },
    adaptiveMask: { windowSize: 4 },
  });
  const full = maskOf(4, 4, () => true);
  const quiet = empty(4, 4);
  for (let i = 0; i < 4; i++) g.step(full); // saturate: weight -> 0
  assert.equal(g.step(full).changedBlocks[0]!.weight, 0);
  for (let i = 0; i < 4; i++) g.step(quiet); // window drains
  const r = g.step(full);
  assert.equal(r.changedBlocks[0]!.weight, 1);
});

test("busy region suppression leaves neighbors at full weight", () => {
  // 2 cols: col 0 changes every frame (video), col 1 changes once.
  const g = grid({
    blocks: { gridCols: 2, gridRows: 1, blockChangeRatio: 0.5 },
    adaptiveMask: { windowSize: 4 },
  });
  const video = maskOf(8, 4, (x) => x < 4);
  for (let i = 0; i < 5; i++) g.step(video);
  const both = maskOf(8, 4, () => true);
  const r = g.step(both);
  assert.equal(r.changedBlocks.length, 2);
  const [left, right] = r.changedBlocks;
  assert.equal(left!.weight, 0); // saturated video region
  assert.equal(right!.weight, 1); // fresh slide content
  assert.equal(r.score, 1);
});

test("adaptive disabled: weight is always 1 regardless of history", () => {
  const g = grid({
    blocks: { gridCols: 1, gridRows: 1, blockChangeRatio: 0.5 },
    adaptiveMask: { enabled: false },
  });
  const full = maskOf(4, 4, () => true);
  for (let i = 0; i < 10; i++) {
    assert.equal(g.step(full).changedBlocks[0]!.weight, 1);
  }
});

test("reset clears adaptive history", () => {
  const g = grid({
    blocks: { gridCols: 1, gridRows: 1, blockChangeRatio: 0.5 },
    adaptiveMask: { windowSize: 4 },
  });
  const full = maskOf(4, 4, () => true);
  for (let i = 0; i < 5; i++) g.step(full);
  g.reset();
  assert.equal(g.step(full).changedBlocks[0]!.weight, 1);
});

test("blockChangeRatio 0 still requires at least one changed pixel", () => {
  const g = grid({
    blocks: { gridCols: 1, gridRows: 1, blockChangeRatio: 0 },
  });
  assert.equal(g.step(empty(4, 4)).changedBlocks.length, 0);
  const one = maskOf(4, 4, (x, y) => x === 0 && y === 0);
  assert.equal(g.step(one).changedBlocks.length, 1);
});
