import { test } from "node:test";
import assert from "node:assert/strict";

import {
  desktopSourceConstraints,
  frameFromNativeImage,
  type NativeImageLike,
} from "../src/electron/index.ts";

test("desktopSourceConstraints wires the source id into chromeMediaSource", () => {
  const constraints = desktopSourceConstraints("screen:1:0", {
    maxWidth: 1280,
    maxHeight: 720,
  });
  assert.equal(constraints.audio, false);
  const video = constraints.video as unknown as {
    mandatory: Record<string, unknown>;
  };
  assert.deepEqual(video.mandatory, {
    chromeMediaSource: "desktop",
    chromeMediaSourceId: "screen:1:0",
    maxWidth: 1280,
    maxHeight: 720,
    maxFrameRate: 5,
  });
});

test("frameFromNativeImage swaps BGRA to RGBA", () => {
  // Two pixels in BGRA: (B,G,R,A) = (10,20,30,40) then (1,2,3,255).
  const bgra = new Uint8Array([10, 20, 30, 40, 1, 2, 3, 255]);
  const image: NativeImageLike = {
    getSize: () => ({ width: 2, height: 1 }),
    toBitmap: () => bgra,
  };
  const frame = frameFromNativeImage(image, 500);
  assert.equal(frame.width, 2);
  assert.equal(frame.height, 1);
  assert.equal(frame.elapsedMs, 500);
  // RGBA: (R,G,B,A) = (30,20,10,40) then (3,2,1,255).
  assert.deepEqual(Array.from(frame.data), [30, 20, 10, 40, 3, 2, 1, 255]);
});
