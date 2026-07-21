import { test } from "node:test";
import assert from "node:assert/strict";

import { frameFromImageData } from "../src/frame.ts";

test("frameFromImageData wraps a Uint8ClampedArray without copying", () => {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  data[0] = 42;
  const frame = frameFromImageData({ data, width: 2, height: 2 }, 100);
  assert.equal(frame.width, 2);
  assert.equal(frame.height, 2);
  assert.equal(frame.elapsedMs, 100);
  // Same backing buffer: the helper reuses, it does not copy.
  assert.equal(frame.data, data);
});

test("frameFromImageData accepts a Uint8Array (e.g. Buffer) and converts", () => {
  const data = new Uint8Array(1 * 1 * 4);
  data[0] = 255;
  const frame = frameFromImageData({ data, width: 1, height: 1 }, 0);
  assert.ok(frame.data instanceof Uint8ClampedArray);
  assert.equal(frame.data[0], 255);
});

test("frameFromImageData rejects a length that does not match dimensions", () => {
  const data = new Uint8ClampedArray(10);
  assert.throws(
    () => frameFromImageData({ data, width: 2, height: 2 }, 0),
    /does not match/,
  );
});

test("frameFromImageData rejects non-integer or non-positive dimensions", () => {
  const data = new Uint8ClampedArray(4);
  assert.throws(
    () => frameFromImageData({ data, width: 0, height: 1 }, 0),
    /width must be a positive integer/,
  );
  assert.throws(
    () => frameFromImageData({ data, width: 1.5, height: 1 }, 0),
    /width must be a positive integer/,
  );
});

test("frameFromImageData rejects a negative or non-finite elapsedMs", () => {
  const data = new Uint8ClampedArray(4);
  assert.throws(
    () => frameFromImageData({ data, width: 1, height: 1 }, -1),
    /elapsedMs must be a finite number/,
  );
  assert.throws(
    () => frameFromImageData({ data, width: 1, height: 1 }, Number.NaN),
    /elapsedMs must be a finite number/,
  );
});

test("frameFromImageData output pushes cleanly through the gate", async () => {
  const { createFrameGate } = await import("../src/gate.ts");
  const data = new Uint8ClampedArray(4 * 4 * 4);
  const gate = createFrameGate();
  const decision = gate.push(frameFromImageData({ data, width: 4, height: 4 }, 0));
  assert.equal(decision.seq, 1);
});
