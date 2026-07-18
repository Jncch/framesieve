import { test } from "node:test";
import assert from "node:assert/strict";

import { DiffEngine, toGray, validateFrame } from "../src/diff.ts";
import { resolveOptions } from "../src/config.ts";
import { solidFrame, frameOf, paintRect } from "./helpers.ts";

function engine(overrides: Parameters<typeof resolveOptions>[0] = {}) {
  return new DiffEngine(resolveOptions(overrides));
}

function maskSum(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) n += v;
  return n;
}

test("first frame diffs against a black baseline: white frame is fully changed", () => {
  const e = engine({ diff: { downsampleFactor: 4 } });
  const { mask, w, h } = e.step(solidFrame(32, 16, 255, 0));
  assert.equal(w, 8);
  assert.equal(h, 4);
  assert.equal(maskSum(mask), w * h);
});

test("first all-black frame produces no change against the black baseline", () => {
  const e = engine({ diff: { downsampleFactor: 4 } });
  const { mask } = e.step(solidFrame(32, 16, 0, 0));
  assert.equal(maskSum(mask), 0);
});

test("identical consecutive frames produce an empty mask", () => {
  const e = engine({ diff: { downsampleFactor: 4 } });
  const f = solidFrame(32, 16, 128, 0);
  e.step(f);
  const { mask } = e.step({ ...f, elapsedMs: 500 });
  assert.equal(maskSum(mask), 0);
});

test("luminance floor: delta below threshold is noise, above is change", () => {
  const e = engine({ diff: { downsampleFactor: 1, luminanceThreshold: 10 } });
  e.step(solidFrame(4, 4, 100, 0));
  const below = e.step(solidFrame(4, 4, 105, 500));
  assert.equal(maskSum(below.mask), 0);
  const above = e.step(solidFrame(4, 4, 130, 1000));
  assert.equal(maskSum(above.mask), 16);
});

test("downsample averages luma over the factor block", () => {
  // Left half black, right half white in one 8x8 block: average ~127.
  const f = frameOf(8, 8, 0, (x) => (x < 4 ? 0 : 255));
  const { gray, w, h } = toGray(f, "downsample", 8);
  assert.equal(w, 1);
  assert.equal(h, 1);
  const g = gray[0]!;
  assert.ok(g > 120 && g < 132, `average luma ${g} out of range`);
});

test("remainder columns beyond the last full block are dropped", () => {
  const f = solidFrame(10, 8, 200, 0);
  const { w, h } = toGray(f, "downsample", 8);
  assert.equal(w, 1);
  assert.equal(h, 1);
});

test("sub-block change is diluted by downsampling; localized change is not", () => {
  const e = engine({ diff: { downsampleFactor: 8, luminanceThreshold: 10 } });
  const base = solidFrame(64, 64, 100, 0);
  e.step(base);
  // 2x2 pixels inside one 8x8 block: delta contribution 155*4/64 < 10.
  const tiny = paintRect(base, 0, 0, 2, 2, 255);
  const r1 = e.step({ ...tiny, elapsedMs: 500 });
  assert.equal(maskSum(r1.mask), 0);
  // Full 8x8 block flipped: shows up as exactly one changed working pixel.
  const block = paintRect(base, 8, 8, 8, 8, 255);
  const r2 = e.step({ ...block, elapsedMs: 1000 });
  assert.equal(maskSum(r2.mask), 1);
});

test("pixel algorithm compares at full resolution", () => {
  const e = engine({ diff: { algorithm: "pixel", luminanceThreshold: 10 } });
  const base = solidFrame(16, 16, 50, 0);
  e.step(base);
  const changed = paintRect(base, 3, 3, 2, 2, 200);
  const { mask, w, h } = e.step({ ...changed, elapsedMs: 500 });
  assert.equal(w, 16);
  assert.equal(h, 16);
  assert.equal(maskSum(mask), 4);
});

test("ignoreRegions suppress changes inside the region only", () => {
  const e = engine({
    diff: { downsampleFactor: 1, luminanceThreshold: 10 },
    policy: { ignoreRegions: [{ x: 0, y: 0, width: 8, height: 8 }] },
  });
  const base = solidFrame(16, 8, 0, 0);
  e.step(base);
  let f = paintRect(base, 0, 0, 8, 8, 255); // inside ignore region
  f = paintRect(f, 8, 0, 8, 8, 255); // outside
  const { mask } = e.step({ ...f, elapsedMs: 500 });
  assert.equal(maskSum(mask), 64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      assert.equal(mask[y * 16 + x], 0, `ignored pixel (${x},${y}) marked`);
    }
  }
});

test("dimension change resets the baseline to black", () => {
  const e = engine({ diff: { downsampleFactor: 4 } });
  e.step(solidFrame(32, 16, 255, 0));
  const { mask, w, h } = e.step(solidFrame(64, 32, 255, 500));
  assert.equal(w, 16);
  assert.equal(h, 8);
  assert.equal(maskSum(mask), w * h);
});

test("reset clears the baseline", () => {
  const e = engine({ diff: { downsampleFactor: 4 } });
  const f = solidFrame(32, 16, 255, 0);
  e.step(f);
  e.reset();
  const { mask } = e.step({ ...f, elapsedMs: 500 });
  assert.equal(maskSum(mask), 8 * 4);
});

test("validateFrame rejects malformed input", () => {
  const good = solidFrame(4, 4, 0, 0);
  validateFrame(good);
  assert.throws(() => validateFrame({ ...good, width: 5 }), RangeError);
  assert.throws(() => validateFrame({ ...good, elapsedMs: -1 }), RangeError);
  assert.throws(() => validateFrame({ ...good, elapsedMs: NaN }), RangeError);
  assert.throws(
    () => validateFrame({ ...good, data: good.data.subarray(0, 8) }),
    RangeError,
  );
});

test("resolveOptions validates ranges", () => {
  assert.throws(() => resolveOptions({ diff: { downsampleFactor: 0 } }), RangeError);
  assert.throws(() => resolveOptions({ diff: { luminanceThreshold: 300 } }), RangeError);
  assert.throws(() => resolveOptions({ blocks: { blockChangeRatio: 1.5 } }), RangeError);
  assert.throws(
    () =>
      resolveOptions({
        policy: { ignoreRegions: [{ x: -1, y: 0, width: 2, height: 2 }] },
      }),
    RangeError,
  );
});
